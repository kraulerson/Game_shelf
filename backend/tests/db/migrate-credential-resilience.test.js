const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * The startup re-seal must never be able to stop the app booting.
 *
 * Before this change, a wrong GAMESHELF_ENCRYPTION_KEY left the app degraded but
 * running — the operator could re-enter credentials through the UI. Adding a
 * migration that throws turns that into an uncaught exception at server.js, and
 * docker-compose's `restart: unless-stopped` turns *that* into an infinite crash
 * loop with no in-app recovery path at all.
 *
 * Reads already dispatch on the envelope version, so leaving an un-re-sealable blob
 * alone is safe. Upgrading the envelope is hardening, not a correctness prerequisite.
 */
describe('startup credential re-seal resilience', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'envelope-resilience', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  const OTHER_KEY = 'zzz]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN';

  function cleanup() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    // encrypt.js memoises derived keys, and removing the salt invalidates them.
    // Drop the module with the salt so each case starts from one consistent pair.
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    delete require.cache[require.resolve('../../src/utils/rotateCredentials')];
  }

  function sealLegacyUnder(passphrase, plaintext) {
    const key = crypto.createHash('sha256').update(passphrase).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let data = cipher.update(plaintext, 'utf8', 'hex');
    data += cipher.final('hex');
    return Buffer.from(
      JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data })
    ).toString('base64');
  }

  function seedWith(credentialsJson) {
    cleanup();
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('ubisoft', 'Ubisoft Connect', credentialsJson);
    db.close();
  }

  beforeEach(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;
  });

  after(() => {
    cleanup();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('still boots when a stored credential cannot be decrypted with the current key', () => {
    // Sealed under a key the app no longer has — the exact state an operator creates
    // by editing GAMESHELF_ENCRYPTION_KEY without running the rotation script.
    seedWith(sealLegacyUnder(OTHER_KEY, JSON.stringify({ password: 'hunter2' })));

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');

    let db;
    assert.doesNotThrow(() => {
      db = runMigrations(testDbPath);
    }, 'an un-re-sealable credential must not stop the app booting');

    // And the untouched blob must still be there for the operator to recover from.
    const row = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get('ubisoft');
    db.close();
    assert.ok(row.credentials_json, 'the original blob must be left intact, not blanked');
  });

  it('still boots when credentials_json holds something that is not an envelope', () => {
    // `WHERE credentials_json IS NOT NULL` lets '' and arbitrary junk through, and
    // tests/routes/sync-health.test.js already writes a literal placeholder here.
    seedWith('');

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');

    let db;
    assert.doesNotThrow(() => {
      db = runMigrations(testDbPath);
    }, 'unparseable credential data must not stop the app booting');
    if (db) db.close();
  });

});

describe('salt location follows the database being migrated', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'salt-location', 'test.db');
  const expectedSalt = path.join(path.dirname(testDbPath), 'encryption-salt');
  const strayDir = path.join(__dirname, '..', 'data', 'salt-location-stray');
  const straySalt = path.join(strayDir, 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  function clean() {
    for (const f of [testDbPath, testDbPath + '-wal', testDbPath + '-shm', expectedSalt, straySalt]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    delete require.cache[require.resolve('../../src/utils/rotateCredentials')];
    delete require.cache[require.resolve('../../src/db/migrate')];
  }

  before(() => clean());

  after(() => {
    clean();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('writes the salt beside the database it was given, not beside the env var', () => {
    // runMigrations takes the path as an argument while encrypt.js reads the env var,
    // so the two can disagree. Eight test suites already call runMigrations without
    // setting GAMESHELF_DB_PATH; they survive only because their databases hold no
    // credentials. A salt beside the wrong database is unrecoverable data loss.
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = path.join(strayDir, 'other.db');
    fs.mkdirSync(strayDir, { recursive: true });

    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', require('../../src/utils/encrypt').encrypt('{"t":"x"}'));
    db.close();

    assert.ok(
      fs.existsSync(expectedSalt),
      'the salt must land beside the database runMigrations was given'
    );
    assert.ok(!fs.existsSync(straySalt), 'the salt must not land beside the env var path');
  });
});
