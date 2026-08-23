const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Saving credentials must not destroy fields the form did not send.
 *
 * The Setup form deliberately has no read-back of stored secrets, so after a page
 * reload it holds nothing. POSTing the fields the user retyped previously REPLACED
 * credentials_json wholesale, silently discarding everything absent from that request
 * — most damagingly the TOTP secret, which the user can never re-supply from the UI
 * because it is never shown to them again.
 */
describe('POST /api/launchers/:id/credentials preserves unsent fields', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'credential-merge', 'test.db');
  const saltPath = path.join(path.dirname(testDbPath), 'encryption-salt');
  const KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
  let app;
  let db;

  function cleanup() {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(saltPath)) fs.unlinkSync(saltPath);
  }

  before(() => {
    cleanup();
    process.env.GAMESHELF_ENCRYPTION_KEY = KEY;
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;

    for (const m of ['../../src/db/migrate', '../../src/utils/encrypt']) {
      delete require.cache[require.resolve(m)];
    }
    const { runMigrations } = require('../../src/db/migrate');
    db = runMigrations(testDbPath);

    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run(
      'ubisoft',
      'Ubisoft Connect',
      encrypt(JSON.stringify({ username: 'karl', password: 'old', totp_secret: 'JBSWY3DPEHPK3PXP' }))
    );

    const express = require('express');
    const cookieParser = require('cookie-parser');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.locals.db = db;
    app.use('/api/launchers', require('../../src/routes/launchers'));
  });

  after(() => {
    if (db) db.close();
    cleanup();
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete process.env.GAMESHELF_JWT_SECRET;
    delete process.env.GAMESHELF_DB_PATH;
  });

  function stored() {
    const { decrypt } = require('../../src/utils/encrypt');
    const row = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get('ubisoft');
    return JSON.parse(decrypt(row.credentials_json));
  }

  function authCookie() {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 1, username: 'admin' }, 'test-jwt', { expiresIn: '1h' });
    return `gameshelf_session=${token}`;
  }

  async function post(body) {
    // Wait for 'listening' before reading the address. listen() is asynchronous, so
    // reading server.address() straight after it can return null and produce a request
    // to port "undefined" that never resolves — which is exactly what happened when a
    // host argument was added and made the bind slower.
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();
    try {
      return await fetch(`http://127.0.0.1:${port}/api/launchers/ubisoft/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
        body: JSON.stringify(body),
      });
    } finally {
      server.close();
    }
  }

  it('keeps the stored TOTP secret when a reloaded form re-saves only username and password', async () => {
    // Exactly what a reloaded Setup page sends: the fields the user retyped, and
    // nothing else. The secret is not withheld deliberately — the UI cannot supply it.
    const res = await post({ username: 'karl', password: 'corrected' });
    assert.equal(res.status, 200);

    const after = stored();
    assert.equal(after.password, 'corrected', 'the edited field must be updated');
    assert.equal(
      after.totp_secret,
      'JBSWY3DPEHPK3PXP',
      'a field the form could not send must not be destroyed'
    );
  });

  it('treats an empty totp_secret as absent, not as a removal', async () => {
    // A blank input is what a reloaded form holds, what a browser autofill leaves
    // behind, and what a client that always sends every key produces. None of those
    // is a decision to destroy a secret the UI can never re-supply, so a value can
    // no longer mean removal at all.
    const res = await post({ username: 'karl', password: 'corrected', totp_secret: '' });
    assert.equal(res.status, 200);

    assert.equal(
      stored().totp_secret,
      'JBSWY3DPEHPK3PXP',
      'an empty value must leave the stored secret alone'
    );
  });

  it('destroys nothing when sent a whole bundle of empty fields', async () => {
    // The shape a client sends when it posts its entire form state regardless of what
    // the user touched. Every key is present; every value is empty.
    const res = await post({
      username: 'karl',
      password: 'corrected',
      api_key: '',
      steamid64: '',
      totp_secret: '',
      auth_code: '',
      session_cookie: '',
    });
    assert.equal(res.status, 200);

    const after = stored();
    assert.equal(after.totp_secret, 'JBSWY3DPEHPK3PXP', 'the secret must survive');
    assert.equal(after.username, 'karl', 'and so must every other stored field');
    assert.equal(after.password, 'corrected');
  });

  it('accepts a removal on its own, which is all a reloaded form can send', async () => {
    // The state unticking is actually done from: the page was reloaded, so the form
    // holds no password to send. Demanding the fields required to CREATE a credential
    // made the removal impossible from the only state it ever happens in — the route
    // answered 400 and the secret stayed.
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(
      encrypt(JSON.stringify({ username: 'karl', password: 'p', totp_secret: 'JBSWY3DPEHPK3PXP' })),
      'ubisoft'
    );

    const res = await post({ remove_totp_secret: true });
    assert.equal(res.status, 200);

    const after = stored();
    assert.ok(!after.totp_secret, 'the secret must be gone');
    assert.equal(after.username, 'karl', 'and everything else must survive');
    assert.equal(after.password, 'p');
  });

  it('does not re-enable a disabled launcher', async () => {
    // The save path upserts with enabled = 1, which is right for a save and wrong for
    // a removal: taking one field away is not a decision to turn the launcher back on.
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare('UPDATE launchers SET credentials_json = ?, enabled = 0 WHERE name = ?').run(
      encrypt(JSON.stringify({ username: 'karl', password: 'p', totp_secret: 'JBSWY3DPEHPK3PXP' })),
      'ubisoft'
    );

    const res = await post({ remove_totp_secret: true });
    assert.equal(res.status, 200);

    const row = db.prepare('SELECT enabled FROM launchers WHERE name = ?').get('ubisoft');
    assert.equal(row.enabled, 0, 'a removal must not turn the launcher back on');
    assert.ok(!stored().totp_secret, 'and must still do what it was asked');
  });

  it('refuses a removal when there is nothing stored to remove from', async () => {
    // Otherwise a removal-only request creates a launcher row holding an empty
    // credential, which then reports itself as configured.
    db.prepare('UPDATE launchers SET credentials_json = NULL WHERE name = ?').run('ubisoft');

    const res = await post({ remove_totp_secret: true });
    assert.equal(res.status, 404);

    const row = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get('ubisoft');
    assert.equal(row.credentials_json, null, 'and nothing may be created');
  });

  it('ignores a totp_secret that is not a string', async () => {
    // [] and {} are truthy, so they were stored verbatim over the real secret — a
    // request field VALUE destroying a credential, which is the thing this contract
    // forbids. Worse than a plain overwrite: totp_configured still reports true, so
    // the UI shows 2FA configured while code generation throws.
    const { encrypt } = require('../../src/utils/encrypt');

    // ' ' and '\t\n' are strings, so a type check alone lets them through — and they
    // are as destructive as an array: totp_configured reads !!totp_secret, so ' ' still
    // reports 2FA as configured, while code generation either returns a code that can
    // never authenticate or throws on an invalid character.
    for (const hostile of [[], {}, 42, true, ' ', '\t\n', '   ']) {
      db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(
        encrypt(JSON.stringify({ username: 'karl', password: 'p', totp_secret: 'JBSWY3DPEHPK3PXP' })),
        'ubisoft'
      );

      const res = await post({ username: 'karl', password: 'p', totp_secret: hostile });
      assert.equal(res.status, 200);
      assert.equal(
        stored().totp_secret,
        'JBSWY3DPEHPK3PXP',
        `a ${JSON.stringify(hostile)} secret must be ignored, not stored`
      );
    }
  });

  it('removes the TOTP secret when asked with the explicit verb', async () => {
    // Re-seal a known secret rather than relying on the tests above having left one:
    // an ordering change would otherwise turn this into a test that passes because
    // the secret was already gone.
    const { encrypt } = require('../../src/utils/encrypt');
    db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(
      encrypt(JSON.stringify({ username: 'karl', password: 'corrected', totp_secret: 'JBSWY3DPEHPK3PXP' })),
      'ubisoft'
    );

    // Removal stays possible, but it needs a verb rather than a value. There is no
    // shape a form can accidentally take that spells remove_totp_secret: true.
    const res = await post({ username: 'karl', password: 'corrected', remove_totp_secret: true });
    assert.equal(res.status, 200);

    assert.ok(!stored().totp_secret, 'the verb must actually remove it');
    assert.equal(stored().username, 'karl', 'and must remove only what it names');
  });
});
