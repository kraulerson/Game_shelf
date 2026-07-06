# GOG Download Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface each owned GOG game's manual-download status ("Downloaded" / "Not downloaded") on the Game_shelf main-page card badge, the game-detail Cache panel, and a new filter facet — backed by exact GOG product-slug matching.

**Architecture:** GOG is NOT made a lancache platform. Downloaded status is computed live (in-memory 60s snapshot of the orchestrator's folder listing, mirroring `cacheSnapshot.js`), matched to owned games at query time via a query-time temp-table (mirroring the existing `_cache_status` temp-table), and matched exactly on a newly-persisted `game_editions.gog_slug` (fuzzy title-slug fallback retained).

**Tech Stack:** Express + better-sqlite3 (CommonJS) backend, `node:test`; React 18 + Vite + Tailwind + @tanstack/react-query frontend, vitest + RTL.

## Global Constraints

- **Repo:** `/Users/karl/Documents/Claude Projects/Game_shelf`, branch `feat/gog-download-visibility` (created, spec committed). NO Solo Orchestrator framework hooks here. Game_shelf-only — NO orchestrator/agent changes.
- **Do NOT add `gog` to `TRACKED_LAUNCHERS`** in `cacheBadge.js` — GOG must never render lancache action buttons (Prefill/Validate/Purge/Block) because `orchId` would be `undefined`. GOG uses a SEPARATE manual-download status path.
- **`download_status` is a NEW filter facet**, parallel to `cache_status` — never reuse or extend `cache_status` (collides with the `unknown` value GOG editions already get).
- **`download_status` values:** `'downloaded'`, `'not_downloaded'`, or `null` (game has no manual-launcher edition). Only games with a GOG (manual) edition get a non-null value.
- **Steam/epic `cache_status` behavior must be unchanged** (regression guard in every backend task that touches `games.js`).
- Frontend mutations = plain `fetch` + `queryClient.invalidateQueries` (no `useMutation`). Badge tones/icons already available: `green`/`gray` tones, `CheckCircle`/`Circle` icons (used by `STATUS_MAP`).
- One PR. Karl merges (never `gh pr merge`). PR closes #222 (cross-repo — state "Closes #222" in the body manually).
- Backend suite has **2 pre-existing failures** (`setup/qr`, `health`) — "no new failures" = the count stays 2.
- Run backend tests: `cd backend && node --test <file>` (single) / `node --test 'tests/**/*.test.js'` (all). Frontend: `cd frontend && npx vitest run <file>`.

## File Structure

- `backend/src/db/schema.sql` + `db/migrate.js` — add `game_editions.gog_slug TEXT`.
- `backend/src/services/launchers/gog.js` + `services/syncEngine.js` — capture + persist `gog_slug` at sync.
- `backend/src/services/manualCoverage.js` — exact `gog_slug` match + `downloadedGameIds()` export.
- `backend/src/services/manualCoverageSnapshot.js` (new) — in-memory TTL folder-list snapshot.
- `backend/src/routes/games.js` — `download_status` surface + filter facet + temp-table.
- `frontend/src/utils/cacheBadge.js` — `manualDownloadBadge()`.
- `frontend/src/components/GameCard.jsx` — render manual badge for GOG.
- `frontend/src/components/cache/CachePanel.jsx` — read-only GOG row (no lancache buttons).
- `frontend/src/components/FilterPanel.jsx` — download-status facet.

---

### Task 1: Migration — `game_editions.gog_slug`

**Files:**
- Modify: `backend/src/db/schema.sql` (game_editions CREATE TABLE)
- Modify: `backend/src/db/migrate.js` (guarded ADD COLUMN, before `return db;`)
- Test: `backend/tests/db/migrate-gog-slug.test.js` (create)

**Interfaces:**
- Produces: column `game_editions.gog_slug TEXT` (nullable), on both fresh and migrated DBs.

- [ ] **Step 1: Write the failing test** — `backend/tests/db/migrate-gog-slug.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('migrate: game_editions.gog_slug', () => {
  const dbPath = path.join(__dirname, '..', 'data', 'test-gog-slug-migrate.db');
  let db;
  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = dbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = dbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(dbPath);
  });
  after(() => {
    try { db.close(); } catch {}
    for (const s of ['', '-wal', '-shm']) { const f = dbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('adds gog_slug to game_editions', () => {
    const cols = db.pragma('table_info(game_editions)');
    assert.ok(cols.some((c) => c.name === 'gog_slug'), 'gog_slug column exists');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test tests/db/migrate-gog-slug.test.js` → FAIL (column absent).

- [ ] **Step 3: Implement.** In `backend/src/db/schema.sql`, add `gog_slug TEXT` to the `game_editions` CREATE TABLE column list (after `sandbox_type TEXT,` or any existing column — a nullable text column, no constraints). In `backend/src/db/migrate.js`, near the end of `runMigrations` (mirror the existing Phase-12 guarded ALTER blocks that use `db.pragma('table_info(game_editions)')`), before `return db;`:

```javascript
  // #222: GOG product slug for exact manual-download folder matching.
  const geColsGog = db.pragma('table_info(game_editions)');
  if (!geColsGog.some((c) => c.name === 'gog_slug')) {
    db.exec('ALTER TABLE game_editions ADD COLUMN gog_slug TEXT');
    console.log('[Migration] #222: added game_editions.gog_slug');
  }
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.sql backend/src/db/migrate.js backend/tests/db/migrate-gog-slug.test.js
git commit -m "feat(#222): add game_editions.gog_slug (migration)"
```

---

### Task 2: GOG sync persists `gog_slug`

**Files:**
- Modify: `backend/src/services/launchers/gog.js` (push `gog_slug` into the returned game object, ~line 117)
- Modify: `backend/src/services/syncEngine.js` (thread `gog_slug` through the upsert, lines 57-88)
- Test: `backend/tests/services/gog-sync-slug.test.js` (create)

**Interfaces:**
- Consumes: `game_editions.gog_slug` (Task 1).
- Produces: after a GOG sync, each synced edition row has `gog_slug = productRes.data.slug` (or null).

- [ ] **Step 1: Write the failing test** — `backend/tests/services/gog-sync-slug.test.js`. Unit-test at the `fetchOwnedGames` layer (mock axios) that the returned object carries `gog_slug`, AND that the syncEngine upsert persists it. The lightest true test: verify `GOGLauncher.fetchOwnedGames` includes `gog_slug` from the product `slug`. Mock `axios`:

```javascript
const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('GOG sync captures gog_slug', () => {
  afterEach(() => mock.reset());

  it('fetchOwnedGames returns the GOG product slug as gog_slug', async () => {
    const axios = require('axios');
    mock.method(axios, 'get', async (url) => {
      if (url.includes('/user/data/games')) return { data: { owned: [42] } };
      if (url.includes('/products/42')) return { data: { game_type: 'game', title: "Baldur's Gate II: EE", slug: 'baldurs_gate_2_enhanced_edition' } };
      throw new Error('unexpected url ' + url);
    });
    delete require.cache[require.resolve('../../src/services/launchers/gog')];
    const GOGLauncher = require('../../src/services/launchers/gog');
    const inst = new GOGLauncher();
    const games = await inst.fetchOwnedGames('tok');
    assert.equal(games.length, 1);
    assert.equal(games[0].gog_slug, 'baldurs_gate_2_enhanced_edition');
  });
});
```

> If `gog.js` `sleep(1000)` slows the test, the single-item list still only sleeps once (~1s) — acceptable. If the constructor needs args, mirror how existing GOG tests instantiate it (check `backend/tests` for an existing GOG test); otherwise `new GOGLauncher()` is fine.

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test tests/services/gog-sync-slug.test.js` → FAIL (`gog_slug` undefined).

- [ ] **Step 3: Implement.**
In `backend/src/services/launchers/gog.js`, in the `games.push({...})` object (~line 117), add `gog_slug`:

```javascript
        games.push({
          launcher_game_id: id.toString(),
          title,
          playtime_minutes: 0,
          gog_slug: productRes.data.slug || null,
        });
```

In `backend/src/services/syncEngine.js`, thread it through the upsert (lines 57-88): add `gog_slug` to the INSERT column list + a placeholder, the `.run()` arg, and the ON CONFLICT DO UPDATE set:

```javascript
    const upsert = db.prepare(`
      INSERT INTO game_editions (launcher_id, launcher_game_id, title, playtime_minutes, owned,
                                  epic_namespace, epic_catalog_id, sandbox_type, gog_slug)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(launcher_id, launcher_game_id) DO UPDATE SET
        title = excluded.title,
        playtime_minutes = excluded.playtime_minutes,
        epic_namespace = excluded.epic_namespace,
        epic_catalog_id = excluded.epic_catalog_id,
        sandbox_type = excluded.sandbox_type,
        gog_slug = COALESCE(excluded.gog_slug, game_editions.gog_slug),
        owned = 1
    `);
```

and in `upsert.run(...)` add `game.gog_slug || null` as the final argument (after `game.sandbox_type || null`). `COALESCE(excluded.gog_slug, game_editions.gog_slug)` preserves a previously-stored slug if a non-GOG launcher's sync (which has no `gog_slug`) touches the same row — harmless since the conflict key includes `launcher_id`, but defensive.

- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add backend/src/services/launchers/gog.js backend/src/services/syncEngine.js backend/tests/services/gog-sync-slug.test.js
git commit -m "feat(#222): GOG sync persists gog_slug for exact folder matching"
```

---

### Task 3: `manualCoverage` — exact `gog_slug` match + `downloadedGameIds`

**Files:**
- Modify: `backend/src/services/manualCoverage.js`
- Test: `backend/tests/services/manualCoverage.test.js` (extend if it exists; else create)

**Interfaces:**
- Consumes: `game_editions.gog_slug` (Task 1/2), `folderSlugForms` (existing).
- Produces:
  - `ownedGamesForLauncher(db, launcherName)` now also returns `gog_slug` per row.
  - `computeManualCoverage(games, folderNames)` matches on `gog_slug` (exact, against the folder name AND its `_game`/`_base`/`_gog`-suffix-stripped form) BEFORE the existing fuzzy `slug`/`title`/`edition_title` match.
  - NEW `downloadedGameIds(db, launcherName, folderNames) -> Set<number>` — the set of owned game ids present in the folder list (shares the matcher with `computeManualCoverage`).

- [ ] **Step 1: Write the failing test** — add to `backend/tests/services/manualCoverage.test.js`:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeManualCoverage, downloadedGameIds } = require('../../src/services/manualCoverage');

describe('manualCoverage exact gog_slug match', () => {
  it('matches on gog_slug even when title/slug would not', () => {
    // title "Baldur's Gate II: Enhanced Edition" slugifies to baldurs-gate-ii...,
    // which does NOT equal the folder slug — only gog_slug does.
    const games = [
      { id: 1, title: "Baldur's Gate II: Enhanced Edition", slug: 'baldurs-gate-ii-ee', edition_title: null, gog_slug: 'baldurs_gate_2_enhanced_edition' },
    ];
    const r = computeManualCoverage(games, ['baldurs_gate_2_enhanced_edition']);
    assert.equal(r.present, 1);
    assert.equal(r.missing.length, 0);
  });

  it('falls back to fuzzy title-slug match when gog_slug is null', () => {
    const games = [{ id: 2, title: 'Ancient Enemy', slug: 'a96de508', edition_title: null, gog_slug: null }];
    const r = computeManualCoverage(games, ['ancient_enemy']);
    assert.equal(r.present, 1);
  });

  it('downloadedGameIds returns the matched owned game ids', () => {
    const games = [
      { id: 1, title: 'X', slug: 'x', edition_title: null, gog_slug: 'baldurs_gate_2_enhanced_edition' },
      { id: 2, title: 'Missing Game', slug: 'missing-game', edition_title: null, gog_slug: 'missing_game' },
    ];
    // downloadedGameIds takes a db, but we test the pure matcher via computeManualCoverage's
    // shared path: expose a pure helper computeDownloadedIds(games, folderNames).
    const { computeDownloadedIds } = require('../../src/services/manualCoverage');
    const ids = computeDownloadedIds(games, ['baldurs_gate_2_enhanced_edition']);
    assert.deepEqual([...ids], [1]);
  });
});
```

> Note: this test imports `computeDownloadedIds(games, folderNames) -> Set<id>` (a PURE helper, no db) plus the db-bound `downloadedGameIds(db, launcher, folders)` that wraps it via `ownedGamesForLauncher`. Add both.

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test tests/services/manualCoverage.test.js` → FAIL (exact match + `computeDownloadedIds` missing).

- [ ] **Step 3: Implement.** In `backend/src/services/manualCoverage.js`:
1. `ownedGamesForLauncher`: add `ge.gog_slug AS gog_slug` to the SELECT.
2. Add a shared per-game match predicate. A game matches if:
   - its `gog_slug` (when set) equals any folder form (`folderSlugForms` already yields full + suffix-stripped; but `gog_slug` is raw underscored, so ALSO compare against the raw folder name and its suffix-stripped raw form — add a `folderRawForms(name)` returning `[name, name.replace(/_(?:game|base|gog)$/i,'')]` lowercased), OR
   - the existing fuzzy path: `[g.slug, g.title, g.edition_title]` slugified ∈ `allForms`.
3. Refactor: extract `computeDownloadedIds(games, folderNames) -> Set<id>` that runs the predicate over all games and returns the set of matched ids. Have `computeManualCoverage` call it (present = size; missing = the rest), so the two never diverge.
4. Add `downloadedGameIds(db, launcherName, folderNames)` = `computeDownloadedIds(ownedGamesForLauncher(db, launcherName), folderNames)`.
5. Export `computeDownloadedIds` and `downloadedGameIds` alongside the existing exports. Keep `fetchManualCoverage` working (it calls `computeManualCoverage`).

Exact matcher core (replace the per-game body inside the loop with a shared `isPresent(g, allForms, rawForms)`):

```javascript
function folderRawForms(name) {
  const raw = String(name).toLowerCase();
  const stripped = raw.replace(/_(?:game|base|gog)$/i, '');
  return stripped !== raw ? [raw, stripped] : [raw];
}

function computeDownloadedIds(games, folderNames) {
  const folders = (folderNames || []);
  const allForms = new Set(folders.flatMap((n) => folderSlugForms(n)));       // slugified forms
  const rawForms = new Set(folders.flatMap((n) => folderRawForms(n)));         // raw underscored forms
  const ids = new Set();
  for (const g of games) {
    const exact = g.gog_slug && rawForms.has(String(g.gog_slug).toLowerCase());
    const fuzzy = !exact && [g.slug, g.title, g.edition_title]
      .filter(Boolean)
      .map((c) => (c === g.slug ? c : slugify(c)))
      .some((s) => allForms.has(s));
    if (exact || fuzzy) ids.add(g.id);
  }
  return ids;
}

function downloadedGameIds(db, launcherName, folderNames) {
  return computeDownloadedIds(ownedGamesForLauncher(db, launcherName), folderNames);
}
```

Then rewrite `computeManualCoverage` to use it: `const present = computeDownloadedIds(games, folderNames); ... missing = games.filter(g => !present.has(g.id))`; `present: present.size`. (Recompute `extra_folders` from folders whose forms matched none — keep the existing extra_folders logic, or drop it if unused; do NOT change the returned shape's existing keys.)

- [ ] **Step 4: Run to verify it passes** — same command → PASS (new + existing manualCoverage tests).
- [ ] **Step 5: Commit**

```bash
git add backend/src/services/manualCoverage.js backend/tests/services/manualCoverage.test.js
git commit -m "feat(#222): exact gog_slug matching + downloadedGameIds()"
```

---

### Task 4: `manualCoverageSnapshot` service

**Files:**
- Create: `backend/src/services/manualCoverageSnapshot.js`
- Test: `backend/tests/services/manualCoverageSnapshot.test.js` (create)

**Interfaces:**
- Consumes: `services/orchestrator.js` `callOrchestrator('GET', '/api/v1/manual-downloads/<launcher>')`.
- Produces: `makeManualDownloadsSnapshot({ client, ttlMs, now })` with `get(launcher) -> { present, entries, stale }`, in-memory TTL (default 60s), serves last-good on error, coalesces concurrent refreshes PER LAUNCHER. Plus `getManualDownloadsSnapshot(launcher)` bound to the default client.

- [ ] **Step 1: Write the failing test** — `backend/tests/services/manualCoverageSnapshot.test.js` (mirror the `cacheSnapshot` behavior: fresh fetch, cached within TTL, last-good on error). Use a fake `now` and a stub client:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeManualDownloadsSnapshot } = require('../../src/services/manualCoverageSnapshot');

function stubClient(seq) { // seq: array of responses/errors returned in order per call
  let i = 0;
  return { calls: () => i, callOrchestrator: async () => { const r = seq[Math.min(i, seq.length - 1)]; i++; if (r instanceof Error) throw r; return r; } };
}

describe('manualCoverageSnapshot', () => {
  it('fetches, caches within TTL, refreshes after TTL', async () => {
    let t = 1000;
    const client = stubClient([
      { status: 200, data: { launcher: 'GOG', present: true, entries: ['a', 'b'] } },
      { status: 200, data: { launcher: 'GOG', present: true, entries: ['a', 'b', 'c'] } },
    ]);
    const snap = makeManualDownloadsSnapshot({ client, ttlMs: 60000, now: () => t });
    const r1 = await snap.get('GOG');
    assert.deepEqual(r1.entries, ['a', 'b']);
    t += 1000; // within TTL
    await snap.get('GOG');
    assert.equal(client.calls(), 1); // still cached
    t += 60000; // past TTL
    const r3 = await snap.get('GOG');
    assert.deepEqual(r3.entries, ['a', 'b', 'c']);
  });

  it('serves last-good on error, and empty when never fetched', async () => {
    let t = 0;
    const good = { status: 200, data: { present: true, entries: ['x'] } };
    const client = stubClient([good, new Error('orchestrator offline')]);
    const snap = makeManualDownloadsSnapshot({ client, ttlMs: 10, now: () => t });
    await snap.get('GOG');
    t += 100;
    const r = await snap.get('GOG');
    assert.deepEqual(r.entries, ['x']);
    assert.equal(r.stale, true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test tests/services/manualCoverageSnapshot.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** — `backend/src/services/manualCoverageSnapshot.js` (mirror `cacheSnapshot.js`, keyed per launcher):

```javascript
const orchestrator = require('./orchestrator');

const DEFAULT_TTL_MS = 60_000;

// In-memory snapshot of each manual launcher's downloaded-folder listing from the
// orchestrator (GET /api/v1/manual-downloads/<launcher>). Returns
// { present, entries, stale }. Serves last-good on error; coalesces concurrent
// refreshes per launcher. Mirrors services/cacheSnapshot.js.
function makeManualDownloadsSnapshot({ client = orchestrator, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const cache = new Map();    // launcher -> { present, entries, fetchedAt }
  const inflight = new Map(); // launcher -> Promise

  async function get(launcher) {
    const key = String(launcher);
    const cached = cache.get(key);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return { present: cached.present, entries: cached.entries, stale: false };
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const { status, data } = await client.callOrchestrator('GET', `/api/v1/manual-downloads/${encodeURIComponent(key)}`);
        if (status !== 200) throw Object.assign(new Error('manual-downloads fetch failed'), { status });
        const entry = { present: Boolean(data.present), entries: Array.isArray(data.entries) ? data.entries : [], fetchedAt: now() };
        cache.set(key, entry);
        return { present: entry.present, entries: entry.entries, stale: false };
      } catch {
        const last = cache.get(key);
        if (last) return { present: last.present, entries: last.entries, stale: true };
        return { present: false, entries: [], stale: true };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  return { get };
}

const defaultSnapshot = makeManualDownloadsSnapshot();

module.exports = {
  makeManualDownloadsSnapshot,
  getManualDownloadsSnapshot: (launcher) => defaultSnapshot.get(launcher),
};
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add backend/src/services/manualCoverageSnapshot.js backend/tests/services/manualCoverageSnapshot.test.js
git commit -m "feat(#222): in-memory manual-downloads folder snapshot (mirrors cacheSnapshot)"
```

---

### Task 5: `games.js` — surface `download_status` + filter facet

**Files:**
- Modify: `backend/src/routes/games.js` (GET `/` list route ~384-560; GET `/:id` ~80-160)
- Test: `backend/tests/routes/games-download-status.test.js` (create)

**Interfaces:**
- Consumes: `downloadedGameIds` (Task 3), `getManualDownloadsSnapshot` (Task 4).
- Produces: GET `/api/games` list rows each carry `download_status ∈ {'downloaded','not_downloaded',null}`; `?download_status=downloaded|not_downloaded` (comma-multi-select) filters; GET `/api/games/:id` carries `download_status` on the game. Steam/epic `cache_status` UNCHANGED.

**Read first:** `routes/games.js` lines 384-560 (the `cache_status` block builds `_cache_status` TEMP TABLE at ~454, filters via subquery ~484). Mirror that shape for a `_manual_downloaded` temp table of game ids.

- [ ] **Step 1: Write the failing test** — `backend/tests/routes/games-download-status.test.js`. Mirror the harness in `backend/tests/routes/cache.test.js` (`makeFetch(app, path, opts)` + `gameshelf_session` JWT cookie; a mock orchestrator HTTP server that answers `GET /api/v1/manual-downloads/GOG` with `{present:true, entries:[...]}`; seed a GOG game whose `gog_slug` matches a folder, and one that does not). Assertions:

```javascript
// (harness setup mirrors cache.test.js: startMock() answering /api/v1/manual-downloads/GOG
//  -> { present:true, entries:['baldurs_gate_2_enhanced_edition'] }; makeFetch; authCookie;
//  seed launchers(gog), games+game_editions: game 1 gog_slug 'baldurs_gate_2_enhanced_edition',
//  game 2 gog_slug 'not_on_disk'.)

it('surfaces download_status per game in the list', async () => {
  const res = await makeFetch(app, '/api/games?owned=true', { headers: { Cookie: authCookie() } });
  const body = await res.json();
  const g1 = body.games.find((g) => g.id === 1);
  const g2 = body.games.find((g) => g.id === 2);
  assert.equal(g1.download_status, 'downloaded');
  assert.equal(g2.download_status, 'not_downloaded');
});

it('?download_status=downloaded filters to downloaded GOG games', async () => {
  const res = await makeFetch(app, '/api/games?owned=true&download_status=downloaded', { headers: { Cookie: authCookie() } });
  const body = await res.json();
  assert.ok(body.games.every((g) => g.download_status === 'downloaded'));
  assert.ok(body.games.some((g) => g.id === 1));
  assert.ok(!body.games.some((g) => g.id === 2));
});
```

> Match the actual list-response shape (`body.games` vs `body.data` — check cache.test.js / an existing games list test) and the actual pagination params. If the list route requires other params, copy them from an existing games-list test.

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test tests/routes/games-download-status.test.js` → FAIL (`download_status` undefined; filter ignored).

- [ ] **Step 3: Implement.** In `routes/games.js`:
1. Import at top: `const { downloadedGameIds } = require('../services/manualCoverage'); const { getManualDownloadsSnapshot } = require('../services/manualCoverageSnapshot');`
2. In the GET `/` handler, near the `cache_status` block, ALWAYS (not only when filtering) build a downloaded-id set for GOG and a temp table:

```javascript
  // #222: GOG manual-download status (separate facet from lancache cache_status).
  const { entries: gogFolders } = await getManualDownloadsSnapshot('GOG');
  const downloadedIds = downloadedGameIds(db, 'gog', gogFolders);
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _manual_downloaded(game_id INTEGER PRIMARY KEY)');
  db.exec('DELETE FROM _manual_downloaded');
  const insDl = db.prepare('INSERT OR IGNORE INTO _manual_downloaded(game_id) VALUES (?)');
  const insDlAll = db.transaction((ids) => { for (const id of ids) insDl.run(id); });
  insDlAll([...downloadedIds]);
```

3. Surface `download_status` in the list SELECT/response: a game has `download_status = 'downloaded'` if in `_manual_downloaded`, `'not_downloaded'` if it has a GOG edition but is not in the set, else `null`. Compute it in the row-mapping step (simplest: after fetching rows, for each game determine `hasGog` via a `Set` of game ids that have a gog edition — `SELECT DISTINCT ge.game_id FROM game_editions ge JOIN launchers l ON l.id=ge.launcher_id WHERE l.name='gog'` — and set `download_status = downloadedIds.has(id) ? 'downloaded' : (hasGog.has(id) ? 'not_downloaded' : null)`). Prefer computing in JS over SQL to avoid touching the large list query.
4. Filter: parse `download_status` (comma-split, like `cache_status`); if present, filter the returned games by membership (JS filter on the mapped `download_status`) OR add an `outerConditions` clause `g.id IN (SELECT game_id FROM _manual_downloaded)` for `downloaded` / `g.id IN (gog-edition games) AND g.id NOT IN (_manual_downloaded)` for `not_downloaded`. JS post-filter is acceptable if pagination is applied after (check the route's pagination order; if pagination is in SQL, use the SQL `outerConditions` path so counts stay correct).
5. In GET `/:id` (~80-160), add `download_status` to the returned game object using the same `downloadedGameIds` + hasGog logic for that single id.

> Keep the `cache_status` block and steam/epic behavior byte-for-byte unchanged. `download_status` is additive.

- [ ] **Step 4: Run to verify it passes** — `cd backend && node --test tests/routes/games-download-status.test.js` → PASS; then `cd backend && node --test tests/routes/games.test.js` (or the existing games-list test) → no new failures.
- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/games.js backend/tests/routes/games-download-status.test.js
git commit -m "feat(#222): surface download_status + filter facet in games API"
```

---

### Task 6: `manualDownloadBadge()` util

**Files:**
- Modify: `frontend/src/utils/cacheBadge.js`
- Test: `frontend/src/utils/cacheBadge.test.js` (extend if it exists; else create)

**Interfaces:**
- Produces: `manualDownloadBadge(downloadStatus) -> { icon, tone, label } | null`. `'downloaded'` → `{icon:'CheckCircle', tone:'green', label:'Downloaded'}`; `'not_downloaded'` → `{icon:'Circle', tone:'gray', label:'Not downloaded'}`; anything else → `null`.

- [ ] **Step 1: Write the failing test** — add to `frontend/src/utils/cacheBadge.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { manualDownloadBadge } from './cacheBadge';

describe('manualDownloadBadge', () => {
  it('maps downloaded -> green Downloaded', () => {
    expect(manualDownloadBadge('downloaded')).toEqual({ icon: 'CheckCircle', tone: 'green', label: 'Downloaded' });
  });
  it('maps not_downloaded -> gray Not downloaded', () => {
    expect(manualDownloadBadge('not_downloaded')).toEqual({ icon: 'Circle', tone: 'gray', label: 'Not downloaded' });
  });
  it('returns null for null/unknown', () => {
    expect(manualDownloadBadge(null)).toBeNull();
    expect(manualDownloadBadge('whatever')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && npx vitest run src/utils/cacheBadge.test.js` → FAIL (not exported).

- [ ] **Step 3: Implement** — in `frontend/src/utils/cacheBadge.js`, add (do NOT touch `TRACKED_LAUNCHERS`):

```javascript
// Manual-download launchers (GOG/Humble/Itch/Amazon) aren't lancache-cached —
// they have a downloaded/not-downloaded status instead of a cache status. This is
// a SEPARATE badge path from cacheBadgeFor (which is lancache-only).
export function manualDownloadBadge(downloadStatus) {
  if (downloadStatus === 'downloaded') return { icon: 'CheckCircle', tone: 'green', label: 'Downloaded' };
  if (downloadStatus === 'not_downloaded') return { icon: 'Circle', tone: 'gray', label: 'Not downloaded' };
  return null;
}
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/cacheBadge.js frontend/src/utils/cacheBadge.test.js
git commit -m "feat(#222): manualDownloadBadge() util"
```

---

### Task 7: `GameCard` renders the manual badge for GOG

**Files:**
- Modify: `frontend/src/components/GameCard.jsx`
- Test: `frontend/src/components/GameCard.download.test.jsx` (create)

**Interfaces:**
- Consumes: `game.download_status` (Task 5), `manualDownloadBadge` (Task 6), existing `launcherToPlatform` + `cacheBadgeFor`.
- Produces: a GOG-only card (no lancache platform) with `download_status` shows the Downloaded/Not-downloaded badge; a steam/epic card is unchanged.

**Read first:** `GameCard.jsx` ~lines 20-100 — how it derives `platform = launcherToPlatform(cache_launcher_name||launcher_name)`, `tracked = Boolean(platform)`, and renders `<CacheBadge .../>` (or the badge descriptor). The change: when `!platform` (not a lancache launcher) AND `manualDownloadBadge(game.download_status)` is non-null, render THAT badge instead of the neutral one.

- [ ] **Step 1: Write the failing test** — `frontend/src/components/GameCard.download.test.jsx`. Mirror the render harness of an existing GameCard test (QueryClientProvider + MemoryRouter if it uses `<Link>`). Render a GOG game `{ id: 1, title: 'GOG Game', launcher_name: 'gog', download_status: 'downloaded', editions: [...] }` and assert "Downloaded" appears; render one with `download_status:'not_downloaded'` and assert "Not downloaded".

```javascript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import GameCard from './GameCard';

function wrap(game) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><GameCard game={game} /></MemoryRouter></QueryClientProvider>
  );
}

describe('GameCard GOG download badge', () => {
  it('shows Downloaded for a downloaded GOG game', () => {
    wrap({ id: 1, title: 'GOG Game', slug: 'gog-game', launcher_name: 'gog', download_status: 'downloaded' });
    expect(screen.getByText('Downloaded')).toBeInTheDocument();
  });
  it('shows Not downloaded for a not-downloaded GOG game', () => {
    wrap({ id: 2, title: 'GOG Game 2', slug: 'gog-game-2', launcher_name: 'gog', download_status: 'not_downloaded' });
    expect(screen.getByText('Not downloaded')).toBeInTheDocument();
  });
});
```

> Match the exact `game` prop shape GameCard expects (check an existing GameCard test for required fields like `cover_url`, `launchers`, `editions`). Add whatever fields are needed to render without throwing; keep the two assertions.

- [ ] **Step 2: Run to verify it fails** — `cd frontend && npx vitest run src/components/GameCard.download.test.jsx` → FAIL (no such text).

- [ ] **Step 3: Implement** — in `GameCard.jsx`, import `manualDownloadBadge`, and where the badge is chosen: if `platform` is falsy and `manualDownloadBadge(game.download_status)` is non-null, render a badge from that descriptor (reuse the existing `CacheBadge` presentational component if it accepts an `{icon,tone,label}` descriptor, or render the same markup the neutral badge uses with the descriptor's label/tone). Do not alter the steam/epic branch.

- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/GameCard.jsx frontend/src/components/GameCard.download.test.jsx
git commit -m "feat(#222): GameCard shows GOG Downloaded/Not-downloaded badge"
```

---

### Task 8: `CachePanel` — read-only GOG row (no lancache buttons)

**Files:**
- Modify: `frontend/src/components/cache/CachePanel.jsx`
- Modify: `frontend/src/pages/GameDetail.jsx` (pass `download_status` to CachePanel if not already available)
- Test: `frontend/src/components/cache/CachePanel.test.jsx` (extend)

**Interfaces:**
- Consumes: `game.download_status` (Task 5), `manualDownloadBadge` (Task 6).
- Produces: for a game whose editions include a GOG (manual) edition, CachePanel renders a "GOG — Downloaded/Not downloaded" row with NO Prefill/Validate/Complete-Re-download/Delete/Block buttons. steam/epic rows unchanged. A GOG-only game's panel is no longer `null`.

**Read first:** `CachePanel.jsx` lines 36-40 (`tracked` filter + `if (tracked.length === 0) return null`). The panel currently receives `editions`. It needs `download_status` — pass it as a prop from `GameDetail.jsx` (`<CachePanel editions={game.editions} downloadStatus={game.download_status} />`).

- [ ] **Step 1: Write the failing test** — add to `frontend/src/components/cache/CachePanel.test.jsx`:

```javascript
it('renders a read-only Downloaded row for a GOG edition (no lancache buttons)', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [] }) }));
  const gogEditions = [{ id: 21, launcher_name: 'gog', launcher_game_id: '123', launcher_display_name: 'GOG' }];
  wrap(<CachePanel editions={gogEditions} downloadStatus="downloaded" />);
  expect(await screen.findByText('Downloaded')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^prefill$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^validate$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /delete from cache/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && npx vitest run src/components/cache/CachePanel.test.jsx` → FAIL (panel returns null / no "Downloaded").

- [ ] **Step 3: Implement** — in `CachePanel.jsx`: accept a `downloadStatus` prop. Split editions into lancache-tracked (`launcherToPlatform` truthy) and manual (GOG etc.). Render tracked rows exactly as today. THEN render manual rows: for each GOG edition, a row showing `launcher_display_name` + a `manualDownloadBadge(downloadStatus)` badge (green Downloaded / gray Not downloaded) and NO action buttons. Change the early-return so the panel renders when EITHER tracked OR manual editions exist (`if (tracked.length === 0 && manual.length === 0) return null`). In `GameDetail.jsx`, pass `downloadStatus={game.download_status}` to `<CachePanel>`.

- [ ] **Step 4: Run to verify it passes** — same command → PASS (new + existing CachePanel tests, incl. the steam/epic ones).
- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/cache/CachePanel.jsx frontend/src/pages/GameDetail.jsx frontend/src/components/cache/CachePanel.test.jsx
git commit -m "feat(#222): CachePanel read-only GOG downloaded row (no lancache buttons)"
```

---

### Task 9: `FilterPanel` — download-status facet

**Files:**
- Modify: `frontend/src/components/FilterPanel.jsx`
- Test: `frontend/src/components/FilterPanel.download.test.jsx` (create, or extend an existing FilterPanel test)

**Interfaces:**
- Consumes: `?download_status=` query param (Task 5).
- Produces: a "Download status" filter group with Downloaded / Not downloaded options that toggle `?download_status=downloaded|not_downloaded` in the URL, mirroring the multi-select behavior of the existing `cache_status` facet.

**Read first:** `FilterPanel.jsx` — the `CACHE_STATUS_OPTIONS` array + how a cache-status option toggles `searchParams` (the exact `setSearchParams` pattern, comma-join multi-select).

- [ ] **Step 1: Write the failing test** — `frontend/src/components/FilterPanel.download.test.jsx`. Mirror an existing FilterPanel test's harness (router + QueryClient; the filters query stubbed). Assert a "Downloaded" option renders and clicking it sets `download_status=downloaded` in the URL. If no existing FilterPanel test exists to mirror, assert the presence of the "Download status" heading + the two option labels.

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import FilterPanel from './FilterPanel';

beforeEach(() => vi.restoreAllMocks());

it('renders a Download status facet with Downloaded / Not downloaded', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ genres: [], tags: [], years: [], launchers: [] }) }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}><MemoryRouter><FilterPanel open={true} onClose={() => {}} /></MemoryRouter></QueryClientProvider>
  );
  expect(screen.getByText('Downloaded')).toBeInTheDocument();
  expect(screen.getByText('Not downloaded')).toBeInTheDocument();
});
```

> Match the `filters` query response shape FilterPanel expects (check its `useQuery(['gameFilters'])` usage). Keep the assertions.

- [ ] **Step 2: Run to verify it fails** — `cd frontend && npx vitest run src/components/FilterPanel.download.test.jsx` → FAIL.

- [ ] **Step 3: Implement** — in `FilterPanel.jsx`, add `const DOWNLOAD_STATUS_OPTIONS = [{ key: 'downloaded', label: 'Downloaded' }, { key: 'not_downloaded', label: 'Not downloaded' }];` and render a "Download status" group that toggles `?download_status=` exactly the way the `cache_status` group toggles its param (reuse the same handler/pattern — comma-join multi-select via `setSearchParams`).

- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/FilterPanel.jsx frontend/src/components/FilterPanel.download.test.jsx
git commit -m "feat(#222): FilterPanel download-status facet"
```

---

### Task 10: Full verification + PR

**Files:** none (verification only).

- [ ] **Step 1: Backend suite** — `cd backend && node --test 'tests/**/*.test.js'` → only the 2 pre-existing failures (`setup/qr`, `health`); all new tests PASS.
- [ ] **Step 2: Frontend suite + build** — `cd frontend && npx vitest run && npm run build` → all pass; build succeeds.
- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/gog-download-visibility
gh pr create --base master --title "feat(#222): surface GOG manual-download status (badge + game detail + filter)" --body "..."
```

PR body: summarize — surfaces owned GOG games' downloaded/not-downloaded status on the main-page card badge, the game-detail Cache panel, and a new "Download status" filter facet; backed by exact `game_editions.gog_slug` matching captured at GOG sync (fuzzy title-slug fallback retained); in-memory manual-downloads snapshot mirrors the steam/epic `cacheSnapshot`; GOG kept OUT of the lancache action-button path; **no orchestrator changes**; **Closes #222** (cross-repo). Note: existing GOG rows need one `library sync` to backfill `gog_slug` for exact matching. Karl merges.

---

## Self-Review

**Spec coverage:** persist `gog_slug` → Task 1+2 ✓; exact match + `downloadedGameIds` → Task 3 ✓; in-memory snapshot → Task 4 ✓; `download_status` surface + filter facet → Task 5 ✓; `manualDownloadBadge` → Task 6 ✓; GameCard badge → Task 7 ✓; CachePanel GOG row w/o lancache buttons → Task 8 ✓; FilterPanel facet → Task 9 ✓; verification/PR → Task 10 ✓. Non-goals (no orchestrator change, no persisted flag, `TRACKED_LAUNCHERS` untouched, multi-launcher card follows lancache) respected.

**Placeholder scan:** genuinely-new code (manualCoverageSnapshot, manualDownloadBadge, computeDownloadedIds, the temp-table block) is given in full. Integration edits into large existing files (games.js list route, GameCard, CachePanel, FilterPanel) are specified as exact-change + pattern-anchor + exact test — the implementer reads the named file/lines first (called out in each task's "Read first"). This is the DRY choice for edits into 500-line files, not a placeholder.

**Type consistency:** `gog_slug` (column + per-row field + `game.gog_slug`), `download_status` ∈ {`downloaded`,`not_downloaded`,`null`} (SQL-derived + games API field + `game.download_status` prop), `downloadedGameIds(db,launcher,folders)→Set`, `computeDownloadedIds(games,folders)→Set`, `getManualDownloadsSnapshot(launcher)→{present,entries,stale}`, `manualDownloadBadge(status)→{icon,tone,label}|null` — consistent across Tasks 1-9.
