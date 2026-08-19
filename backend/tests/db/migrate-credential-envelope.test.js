const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

describe('credential envelope migration', () => {
  // Own subdirectory — see the note in tests/utils/encrypt.test.js.
  const testDbPath = path.join(__dirname, '..', 'data', 'envelope-migration', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  function cleanup() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
  }

  // A blob exactly as older releases wrote it: unsalted SHA-256 key, no version field.
  function sealLegacy(plaintext) {
    const legacyKey = crypto.createHash('sha256').update(KEY).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
    let data = cipher.update(plaintext, 'utf8', 'hex');
    data += cipher.final('hex');
    return Buffer.from(JSON.stringify({
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data,
    })).toString('base64');
  }

  before(() => {
    cleanup();
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;
  });

  after(() => {
    cleanup();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('re-seals pre-versioned credentials on startup and leaves them readable', () => {
    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');

    // First run builds the schema. Then plant a legacy blob, as an existing
    // production database would already contain.
    let db = runMigrations(testDbPath);
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('ubisoft', 'Ubisoft Connect', sealLegacy(JSON.stringify({ password: 'hunter2' })));
    db.close();

    // Second run is the upgrade path a real deployment takes.
    db = runMigrations(testDbPath);
    const stored = db
      .prepare('SELECT credentials_json FROM launchers WHERE name = ?')
      .get('ubisoft').credentials_json;
    db.close();

    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { decrypt, isLegacyEnvelope } = require('../../src/utils/encrypt');

    assert.equal(isLegacyEnvelope(stored), false, 'blob should have been upgraded to the versioned envelope');
    assert.deepEqual(
      JSON.parse(decrypt(stored)),
      { password: 'hunter2' },
      'the credential must survive the upgrade unchanged'
    );
  });
});
