const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * The boot probe reports what will not open, and quotes why. It does not narrate.
 *
 * Earlier revisions asserted a cause — "the salt is missing" — that a bare GCM failure
 * cannot distinguish from "the key changed", and got it wrong in both directions: a
 * raw-key install was told to restore a salt that never existed, and a genuinely lost
 * salt was reported only if a v0 blob happened to coexist.
 *
 * Since step 1 the underlying error self-identifies (SaltMissingError names the file;
 * a wrong key gives the GCM message), so the probe's whole job is to surface it
 * per launcher and stay out of the way.
 */
describe('boot credential probe', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'boot-probe', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  const OTHER = 'zzz]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN';

  function reset() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
    dropModules();
  }

  function dropModules() {
    for (const m of [
      '../../src/db/migrate',
      '../../src/utils/encrypt',
      '../../src/utils/rotateCredentials',
    ]) {
      delete require.cache[require.resolve(m)];
    }
  }

  function bootErrors() {
    dropModules();
    const errors = [];
    const real = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    let db;
    try {
      db = require('../../src/db/migrate').runMigrations(testDbPath);
    } finally {
      console.error = real;
      if (db) db.close();
    }
    return errors;
  }

  function seed(launchers) {
    reset();
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    const db = require('../../src/db/migrate').runMigrations(testDbPath);
    const { encrypt } = require('../../src/utils/encrypt');
    const insert = db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    );
    for (const name of launchers) insert.run(name, name, encrypt(JSON.stringify({ t: name })));
    db.close();
  }

  after(() => {
    reset();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_DB_PATH;
  });

  it('names the missing salt file, taken from the error rather than guessed', () => {
    seed(['gog']);
    fs.unlinkSync(saltPath);

    const errors = bootErrors();

    assert.ok(
      errors.some((l) => l.includes(saltPath)),
      `the report must quote the path the error names. Got: ${JSON.stringify(errors)}`
    );
    assert.ok(
      !fs.existsSync(saltPath),
      'and reporting must still not create it'
    );
  });

  it('quotes the authentication failure when the key changed', () => {
    seed(['epic']);
    process.env.GAMESHELF_ENCRYPTION_KEY = OTHER;

    const errors = bootErrors();

    assert.ok(
      errors.some((l) => /unable to authenticate|unsupported state/i.test(l)),
      `the report must quote the underlying failure. Got: ${JSON.stringify(errors)}`
    );
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
  });

  it('reports each unreadable launcher on its own line', () => {
    seed(['gog', 'epic', 'ubisoft']);
    process.env.GAMESHELF_ENCRYPTION_KEY = OTHER;

    const errors = bootErrors();

    for (const name of ['gog', 'epic', 'ubisoft']) {
      assert.ok(
        // The line naming the launcher must also carry the reason. An aggregate
        // "3 credentials cannot be decrypted: gog, epic, ubisoft" satisfies a
        // name-only check while telling the operator nothing about any of them.
        errors.some((l) => l.includes(name) && /unable to authenticate|unsupported state/i.test(l)),
        `${name} must have its own line carrying the reason. Got: ${JSON.stringify(errors)}`
      );
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
  });

  it('says nothing at all when every credential opens', () => {
    seed(['gog']);

    assert.deepEqual(bootErrors(), [], 'a healthy install must boot silently');
  });

  it('reports a stored value that is not an envelope at all', () => {
    reset();
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    const db = require('../../src/db/migrate').runMigrations(testDbPath);
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('humble', 'Humble', 'not-an-envelope');
    db.close();

    const errors = bootErrors();

    assert.ok(
      errors.some((l) => l.includes('humble')),
      `corruption is a fault too and must be named. Got: ${JSON.stringify(errors)}`
    );
  });

  it('is silent on a declared raw key with no salt file anywhere', () => {
    reset();
    process.env.GAMESHELF_ENCRYPTION_KEY = 'hex:' + crypto.randomBytes(32).toString('hex');
    process.env.GAMESHELF_DB_PATH = testDbPath;
    const db = require('../../src/db/migrate').runMigrations(testDbPath);
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('steam', 'Steam', encrypt(JSON.stringify({ api_key: 'k' })));
    db.close();

    // Raw keys skip the KDF entirely, so no salt exists and none is needed — the
    // configuration .env.example calls "Preferred". An earlier version reported a
    // missing salt here on every single boot and skipped the real check.
    const errors = bootErrors();

    assert.deepEqual(errors, [], `raw-key installs must boot silently. Got: ${JSON.stringify(errors)}`);
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
  });
});
