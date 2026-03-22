const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-setup';

describe('Setup routes', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-setup.db');
  let app;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';

    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  function authCookie() {
    const token = jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    return `gameshelf_session=${token}`;
  }

  it('GET /api/setup/status should return 401 without auth', async () => {
    const res = await makeFetch(app, '/api/setup/status');
    assert.equal(res.status, 401);
  });

  it('GET /api/setup/status should return {complete: false} initially', async () => {
    const res = await makeFetch(app, '/api/setup/status', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.complete, false);
  });

  it('GET /api/setup/qr/:launcher_id should return 404 when no credentials stored', async () => {
    const res = await makeFetch(app, '/api/setup/qr/steam', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 404);
  });

  it('GET /api/setup/qr/:launcher_id should return URI when credentials with TOTP secret exist', async () => {
    // First, save credentials with a totp_secret via the launchers route
    await makeFetch(app, '/api/launchers/steam/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ api_key: 'test-key', steamid64: '12345', totp_secret: 'JBSWY3DPEHPK3PXP' }),
    });

    const res = await makeFetch(app, '/api/setup/qr/steam', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.uri.startsWith('otpauth://totp/'), 'Should return an otpauth URI');
    assert.ok(body.uri.includes('secret='), 'URI should contain the secret');
  });

  it('GET /api/setup/qr/:launcher_id should return 400 when no TOTP secret in credentials', async () => {
    // Save credentials without totp_secret for gog
    await makeFetch(app, '/api/launchers/gog/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'goguser', password: 'pass' }),
    });

    const res = await makeFetch(app, '/api/setup/qr/gog', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/setup/complete should mark setup as complete', async () => {
    const res = await makeFetch(app, '/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    // Verify status is now complete
    const statusRes = await makeFetch(app, '/api/setup/status', {
      headers: { Cookie: authCookie() },
    });
    const statusBody = await statusRes.json();
    assert.equal(statusBody.complete, true);
  });
});

function makeFetch(app, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${urlPath}`;
      fetch(url, options)
        .then(resolve)
        .catch(reject)
        .finally(() => server.close());
    });
  });
}
