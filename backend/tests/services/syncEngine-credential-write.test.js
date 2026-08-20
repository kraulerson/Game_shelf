const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

/**
 * A sync's credential write happens AFTER a network round-trip, using a copy of the
 * store read before it. Anything the operator does in those seconds — correcting a
 * password, removing the launcher — is inside the window, and the write lands on top
 * of it with values already known to be stale.
 *
 * .env.example warns about exactly this for key rotation ("stop the app first"). The
 * same window exists for ordinary saves, where there is nothing to stop.
 */
describe('Sync engine — the credential write reads what is stored now', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'sync-credential-write', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const STORED = { username: 'karl', password: 'old', totp_secret: 'JBSWY3DPEHPK3PXP' };

  let db;
  let syncLauncher;
  let encrypt, decrypt;
  let duringRefresh = null;

  // Shaped like the real Ubisoft launcher, which is the one this matters for: it is
  // handed the credentials, and it puts the username and password it was given
  // straight back into updatedCredentials alongside the tokens it actually refreshed.
  // A fake whose overlay shares no field with the store proves nothing about a merge.
  class FakeLauncher {
    async refreshIfNeeded(credentials) {
      // Yield the way a real network call does. Everything the operator can do to
      // the store happens in here.
      await Promise.resolve();
      if (duringRefresh) duringRefresh();
      return {
        session: { ok: true },
        updatedCredentials: {
          username: credentials.username,
          password: credentials.password,
          token: 'refreshed',
        },
      };
    }

    async fetchOwnedGames() {
      return [];
    }
  }

  function cleanup() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
  }

  before(() => {
    cleanup();
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;

    for (const m of ['../../src/db/migrate', '../../src/utils/encrypt', '../../src/services/syncEngine']) {
      delete require.cache[require.resolve(m)];
    }
    db = require('../../src/db/migrate').runMigrations(testDbPath);
    ({ encrypt, decrypt } = require('../../src/utils/encrypt'));
    ({ syncLauncher } = require('../../src/services/syncEngine'));

    // Same object the engine destructured at load, so assigning a key reaches it.
    require('../../src/services/launchers').LAUNCHER_CLASSES.ubisoft = FakeLauncher;

    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('ubisoft', 'Ubisoft Connect', encrypt(JSON.stringify(STORED)));
  });

  after(() => {
    if (db) db.close();
    cleanup();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_JWT_SECRET;
    delete process.env.GAMESHELF_DB_PATH;
  });

  beforeEach(() => {
    duringRefresh = null;
    db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(
      encrypt(JSON.stringify(STORED)),
      'ubisoft'
    );
  });

  function stored() {
    const row = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get('ubisoft');
    return row.credentials_json === null ? null : JSON.parse(decrypt(row.credentials_json));
  }

  it('does not undo a save that landed while it was on the network', async () => {
    duringRefresh = () => {
      db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(
        encrypt(JSON.stringify({ ...STORED, password: 'corrected' })),
        'ubisoft'
      );
    };

    await syncLauncher('ubisoft', db);

    const after = stored();
    assert.equal(after.password, 'corrected', "the operator's save must survive the sync");
    assert.equal(after.token, 'refreshed', 'and the refreshed token must still be stored');
    assert.equal(after.totp_secret, STORED.totp_secret, 'and untouched fields must be untouched');
  });

  it('does not resurrect credentials that were removed while it was on the network', async () => {
    duringRefresh = () => {
      db.prepare('UPDATE launchers SET credentials_json = NULL WHERE name = ?').run('ubisoft');
    };

    await syncLauncher('ubisoft', db);

    assert.equal(stored(), null, 'a removal must not be undone by a sync already in flight');
  });

  it('lets a field the launcher genuinely refreshed win over a concurrent save of it', async () => {
    // The other half of the rule, and the one that stops "prefer the store" being the
    // fix. A token the launcher just refreshed is newer than anything a form wrote a
    // moment earlier, so it must win — deferring to the store there would persist a
    // token already known to be spent.
    duringRefresh = () => {
      db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(
        encrypt(JSON.stringify({ ...STORED, token: 'written-by-a-form' })),
        'ubisoft'
      );
    };

    await syncLauncher('ubisoft', db);

    assert.equal(stored().token, 'refreshed', 'the launcher owns the field it refreshed');
  });

  it('still persists a refreshed token when nothing else touched the store', async () => {
    await syncLauncher('ubisoft', db);

    const after = stored();
    assert.equal(after.token, 'refreshed');
    assert.equal(after.password, 'old');
  });
});
