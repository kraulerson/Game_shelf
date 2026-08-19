const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'rotate-encryption-key.js');

describe('scripts/rotate-encryption-key.js', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-rotate-script.db');
  const OLD_KEY = 'old]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  const NEW_KEY = 'new]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  function cleanupDb() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  function seedDb() {
    cleanupDb();
    process.env.GAMESHELF_ENCRYPTION_KEY = OLD_KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('steam', 'Steam', encrypt(JSON.stringify({ api_key: 'steam-key' })));
    db.close();
  }

  function readStoredBlob() {
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    const row = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get('steam');
    db.close();
    return row.credentials_json;
  }

  function runScript(env) {
    return spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, GAMESHELF_DB_PATH: testDbPath, ...env },
    });
  }

  beforeEach(() => seedDb());

  after(() => {
    cleanupDb();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('re-seals stored credentials under the new key and reports the count', () => {
    const result = runScript({
      GAMESHELF_ENCRYPTION_KEY: OLD_KEY,
      GAMESHELF_ENCRYPTION_KEY_NEW: NEW_KEY,
    });

    assert.equal(result.status, 0, `expected success, got:\n${result.stderr}`);
    assert.match(result.stdout, /1/, 'should report how many credentials were rotated');

    // The stored blob must now open under the NEW key.
    process.env.GAMESHELF_ENCRYPTION_KEY = NEW_KEY;
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { decrypt } = require('../../src/utils/encrypt');
    assert.deepEqual(JSON.parse(decrypt(readStoredBlob())), { api_key: 'steam-key' });
  });

  it('refuses to run and changes nothing when the new key is not supplied', () => {
    const before = readStoredBlob();

    const result = runScript({
      GAMESHELF_ENCRYPTION_KEY: OLD_KEY,
      GAMESHELF_ENCRYPTION_KEY_NEW: '',
    });

    assert.notEqual(result.status, 0, 'missing new key must be a non-zero exit');
    assert.match(
      `${result.stderr}${result.stdout}`,
      /GAMESHELF_ENCRYPTION_KEY_NEW/,
      'must name the variable the operator has to set'
    );
    assert.equal(readStoredBlob(), before, 'nothing may be written when the input is rejected');
  });

  it('refuses a new key that is too short, leaving the store untouched', () => {
    const before = readStoredBlob();

    const result = runScript({
      GAMESHELF_ENCRYPTION_KEY: OLD_KEY,
      GAMESHELF_ENCRYPTION_KEY_NEW: 'tooshort',
    });

    assert.notEqual(result.status, 0, 'a weak new key must be a non-zero exit');
    assert.equal(readStoredBlob(), before, 'nothing may be written when the input is rejected');
  });
});
