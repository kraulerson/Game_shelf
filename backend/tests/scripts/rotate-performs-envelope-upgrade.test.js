const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'rotate-encryption-key.js');

/**
 * CHARACTERISATION TEST — deliberately expected to pass on first run.
 *
 * Step 2 deleted the boot-time v0→v1 re-seal on the grounds that the rotation script
 * already performs that upgrade when the new key equals the current one. That is a
 * load-bearing assumption: if it were false, removing the boot version would have left
 * no upgrade path at all and the whole plan would be wrong.
 *
 * So this does not drive new behaviour — it pins behaviour the previous step now
 * depends on, and turns a claim in a commit message into something CI would catch.
 */
describe('rotate-encryption-key.js performs the envelope upgrade', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'rotate-upgrade', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  function cleanup() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    for (const m of ['../../src/db/migrate', '../../src/utils/encrypt']) {
      delete require.cache[require.resolve(m)];
    }
  }

  /** A blob exactly as releases before the versioned envelope wrote it. */
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
    cleanup();
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    const db = require('../../src/db/migrate').runMigrations(testDbPath);
    const insert = db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    );
    insert.run('ubisoft', 'Ubisoft', sealLegacy(JSON.stringify({ password: 'hunter2' })));
    insert.run('gog', 'GOG', sealLegacy(JSON.stringify({ token: 'gog-token' })));
    db.close();
  });

  after(() => {
    cleanup();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('upgrades pre-versioned blobs to the salted derivation when NEW equals the current key', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const before = require('../../src/utils/encrypt');
    const Database = require('better-sqlite3');

    let db = new Database(testDbPath);
    const rows = db.prepare('SELECT name, credentials_json FROM launchers').all();
    db.close();
    for (const row of rows) {
      assert.equal(before.envelopeVersion(row.credentials_json), 0, `${row.name} starts at v0`);
    }

    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GAMESHELF_DB_PATH: testDbPath,
        GAMESHELF_ENCRYPTION_KEY: KEY,
        GAMESHELF_ENCRYPTION_KEY_NEW: KEY,
      },
    });

    assert.equal(result.status, 0, `script should succeed, got:\n${result.stderr}`);
    assert.match(result.stdout, /Rotated 2/, 'both rows should have been rewritten');

    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const after = require('../../src/utils/encrypt');

    db = new Database(testDbPath);
    const upgraded = db.prepare('SELECT name, credentials_json FROM launchers').all();
    db.close();

    assert.deepEqual(
      JSON.parse(after.decrypt(upgraded.find((r) => r.name === 'ubisoft').credentials_json)),
      { password: 'hunter2' },
      'the credential must survive the upgrade unchanged'
    );

    for (const row of upgraded) {
      assert.equal(
        after.envelopeVersion(row.credentials_json),
        1,
        `${row.name} must be on the versioned envelope after the upgrade`
      );
    }

    assert.ok(fs.existsSync(saltPath), 'the upgrade seals under a salt, so one must exist');
  });
});
