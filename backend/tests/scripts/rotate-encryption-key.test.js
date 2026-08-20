const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'rotate-encryption-key.js');

describe('scripts/rotate-encryption-key.js', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'rotate-script', 'test.db');
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

  it('counts only credentials it actually opened', async () => {
    // A row holding an empty string is NOT NULL, so it reached the verification set,
    // and it is not a corrupt envelope either — so it was subtracted from nothing and
    // reported as having re-opened under the new key without ever being opened. On the
    // one tool whose selling point is "it verifies before you discard the old key",
    // an inflated count is the worst possible defect.
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    db.prepare(
      "INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES ('gog', 'GOG', 1, '')"
    ).run();
    db.close();

    const result = runScript({ GAMESHELF_ENCRYPTION_KEY: OLD_KEY, GAMESHELF_ENCRYPTION_KEY_NEW: NEW_KEY });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Verified: 1 stored credential/,
      `only the one real credential was opened. Got:\n${result.stdout}`
    );
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

  it('refuses a weak new key even when there is nothing to rotate', () => {
    // Fresh install, or credentials just deleted: rotateAllCredentials never reaches
    // rotate(), so the length check never ran. The script reported success and told
    // the operator to adopt a key the app then dies on at boot.
    const Database = require('better-sqlite3');
    const db = new Database(testDbPath);
    db.prepare('UPDATE launchers SET credentials_json = NULL').run();
    db.close();

    const result = runScript({
      GAMESHELF_ENCRYPTION_KEY: OLD_KEY,
      GAMESHELF_ENCRYPTION_KEY_NEW: 'tooshort',
    });

    assert.notEqual(result.status, 0, 'a weak new key must fail even with no rows to rotate');
    assert.match(
      `${result.stderr}${result.stdout}`,
      /32/,
      'the operator must be told why, before they adopt the key'
    );
  });


  it('reports a missing database instead of silently creating an empty one', () => {
    // Verified behaviour before the fix: better-sqlite3 creates the file, then the
    // script reports "no such table: launchers" — telling the operator their schema
    // is broken during the one operation where they already fear losing every
    // credential. And with GAMESHELF_DB_PATH unset it defaults to a CWD-relative
    // path, so running the documented command from the wrong directory does this.
    const missing = path.join(__dirname, '..', 'data', 'rotate-script', 'definitely-absent.db');
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(missing + suffix)) fs.unlinkSync(missing + suffix);
    }

    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GAMESHELF_DB_PATH: missing,
        GAMESHELF_ENCRYPTION_KEY: OLD_KEY,
        GAMESHELF_ENCRYPTION_KEY_NEW: NEW_KEY,
      },
    });

    assert.notEqual(result.status, 0, 'a missing database must be a non-zero exit');
    assert.match(
      `${result.stderr}${result.stdout}`,
      /not found|does not exist/i,
      'the operator must be told the database is missing, not that the schema is wrong'
    );
    assert.ok(!fs.existsSync(missing), 'no stray empty database may be created');
  });

});
