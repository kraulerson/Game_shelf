const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Invariant B: boot never writes credential rows.
 *
 * Boot cannot ask the operator anything, runs under `restart: unless-stopped`, and
 * races the very state it inspects. Every repair mechanism placed there needed a
 * guard, and every guard a counter-guard — the automatic v0→v1 re-seal and the
 * salt-loss detector between them account for most of this branch's regressions,
 * including one that permanently destroyed a credential that had been readable.
 *
 * Upgrading the envelope is hardening, not a correctness prerequisite: reads dispatch
 * on the envelope version, so a v0 blob works indefinitely. So the upgrade moves to
 * the operator-run rotation script, where it is deliberate, offline, verified, and
 * preceded by a backup.
 */
describe('Invariant B — migrations never rewrite credentials', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'migrate-no-writes', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  function cleanup() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    for (const m of [
      '../../src/db/migrate',
      '../../src/utils/encrypt',
      '../../src/utils/rotateCredentials',
    ]) {
      delete require.cache[require.resolve(m)];
    }
  }

  function sealLegacy(plaintext) {
    const key = crypto.createHash('sha256').update(KEY).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let data = cipher.update(plaintext, 'utf8', 'hex');
    data += cipher.final('hex');
    return Buffer.from(
      JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data })
    ).toString('base64');
  }

  before(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;
  });

  after(() => {
    cleanup();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('leaves a pre-versioned credential exactly as it found it', () => {
    cleanup();
    const { runMigrations } = require('../../src/db/migrate');
    let db = runMigrations(testDbPath);

    const original = sealLegacy(JSON.stringify({ password: 'hunter2' }));
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('ubisoft', 'Ubisoft Connect', original);
    db.close();

    cleanup2();
    const { runMigrations: run2 } = require('../../src/db/migrate');
    db = run2(testDbPath);
    const after = db
      .prepare('SELECT credentials_json FROM launchers WHERE name = ?')
      .get('ubisoft').credentials_json;
    db.close();

    assert.equal(
      after,
      original,
      'boot must not rewrite a stored credential — the upgrade belongs to the ' +
        'operator-run rotation script, not to a process that cannot ask anything'
    );
  });

  // Same as cleanup() but keeps the database: only module state is dropped.
  function cleanup2() {
    for (const m of [
      '../../src/db/migrate',
      '../../src/utils/encrypt',
      '../../src/utils/rotateCredentials',
    ]) {
      delete require.cache[require.resolve(m)];
    }
  }

  it('does not create a salt when starting with only pre-versioned credentials', () => {
    cleanup();
    const { runMigrations } = require('../../src/db/migrate');
    let db = runMigrations(testDbPath);
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', sealLegacy(JSON.stringify({ token: 'x' })));
    db.close();

    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    cleanup2();

    const { runMigrations: run2 } = require('../../src/db/migrate');
    db = run2(testDbPath);
    db.close();

    assert.ok(
      !fs.existsSync(saltPath),
      'a v0-only store needs no salt; minting one at boot is what re-sealed rows ' +
        'under a throwaway salt and destroyed them when the real one was restored'
    );
  });

  it('boots without throwing when a stored credential cannot be decrypted', () => {
    cleanup();
    const { runMigrations } = require('../../src/db/migrate');
    let db = runMigrations(testDbPath);
    const otherKey = crypto.createHash('sha256').update('a-different-key-entirely!!!!!!!!!').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', otherKey, iv);
    let data = cipher.update('x', 'utf8', 'hex');
    data += cipher.final('hex');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run(
      'epic',
      'Epic',
      Buffer.from(
        JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data })
      ).toString('base64')
    );
    db.close();

    cleanup2();
    const { runMigrations: run2 } = require('../../src/db/migrate');
    assert.doesNotThrow(() => {
      const boot = run2(testDbPath);
      boot.close();
    }, 'an unreadable credential must never stop the container starting');
  });
});
