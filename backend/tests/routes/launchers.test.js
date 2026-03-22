const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-launchers';

describe('Launcher routes', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-launchers.db');
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

  it('GET /api/launchers/available should return 9 launchers', async () => {
    const res = await makeFetch(app, '/api/launchers/available', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 9);
    assert.equal(body[0].id, 'steam');
    assert.equal(body[0].display_name, 'Steam');
  });

  it('POST /api/launchers/:id/credentials should save encrypted credentials', async () => {
    const res = await makeFetch(app, '/api/launchers/steam/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ api_key: 'test-steam-key', steamid64: '76561198012345678' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });

  it('POST /api/launchers/:id/credentials should reject invalid launcher', async () => {
    const res = await makeFetch(app, '/api/launchers/fakeLauncher/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'user', password: 'pass' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/launchers/:id/credentials should validate required fields for api_key type', async () => {
    const res = await makeFetch(app, '/api/launchers/itchio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'user', password: 'pass' }),
    });
    assert.equal(res.status, 400);
  });

  it('GET /api/launchers/:id/test should return stub response', async () => {
    // Steam credentials already saved above
    const res = await makeFetch(app, '/api/launchers/steam/test', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.message.includes('Steam'));
  });

  it('POST /api/launchers/priority should update priorities', async () => {
    // Save credentials for gog too
    await makeFetch(app, '/api/launchers/gog/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'goguser', password: 'gogpass' }),
    });

    const res = await makeFetch(app, '/api/launchers/priority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify([
        { name: 'steam', priority: 1 },
        { name: 'gog', priority: 2 },
      ]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
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
