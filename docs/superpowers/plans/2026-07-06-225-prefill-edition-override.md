# #225 Per-Game Prefill-Edition Override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator override, per game, whether a Steam+Epic game's **Epic** edition gets prefilled — independent of the #224 display edition.

**Architecture:** Game_shelf-only. A new `edition_tiers.is_prefill_edition` flag (mirrors `is_display_edition`) removes a chosen Steam+Epic game's Epic edition from the cross-launcher exclusion set (`computeSteamCoveredEpicAppIds`) that Game_shelf already pushes to the orchestrator, so the Epic scheduled prefill caches it. Default (no override) = Steam wins, unchanged. No orchestrator changes.

**Tech Stack:** Express + better-sqlite3 (ESM), `node:test` backend; React 18 + Vite + Tailwind + @tanstack/react-query, vitest frontend.

## Global Constraints

- **Repo:** `/Users/karl/Documents/Claude Projects/Game_shelf`, branch `feat/225-prefill-edition-override` (already created, spec committed). NO Solo Orchestrator framework hooks here.
- **Toggle scope:** the prefill override is meaningful **only for games owned on BOTH Steam and Epic**. Default resolved prefill edition = the **Steam** edition. Epic-only / Epic+non-Steam games always auto-prefill Epic (never in the exclusion set) — no override, no UI.
- **Reach (Karl's choice):** the override only controls whether **Epic** is prefilled. Do NOT touch the host SteamPrefill selection. Setting prefill=Epic = "stop excluding this Epic edition"; Steam is left to its cron.
- **Mirror existing patterns:** `is_prefill_edition` mirrors `is_display_edition` (`edition_tiers`); the setter mirrors `POST /:id/display-edition`; the UI mirrors the "Set as display" button. Frontend data mutations = plain `fetch` + `queryClient.invalidateQueries` (NO `useMutation`).
- **One PR** for the whole feature. Karl merges (never `gh pr merge`).
- Backend suite has **2 pre-existing failures** (`setup/qr`, `health`) — "no NEW failures" means the count stays 2.
- Run backend tests: `cd backend && node --test <file>` (single) or `node --test 'tests/**/*.test.js'` (all). Frontend: `cd frontend && npx vitest run <file>`.

---

### Task 1: Migration — `edition_tiers.is_prefill_edition`

**Files:**
- Modify: `backend/src/db/schema.sql` (edition_tiers CREATE TABLE)
- Modify: `backend/src/db/migrate.js` (guarded ADD COLUMN for existing DBs)
- Test: `backend/tests/db/migrate-prefill-edition.test.js` (create)

**Interfaces:**
- Produces: column `edition_tiers.is_prefill_edition INTEGER DEFAULT 0`. Present on both fresh (schema.sql) and migrated (migrate.js) DBs.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/db/migrate-prefill-edition.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('migrate: edition_tiers.is_prefill_edition', () => {
  const dbPath = path.join(__dirname, '..', 'data', 'test-prefill-migrate.db');
  let db;
  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = dbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = dbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(dbPath);
  });
  after(() => { try { db.close(); } catch {} });

  it('adds is_prefill_edition to edition_tiers (default 0)', () => {
    const cols = db.prepare("PRAGMA table_info(edition_tiers)").all();
    const col = cols.find((c) => c.name === 'is_prefill_edition');
    assert.ok(col, 'is_prefill_edition column exists');
    assert.equal(col.dflt_value, '0');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test tests/db/migrate-prefill-edition.test.js`
Expected: FAIL — `is_prefill_edition column exists` assertion fails (column absent).

- [ ] **Step 3: Implement**

In `backend/src/db/schema.sql`, add the column to the `edition_tiers` CREATE TABLE (after `is_display_edition INTEGER DEFAULT 0,`):

```sql
  is_display_edition INTEGER DEFAULT 0,
  is_prefill_edition INTEGER DEFAULT 0,
```

In `backend/src/db/migrate.js`, add a guarded migration near the end of `runMigrations` (after the last existing migration block, before `return db;`):

```javascript
  // #225: per-game prefill-edition override (mirrors is_display_edition).
  const etCols = db.prepare("PRAGMA table_info(edition_tiers)").all();
  if (!etCols.some((c) => c.name === 'is_prefill_edition')) {
    db.exec('ALTER TABLE edition_tiers ADD COLUMN is_prefill_edition INTEGER DEFAULT 0');
    console.log('[Migration] #225: added edition_tiers.is_prefill_edition');
  }
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.sql backend/src/db/migrate.js backend/tests/db/migrate-prefill-edition.test.js
git commit -m "feat(#225): add edition_tiers.is_prefill_edition (migration)"
```

---

### Task 2: Compute — exclude Epic unless it's the chosen prefill edition

**Files:**
- Modify: `backend/src/services/crossLauncherExclusions.js` (`computeSteamCoveredEpicAppIds`)
- Test: `backend/tests/services/crossLauncherExclusions.test.js` (add cases)

**Interfaces:**
- Consumes: `edition_tiers.is_prefill_edition` (Task 1).
- Produces: `computeSteamCoveredEpicAppIds(db)` still returns the sorted Epic `launcher_game_id`s covered by Steam, but now EXCLUDES any Epic edition whose `edition_tiers.is_prefill_edition = 1`.

- [ ] **Step 1: Write the failing test**

In `backend/tests/services/crossLauncherExclusions.test.js`, add a game + two assertions inside the existing `describe`'s seed + `it`. After the existing seed rows (Game 60), add:

```javascript
    // Game 70: Steam + Epic, operator OVERRODE prefill to the Epic edition ->
    // its Epic app_id must NOT be covered (Epic should get prefilled).
    db.prepare("INSERT INTO games (id,title,slug) VALUES (70,'Override Game','override-game')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (700,70,1,'700steam','OG (Steam)')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (701,70,2,'epic-override','OG (Epic)')").run();
    db.prepare("INSERT INTO edition_tiers (game_edition_id, is_prefill_edition) VALUES (701, 1)").run();
```

Add a new `it` (in the same describe):

```javascript
  it('excludes an Epic edition the operator chose to prefill (is_prefill_edition=1)', () => {
    const ids = compute(db);
    assert.ok(!ids.includes('epic-override'), 'overridden Epic edition is NOT in the covered set');
    assert.ok(ids.includes('epic-cs'), 'a normal Steam+Epic game is still covered by default');
  });
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test tests/services/crossLauncherExclusions.test.js`
Expected: FAIL — `epic-override` IS in the set (compute doesn't yet honor the flag).

- [ ] **Step 3: Implement**

In `backend/src/services/crossLauncherExclusions.js`, change the query in `computeSteamCoveredEpicAppIds` to LEFT JOIN `edition_tiers` and skip prefill-chosen Epic editions:

```javascript
  const rows = db
    .prepare(
      `SELECT DISTINCT CAST(ge.launcher_game_id AS TEXT) AS app_id
         FROM game_editions ge
         JOIN launchers le ON le.id = ge.launcher_id AND le.name = 'epic'
         LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
        WHERE ge.game_id IS NOT NULL
          AND ge.launcher_game_id IS NOT NULL
          AND COALESCE(et.is_prefill_edition, 0) = 0
          AND EXISTS (
            SELECT 1 FROM game_editions ge2
              JOIN launchers ls ON ls.id = ge2.launcher_id AND ls.name = 'steam'
             WHERE ge2.game_id = ge.game_id
          )`
    )
    .all();
```

(Only the `LEFT JOIN edition_tiers` line and the `AND COALESCE(et.is_prefill_edition, 0) = 0` line are new.)

- [ ] **Step 4: Run to verify it passes** — same command → PASS (new case + all existing cases).
- [ ] **Step 5: Commit**

```bash
git add backend/src/services/crossLauncherExclusions.js backend/tests/services/crossLauncherExclusions.test.js
git commit -m "feat(#225): compute — don't exclude an Epic edition chosen for prefill"
```

---

### Task 3: Backend setter — `POST /api/games/:id/prefill-edition`

**Files:**
- Modify: `backend/src/routes/games.js` (add the route; import `syncCrossLauncherExclusions`)
- Test: `backend/tests/routes/games-prefill-edition.test.js` (create)

**Interfaces:**
- Consumes: `edition_tiers.is_prefill_edition` (Task 1), `syncCrossLauncherExclusions` (existing).
- Produces: `POST /api/games/:id/prefill-edition` body `{ edition_id }` (or `{ edition_id: null }` to clear) → `{ ok: true }`. Sets `is_prefill_edition=1` on the chosen Epic edition (clears siblings), creating the `edition_tiers` row if missing. Guards: 404 unknown game; 400 edition-not-in-game / not-Epic / game-not-also-on-Steam. Fire-and-forget triggers a cross-launcher sync.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/routes/games-prefill-edition.test.js`. Mirror the existing route-test harness (start the app with a seeded test DB — copy the setup style from `backend/tests/routes/cache.test.js`: build the app via `require('../../src/server')` with `GAMESHELF_DB_PATH` pointed at a fresh migrated DB, and an auth cookie helper). Point `ORCH_API_URL` at an unused port so the fire-and-forget sync fails fast (the route still returns ok).

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

describe('POST /api/games/:id/prefill-edition', () => {
  const dbPath = path.join(__dirname, '..', 'data', 'test-prefill-edition-route.db');
  let app, db;
  const authCookie = () =>
    `gs_token=${jwt.sign({ sub: 'test' }, process.env.GAMESHELF_JWT_SECRET)}`;

  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = dbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = dbPath;
    process.env.ORCH_API_URL = 'http://127.0.0.1:9'; // unreachable -> sync fails fast, route still ok
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(dbPath);
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (1,'steam','Steam',1,1)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (2,'epic','Epic',1,2)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (3,'gog','GOG',1,3)").run();
    // Game 10: Steam + Epic
    db.prepare("INSERT INTO games (id,title,slug) VALUES (10,'Dual','dual')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (100,10,1,'s10','Dual Steam')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (101,10,2,'e10','Dual Epic')").run();
    // Game 20: Epic only
    db.prepare("INSERT INTO games (id,title,slug) VALUES (20,'EpicOnly','epic-only')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (200,20,2,'e20','EO Epic')").run();
    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));
  });
  after(() => { try { db.close(); } catch {} });

  const post = (id, body) =>
    require('supertest')(app).post(`/api/games/${id}/prefill-edition`).set('Cookie', authCookie()).send(body);

  it('sets is_prefill_edition on the Epic edition of a Steam+Epic game', async () => {
    const r = await post(10, { edition_id: 101 });
    assert.equal(r.status, 200);
    const row = db.prepare('SELECT is_prefill_edition FROM edition_tiers WHERE game_edition_id = 101').get();
    assert.equal(row.is_prefill_edition, 1);
  });

  it('clearing (edition_id: null) resets the override', async () => {
    await post(10, { edition_id: 101 });
    const r = await post(10, { edition_id: null });
    assert.equal(r.status, 200);
    const row = db.prepare('SELECT is_prefill_edition FROM edition_tiers WHERE game_edition_id = 101').get();
    assert.equal(row.is_prefill_edition, 0);
  });

  it('400 when the target edition is not Epic', async () => {
    const r = await post(10, { edition_id: 100 }); // Steam edition
    assert.equal(r.status, 400);
  });

  it('400 when the game is not also on Steam', async () => {
    const r = await post(20, { edition_id: 200 }); // Epic-only game
    assert.equal(r.status, 400);
  });

  it('404 for an unknown game', async () => {
    const r = await post(9999, { edition_id: 1 });
    assert.equal(r.status, 404);
  });
});
```

> Note: if the repo's route tests use a different HTTP harness than `supertest`, mirror that harness (check `backend/tests/routes/cache.test.js`'s `makeFetch` helper) instead of `supertest` — keep the assertions identical.

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test tests/routes/games-prefill-edition.test.js`
Expected: FAIL — route 404s (not registered) on every case.

- [ ] **Step 3: Implement**

In `backend/src/routes/games.js`: ensure `syncCrossLauncherExclusions` is imported at the top:

```javascript
const { syncCrossLauncherExclusions } = require('../services/crossLauncherExclusions');
```

Add the route immediately after the existing `POST /:id/display-edition` handler:

```javascript
// POST /api/games/:id/prefill-edition — override which edition gets prefilled
// (separate from the display edition). Only meaningful for a Steam+Epic game;
// setting the Epic edition stops it being cross-launcher-excluded so Epic caches.
router.post('/:id/prefill-edition', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { edition_id } = req.body || {};

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const clearAll = db.prepare(`
    UPDATE edition_tiers SET is_prefill_edition = 0
    WHERE game_edition_id IN (SELECT id FROM game_editions WHERE game_id = ?)
  `);

  if (edition_id == null) {
    clearAll.run(id); // revert to default (Steam)
  } else {
    const ed = db.prepare(`
      SELECT ge.id, l.name AS launcher
        FROM game_editions ge JOIN launchers l ON l.id = ge.launcher_id
       WHERE ge.id = ? AND ge.game_id = ?
    `).get(edition_id, id);
    if (!ed) return res.status(400).json({ error: 'Edition does not belong to this game' });
    if (ed.launcher !== 'epic')
      return res.status(400).json({ error: 'Prefill override only applies to an Epic edition' });
    const hasSteam = db.prepare(`
      SELECT 1 FROM game_editions ge JOIN launchers l ON l.id = ge.launcher_id
       WHERE ge.game_id = ? AND l.name = 'steam' LIMIT 1
    `).get(id);
    if (!hasSteam)
      return res.status(400).json({ error: 'Prefill override only applies when the game is also on Steam' });
    db.transaction(() => {
      clearAll.run(id);
      db.prepare('INSERT OR IGNORE INTO edition_tiers (game_edition_id) VALUES (?)').run(edition_id);
      db.prepare('UPDATE edition_tiers SET is_prefill_edition = 1 WHERE game_edition_id = ?').run(edition_id);
    })();
  }

  // Actuate promptly; fire-and-forget (the daily cron is the backstop, and this
  // must not fail the request if the orchestrator is offline).
  syncCrossLauncherExclusions(db).catch(() => {});
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS (5 cases).
- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/games.js backend/tests/routes/games-prefill-edition.test.js
git commit -m "feat(#225): POST /api/games/:id/prefill-edition setter"
```

---

### Task 4: GET game — surface `is_prefill_edition` + `has_prefill_choice`

**Files:**
- Modify: `backend/src/routes/games.js` (the `GET /:id` editions query + response)
- Test: `backend/tests/routes/games-prefill-edition.test.js` (add GET cases to the same file)

**Interfaces:**
- Produces: `GET /api/games/:id` — each edition gains `is_prefill_edition: boolean` (true for the RESOLVED prefill edition: the override if set, else the Steam edition), and the game object gains `has_prefill_choice: boolean` (true iff the game has both a Steam and an Epic edition).

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/routes/games-prefill-edition.test.js`:

```javascript
  const getGame = (id) =>
    require('supertest')(app).get(`/api/games/${id}`).set('Cookie', authCookie());

  it('GET exposes has_prefill_choice + default prefill=Steam', async () => {
    await post(10, { edition_id: null }); // ensure default
    const r = await getGame(10);
    assert.equal(r.status, 200);
    assert.equal(r.body.has_prefill_choice, true);
    const steam = r.body.editions.find((e) => e.launcher_name === 'steam');
    const epic = r.body.editions.find((e) => e.launcher_name === 'epic');
    assert.equal(steam.is_prefill_edition, true);   // default: Steam
    assert.equal(epic.is_prefill_edition, false);
  });

  it('GET reflects an Epic prefill override', async () => {
    await post(10, { edition_id: 101 });
    const r = await getGame(10);
    const epic = r.body.editions.find((e) => e.launcher_name === 'epic');
    const steam = r.body.editions.find((e) => e.launcher_name === 'steam');
    assert.equal(epic.is_prefill_edition, true);
    assert.equal(steam.is_prefill_edition, false);
  });

  it('GET has_prefill_choice=false for an Epic-only game', async () => {
    const r = await getGame(20);
    assert.equal(r.body.has_prefill_choice, false);
  });
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test tests/routes/games-prefill-edition.test.js`
Expected: FAIL — `has_prefill_choice` is undefined and `is_prefill_edition` missing on editions.

- [ ] **Step 3: Implement**

In `backend/src/routes/games.js` `GET /:id`, add `is_prefill_override` to the editions SELECT (next to `is_display_edition`):

```sql
           COALESCE(et.is_display_edition, 0) as is_display_override,
           COALESCE(et.is_prefill_edition, 0) as is_prefill_override
```

After `const displayEdition = editions[0];`, compute the resolved prefill edition + choice flag:

```javascript
  // #225: resolved prefill edition = explicit override, else the Steam edition
  // (default). has_prefill_choice = game owned on BOTH Steam and Epic.
  const hasSteamEdition = editions.some((e) => e.launcher_name === 'steam');
  const hasEpicEdition = editions.some((e) => e.launcher_name === 'epic');
  const has_prefill_choice = hasSteamEdition && hasEpicEdition;
  const prefillEdition =
    editions.find((e) => e.is_prefill_override === 1) ||
    editions.find((e) => e.launcher_name === 'steam') ||
    null;
```

In the `editionsWithTier` map, add the per-edition flag:

```javascript
    is_display_edition: displayEdition ? e.id === displayEdition.id : false,
    is_prefill_edition: prefillEdition ? e.id === prefillEdition.id : false,
```

Add `has_prefill_choice` to the response object (find where the game JSON is assembled/returned — alongside `editions: editionsWithTier`):

```javascript
    has_prefill_choice,
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS (all Task 3 + Task 4 cases).
- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/games.js backend/tests/routes/games-prefill-edition.test.js
git commit -m "feat(#225): GET game exposes is_prefill_edition + has_prefill_choice"
```

---

### Task 5: Frontend — "Prefill this edition" control on GameDetail

**Files:**
- Modify: `frontend/src/pages/GameDetail.jsx` (edition block, near "Set as display")
- Test: `frontend/src/pages/GameDetail.prefill.test.jsx` (create) — OR extend an existing GameDetail test if one exists.

**Interfaces:**
- Consumes: `game.has_prefill_choice`, `edition.is_prefill_edition` (Task 4). Produces: a "Prefill this edition" button per edition, shown ONLY when `game.has_prefill_choice` and the edition is not already the prefill edition. Clicking → `POST /api/games/:id/prefill-edition {edition_id}` → invalidate `['game', id]`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/GameDetail.prefill.test.jsx`. Mirror the existing GameDetail/CachePanel test harness (QueryClientProvider wrap + `vi.stubGlobal('fetch', ...)`; render with a router if GameDetail uses route params — copy the setup from any existing `GameDetail*.test.jsx` or `CachePanel.test.jsx`). Stub the game fetch to return a Steam+Epic game with `has_prefill_choice: true`.

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// import GameDetail + any router wrapper exactly as the existing GameDetail tests do

const game = {
  id: 7, title: 'Dual', has_prefill_choice: true,
  editions: [
    { id: 100, launcher_name: 'steam', launcher_display_name: 'Steam', is_display_edition: true,  is_prefill_edition: true },
    { id: 101, launcher_name: 'epic',  launcher_display_name: 'Epic',  is_display_edition: false, is_prefill_edition: false },
  ],
};

beforeEach(() => vi.restoreAllMocks());

it('shows "Prefill this edition" on the non-prefill edition and POSTs on click', async () => {
  const fetchMock = vi.fn((url, opts) => {
    if (/\/api\/games\/7\/prefill-edition$/.test(url) && opts?.method === 'POST')
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    return Promise.resolve({ ok: true, json: async () => game });
  });
  vi.stubGlobal('fetch', fetchMock);
  // render GameDetail for game id 7 inside QueryClientProvider + router (mirror existing tests)
  await screen.findByText('Epic');
  await userEvent.click(screen.getByRole('button', { name: /prefill this edition/i }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/games/7/prefill-edition',
      expect.objectContaining({ method: 'POST' })
    )
  );
});
```

> If GameDetail needs route/loader context that's awkward to stub, follow whatever pattern the existing GameDetail tests use; keep the two assertions (button renders, POST fires) identical.

- [ ] **Step 2: Run to verify it fails** — `cd frontend && npx vitest run src/pages/GameDetail.prefill.test.jsx`
Expected: FAIL — no "Prefill this edition" button.

- [ ] **Step 3: Implement**

In `frontend/src/pages/GameDetail.jsx`, in the per-edition block right after the existing "Set as display" button (the `{!edition.is_display_edition && (...)}` at ~line 433), add — gated on `game.has_prefill_choice`:

```jsx
{game.has_prefill_choice && !edition.is_prefill_edition && (
  <button
    className="text-xs text-blue-400 hover:text-blue-300"
    onClick={async () => {
      await fetch(`/api/games/${game.id}/prefill-edition`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition_id: edition.id }),
      });
      queryClient.invalidateQueries({ queryKey: ['game', String(game.id)] });
    }}
    title="Cache this launcher's copy instead of the default (Steam). Display edition is unchanged."
  >
    Prefill this edition
  </button>
)}
```

(Match the exact `['game', ...]` query key the page already uses for its game query — check the `useQuery` key at the top of GameDetail and reuse it verbatim; the display-edition button's `invalidateQueries` call shows the correct key.)

- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/GameDetail.jsx frontend/src/pages/GameDetail.prefill.test.jsx
git commit -m "feat(#225): GameDetail 'Prefill this edition' control"
```

---

### Task 6: Full verification + PR

**Files:** none (verification only).

- [ ] **Step 1: Backend suite** — `cd backend && node --test 'tests/**/*.test.js'`
Expected: only the 2 pre-existing failures (`setup/qr`, `health`); the new migrate/compute/route tests PASS.

- [ ] **Step 2: Frontend suite + build** — `cd frontend && npx vitest run && npm run build`
Expected: all pass; build succeeds.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/225-prefill-edition-override
gh pr create --base master --title "feat(#225): per-game prefill-edition override" --body "..."
```

PR body: summarize — per-game prefill-edition override (separate from #224 display edition); `edition_tiers.is_prefill_edition`; `computeSteamCoveredEpicAppIds` skips prefill-chosen Epic editions; `POST /api/games/:id/prefill-edition` setter (+ fire-and-forget sync); GET surfaces `is_prefill_edition` + `has_prefill_choice`; GameDetail "Prefill this edition" control shown only for Steam+Epic games; **no orchestrator changes**; **Closes #225**. Karl merges.

---

## Self-Review

**Spec coverage:** data (`is_prefill_edition`) → Task 1 ✓; compute change → Task 2 ✓; setter API → Task 3 ✓; GET `is_prefill_edition` + `has_prefill_choice` → Task 4 ✓; UI (shown only for Steam+Epic) → Task 5 ✓; sync trigger → Task 3 (fire-and-forget) ✓; Epic-only/Epic+GOG unchanged → covered by compute (never in set) + `has_prefill_choice=false` hides UI ✓. Non-goals (no host-selection prune, no orchestrator change, no global order) respected — nothing touches them.

**Placeholder scan:** no TBD/TODO; every code step has concrete code. The two "mirror the existing test harness" notes (Task 3 supertest-vs-makeFetch, Task 5 GameDetail render setup) point at named existing files to copy — acceptable since the harness differs per repo and must match what's there.

**Type consistency:** `is_prefill_edition` (column + per-edition boolean), `is_prefill_override` (raw SQL alias), `has_prefill_choice` (game flag), `computeSteamCoveredEpicAppIds` (unchanged signature), `POST /api/games/:id/prefill-edition {edition_id}` — names consistent across Tasks 1–5.
