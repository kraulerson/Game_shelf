const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Express server', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-server.db');

  before(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt-secret';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('GET /api/health should return status ok', async () => {
    delete require.cache[require.resolve('../src/server')];
    const { app } = require('../src/server');

    const res = await makeFetch(app, '/api/health');
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.version, '1.6.0');
    assert.equal(body.app, 'Gameshelf');
  });

  it('GET /api/auth/me should return 401 without auth', async () => {
    delete require.cache[require.resolve('../src/server')];
    const { app } = require('../src/server');

    const res = await makeFetch(app, '/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('GET /api/games should return 401 without auth', async () => {
    delete require.cache[require.resolve('../src/server')];
    const { app } = require('../src/server');

    const res = await makeFetch(app, '/api/games');
    assert.equal(res.status, 401);
  });
});

function makeFetch(app, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${path}`;
      fetch(url, options)
        .then(resolve)
        .catch(reject)
        .finally(() => server.close());
    });
  });
}
