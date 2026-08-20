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

  it('keeps reporting a lost salt on every boot, with no stored flag to go stale', () => {
    cleanup();
    const { runMigrations } = require('../../src/db/migrate');
    let db = runMigrations(testDbPath);
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', encrypt(JSON.stringify({ token: 'x' })));
    db.close();

    assert.ok(fs.existsSync(saltPath), 'sealing should have created a salt');

    // The operator restores gameshelf.db from backup but not the salt beside it.
    fs.unlinkSync(saltPath);

    function bootErrors() {
      for (const m of [
        '../../src/utils/encrypt',
        '../../src/utils/rotateCredentials',
        '../../src/db/migrate',
      ]) {
        delete require.cache[require.resolve(m)];
      }
      const errors = [];
      const real = console.error;
      console.error = (...a) => errors.push(a.join(' '));
      let boot;
      try {
        const { runMigrations: run } = require('../../src/db/migrate');
        assert.doesNotThrow(() => {
          boot = run(testDbPath);
        }, 'a missing salt must not crash-loop the container');
      } finally {
        console.error = real;
        if (boot) boot.close();
      }
      return errors;
    }

    const first = bootErrors();
    assert.ok(
      first.some((l) => /cannot be decrypted/i.test(l)),
      `first boot must report it. Got: ${JSON.stringify(first)}`
    );

    // And again. Warning once was useless: the act of warning minted a salt, so the
    // file existed next boot and the warning never fired again while the credentials
    // stayed unreadable. A stored marker fixed that but never self-cleared, leaving
    // the operator to hand-edit SQLite. A live check does both.
    const second = bootErrors();
    assert.ok(
      second.some((l) => /cannot be decrypted/i.test(l)),
      'the report must survive the restart that used to erase it'
    );
    assert.ok(
      second.some((l) => /key/i.test(l) && /salt/i.test(l)),
      'and must name both possible causes, since a failed decrypt cannot separate them'
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
      if (fs.statSync(saltPath).isDirectory()) fs.rmSync(saltPath, { recursive: true });
      else fs.unlinkSync(saltPath);
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

    // Salt unreadable: the state left by running the rotation script as root inside
    // the container, which creates the 0600 salt owned by root while the app runs as
    // `node`. Key derivation then throws from inside the row loop.
    //
    // A directory where the salt path is occupied by a directory reproduces the EISDIR
    // failure for every user, including root — chmod 0o000 is a no-op as root, so a
    // permissions-based version of this test would pass trivially in the container CI
    // most likely to run it.
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    fs.mkdirSync(saltPath, { recursive: true });

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

describe('key material is never guessed from shape', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'key-mode', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');

  function withKey(key) {
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    process.env.GAMESHELF_ENCRYPTION_KEY = key;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
    return require('../../src/utils/encrypt');
  }

  after(() => {
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('treats a human passphrase as a passphrase even at raw-key length', () => {
    // .env.example's own placeholder is 43 chars, matches the base64url alphabet, and
    // decodes to exactly 32 bytes — so shape-sniffing used this low-entropy English
    // string verbatim as the AES-256 key with the KDF skipped entirely. Worse than
    // the unsalted SHA-256 this work set out to replace.
    const mod = withKey('change_this_to_a_random_32_plus_char_string');

    assert.equal(
      mod.derivationMode(),
      'scrypt',
      'an unprefixed value must be stretched, whatever its length or alphabet'
    );
    mod.encrypt('x');
    assert.ok(fs.existsSync(saltPath), 'the passphrase path must actually use a salt');
  });

  it('uses a raw key only when it is explicitly declared', () => {
    const raw = 'hex:' + 'ab'.repeat(32);
    const mod = withKey(raw);

    assert.equal(mod.derivationMode(), 'raw', 'an explicit prefix selects raw key material');
    mod.encrypt('x');
    assert.ok(!fs.existsSync(saltPath), 'raw keys need no salt');
  });

  it('rejects a declared raw key that is not the right size', () => {
    assert.throws(
      () => withKey('hex:' + 'ab'.repeat(20)),
      /32 bytes|64 hex/i,
      'a malformed declared key must fail loudly, not fall back to treating it as text'
    );
  });
});

describe('declared raw keys are validated by round-trip, not just length', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'key-roundtrip', 'test.db');

  function withKey(key) {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    process.env.GAMESHELF_ENCRYPTION_KEY = key;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
    return require('../../src/utils/encrypt');
  }

  after(() => {
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('rejects a hex key with trailing junk instead of silently truncating it', () => {
    // Buffer.from(...,'hex') stops at the first invalid character and returns 32 bytes,
    // so this passes an exact-length check while being a different key than intended.
    assert.throws(() => withKey('hex:' + '00'.repeat(32) + 'zzzz'), /hex|decode/i);
  });

  it('rejects a base64 key whose final character was altered in transit', () => {
    // Still decodes to exactly 32 bytes, so a length check passes — but they are
    // DIFFERENT bytes. The app boots clean, seals everything under the wrong key, and
    // the mistake surfaces only when the operator tries to restore from the value
    // they believe they saved. The canonical encoding of these bytes ends 'jig=',
    // not 'jij='.
    assert.throws(
      () => withKey('base64:cd4NS+E5vMKJa7Zdo+FAKvxuaGPFWnTSHbxioWPyjij='),
      /base64|dropped|not valid/i
    );
  });

  it('accepts a correctly encoded declared key', () => {
    const key = crypto.randomBytes(32);
    assert.doesNotThrow(() => withKey('hex:' + key.toString('hex')));
    assert.doesNotThrow(() => withKey('base64:' + key.toString('base64')));
  });
});

describe('boot reports unreadable credentials without guessing the cause', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'boot-diagnosis', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  const OTHER = 'zzz]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN';

  function reset() {
    for (const f of [testDbPath, testDbPath + '-wal', testDbPath + '-shm']) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    for (const m of ['../../src/utils/encrypt', '../../src/utils/rotateCredentials', '../../src/db/migrate']) {
      delete require.cache[require.resolve(m)];
    }
  }

  function bootCapturingErrors(dbPath) {
    const errors = [];
    const real = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    let db;
    try {
      const { runMigrations } = require('../../src/db/migrate');
      db = runMigrations(dbPath);
    } finally {
      console.error = real;
      if (db) db.close();
    }
    return errors;
  }

  after(() => {
    reset();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('reports credentials it cannot open after the key is changed, with everything already upgraded', () => {
    // The commonest operator mistake, in the steady state this PR creates: all blobs
    // are v1 and the salt is present, so neither the salt-lost branch nor the re-seal
    // branch fires. The app booted with a clean log and a healthy /api/health while
    // every sync failed — the exact silence this work exists to remove.
    reset();
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', encrypt(JSON.stringify({ token: 'x' })));
    db.close();

    // Key changed without rotating. Salt untouched, everything already v1.
    for (const m of ['../../src/utils/encrypt', '../../src/utils/rotateCredentials', '../../src/db/migrate']) {
      delete require.cache[require.resolve(m)];
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = OTHER;

    const errors = bootCapturingErrors(testDbPath);

    assert.ok(
      errors.some((l) => /cannot be (read|decrypted)|unreadable/i.test(l)),
      `boot must report unreadable credentials. Got: ${JSON.stringify(errors)}`
    );
    assert.ok(
      errors.some((l) => /key/i.test(l) && /salt/i.test(l)),
      'it must name BOTH possible causes rather than asserting one it cannot distinguish'
    );
  });

  it('says nothing when every credential opens normally', () => {
    reset();
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', encrypt(JSON.stringify({ token: 'x' })));
    db.close();

    for (const m of ['../../src/utils/encrypt', '../../src/utils/rotateCredentials', '../../src/db/migrate']) {
      delete require.cache[require.resolve(m)];
    }

    const errors = bootCapturingErrors(testDbPath);

    assert.deepEqual(errors, [], 'a healthy install must boot silently');
  });

  it('stops warning once the credentials are readable again, with no manual cleanup', () => {
    // A stored marker could not do this: the operator recovered and the banner kept
    // firing until they hand-edited SQLite on a production volume.
    reset();
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;

    const { runMigrations } = require('../../src/db/migrate');
    let db = runMigrations(testDbPath);
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', encrypt(JSON.stringify({ token: 'x' })));
    db.close();

    for (const m of ['../../src/utils/encrypt', '../../src/utils/rotateCredentials', '../../src/db/migrate']) {
      delete require.cache[require.resolve(m)];
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = OTHER;
    assert.ok(bootCapturingErrors(testDbPath).length > 0, 'should warn while broken');

    // Operator restores the correct key.
    for (const m of ['../../src/utils/encrypt', '../../src/utils/rotateCredentials', '../../src/db/migrate']) {
      delete require.cache[require.resolve(m)];
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;

    assert.deepEqual(
      bootCapturingErrors(testDbPath),
      [],
      'the warning must clear itself when the problem is actually fixed'
    );
  });
});

describe('declared base64 keys accept every legitimate encoding', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'key-b64', 'test.db');

  function withKey(key) {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    process.env.GAMESHELF_ENCRYPTION_KEY = key;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
    return require('../../src/utils/encrypt');
  }

  after(() => {
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  const key = crypto.randomBytes(32);

  it('accepts padded base64', () => {
    assert.doesNotThrow(() => withKey('base64:' + key.toString('base64')));
  });

  it('accepts unpadded base64 — what `openssl rand -base64 32 | tr -d =` produces', () => {
    // The round-trip check re-added padding and then declared the input truncated, so
    // the app refused to boot and told the operator to hunt a corruption that did not
    // exist. server.js turns that throw into a FATAL exit.
    assert.doesNotThrow(() => withKey('base64:' + key.toString('base64').replace(/=+$/, '')));
  });

  it('accepts base64url, which decodes to byte-identical material', () => {
    assert.doesNotThrow(() => withKey('base64:' + key.toString('base64url')));
  });

  it('still rejects a key whose characters were genuinely altered', () => {
    assert.throws(
      () => withKey('base64:cd4NS+E5vMKJa7Zdo+FAKvxuaGPFWnTSHbxioWPyjij='),
      /not valid|dropped/i
    );
  });

  it('derives the same key from all three encodings of the same bytes', () => {
    const a = withKey('base64:' + key.toString('base64')).encrypt('x');
    const modB = withKey('base64:' + key.toString('base64').replace(/=+$/, ''));
    assert.equal(modB.decrypt(a), 'x', 'padding must not change the derived key');

    const modC = withKey('base64:' + key.toString('base64url'));
    assert.equal(modC.decrypt(a), 'x', 'base64url must not change the derived key');
  });
});
