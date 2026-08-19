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

  it('should no longer expose a QR endpoint that reads a stored TOTP secret back', async () => {
    // Store credentials that DO contain a totp_secret, so the only reason a request
    // can fail is that the route is gone — not that there was nothing to return.
    await makeFetch(app, '/api/launchers/steam/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ api_key: 'test-key', steamid64: '12345', totp_secret: 'JBSWY3DPEHPK3PXP' }),
    });

    const res = await makeFetch(app, '/api/setup/qr/steam', {
      headers: { Cookie: authCookie() },
    });

    assert.equal(res.status, 404, 'the secret read-back route must not exist');
    const body = await res.text();
    assert.ok(
      !body.includes('JBSWY3DPEHPK3PXP'),
      'no response from this path may ever contain the stored TOTP secret'
    );
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
