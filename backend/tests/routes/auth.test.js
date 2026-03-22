const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Auth routes', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-auth.db');
  let app;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt-secret-auth';
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

  it('POST /api/auth/login should return username and set cookie on valid credentials', async () => {
    const res = await makeFetch(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'changeme123' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, 'admin');

    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Should set a cookie');
    assert.ok(setCookie.includes('gameshelf_session='), 'Cookie should be named gameshelf_session');
    assert.ok(setCookie.includes('HttpOnly'), 'Cookie should be HttpOnly');
    assert.ok(setCookie.includes('SameSite=Strict'), 'Cookie should be SameSite=Strict');
  });

  it('POST /api/auth/login should return 401 on wrong password', async () => {
    const res = await makeFetch(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrongpassword' }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Invalid credentials');
  });

  it('POST /api/auth/login should return 401 on non-existent user (timing-safe)', async () => {
    const res = await makeFetch(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'wrongpassword' }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Invalid credentials');
  });

  it('GET /api/auth/me should return 401 without cookie', async () => {
    const res = await makeFetch(app, '/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('GET /api/auth/me should return username with valid cookie', async () => {
    const loginRes = await makeFetch(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'changeme123' }),
    });
    const setCookie = loginRes.headers.get('set-cookie');
    const cookie = setCookie.split(';')[0];

    const res = await makeFetch(app, '/api/auth/me', {
      headers: { Cookie: cookie },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, 'admin');
  });

  it('POST /api/auth/logout should clear the cookie', async () => {
    const res = await makeFetch(app, '/api/auth/logout', { method: 'POST' });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Should set a cookie to clear it');
    assert.ok(setCookie.includes('gameshelf_session='), 'Should reference the session cookie');
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
