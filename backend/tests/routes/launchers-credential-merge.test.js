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
    const server = app.listen(0);
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

  it('clears a field when the client explicitly sends it empty', async () => {
    // Unticking the TOTP checkbox is a deliberate action with the field on screen, so
    // the client can say so explicitly. That is how removal stays possible without
    // making absence mean removal.
    const res = await post({ username: 'karl', password: 'corrected', totp_secret: '' });
    assert.equal(res.status, 200);

    assert.ok(!stored().totp_secret, 'an explicitly emptied field must be removed');
  });
});
