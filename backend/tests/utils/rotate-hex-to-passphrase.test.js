const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Moving OFF a declared raw key.
 *
 * A hex: install has no salt file and never needed one. Rotating it to a passphrase
 * is the one direction where the target key's salt does not exist yet — and the
 * short-circuit that asks "is this row already sealed under the new key?" derives
 * that key to answer, on the pure read path, which refuses to create anything.
 *
 * So the rotation died on its own question, quoting SaltMissingError: "restore that
 * file from the same backup as the database". On a hex install that file has never
 * existed in any backup. .env.example calls hex "Preferred", so this is the direction
 * the recommended configuration has to travel to ever change key type.
 */
describe('rotating from a declared hex key to a passphrase', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'rotate-hex-to-pass', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const HEX_KEY = 'hex:' + crypto.randomBytes(32).toString('hex');
  const PASSPHRASE = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  let db;

  function dropModules() {
    for (const m of [
      '../../src/db/migrate',
      '../../src/utils/encrypt',
      '../../src/utils/rotateCredentials',
    ]) {
      delete require.cache[require.resolve(m)];
    }
  }

  function cleanup() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    dropModules();
  }

  before(() => {
    cleanup();
    process.env.GAMESHELF_ENCRYPTION_KEY = HEX_KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    db = require('../../src/db/migrate').runMigrations(testDbPath);
    const { encrypt } = require('../../src/utils/encrypt');

    const insert = db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    );
    insert.run('steam', 'Steam', encrypt(JSON.stringify({ api_key: 'steam-key' })));
    insert.run('gog', 'GOG', encrypt(JSON.stringify({ refresh_token: 'gog-token' })));
  });

  after(() => {
    if (db) db.close();
    cleanup();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('succeeds, and creates the salt the passphrase now needs', () => {
    assert.ok(!fs.existsSync(saltPath), 'a hex install starts with no salt at all');

    const { rotateAllCredentials } = require('../../src/utils/rotateCredentials');
    const result = rotateAllCredentials(db, HEX_KEY, PASSPHRASE);

    assert.equal(result.rotated, 2);
    assert.deepEqual(result.failed, []);
    assert.ok(fs.existsSync(saltPath), 'sealing under a passphrase must create one');

    process.env.GAMESHELF_ENCRYPTION_KEY = PASSPHRASE;
    dropModules();
    const { decrypt } = require('../../src/utils/encrypt');
    require('../../src/utils/encrypt').setSaltDirectory(path.dirname(testDbPath));

    const rows = db.prepare('SELECT name, credentials_json FROM launchers').all();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.credentials_json]));

    assert.deepEqual(JSON.parse(decrypt(byName.steam)), { api_key: 'steam-key' });
    assert.deepEqual(JSON.parse(decrypt(byName.gog)), { refresh_token: 'gog-token' });

    process.env.GAMESHELF_ENCRYPTION_KEY = HEX_KEY;
  });
});
