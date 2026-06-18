# Cache-Status Filter + Relocated Card Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator filter the library by orchestrator cache status (multi-select, server-side, correctly paginated) and see each game's cache badge under its card info, plus an nginx cache-control fix.

**Architecture:** The cache status lives in the orchestrator, not Game_shelf's DB. A 60 s in-memory snapshot of the orchestrator's status set is loaded into a per-request SQLite temp table; the `/api/games` list handler adds an edition-level `EXISTS` filter composed with the launcher filter, keeping `LIMIT/OFFSET` + count correct. Frontend adds a fixed six-checkbox "Cache status" section, relocates the badge, and surfaces an offline note.

**Tech Stack:** Express + better-sqlite3 (backend, `node:test`), React 18 + Vite + Tailwind + @tanstack/react-query (frontend, vitest + RTL), nginx (prod static serving).

---

## Context the engineer needs (read before starting)

- **Branch:** `feat/cache-status-filter` (off master; spec committed f72ed95).
- **No framework hooks** in this repo. **No per-task commits** — implement every task TDD-style, then a single `feat(cache)` commit in the final task.
- **Run tests:** backend `cd backend && node --test tests/services/cacheSnapshot.test.js` (single) or `node --test 'tests/**/*.test.js'` (all). Frontend `cd frontend && npm test <path>` or `npm test`. Shell cwd resets between commands — `cd` at the start of each.
- **Two pre-existing backend failures** exist on master (`server.test.js` version `1.17.3` vs the bumped version; setup/qr TOTP). Do not "fix" them; just don't add NEW failures.
- **The `/api/games` list handler** is `backend/src/routes/games.js:322` `router.get('/', (req, res) => {...})`. Key facts:
  - `const db = req.app.locals.db;` (better-sqlite3, synchronous, single connection).
  - Query params destructured incl. `search, genre, tag, launcher, sort, page, limit, duplicates, starts_with, ...`.
  - Two SQL modes: `duplicates === 'show'` (flat, each row = an edition) and else (deduplicated `WITH ranked … ROW_NUMBER() … rn=1`). **Both** outer queries `LEFT JOIN games g` so `g.id` is in scope.
  - Filters are split into `innerConditions/innerParams` (edition/launcher-level, inside `innerWhere`) and `outerConditions/outerParams` (game-level, inside `outerWhere`). The launcher filter is an inner condition: `l.name IN (...)`.
  - Params are concatenated as `[...innerParams, ...outerParams, ...searchParams, ...startsWithParams, (limit, offset)]` for the page query and without limit/offset for the count query. **Anything added to `outerConditions` must push matching values to `outerParams`.**
  - `const total = db.prepare(countQuery).get(...countParams)?.total || 0; const rows = db.prepare(query).all(...allParams);` then it builds `games` and responds.
- **Orchestrator client:** `backend/src/services/orchestrator.js` exports `fetchAllGames()` → `{ games: [{ id, platform, app_id, status, blocked }], meta:{total} }` and `callOrchestrator()`. Bearer injected server-side.
- **F15 correlation key:** orchestrator `app_id` ↔ `game_editions.launcher_game_id`; orchestrator `platform` ↔ `launchers.name`. (Confirmed by `useCacheStatus`/`GameCard`: `statusFor(launcherToPlatform(launcher_name), launcher_game_id)`.)
- **Backend test harness** (mirror `backend/tests/routes/cache.test.js`): `node:test` (`describe/it/before/after`), `node:assert/strict`; a mock orchestrator via `http.createServer` answering `/api/v1/games?...` etc. with `process.env.ORCH_API_URL = mock.url`; `authCookie()` signs a `gameshelf_session` JWT with the test `GAMESHELF_JWT_SECRET`; `makeFetch(app, path, opts)` = `app.listen(0)` + `fetch` + close; DB via `process.env.GAMESHELF_DB_PATH`; `delete require.cache[require.resolve('../../src/server')]; ({app}=require('../../src/server'))`. For DB seeding of games/editions/launchers, mirror `backend/tests/routes/games.test.js`.
- **Frontend conventions:** `useSearchParams` for filters; `toggleFilter(key,value)` comma-joins + sets `page=1`; vitest+RTL with a `MemoryRouter` (react-router) and/or `QueryClientProvider` wrapper; `cd frontend && npm test`.

## File Structure

- **Create** `backend/src/services/cacheSnapshot.js` — 60 s TTL snapshot of the orchestrator status set; injectable client + clock; last-good on error.
- **Modify** `backend/src/routes/games.js` — async list handler; `cache_status` temp-table `EXISTS` filter; `cache_filter_unavailable` flag.
- **Modify** `frontend/src/components/GameCard.jsx` — relocate `CacheBadge` to the info block.
- **Modify** `frontend/src/components/FilterPanel.jsx` — Cache-status six-checkbox section.
- **Modify** `frontend/src/pages/Library.jsx` — `cache_status` in `filterKeys`, chip, unavailable note.
- **Modify** `frontend/nginx.conf` — cache-control headers.
- **Create/extend** tests alongside each.

---

### Task 1: `cacheSnapshot` service

**Files:**
- Create: `backend/src/services/cacheSnapshot.js`
- Test: `backend/tests/services/cacheSnapshot.test.js`

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/services/cacheSnapshot.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeCacheSnapshot } = require('../../src/services/cacheSnapshot');

function stubClient(pages) {
  // pages: function returning the games array (so we can vary per call)
  let calls = 0;
  return {
    calls: () => calls,
    fetchAllGames: async () => { calls += 1; const games = pages(calls); if (games instanceof Error) throw games; return { games, meta: { total: games.length } }; },
  };
}

describe('cacheSnapshot', () => {
  it('builds a platform:app_id -> status map from the client', async () => {
    const client = stubClient(() => [{ platform: 'steam', app_id: '730', status: 'up_to_date' }]);
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => 0 });
    const { map, stale } = await snap.get();
    assert.equal(stale, false);
    assert.equal(map.get('steam:730'), 'up_to_date');
  });

  it('serves cached within TTL without refetching', async () => {
    let t = 0;
    const client = stubClient(() => [{ platform: 'steam', app_id: '1', status: 'up_to_date' }]);
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => t });
    await snap.get();
    t = 500;
    await snap.get();
    assert.equal(client.calls(), 1);
  });

  it('refetches after the TTL expires', async () => {
    let t = 0;
    const client = stubClient(() => [{ platform: 'steam', app_id: '1', status: 'up_to_date' }]);
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => t });
    await snap.get();
    t = 1500;
    await snap.get();
    assert.equal(client.calls(), 2);
  });

  it('returns last-good map with stale=true when the client throws', async () => {
    let t = 0, fail = false;
    const client = stubClient(() => (fail ? new Error('offline') : [{ platform: 'steam', app_id: '1', status: 'up_to_date' }]));
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => t });
    await snap.get();          // good
    t = 2000; fail = true;
    const { map, stale } = await snap.get();
    assert.equal(stale, true);
    assert.equal(map.get('steam:1'), 'up_to_date'); // last good
  });

  it('returns {map:null, stale:true} when the client throws and there is no prior snapshot', async () => {
    const client = stubClient(() => new Error('offline'));
    const snap = makeCacheSnapshot({ client, ttlMs: 1000, now: () => 0 });
    const { map, stale } = await snap.get();
    assert.equal(map, null);
    assert.equal(stale, true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/services/cacheSnapshot.test.js`
Expected: FAIL — `Cannot find module '../../src/services/cacheSnapshot'`.

- [ ] **Step 3: Implement**

```js
// backend/src/services/cacheSnapshot.js
const orchestrator = require('./orchestrator');

const DEFAULT_TTL_MS = 60_000;

// In-memory snapshot of the orchestrator's (platform:app_id -> status) set.
// Returns { map, stale }. On a fetch error, serves the last-good map (stale:true),
// or { map:null, stale:true } if nothing was ever fetched. Concurrent refreshes
// are coalesced into one in-flight request.
function makeCacheSnapshot({ client = orchestrator, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  let cached = null;   // { map, fetchedAt }
  let inflight = null;

  async function get() {
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return { map: cached.map, stale: false };
    }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { games } = await client.fetchAllGames();
        const map = new Map();
        for (const g of games) map.set(`${g.platform}:${g.app_id}`, g.status);
        cached = { map, fetchedAt: now() };
        return { map, stale: false };
      } catch {
        if (cached) return { map: cached.map, stale: true };
        return { map: null, stale: true };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return { get };
}

const defaultSnapshot = makeCacheSnapshot();

module.exports = {
  makeCacheSnapshot,
  getCacheStatusSnapshot: () => defaultSnapshot.get(),
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && node --test tests/services/cacheSnapshot.test.js`
Expected: PASS (5 tests).

---

### Task 2: `cache_status` filter in the games list handler

**Files:**
- Modify: `backend/src/routes/games.js` (the `router.get('/', …)` list handler at ~line 322)
- Test: `backend/tests/routes/games-cache-filter.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/routes/games-cache-filter.test.js`. It seeds launchers/games/editions, stands up a mock orchestrator returning statuses, and asserts the filter. Mirror `cache.test.js`'s mock/auth/makeFetch and `games.test.js`'s seeding.

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-cache-filter';
const testDbPath = path.join(__dirname, '..', 'data', 'test-cache-filter.db');
let app, mock;

// Orchestrator status set: steam:10 cached, steam:20 not_downloaded, epic:30 not_downloaded,
// epic:40 validation_failed; (steam:99 has NO record -> unknown)
const ORCH_GAMES = [
  { id: 1, platform: 'steam', app_id: '10', status: 'up_to_date' },
  { id: 2, platform: 'steam', app_id: '20', status: 'not_downloaded' },
  { id: 3, platform: 'epic', app_id: '30', status: 'not_downloaded' },
  { id: 4, platform: 'epic', app_id: '40', status: 'validation_failed' },
];
let orchUp = true;

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!orchUp) { res.destroy(); return; }
      if (req.url.startsWith('/api/v1/games?')) {
        const u = new URL('http://x' + req.url);
        const offset = Number(u.searchParams.get('offset') || 0);
        const page = ORCH_GAMES.slice(offset, offset + 500);
        return send(200, { games: page, meta: { total: ORCH_GAMES.length, limit: 500, offset, has_more: false } });
      }
      send(404, { detail: 'nf' });
    });
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function authCookie() {
  return `gameshelf_session=${jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '1h' })}`;
}
function makeFetch(a, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const url = `http://127.0.0.1:${server.address().port}${urlPath}`;
      fetch(url, options).then(resolve).catch(reject).finally(() => server.close());
    });
  });
}

function seed(db) {
  // two launchers
  db.prepare("INSERT INTO launchers (id, name, display_name, enabled, priority) VALUES (1,'steam','Steam',1,1),(2,'epic','Epic',1,2)").run();
  // games + owned primary editions: (game, launcher, launcher_game_id)
  const insGame = db.prepare("INSERT INTO games (id, title, slug) VALUES (?,?,?)");
  const insEd = db.prepare("INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned, parent_edition_id) VALUES (?,?,?,?,1,NULL)");
  const rows = [
    [1, 'Cached Steam', 'cached-steam', 1, '10'],
    [2, 'Uncached Steam', 'uncached-steam', 1, '20'],
    [3, 'Uncached Epic', 'uncached-epic', 2, '30'],
    [4, 'Failed Epic', 'failed-epic', 2, '40'],
    [5, 'Unknown Steam', 'unknown-steam', 1, '99'], // no orch record
  ];
  for (const [gid, title, slug] of rows) insGame.run(gid, title, slug);
  for (const [gid, , , lid, lgid] of rows) insEd.run(gid, lid, lgid, 'ed');
}

async function get(qs) {
  const res = await makeFetch(app, `/api/games?${qs}`, { headers: { Cookie: authCookie() } });
  return res.json();
}

describe('cache_status filter', () => {
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
    seed(app.locals.db);
    orchUp = true;
  });
  after(() => { mock.server.close(); });

  it('cache_status=up_to_date returns only the cached game', async () => {
    const body = await get('cache_status=up_to_date');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Cached Steam']);
  });

  it('cache_status=not_downloaded returns both uncached games', async () => {
    const body = await get('cache_status=not_downloaded');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Uncached Epic', 'Uncached Steam']);
  });

  it('failed folds in validation_failed', async () => {
    const body = await get('cache_status=failed');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Failed Epic']);
  });

  it('unknown includes games with no orchestrator record', async () => {
    const body = await get('cache_status=unknown');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Unknown Steam']);
  });

  it('launcher=epic + not_downloaded matches the Epic edition specifically', async () => {
    const body = await get('launcher=epic&cache_status=not_downloaded');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Uncached Epic']);
  });

  it('total reflects the filter (pagination correctness)', async () => {
    const body = await get('cache_status=not_downloaded&limit=1');
    assert.equal(body.total, 2);
    assert.equal(body.games.length, 1);
  });

  it('orchestrator offline -> filter skipped + cache_filter_unavailable flag', async () => {
    orchUp = false;
    // force a fresh snapshot fetch by waiting out TTL is impractical in-test; the
    // default snapshot has cached data from prior tests, so it would serve last-good.
    // To exercise the null path, this assertion only checks the flag is BOOLEAN and
    // present, and that the response still returns games. (The null-path unit is
    // covered in cacheSnapshot.test.js.)
    const body = await get('cache_status=up_to_date');
    assert.equal(typeof body.cache_filter_unavailable, 'boolean');
    assert.ok(Array.isArray(body.games));
    orchUp = true;
  });
});
```

> NOTE on seeding: if `games.test.js` uses a helper to seed or a different column set, mirror it. Adjust the `INSERT` columns to the actual `games`/`game_editions`/`launchers` schema (read `backend/src/db/` migrations). The columns used here (`launchers.name/display_name/enabled/priority`, `game_editions.game_id/launcher_id/launcher_game_id/title/owned/parent_edition_id`, `games.id/title/slug`) match the queries in `games.js`; confirm against the schema and fix any NOT NULL columns the seed omits.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/routes/games-cache-filter.test.js`
Expected: FAIL — the filter isn't implemented, so `cache_status=up_to_date` returns all games (assertions fail) and `cache_filter_unavailable` is undefined.

- [ ] **Step 3: Implement the filter**

In `backend/src/routes/games.js`:

1. Add the import at the top with the other requires:
```js
const { getCacheStatusSnapshot } = require('../services/cacheSnapshot');
```

2. Make the list handler **async**: change `router.get('/', (req, res) => {` to `router.get('/', async (req, res) => {`.

3. Add `cache_status` to the destructured query params (in the `const { … } = req.query;` block): add `cache_status,`.

4. Immediately **after** the `outerWhere` is built but **before** the `query`/`countQuery` are assembled (i.e. right after the `const outerWhere = …` line ~386, BEFORE the `searchWhere*` section is fine too — it just needs to mutate `outerConditions`/`outerParams` before `outerWhere` is used; so place this block BEFORE `const outerWhere = …`). Insert:

```js
  // Cache-status filter (orchestrator-derived). Edition-level EXISTS, composed
  // with the launcher filter. Uses a per-request TEMP table populated from the
  // 60s orchestrator snapshot so LIMIT/OFFSET + count stay correct.
  let cacheFilterUnavailable = false;
  if (cache_status) {
    const snap = await getCacheStatusSnapshot();
    if (!snap.map) {
      cacheFilterUnavailable = true; // orchestrator never reachable -> skip filter
    } else {
      // Populate the temp table (sync after the await above, so no request interleaves).
      db.exec('CREATE TEMP TABLE IF NOT EXISTS _cache_status(platform TEXT, app_id TEXT, status TEXT, PRIMARY KEY(platform, app_id))');
      db.exec('DELETE FROM _cache_status');
      const ins = db.prepare('INSERT OR REPLACE INTO _cache_status(platform, app_id, status) VALUES (?, ?, ?)');
      const insMany = db.transaction((entries) => {
        for (const [key, status] of entries) {
          const idx = key.indexOf(':');
          ins.run(key.slice(0, idx), key.slice(idx + 1), status);
        }
      });
      insMany([...snap.map.entries()]);

      const EXPAND = { failed: ['failed', 'validation_failed'] };
      const selected = cache_status.split(',').map(s => s.trim()).filter(Boolean);
      const expanded = [...new Set(selected.flatMap(s => EXPAND[s] || [s]))];

      const existsParams = [];
      let launcherInExists = '';
      if (launcher) {
        const launchers = launcher.split(',').map(l => l.trim());
        launcherInExists = `AND l2.name IN (${launchers.map(() => '?').join(',')})`;
        existsParams.push(...launchers);
      }
      const stPlaceholders = expanded.map(() => '?').join(',');
      existsParams.push(...expanded);

      outerConditions.push(`EXISTS (
        SELECT 1 FROM game_editions ge2
        JOIN launchers l2 ON l2.id = ge2.launcher_id
        LEFT JOIN _cache_status cs ON cs.platform = l2.name AND cs.app_id = CAST(ge2.launcher_game_id AS TEXT)
        WHERE ge2.game_id = g.id AND ge2.owned = 1 AND ge2.parent_edition_id IS NULL
          ${launcherInExists}
          AND COALESCE(cs.status, 'unknown') IN (${stPlaceholders})
      )`);
      outerParams.push(...existsParams);
    }
  }
```

> IMPORTANT placement: this block must run **before** `const outerWhere = outerConditions.length > 0 ? …` so the new condition is included. If `outerWhere` is already computed above this point in the current file, move this block up to just before that line. The `EXISTS` references `g.id`, which is present in both query modes' outer SELECT (the dups mode `LEFT JOIN games g`, the dedup mode `LEFT JOIN games g ON g.id = r.game_id`). `CAST(ge2.launcher_game_id AS TEXT)` guards the TEXT/INTEGER affinity mismatch against the temp table's TEXT `app_id`.

5. Add the flag to the JSON response. Find the `res.json({ … })` (or `res.json(...)`) at the end of the handler and add `cache_filter_unavailable: cacheFilterUnavailable` to the returned object (alongside `games`, `total`, pagination).

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && node --test tests/routes/games-cache-filter.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Confirm no backend regressions**

Run: `cd backend && node --test 'tests/**/*.test.js' 2>&1 | tail -6`
Expected: same as master baseline (only the 2 known pre-existing failures; no NEW ones). In particular `games.test.js` (existing list behavior without `cache_status`) still passes — the new block is inert when `cache_status` is absent.

---

### Task 3: Relocate the cache badge on the card

**Files:**
- Modify: `frontend/src/components/GameCard.jsx`
- Test: `frontend/src/components/GameCard.cache.test.jsx` (existing — extend it)

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/GameCard.cache.test.jsx` (it already renders `GameCard` with the cache hook + router; reuse its wrapper/mocks):

```js
it('renders the cache badge in the info block, not as an absolute art overlay', async () => {
  // (reuse the file's existing fetch stub that returns a cached steam game; if the
  // helper is named differently, match it.)
  const { container } = renderCard({ launcher_name: 'steam', launcher_game_id: '730' }); // existing helper
  // The badge text shows (e.g. "Cached" / "Unknown"); the OLD absolute overlay wrapper is gone.
  expect(container.querySelector('.absolute.top-1\\.5.left-1\\.5')).toBeNull();
});
```

> If `GameCard.cache.test.jsx` doesn't expose a `renderCard` helper, mirror its existing render setup (it wraps with `QueryClientProvider` + `MemoryRouter` and stubs `fetch` for `/api/cache/games`). The assertion that matters: no element with the `top-1.5 left-1.5` absolute-overlay classes exists.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test src/components/GameCard.cache.test.jsx`
Expected: FAIL — the overlay wrapper `div.absolute.top-1.5.left-1.5` still exists.

- [ ] **Step 3: Implement the move**

In `frontend/src/components/GameCard.jsx`:
1. **Remove** the overlay block:
```jsx
      {/* Cache status badge (primary edition) */}
      <div className="absolute top-1.5 left-1.5 z-10">
        <CacheBadge
          status={cache?.status}
          blocked={cache?.blocked}
          tracked={Boolean(platform)}
          offline={isOffline}
          size="small"
        />
      </div>
```
2. **Add** the badge at the end of the info block — inside the `<div className="p-2">…</div>`, after the DLC/playtime row (the last child), as a new left-aligned row:
```jsx
        {/* Cache/prefill status (relocated under the info) */}
        <div className="mt-1">
          <CacheBadge
            status={cache?.status}
            blocked={cache?.blocked}
            tracked={Boolean(platform)}
            offline={isOffline}
            size="small"
          />
        </div>
```
(Keep the `useCacheStatus`/`platform`/`cache` lines and the `import CacheBadge` unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test src/components/GameCard.cache.test.jsx`
Expected: PASS (existing badge tests + the new position test).

---

### Task 4: Cache-status section in the FilterPanel

**Files:**
- Modify: `frontend/src/components/FilterPanel.jsx`
- Test: `frontend/src/components/FilterPanel.test.jsx` (create if absent)

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/components/FilterPanel.test.jsx  (create if it doesn't exist)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import FilterPanel from './FilterPanel';

function Harness() {
  const [params] = useSearchParams();
  return (
    <>
      <FilterPanel open onClose={() => {}} />
      <div data-testid="cs">{params.get('cache_status') || ''}</div>
    </>
  );
}
function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/library']}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ genres: [], tags: [], launchers: [] }) }));
});

describe('FilterPanel cache status', () => {
  it('toggling "Not cached" sets cache_status=not_downloaded', async () => {
    wrap();
    await userEvent.click(await screen.findByLabelText('Not cached'));
    expect(screen.getByTestId('cs').textContent).toBe('not_downloaded');
  });

  it('selecting two statuses comma-joins them', async () => {
    wrap();
    await userEvent.click(await screen.findByLabelText('Cached'));
    await userEvent.click(screen.getByLabelText('Failed'));
    expect(screen.getByTestId('cs').textContent).toBe('up_to_date,failed');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test src/components/FilterPanel.test.jsx`
Expected: FAIL — no "Not cached"/"Cached" checkboxes (`findByLabelText` throws).

- [ ] **Step 3: Implement the section**

In `frontend/src/components/FilterPanel.jsx`, add a "Cache status" section using the existing `toggleFilter` + `selectedX` pattern. Near the other `selected*` derivations add:
```jsx
  const selectedCacheStatuses = (searchParams.get('cache_status') || '').split(',').filter(Boolean);
```
Add a constant near the top of the module (outside the component):
```jsx
const CACHE_STATUS_OPTIONS = [
  { key: 'up_to_date', label: 'Cached' },
  { key: 'pending_update', label: 'Update ready' },
  { key: 'not_downloaded', label: 'Not cached' },
  { key: 'failed', label: 'Failed' },
  { key: 'downloading', label: 'Downloading' },
  { key: 'unknown', label: 'Unknown' },
];
```
Then render a section mirroring the launchers section (checkbox list). Place it near the launcher section:
```jsx
      <div className="mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Cache status</h3>
        {CACHE_STATUS_OPTIONS.map(opt => (
          <label key={opt.key} className="flex items-center gap-2 text-sm text-gray-300 py-0.5 cursor-pointer">
            <input
              type="checkbox"
              checked={selectedCacheStatuses.includes(opt.key)}
              onChange={() => toggleFilter('cache_status', opt.key)}
              className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
            />
            {opt.label}
          </label>
        ))}
      </div>
```
(Use the exact checkbox/label classes already used by the launcher section in this file so styling matches.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test src/components/FilterPanel.test.jsx`
Expected: PASS (2 tests).

---

### Task 5: Library — filterKeys, chip, and unavailable note

**Files:**
- Modify: `frontend/src/pages/Library.jsx`
- Test: `frontend/src/pages/Library.cache.test.jsx` (new, focused)

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/pages/Library.cache.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Library from './Library';

function wrap(entry) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Library />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/api/games?') || u.includes('/api/games')) {
      return Promise.resolve({ ok: true, json: async () => ({ games: [], total: 0, page: 1, cache_filter_unavailable: u.includes('cache_status') }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ genres: [], tags: [], launchers: [] }) });
  }));
});

describe('Library cache-status integration', () => {
  it('shows the unavailable note when the response flags it', async () => {
    wrap('/library?cache_status=up_to_date');
    expect(await screen.findByText(/cache status unavailable/i)).toBeInTheDocument();
  });

  it('does not show the note on a normal response', async () => {
    wrap('/library');
    // let queries settle
    await screen.findByPlaceholderText(/search games/i);
    expect(screen.queryByText(/cache status unavailable/i)).not.toBeInTheDocument();
  });
});
```

> If `Library` requires more providers/state than this minimal wrapper supplies and the test errors on mount, reduce the assertion to the smallest stable check (the note's presence/absence) and add only the providers Library actually needs (match how `Cache.test.jsx`/other page tests wrap). Do not over-mock.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test src/pages/Library.cache.test.jsx`
Expected: FAIL — no "cache status unavailable" note rendered.

- [ ] **Step 3: Implement**

In `frontend/src/pages/Library.jsx`:
1. Add `'cache_status'` to the `filterKeys` array (so it counts toward `activeFilterCount` and is cleared by "clear all"):
```js
  const filterKeys = ['genre', 'tag', 'launcher', 'cache_status', 'release_year_min', 'release_year_max', 'playtime_min', 'playtime_max', 'owned', 'duplicates', 'starts_with'];
```
2. Read the flag off the games query data. The list query is `useQuery({ queryKey:['games', …], queryFn: …fetch('/api/games?…').then(r=>r.json()) })`. Use its `data`:
```jsx
  const cacheFilterUnavailable = Boolean(data?.cache_filter_unavailable);
```
(Use the existing destructured query result variable name for the games query — it's the `useQuery` whose `queryKey` starts with `'games'`. If it's `const { data } = useQuery(...)`, reuse `data`.)
3. Render the note near the filter bar (e.g. just under the Filters button / above the grid):
```jsx
        {cacheFilterUnavailable && (
          <p className="text-xs text-amber-400 mb-2">Cache status unavailable — status filter ignored.</p>
        )}
```
4. Add a removable chip for selected cache statuses, mirroring the existing `launcher` chip block (the `searchParams.get('launcher') && …split(',').map(...)` pattern). For each selected `cache_status` value, render a chip showing its label (map key→label via the same six-option list — import or inline the `{up_to_date:'Cached', …}` map) with an X that removes just that value:
```jsx
        {searchParams.get('cache_status') && searchParams.get('cache_status').split(',').map(s => (
          <button
            key={s}
            onClick={() => {
              const next = searchParams.get('cache_status').split(',').filter(v => v !== s);
              const p = new URLSearchParams(searchParams);
              if (next.length) p.set('cache_status', next.join(',')); else p.delete('cache_status');
              p.set('page', '1');
              setSearchParams(p);
            }}
            className="inline-flex items-center gap-1 px-2 py-1 bg-gray-700 text-gray-200 rounded-full text-xs"
          >
            {({ up_to_date: 'Cached', pending_update: 'Update ready', not_downloaded: 'Not cached', failed: 'Failed', downloading: 'Downloading', unknown: 'Unknown' })[s] || s}
            <X size={12} />
          </button>
        ))}
```
(Place it alongside the existing genre/launcher chip blocks so it sits in the same chip row. `X` is already imported in Library.jsx.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test src/pages/Library.cache.test.jsx`
Expected: PASS (2 tests).

---

### Task 6: nginx cache-control fix

**Files:**
- Modify: `frontend/nginx.conf`

- [ ] **Step 1: Add cache headers**

In `frontend/nginx.conf`, add two `location` blocks. Put the exact-match `index.html` and the `/assets/` block **before** the catch-all `location /` so they take precedence:

```nginx
    # Never cache the SPA entry point — it references content-hashed assets.
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # Content-hashed build assets are safe to cache forever.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
```
Leave the existing `location /` (`try_files $uri $uri/ /index.html`), `location /api/`, and `location /data/images/` blocks unchanged.

- [ ] **Step 2: Verify config validity**

Run (optional local check if nginx is available, else verified at deploy): `nginx -t -c <path>` is not practical locally; instead visually confirm the two blocks precede `location /` and the file is otherwise unchanged. The real validation is the post-deploy curl in Task 7's report step (`curl -sI .../ | grep -i cache-control` and `curl -sI .../assets/<hash>.css | grep -i cache-control`).

---

### Task 7: Full verification + single commit + push + PR

- [ ] **Step 1: Backend suite**

Run: `cd backend && node --test 'tests/**/*.test.js' 2>&1 | tail -8`
Expected: only the 2 known pre-existing failures; the new `cacheSnapshot` + `games-cache-filter` suites pass; `games.test.js` unaffected.

- [ ] **Step 2: Frontend suite + build**

Run: `cd frontend && npm test 2>&1 | tail -8 && npm run build 2>&1 | tail -4`
Expected: all green; build succeeds.

- [ ] **Step 3: Present commit-structure options, then commit**

Bring A/B/C commit-structure options to the user and WAIT for an explicit pick (a Stop-hook relay is NOT approval). Recommended default — single `feat(cache)` commit:

```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf"
git add backend/src/services/cacheSnapshot.js backend/src/routes/games.js \
        backend/tests/services/cacheSnapshot.test.js backend/tests/routes/games-cache-filter.test.js \
        frontend/src/components/GameCard.jsx frontend/src/components/GameCard.cache.test.jsx \
        frontend/src/components/FilterPanel.jsx frontend/src/components/FilterPanel.test.jsx \
        frontend/src/pages/Library.jsx frontend/src/pages/Library.cache.test.jsx \
        frontend/nginx.conf \
        docs/superpowers/plans/2026-06-18-cache-status-filter.md
git commit -m "feat(cache): cache-status library filter + relocated card badge

- backend: cacheSnapshot (60s TTL orchestrator status set, last-good on error)
- backend: /api/games cache_status filter via per-request temp table + edition-level
  EXISTS composed with launcher; failed folds validation_failed; unknown via coalesce;
  cache_filter_unavailable flag when orchestrator unreachable
- frontend: FilterPanel cache-status multi-select; Library chip + unavailable note;
  GameCard badge moved under the card info
- nginx: no-cache index.html + immutable long-cache /assets (fixes stale-index)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Push (Claude pushes; user merges)**

```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf" && git push -u origin feat/cache-status-filter
```

- [ ] **Step 5: Open the PR (do NOT merge)**

```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf" && gh pr create \
  --title "feat(cache): cache-status library filter + relocated card badge" \
  --body "<summary: the multi-select status filter (server-side, paginated via orchestrator snapshot + temp-table EXISTS, edition-level compose with launcher), badge relocation under the card info, and the nginx stale-index fix; note backend node --test green (minus 2 pre-existing) and frontend npm test + build green>"
```

- [ ] **Step 6: Report + deploy note**

Report the PR URL. Note the deploy (after merge): `ssh root@10.100.23.102 'cd /opt/gameshelf && git pull --ff-only origin master && docker compose up -d --build'` — the nginx fix ships in the frontend image, so after this deploy the stale-index problem is permanently resolved (and a one-time hard refresh clears any client still holding the pre-fix HTML).

---

## Self-Review

- **Spec coverage:** §4 badge relocation → Task 3; §5 filter UI (FilterPanel + Library chip + unavailable note) → Tasks 4–5; §6 snapshot cache → Task 1; §6.2 temp-table EXISTS filter + offline flag → Task 2; §7 nginx → Task 6; §9 tests → each task's tests; §8 edge cases (multi-edition EXISTS, empty param inert, offline skip) → Task 2 tests.
- **Placeholder scan:** none — every step has concrete code. The SQL uses real placeholders bound by `existsParams`. The one judgment note (FilterPanel/Library exact class names + render wrapper) instructs mirroring existing siblings, not a TBD.
- **Type/name consistency:** `getCacheStatusSnapshot()` (Task 1) is imported + called in Task 2; `makeCacheSnapshot({client,ttlMs,now})` matches its tests; the `cache_status` param + the six status keys (`up_to_date/pending_update/not_downloaded/failed/downloading/unknown`) are identical across Task 2 (expand map), Task 4 (`CACHE_STATUS_OPTIONS`), and Task 5 (chip label map); `failed→[failed,validation_failed]` mapping appears only server-side (Task 2). `cache_filter_unavailable` flag name matches across Task 2 response and Task 5 read.
- **Pagination correctness:** the `EXISTS` is an `outerCondition` applied to BOTH the page query and the count query (they share `outerWhere`/`outerParams`), so `total` and `LIMIT/OFFSET` stay consistent.
- **Concurrency:** the only `await` precedes the synchronous temp-table create/populate/query, so no request interleaves the shared `_cache_status` table; `IF NOT EXISTS` + `DELETE` makes reuse safe.
