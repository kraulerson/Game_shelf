# F14 — Backend Proxy Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **NO per-task commits.** Implement all tasks TDD-style (write failing test → verify red → implement → verify green), then Task 9 = full `node --test` run + a single `feat(cache)` commit (bring A/B/C structure to the user FIRST) + push + PR. User merges.

**Goal:** A server-side Express proxy (`/api/cache/*`) that forwards Game_shelf requests to the lancache orchestrator API with the bearer token injected server-side (never reaching the browser), with centralized error mapping and graceful "not configured / offline" behavior.

**Architecture:** A thin axios-based orchestrator client (`services/orchestrator.js`) exposes one `callOrchestrator()` helper that injects `Authorization: Bearer ${ORCH_TOKEN}`, talks to `ORCH_API_URL`, and translates failures (401→502, connection-refused/timeout→503 `orchestrator_offline`, unconfigured→503). A `routes/cache.js` router (behind the existing `authMiddleware`) maps `/api/cache/*` → orchestrator `/api/v1/*`, paging `/games` to a full set for F15's bulk badge correlation.

**Tech Stack:** Node v25 (built-in fetch/http/test), Express, axios (existing dep), CommonJS, `node --test`.

**Conventions (match Game_shelf exactly):**
- CommonJS `require`/`module.exports`. Routers: `const { Router } = require('express'); const router = Router(); router.use(authMiddleware);`. Routes read db via `req.app.locals.db` (not needed here — F14 is stateless proxy).
- Tests: `node:test` (`describe/it/before/after`) + `node:assert/strict`; `makeFetch(app, path, opts)` (ephemeral `app.listen(0)` + `fetch`); `authCookie()` (signed `gameshelf_session` JWT); fresh-require the app in `before()` after setting env. Run: `node --test 'tests/**/*.test.js'` from `backend/`.
- No new deps (axios already present).

---

## Env handling (read this first — applies to Tasks 1 & 8)

`ORCH_API_URL` and `ORCH_TOKEN` are **optional** at boot. Do **NOT** add them to `server.js`'s `requiredEnv` array — that would make Game_shelf refuse to start without the cache config and break the existing test suites. Instead:
- `server.js` logs a one-line **warning** at boot if either is unset (cache features disabled until configured).
- The orchestrator client reads `process.env.ORCH_API_URL` / `ORCH_TOKEN` **lazily** (at call time) so tests can set them per-suite.
- When `ORCH_API_URL` is unset, `callOrchestrator()` throws a `503` `{ status: 'orchestrator_offline' }` — the same shape as an unreachable orchestrator (consistent with F17).

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/services/orchestrator.js` | **New.** axios call + `callOrchestrator()` error mapping + `fetchAllGames()` paging |
| `backend/src/routes/cache.js` | **New.** `/api/cache/*` router behind `authMiddleware` |
| `backend/src/server.js` | Register the router + boot warning for unset `ORCH_*` |
| `backend/tests/routes/cache.test.js` | **New.** proxy + error-mapping + token-safety + auth-gating tests |
| `backend/.env.example` | `ORCH_API_URL`, `ORCH_TOKEN` entries |

---

## Task 1: Orchestrator client — `callOrchestrator()` error mapping

**Files:**
- Create: `backend/src/services/orchestrator.js`
- Test: `backend/tests/services/orchestrator.test.js`

The client makes the outbound call and normalizes the outcome:
- transport error (`ECONNREFUSED`/`ETIMEDOUT`/abort) OR unset `ORCH_API_URL` → throw `Object.assign(new Error(...), { status: 503, body: { status: 'orchestrator_offline' } })`.
- orchestrator `401` → throw `{ status: 502, body: { error: 'orchestrator authentication failed' } }`.
- any other response (2xx / 404 / 400 / …) → **return** `{ status, data }` for the route to pass through.

- [ ] **Step 1: Write the failing test** (`backend/tests/services/orchestrator.test.js`)

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe('callOrchestrator', () => {
  let mock;
  let lastAuth;
  before(async () => {
    process.env.ORCH_TOKEN = 'test-orch-token';
    mock = await startMock((req, res) => {
      lastAuth = req.headers.authorization;  // record on every request
      if (req.url === '/api/v1/ok') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ hello: 'world' })); }
      if (req.url === '/api/v1/unauth') { res.writeHead(401); return res.end(JSON.stringify({ detail: 'no' })); }
      if (req.url === '/api/v1/missing') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ detail: 'game not found' })); }
      res.writeHead(500); res.end();
    });
    process.env.ORCH_API_URL = mock.url;
  });
  after(() => mock.server.close());

  it('returns {status,data} on success and injects the bearer token', async () => {
    const { callOrchestrator } = require('../../src/services/orchestrator');
    const r = await callOrchestrator('GET', '/api/v1/ok');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { hello: 'world' });
    assert.equal(lastAuth, 'Bearer test-orch-token');  // token injected server-side
  });

  it('maps orchestrator 401 -> 502', async () => {
    const { callOrchestrator } = require('../../src/services/orchestrator');
    await assert.rejects(() => callOrchestrator('GET', '/api/v1/unauth'), (e) => e.status === 502);
  });

  it('passes through a non-401 error status + body', async () => {
    const { callOrchestrator } = require('../../src/services/orchestrator');
    const r = await callOrchestrator('GET', '/api/v1/missing');
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { detail: 'game not found' });
  });

  it('maps connection refused -> 503 orchestrator_offline', async () => {
    process.env.ORCH_API_URL = 'http://127.0.0.1:1';  // nothing listening
    const { callOrchestrator } = require('../../src/services/orchestrator');
    await assert.rejects(
      () => callOrchestrator('GET', '/api/v1/ok'),
      (e) => e.status === 503 && e.body.status === 'orchestrator_offline'
    );
    process.env.ORCH_API_URL = mock.url;  // restore
  });

  it('throws 503 orchestrator_offline when ORCH_API_URL is unset', async () => {
    const saved = process.env.ORCH_API_URL; delete process.env.ORCH_API_URL;
    const { callOrchestrator } = require('../../src/services/orchestrator');
    await assert.rejects(() => callOrchestrator('GET', '/api/v1/ok'), (e) => e.status === 503);
    process.env.ORCH_API_URL = saved;
  });
});
```

- [ ] **Step 2: Run to verify red**

Run: `cd backend && node --test tests/services/orchestrator.test.js`
Expected: FAIL — `Cannot find module '../../src/services/orchestrator'`.

- [ ] **Step 3: Implement** (`backend/src/services/orchestrator.js`)

```js
const axios = require('axios');

const TIMEOUT_MS = 5000;

function offline() {
  return Object.assign(new Error('orchestrator offline'), {
    status: 503,
    body: { status: 'orchestrator_offline' },
  });
}

// Lazily read env so tests can set ORCH_API_URL/ORCH_TOKEN per-suite.
async function callOrchestrator(method, path, { params, data } = {}) {
  const baseURL = process.env.ORCH_API_URL;
  if (!baseURL) throw offline();
  try {
    const res = await axios({
      method,
      url: baseURL.replace(/\/$/, '') + path,
      params,
      data,
      timeout: TIMEOUT_MS,
      headers: { Authorization: `Bearer ${process.env.ORCH_TOKEN || ''}` },
      // resolve for any status so we can pass through 4xx; only transport errors throw.
      validateStatus: () => true,
    });
    if (res.status === 401) {
      throw Object.assign(new Error('orchestrator auth failed'), {
        status: 502,
        body: { error: 'orchestrator authentication failed' },
      });
    }
    return { status: res.status, data: res.data };
  } catch (err) {
    if (err.status) throw err; // already-mapped (the 401→502 above)
    // axios transport errors: ECONNREFUSED, ETIMEDOUT, ECONNABORTED (timeout), ENOTFOUND…
    throw offline();
  }
}

module.exports = { callOrchestrator };
```

- [ ] **Step 4: Run to verify green**

Run: `cd backend && node --test tests/services/orchestrator.test.js`
Expected: PASS (all 5).

---

## Task 2: Cache router skeleton + GET passthrough endpoints

**Files:**
- Create: `backend/src/routes/cache.js`
- Modify: `backend/src/server.js` (register router; full env-warning in Task 8)
- Test: `backend/tests/routes/cache.test.js`

Endpoints in this task: `GET /api/cache/jobs`, `/platforms`, `/health`, `/block-list` (simple passthroughs). `/games` paging is Task 3; mutations are Task 4.

- [ ] **Step 1: Write the failing test** (`backend/tests/routes/cache.test.js`) — includes the shared harness used by Tasks 2–7.

```js
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
      lastReq = { method: req.method, url: req.url, auth: req.headers.authorization };
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/v1/jobs') return send(200, { jobs: [{ id: 1, kind: 'prefill' }], meta: { total: 1 } });
      if (req.url === '/api/v1/platforms') return send(200, { platforms: [{ name: 'steam', auth_status: 'ok' }] });
      if (req.url === '/api/v1/health') return send(200, { status: 'ok', git_sha: 'abc' });
      if (req.url.startsWith('/api/v1/block-list')) return send(200, { block_list: [], meta: { total: 0 } });
      send(404, { detail: 'not found' });
    });
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
  after(() => { mock.server.close(); for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); } });

  it('GET /api/cache/jobs proxies the orchestrator', async () => {
    const res = await makeFetch(app, '/api/cache/jobs', { headers: { Cookie: authCookie() } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.jobs[0].kind, 'prefill');
    assert.equal(lastReq.url, '/api/v1/jobs');
    assert.equal(lastReq.auth, 'Bearer test-orch-token');  // token injected server-side
  });

  it('GET /api/cache/platforms / /health / /block-list proxy', async () => {
    for (const [g, o, probe] of [['platforms', '/api/v1/platforms', 'platforms'], ['health', '/api/v1/health', 'status'], ['block-list', '/api/v1/block-list', 'block_list']]) {
      const res = await makeFetch(app, `/api/cache/${g}`, { headers: { Cookie: authCookie() } });
      assert.equal(res.status, 200, g);
      const body = await res.json();
      assert.ok(probe in body, `${g} body has ${probe}`);
    }
  });
});

module.exports = { startMock, authCookie, makeFetch };
```

- [ ] **Step 2: Run to verify red**

Run: `cd backend && node --test tests/routes/cache.test.js`
Expected: FAIL — `/api/cache/jobs` returns 404 (router not registered).

- [ ] **Step 3: Implement the router** (`backend/src/routes/cache.js`)

```js
const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { callOrchestrator } = require('../services/orchestrator');

const router = Router();
router.use(authMiddleware);

// Forward a call and pass the orchestrator's status+body through; map errors.
async function forward(res, method, path, opts) {
  try {
    const { status, data } = await callOrchestrator(method, path, opts);
    res.status(status).json(data);
  } catch (err) {
    res.status(err.status || 503).json(err.body || { status: 'orchestrator_offline' });
  }
}

router.get('/jobs', (req, res) => forward(res, 'GET', '/api/v1/jobs', { params: req.query }));
router.get('/platforms', (req, res) => forward(res, 'GET', '/api/v1/platforms'));
router.get('/health', (req, res) => forward(res, 'GET', '/api/v1/health'));
router.get('/block-list', (req, res) => forward(res, 'GET', '/api/v1/block-list', { params: req.query }));

module.exports = router;
```

And register in `server.js` (after the other `app.use('/api/...', ...)` lines, before `app.use(errorHandler)`):

```js
const cacheRouter = require('./routes/cache');
// ...
app.use('/api/cache', cacheRouter);
```

(Add the `require` alongside the other route requires near the top.)

- [ ] **Step 4: Run to verify green**

Run: `cd backend && node --test tests/routes/cache.test.js`
Expected: PASS.

---

## Task 3: `GET /api/cache/games` — page through to the full set

**Files:**
- Modify: `backend/src/services/orchestrator.js` (add `fetchAllGames`)
- Modify: `backend/src/routes/cache.js` (add `GET /games`)
- Modify: `backend/tests/routes/cache.test.js` (mock multi-page `/games`)

The orchestrator caps `limit` at 500 and returns `{ games, meta: { total, limit, offset, has_more } }`. `fetchAllGames` loops `offset` until all `total` games are collected, returning `{ games: [...all], meta: { total } }`.

- [ ] **Step 1: Write the failing test** — extend the mock to serve a 2-page `/games` (total 3, page size forced small) and add a test.

```js
// add inside startMock()'s handler, before the 404:
if (req.url.startsWith('/api/v1/games')) {
  const u = new URL('http://x' + req.url);
  const offset = Number(u.searchParams.get('offset') || 0);
  const all = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const page = all.slice(offset, offset + 2);
  return send(200, { games: page, meta: { total: 3, limit: 2, offset, has_more: offset + 2 < 3 } });
}
```

```js
// add as a new it() in the describe:
it('GET /api/cache/games pages through to the full set', async () => {
  const res = await makeFetch(app, '/api/cache/games', { headers: { Cookie: authCookie() } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.games.length, 3);             // both pages merged
  assert.equal(body.meta.total, 3);
  assert.deepEqual(body.games.map((g) => g.id), [1, 2, 3]);
});
```

- [ ] **Step 2: Run to verify red**

Run: `cd backend && node --test tests/routes/cache.test.js`
Expected: FAIL — `/api/cache/games` 404 (route missing).

- [ ] **Step 3: Implement**

In `services/orchestrator.js`:

```js
const PAGE = 500;

async function fetchAllGames() {
  const games = [];
  let offset = 0;
  let total = 0;
  do {
    const { status, data } = await callOrchestrator('GET', '/api/v1/games', {
      params: { limit: PAGE, offset },
    });
    if (status !== 200) {
      throw Object.assign(new Error('games fetch failed'), { status, body: data });
    }
    games.push(...(data.games || []));
    total = data.meta ? data.meta.total : games.length;
    offset += PAGE;
  } while (games.length < total);
  return { games, meta: { total } };
}

module.exports = { callOrchestrator, fetchAllGames };
```

In `routes/cache.js`:

```js
const { callOrchestrator, fetchAllGames } = require('../services/orchestrator');
// ...
router.get('/games', async (req, res) => {
  try {
    const result = await fetchAllGames();
    res.json(result);
  } catch (err) {
    res.status(err.status || 503).json(err.body || { status: 'orchestrator_offline' });
  }
});
```

- [ ] **Step 4: Run to verify green**

Run: `cd backend && node --test tests/routes/cache.test.js`
Expected: PASS.

---

## Task 4: Mutations — block-list write + per-game/platform triggers

**Files:**
- Modify: `backend/src/routes/cache.js`
- Modify: `backend/tests/routes/cache.test.js`

Endpoints: `POST /api/cache/block-list`, `DELETE /api/cache/block-list/:platform/:app_id`, `POST /api/cache/games/:id/prefill|validate|manifest/fetch`, `POST /api/cache/platforms/:name/library/sync`.

- [ ] **Step 1: Write the failing test** — extend the mock to echo POST/DELETE, add tests.

```js
// in startMock handler, add a body collector + generic echo for write paths:
//   collect chunks for POST, then:
if (req.method === 'POST' && req.url === '/api/v1/block-list') return send(201, { id: 1, platform: 'steam', app_id: '730' });
if (req.method === 'DELETE' && req.url.startsWith('/api/v1/block-list/')) return send(200, { removed: 1 });
if (req.method === 'POST' && /\/api\/v1\/games\/\d+\/prefill$/.test(req.url)) return send(202, { job_id: 5 });
if (req.method === 'POST' && /\/api\/v1\/platforms\/\w+\/library\/sync$/.test(req.url)) return send(202, { job_id: 7 });
```

```js
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
  const res = await makeFetch(app, '/api/cache/block-list/steam/730', { method: 'DELETE', headers: { Cookie: authCookie() } });
  assert.equal(res.status, 200);
  assert.equal(lastReq.url, '/api/v1/block-list/steam/730');
});

it('POST /api/cache/games/:id/prefill proxies and returns 202', async () => {
  const res = await makeFetch(app, '/api/cache/games/5/prefill', { method: 'POST', headers: { Cookie: authCookie() } });
  assert.equal(res.status, 202);
  assert.equal(lastReq.url, '/api/v1/games/5/prefill');
});

it('POST /api/cache/platforms/:name/library/sync proxies', async () => {
  const res = await makeFetch(app, '/api/cache/platforms/steam/library/sync', { method: 'POST', headers: { Cookie: authCookie() } });
  assert.equal(res.status, 202);
  assert.equal(lastReq.url, '/api/v1/platforms/steam/library/sync');
});
```

- [ ] **Step 2: Run to verify red**

Run: `cd backend && node --test tests/routes/cache.test.js`
Expected: FAIL — write routes 404.

- [ ] **Step 3: Implement** (add to `routes/cache.js`)

```js
router.post('/block-list', (req, res) => forward(res, 'POST', '/api/v1/block-list', { data: req.body }));
router.delete('/block-list/:platform/:app_id', (req, res) =>
  forward(res, 'DELETE', `/api/v1/block-list/${encodeURIComponent(req.params.platform)}/${encodeURIComponent(req.params.app_id)}`));

for (const action of ['prefill', 'validate', 'manifest/fetch']) {
  router.post(`/games/:id/${action}`, (req, res) =>
    forward(res, 'POST', `/api/v1/games/${encodeURIComponent(req.params.id)}/${action}`));
}

router.post('/platforms/:name/library/sync', (req, res) =>
  forward(res, 'POST', `/api/v1/platforms/${encodeURIComponent(req.params.name)}/library/sync`));
```

(`express.json()` is already applied app-wide in `server.js`, so `req.body` is parsed.)

- [ ] **Step 4: Run to verify green**

Run: `cd backend && node --test tests/routes/cache.test.js`
Expected: PASS.

---

## Task 5: Error-mapping through the route (offline + passthrough)

**Files:**
- Modify: `backend/tests/routes/cache.test.js`

- [ ] **Step 1: Write the failing test** — a second `describe` block with the orchestrator pointed at a dead port, plus a passthrough-404 case against the live mock.

```js
describe('Cache proxy — orchestrator offline', () => {
  let appOff;
  before(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';
    process.env.ORCH_API_URL = 'http://127.0.0.1:1';  // nothing listening
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
```

(Passthrough of a non-401 status is already proven by Task 1's `callOrchestrator` 404 test; the route uses the same path.)

- [ ] **Step 2: Run to verify red** → FAIL if the route swallows the offline error differently. Run: `cd backend && node --test tests/routes/cache.test.js`.
- [ ] **Step 3: Implement** — no new code expected (the `forward()` catch already maps it); if red, fix `forward()` to use `err.status`/`err.body`.
- [ ] **Step 4: Run to verify green.**

---

## Task 6: Token-never-in-client-response invariant

**Files:**
- Modify: `backend/tests/routes/cache.test.js`

- [ ] **Step 1: Write the failing test** (add to the main describe)

```js
it('never leaks ORCH_TOKEN to the client', async () => {
  for (const p of ['/api/cache/jobs', '/api/cache/platforms', '/api/cache/health', '/api/cache/games']) {
    const res = await makeFetch(app, p, { headers: { Cookie: authCookie() } });
    const text = await res.text();
    assert.ok(!text.includes('test-orch-token'), `${p} response must not contain the token`);
    assert.ok(!text.toLowerCase().includes('authorization'), `${p} must not echo the auth header`);
  }
});
```

- [ ] **Step 2: Run to verify red/green** — Run: `cd backend && node --test tests/routes/cache.test.js`. Expected PASS (the proxy never returns the token); if it fails, the bug is real — fix it.

---

## Task 7: Auth gating

**Files:**
- Modify: `backend/tests/routes/cache.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('rejects unauthenticated requests with 401', async () => {
  const res = await makeFetch(app, '/api/cache/jobs');  // no Cookie
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2/3/4:** Run; expected PASS (the router's `router.use(authMiddleware)` already gates it). If red, ensure `router.use(authMiddleware)` is the first line of the router.

---

## Task 8: Boot warning + `.env.example`

**Files:**
- Modify: `backend/src/server.js`
- Modify: `backend/.env.example`

- [ ] **Step 1: Implement the boot warning** — after the `requiredEnv` loop in `server.js`, add (do NOT add ORCH_* to `requiredEnv`):

```js
if (!process.env.ORCH_API_URL || !process.env.ORCH_TOKEN) {
  console.warn('[Gameshelf] ORCH_API_URL/ORCH_TOKEN not set — cache integration disabled until configured.');
}
```

- [ ] **Step 2: Add to `backend/.env.example`** (append):

```
# Lancache orchestrator integration (F14). Leave unset to disable the cache UI.
ORCH_API_URL=http://192.168.1.40:8765
ORCH_TOKEN=
```

- [ ] **Step 3: Verify the existing suites still boot** — Run: `cd backend && node --test tests/routes/auth.test.js` (a suite that does NOT set ORCH_*). Expected: PASS (app still boots; only a warning logged).

---

## Task 9: Full sweep, commit, PR

- [ ] **Step 1: Full backend test run** — Run: `cd backend && node --test 'tests/**/*.test.js'`. Expected: all suites pass (new cache + all existing).
- [ ] **Step 2:** Present the **A/B/C commit structure** to the Orchestrator, then a single `feat(cache): F14 backend proxy to the lancache orchestrator` commit.
- [ ] **Step 3:** Push `feat/cache-integration` and open a PR with `gh pr create`. Do NOT merge — the Orchestrator merges.

---

## Notes
- **Deploy prerequisite (separate, lancache_orchestrator repo):** the orchestrator must bind its LAN interface + a host firewall rule allowing `:8765` only from 10.100.23.102 before this proxy can reach a live orchestrator. F14 works in tests against the mock regardless.
- **Out of scope (later plans):** F15 badge correlation/components, F16 dashboard, F17 health/version-skew + token-grep CI + the frontend.
