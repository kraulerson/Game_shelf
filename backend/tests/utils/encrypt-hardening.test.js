const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

describe('envelope parsing rejects malformed blobs cleanly', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'encrypt-hardening', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  function fresh() {
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
    return require('../../src/utils/encrypt');
  }

  const envelope = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

  after(() => {
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('reports a missing auth tag as an unreadable envelope, not a raw TypeError', () => {
    const { decrypt } = fresh();
    const noTag = envelope({ v: 1, kid: 'deadbeef', iv: '00'.repeat(12), data: 'ab' });

    assert.throws(
      () => decrypt(noTag),
      /not a readable envelope/,
      'a blob missing its tag must give the envelope error, not Buffer.from(undefined)'
    );
  });

  it('rejects a non-numeric version instead of claiming it cannot read version 1', () => {
    const { decrypt } = fresh();
    const stringVersion = envelope({
      v: '1',
      kid: 'deadbeef',
      iv: '00'.repeat(12),
      tag: '00'.repeat(16),
      data: 'ab',
    });

    assert.throws(
      () => decrypt(stringVersion),
      (err) =>
        !/uses envelope version 1, which this build cannot read/.test(err.message),
      'saying "cannot read version 1" names the version this build DOES read'
    );
  });
});

describe('salt handling refuses to silently orphan existing credentials', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'salt-guard', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  function cleanup() {
    for (const f of [testDbPath, testDbPath + '-wal', testDbPath + '-shm', saltPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    delete require.cache[require.resolve('../../src/utils/rotateCredentials')];
    delete require.cache[require.resolve('../../src/db/migrate')];
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

  it('refuses to mint a fresh salt when salted credentials already exist', () => {
    cleanup();
    const { runMigrations } = require('../../src/db/migrate');
    let db = runMigrations(testDbPath);
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', encrypt(JSON.stringify({ token: 'x' })));
    db.close();

    assert.ok(fs.existsSync(saltPath), 'sealing should have created a salt');

    // The operator restores gameshelf.db from backup but not the salt beside it, or
    // attaches a fresh volume. Minting a new salt makes every stored credential
    // undecryptable while the app reports itself healthy — and destroys the one clue
    // pointing at the file they still have in backup.
    fs.unlinkSync(saltPath);
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    delete require.cache[require.resolve('../../src/utils/rotateCredentials')];
    delete require.cache[require.resolve('../../src/db/migrate')];

    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    let boot;
    try {
      const { runMigrations: run2 } = require('../../src/db/migrate');
      assert.doesNotThrow(() => {
        boot = run2(testDbPath);
      }, 'a missing salt must not crash-loop the container');
    } finally {
      console.error = realError;
      if (boot) boot.close();
    }

    assert.ok(
      errors.some((line) => /salt/i.test(line) && /backup|restore|missing/i.test(line)),
      'boot must say the salt was missing and point at the backup, not just ' +
        `report generic decrypt failures. Got: ${JSON.stringify(errors)}`
    );
  });
});

describe('startup re-seal survives a broken salt file', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'salt-unreadable', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  function cleanup() {
    for (const f of [testDbPath, testDbPath + '-wal', testDbPath + '-shm']) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) {
      fs.chmodSync(saltPath, 0o600);
      fs.unlinkSync(saltPath);
    }
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    delete require.cache[require.resolve('../../src/utils/rotateCredentials')];
    delete require.cache[require.resolve('../../src/db/migrate')];
  }

  before(() => cleanup());

  after(() => {
    cleanup();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('does not crash the boot when the salt file cannot be read', () => {
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    const { runMigrations } = require('../../src/db/migrate');
    let db = runMigrations(testDbPath);
    const legacyKey = crypto.createHash('sha256').update(KEY).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
    let data = cipher.update('{"t":"x"}', 'utf8', 'hex');
    data += cipher.final('hex');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run(
      'gog',
      'GOG',
      Buffer.from(
        JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data })
      ).toString('base64')
    );
    db.close();

    // Salt unreadable: the exact state left by running the rotation script as root
    // inside the container, which creates the 0600 salt owned by root while the app
    // runs as `node`. Key derivation then throws from inside the row loop.
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    fs.writeFileSync(saltPath, crypto.randomBytes(32), { mode: 0o000 });

    delete require.cache[require.resolve('../../src/utils/encrypt')];
    delete require.cache[require.resolve('../../src/utils/rotateCredentials')];
    delete require.cache[require.resolve('../../src/db/migrate')];

    const { runMigrations: run2 } = require('../../src/db/migrate');
    let boot;
    assert.doesNotThrow(() => {
      boot = run2(testDbPath);
    }, 'an unreadable salt must be reported, not turned into an endless restart loop');
    if (boot) boot.close();
  });
});
