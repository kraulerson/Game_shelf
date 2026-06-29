const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-cache';
const testDbPath = path.join(__dirname, '..', 'data', 'test-cache.db');

let app, mock, lastReq;

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => handle(req, res, raw));
    });
    function handle(req, res, raw) {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      lastReq = { method: req.method, url: req.url, auth: req.headers.authorization, body };
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/api/v1/sweep')
        return send(202, { job_id: 9, full: true, queued: true });
      if (req.url === '/api/v1/jobs') return send(200, { jobs: [{ id: 1, kind: 'prefill' }], meta: { total: 1 } });
      if (req.url === '/api/v1/platforms') return send(200, { platforms: [{ name: 'steam', auth_status: 'ok' }] });
      if (req.url === '/api/v1/health') return send(200, { status: 'ok', git_sha: 'abc' });
      if (req.method === 'GET' && req.url.startsWith('/api/v1/block-list')) return send(200, { block_list: [], meta: { total: 0 } });
      if (req.url.startsWith('/api/v1/games?')) {
        const u = new URL('http://x' + req.url);
        const offset = Number(u.searchParams.get('offset') || 0);
        const all = [{ id: 1 }, { id: 2 }, { id: 3 }];
        const page = all.slice(offset, offset + 2);
        return send(200, { games: page, meta: { total: 3, limit: 2, offset, has_more: offset + 2 < 3 } });
      }
      if (req.method === 'POST' && req.url === '/api/v1/block-list') return send(201, { id: 1, platform: 'steam', app_id: '730' });
      if (req.method === 'DELETE' && req.url.startsWith('/api/v1/block-list/')) return send(200, { removed: 1 });
      if (req.method === 'POST' && /\/api\/v1\/games\/\d+\/prefill$/.test(req.url)) return send(202, { job_id: 5 });
      if (req.method === 'POST' && /\/api\/v1\/games\/\d+\/validate$/.test(req.url)) return send(202, { job_id: 6 });
      if (req.method === 'POST' && /\/api\/v1\/games\/\d+\/manifest\/fetch$/.test(req.url)) return send(202, { job_id: 7 });
      if (req.method === 'POST' && /\/api\/v1\/platforms\/\w+\/library\/sync$/.test(req.url)) return send(202, { job_id: 8 });
      send(404, { detail: 'not found' });
    }
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function authCookie() {
  return `gameshelf_session=${jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function makeFetch(app, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const url = `http://127.0.0.1:${server.address().port}${urlPath}`;
      fetch(url, options).then(resolve).catch(reject).finally(() => server.close());
    });
  });
}

describe('Cache proxy routes', () => {
  before(async () => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    mock = await startMock();
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';
    process.env.ORCH_API_URL = mock.url;
    process.env.ORCH_TOKEN = 'test-orch-token';
    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));
  });
  after(() => {
    mock.server.close();
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('GET /api/cache/jobs proxies the orchestrator', async () => {
    const res = await makeFetch(app, '/api/cache/jobs', { headers: { Cookie: authCookie() } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.jobs[0].kind, 'prefill');
    assert.equal(lastReq.url, '/api/v1/jobs');
    assert.equal(lastReq.auth, 'Bearer test-orch-token'); // token injected server-side
  });

  it('GET /api/cache/platforms / /health / /block-list proxy', async () => {
    for (const [g, probe] of [['platforms', 'platforms'], ['health', 'status'], ['block-list', 'block_list']]) {
      const res = await makeFetch(app, `/api/cache/${g}`, { headers: { Cookie: authCookie() } });
      assert.equal(res.status, 200, g);
      const body = await res.json();
      assert.ok(probe in body, `${g} body has ${probe}`);
    }
  });

  it('GET /api/cache/games pages through to the full set', async () => {
    const res = await makeFetch(app, '/api/cache/games', { headers: { Cookie: authCookie() } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.games.length, 3); // both pages merged
    assert.equal(body.meta.total, 3);
    assert.deepEqual(body.games.map((g) => g.id), [1, 2, 3]);
  });

  it('POST /api/cache/block-list proxies and returns 201', async () => {
    const res = await makeFetch(app, '/api/cache/block-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ platform: 'steam', app_id: '730' }),
    });
    assert.equal(res.status, 201);
    assert.equal(lastReq.method, 'POST');
    assert.equal(lastReq.url, '/api/v1/block-list');
  });

  it('DELETE /api/cache/block-list/:platform/:app_id proxies', async () => {
    const res = await makeFetch(app, '/api/cache/block-list/steam/730', {
      method: 'DELETE',
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    assert.equal(lastReq.url, '/api/v1/block-list/steam/730');
  });

  it('POST /api/cache/games/:id/{prefill,validate,manifest/fetch} proxy', async () => {
    for (const action of ['prefill', 'validate', 'manifest/fetch']) {
      const res = await makeFetch(app, `/api/cache/games/5/${action}`, {
        method: 'POST',
        headers: { Cookie: authCookie() },
      });
      assert.equal(res.status, 202, action);
      assert.equal(lastReq.url, `/api/v1/games/5/${action}`);
    }
  });

  it('POST /api/cache/platforms/:name/library/sync proxies', async () => {
    const res = await makeFetch(app, '/api/cache/platforms/steam/library/sync', {
      method: 'POST',
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 202);
    assert.equal(lastReq.url, '/api/v1/platforms/steam/library/sync');
  });

  it('POST /api/cache/sweep proxies a FULL re-validation sweep', async () => {
    const res = await makeFetch(app, '/api/cache/sweep', {
      method: 'POST',
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.job_id, 9);
    assert.equal(body.queued, true);
    assert.equal(lastReq.method, 'POST');
    assert.equal(lastReq.url, '/api/v1/sweep');
    assert.deepEqual(lastReq.body, { full: true }); // always a full re-validation
  });

  it('never leaks ORCH_TOKEN to the client', async () => {
    for (const p of ['/api/cache/jobs', '/api/cache/platforms', '/api/cache/health', '/api/cache/games']) {
      const res = await makeFetch(app, p, { headers: { Cookie: authCookie() } });
      const text = await res.text();
      assert.ok(!text.includes('test-orch-token'), `${p} response must not contain the token`);
      assert.ok(!text.toLowerCase().includes('authorization'), `${p} must not echo the auth header`);
    }
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await makeFetch(app, '/api/cache/jobs'); // no Cookie
    assert.equal(res.status, 401);
  });
});

describe('Cache proxy — orchestrator offline', () => {
  let appOff;
  before(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';
    process.env.ORCH_API_URL = 'http://127.0.0.1:1'; // nothing listening
    process.env.ORCH_TOKEN = 'test-orch-token';
    delete require.cache[require.resolve('../../src/server')];
    ({ app: appOff } = require('../../src/server'));
  });

  it('returns 503 orchestrator_offline when the orchestrator is unreachable', async () => {
    const res = await makeFetch(appOff, '/api/cache/jobs', { headers: { Cookie: authCookie() } });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, 'orchestrator_offline');
  });
});

module.exports = { startMock, authCookie, makeFetch };
