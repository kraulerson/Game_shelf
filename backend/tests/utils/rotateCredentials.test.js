const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('rotateAllCredentials', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'rotate-credentials', 'test.db');
  const OLD_KEY = 'old]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  const NEW_KEY = 'new]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  let db;

  function cleanupDb() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  before(() => {
    cleanupDb();
    process.env.GAMESHELF_ENCRYPTION_KEY = OLD_KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    db = runMigrations(testDbPath);

    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt } = require('../../src/utils/encrypt');

    const insert = db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, ?, ?)'
    );
    insert.run('steam', 'Steam', 1, encrypt(JSON.stringify({ api_key: 'steam-key' })));
    insert.run('gog', 'GOG', 1, encrypt(JSON.stringify({ refresh_token: 'gog-token' })));
    // A launcher that was never configured — must be left alone, not counted.
    insert.run('ea', 'EA App', 0, null);
  });

  after(() => {
    if (db) db.close();
    cleanupDb();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('should re-seal every stored credential so the new key can read them', () => {
    const { rotateAllCredentials } = require('../../src/utils/rotateCredentials');

    const result = rotateAllCredentials(db, OLD_KEY, NEW_KEY);
    assert.equal(result.rotated, 2, 'both configured launchers should be rotated');
    assert.equal(result.skipped, 1, 'the launcher with no credentials should be skipped');

    process.env.GAMESHELF_ENCRYPTION_KEY = NEW_KEY;
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { decrypt } = require('../../src/utils/encrypt');

    const steam = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get('steam');
    assert.deepEqual(JSON.parse(decrypt(steam.credentials_json)), { api_key: 'steam-key' });

    const gog = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get('gog');
    assert.deepEqual(JSON.parse(decrypt(gog.credentials_json)), { refresh_token: 'gog-token' });

    const ea = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get('ea');
    assert.equal(ea.credentials_json, null, 'unconfigured launcher must be untouched');
  });
});

describe('rotateAllCredentials failure handling', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'rotate-rollback', 'test.db');
  const OLD_KEY = 'old]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  const NEW_KEY = 'new]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  const FOREIGN_KEY = 'fgn]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  let db;

  function cleanupDb() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  before(() => {
    cleanupDb();
    process.env.GAMESHELF_ENCRYPTION_KEY = OLD_KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    db = runMigrations(testDbPath);

    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt, rotate } = require('../../src/utils/encrypt');

    const insert = db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    );
    insert.run('steam', 'Steam', encrypt(JSON.stringify({ api_key: 'steam-key' })));
    // Sealed under a key that is neither the old nor the new one — stands in for a
    // corrupt blob or an operator supplying the wrong old key.
    insert.run('gog', 'GOG', rotate(encrypt('x'), OLD_KEY, FOREIGN_KEY));
  });

  after(() => {
    if (db) db.close();
    cleanupDb();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('should roll back every row when any single credential fails to rotate', () => {
    const { rotateAllCredentials } = require('../../src/utils/rotateCredentials');

    const before = db
      .prepare('SELECT name, credentials_json FROM launchers ORDER BY name')
      .all();

    assert.throws(
      () => rotateAllCredentials(db, OLD_KEY, NEW_KEY),
      'a credential that cannot be decrypted must abort the whole rotation'
    );

    const after = db
      .prepare('SELECT name, credentials_json FROM launchers ORDER BY name')
      .all();
    assert.deepEqual(after, before, 'no row may be left re-sealed after a failed rotation');
  });
});
