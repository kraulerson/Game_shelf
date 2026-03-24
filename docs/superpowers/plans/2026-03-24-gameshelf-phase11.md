# Phase 11: Edition Display Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deduplicate games across platforms by edition tier, show consolidated platform tags, and provide a Versions & Editions detail view with manual override.

**Architecture:** New `edition_tiers` table stores auto-detected tier rankings per edition. The dedup CTE ranks by manual override → tier → launcher priority. Frontend replaces the primary badge + "+N more" pattern with inline platform tags. Detail page shows all editions grouped by tier.

**Tech Stack:** SQLite (better-sqlite3), Express, React, Tailwind CSS, node:test

**Spec:** `docs/superpowers/specs/2026-03-24-edition-display-redesign-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `backend/src/utils/editionTier.js` | Tier detection function + labels |
| Create | `backend/tests/utils/editionTier.test.js` | Unit tests for tier detection |
| Modify | `backend/src/db/schema.sql` | Add `edition_tiers` table + index |
| Modify | `backend/src/db/migrate.js` | Migration for table creation + initial population |
| Create | `backend/tests/db/migrate-phase11.test.js` | Migration tests |
| Modify | `backend/src/services/syncEngine.js` | Post-sync tier computation hook |
| Modify | `backend/src/routes/games.js` | Dedup CTE, list response, detail response, new POST endpoint |
| Create | `backend/tests/routes/games-editions.test.js` | API tests for tier-aware dedup and display-edition endpoint |
| Modify | `frontend/src/components/LauncherBadge.jsx` | Add `size` prop |
| Modify | `frontend/src/components/GameCard.jsx` | Platform tags replacing badge dropdown |
| Modify | `frontend/src/components/GameRow.jsx` | Platform tags replacing badge dropdown |
| Modify | `frontend/src/pages/GameDetail.jsx` | Versions & Editions section, set display button |

---

### Task 1: Edition Tier Utility

**Files:**
- Create: `backend/src/utils/editionTier.js`
- Create: `backend/tests/utils/editionTier.test.js`

- [ ] **Step 1: Write failing tests**

```js
// backend/tests/utils/editionTier.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectEditionTier, getTierLabel } = require('../../src/utils/editionTier');

describe('detectEditionTier', () => {
  it('should return 0 for plain titles', () => {
    assert.equal(detectEditionTier('Half-Life 2'), 0);
    assert.equal(detectEditionTier('Portal'), 0);
  });

  it('should detect launch edition tiers', () => {
    assert.equal(detectEditionTier('Cyberpunk 2077 Deluxe Edition'), 1);
    assert.equal(detectEditionTier('Far Cry 6 Gold Edition'), 2);
    assert.equal(detectEditionTier('Hogwarts Legacy Ultimate Edition'), 3);
    assert.equal(detectEditionTier('Assassins Creed Premium Edition'), 3);
  });

  it('should detect post-launch edition tiers', () => {
    assert.equal(detectEditionTier('The Witcher 3 GOTY'), 4);
    assert.equal(detectEditionTier('The Witcher 3 Game of the Year Edition'), 4);
    assert.equal(detectEditionTier('Batman Arkham City Complete Edition'), 5);
    assert.equal(detectEditionTier('Batman Arkham City Complete Collection'), 5);
    assert.equal(detectEditionTier('Baldurs Gate Enhanced Edition'), 6);
    assert.equal(detectEditionTier('Skyrim Special Edition'), 7);
    assert.equal(detectEditionTier('Death Stranding Definitive Edition'), 8);
    assert.equal(detectEditionTier("Death Stranding Director's Cut"), 9);
    assert.equal(detectEditionTier('Disco Elysium The Final Cut'), 10);
  });

  it('should handle Unicode apostrophes', () => {
    assert.equal(detectEditionTier('Death Stranding Director\u2019s Cut'), 9);
    assert.equal(detectEditionTier("Dragon's Dogma Collector\u2019s Edition"), 3);
  });

  it('should NOT false-positive on titles containing keywords', () => {
    assert.equal(detectEditionTier('Gold Rush'), 0);
    assert.equal(detectEditionTier('Complete Chess'), 0);
    assert.equal(detectEditionTier('Heart of Gold'), 0);
    assert.equal(detectEditionTier('The Complete Journey'), 0);
  });

  it('should pick highest tier when multiple keywords present', () => {
    assert.equal(detectEditionTier('Game Complete Definitive Edition'), 8);
    assert.equal(detectEditionTier('Game Deluxe GOTY Edition'), 4);
  });
});

describe('getTierLabel', () => {
  it('should return correct labels', () => {
    assert.equal(getTierLabel(0), 'Standard');
    assert.equal(getTierLabel(4), 'GOTY');
    assert.equal(getTierLabel(9), "Director's Cut");
    assert.equal(getTierLabel(10), 'Final Cut');
  });

  it('should return Standard for unknown tiers', () => {
    assert.equal(getTierLabel(99), 'Standard');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/utils/editionTier.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// backend/src/utils/editionTier.js
function detectEditionTier(title) {
  const lower = title.toLowerCase();
  if (/\bfinal cut\b/.test(lower)) return 10;
  if (/\bdirector[\u2019']?s cut\b/.test(lower)) return 9;
  if (/\bdefinitive\b/.test(lower)) return 8;
  if (/\bspecial edition\b/.test(lower)) return 7;
  if (/\benhanced\b|\bremastered\b/.test(lower)) return 6;
  if (/\bcomplete\s+(edition|collection|pack)\b/.test(lower)) return 5;
  if (/\bgoty\b|\bgame of the year\b/.test(lower)) return 4;
  if (/\bultimate\b|\bpremium\b|\bcollector[\u2019']?s\b|\blegendary\b|\blimited edition\b/.test(lower)) return 3;
  if (/\bgold edition\b/.test(lower)) return 2;
  if (/\bdeluxe\b/.test(lower)) return 1;
  return 0;
}

const TIER_LABELS = [
  'Standard', 'Deluxe', 'Gold', 'Premium', 'GOTY',
  'Complete', 'Enhanced', 'Special', 'Definitive',
  "Director's Cut", 'Final Cut'
];

function getTierLabel(tier) {
  return TIER_LABELS[tier] || 'Standard';
}

module.exports = { detectEditionTier, getTierLabel, TIER_LABELS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/utils/editionTier.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/editionTier.js backend/tests/utils/editionTier.test.js
git commit -m "feat(phase11): add edition tier detection utility"
```

---

### Task 2: Database Migration

**Files:**
- Modify: `backend/src/db/schema.sql` (append table definition)
- Modify: `backend/src/db/migrate.js` (add migration step + initial population)
- Create: `backend/tests/db/migrate-phase11.test.js`

- [ ] **Step 1: Add table to schema.sql**

Append to `backend/src/db/schema.sql`:

```sql
-- Phase 11: edition tier tracking
CREATE TABLE IF NOT EXISTS edition_tiers (
  id INTEGER PRIMARY KEY,
  game_edition_id INTEGER NOT NULL REFERENCES game_editions(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL DEFAULT 0,
  is_display_edition INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(game_edition_id)
);
CREATE INDEX IF NOT EXISTS idx_edition_tiers_lookup
  ON edition_tiers(game_edition_id, tier, is_display_edition);
```

- [ ] **Step 2: Add migration logic to migrate.js**

In `backend/src/db/migrate.js`, add after the last migration block (before `return db`):

```js
// Phase 11: edition_tiers table
const hasEditionTiers = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='edition_tiers'"
).get();
if (!hasEditionTiers) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edition_tiers (
      id INTEGER PRIMARY KEY,
      game_edition_id INTEGER NOT NULL REFERENCES game_editions(id) ON DELETE CASCADE,
      tier INTEGER NOT NULL DEFAULT 0,
      is_display_edition INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(game_edition_id)
    );
    CREATE INDEX IF NOT EXISTS idx_edition_tiers_lookup
      ON edition_tiers(game_edition_id, tier, is_display_edition);
  `);

  // Initial population: detect tiers for all existing editions
  const { detectEditionTier } = require('../utils/editionTier');
  const editions = db.prepare('SELECT id, title FROM game_editions WHERE title IS NOT NULL').all();
  const insertTier = db.prepare(
    'INSERT OR IGNORE INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)'
  );
  const populateAll = db.transaction((eds) => {
    for (const ed of eds) {
      insertTier.run(ed.id, detectEditionTier(ed.title));
    }
  });
  populateAll(editions);
  console.log(`[Migration] Phase 11: Created edition_tiers, populated ${editions.length} rows`);
}
```

- [ ] **Step 3: Write migration test**

```js
// backend/tests/db/migrate-phase11.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Phase 11 migration: edition_tiers', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-phase11.db');
  let db;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    db = runMigrations(testDbPath);
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('edition_tiers table should exist', () => {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='edition_tiers'"
    ).get();
    assert.ok(table);
  });

  it('edition_tiers should have correct columns', () => {
    const cols = db.pragma('table_info(edition_tiers)').map(c => c.name);
    assert.ok(cols.includes('game_edition_id'));
    assert.ok(cols.includes('tier'));
    assert.ok(cols.includes('is_display_edition'));
  });

  it('should auto-detect tier from edition title', () => {
    // Insert test data
    db.prepare('INSERT OR IGNORE INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('steam', 'Steam');
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (?, ?, ?)').run(launcher.id, 'test-goty', 'Fallout NV GOTY');

    const ed = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('test-goty');

    // Manually trigger tier computation (simulates what migration does for existing data)
    const { detectEditionTier } = require('../../src/utils/editionTier');
    db.prepare('INSERT OR IGNORE INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)').run(ed.id, detectEditionTier('Fallout NV GOTY'));

    const tier = db.prepare('SELECT tier FROM edition_tiers WHERE game_edition_id = ?').get(ed.id);
    assert.equal(tier.tier, 4); // GOTY = tier 4
  });
});
```

- [ ] **Step 4: Run migration test**

Run: `cd backend && node --test tests/db/migrate-phase11.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.sql backend/src/db/migrate.js backend/tests/db/migrate-phase11.test.js
git commit -m "feat(phase11): add edition_tiers migration and initial population"
```

---

### Task 3: Post-Sync Tier Computation Hook

**Files:**
- Modify: `backend/src/services/syncEngine.js` (add tier insert after upsertAll, ~line 77)

- [ ] **Step 1: Add tier computation after upsertAll**

In `backend/src/services/syncEngine.js`, after line 77 (`upsertAll(games)`) and before the "Mark missing games" block (~line 79), add:

```js
    // Compute edition tiers for new/updated editions
    const { detectEditionTier } = require('../utils/editionTier');
    const untypedEditions = db.prepare(`
      SELECT ge.id, ge.title FROM game_editions ge
      WHERE ge.launcher_id = ? AND ge.title IS NOT NULL
        AND ge.id NOT IN (SELECT game_edition_id FROM edition_tiers)
    `).all(launcher.id);
    if (untypedEditions.length > 0) {
      const insertTier = db.prepare(
        'INSERT OR IGNORE INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)'
      );
      const tierTransaction = db.transaction((eds) => {
        for (const ed of eds) {
          insertTier.run(ed.id, detectEditionTier(ed.title));
        }
      });
      tierTransaction(untypedEditions);
    }
```

- [ ] **Step 2: Add sync tier test to syncEngine.test.js**

Append a test to `backend/tests/services/syncEngine.test.js` that verifies tier rows are created after sync:

```js
  it('syncLauncher should create edition_tiers for synced games', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => ({
      data: { response: { games: [
        { appid: 999, name: 'Fallout NV GOTY', playtime_forever: 100 },
      ]}}
    });

    try {
      await syncLauncher('steam', db);
      const ed = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('999');
      assert.ok(ed, 'Edition should exist');
      const tier = db.prepare('SELECT tier FROM edition_tiers WHERE game_edition_id = ?').get(ed.id);
      assert.ok(tier, 'Tier row should exist');
      assert.equal(tier.tier, 4); // GOTY = tier 4
    } finally {
      axios.get = originalGet;
    }
  });
```

- [ ] **Step 3: Run syncEngine tests**

Run: `cd backend && node --test tests/services/syncEngine.test.js`
Expected: All PASS (6/6)

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/syncEngine.js backend/tests/services/syncEngine.test.js
git commit -m "feat(phase11): add post-sync edition tier computation"
```

---

### Task 4: API — List Endpoint Dedup Changes

**Files:**
- Modify: `backend/src/routes/games.js` (dedup CTE ~lines 286-330, also_on → platforms ~lines 336-382)
- Create: `backend/tests/routes/games-editions.test.js`

- [ ] **Step 1: Write failing API test**

```js
// backend/tests/routes/games-editions.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Edition tier dedup API', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-editions-api.db');
  let db, app, server, baseUrl, cookie;

  // Helper: start server, make request, return response (matches games.test.js pattern)
  async function makeFetch(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { Cookie: cookie, ...options.headers },
    });
    return res;
  }

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../src/db/migrate')];
    delete require.cache[require.resolve('../../src/server')];
    app = require('../../src/server');
    db = app.locals.db; // Use the app's db instance, not a separate one

    // Start server on random port
    server = app.listen(0);
    baseUrl = `http://localhost:${server.address().port}`;

    // Auth token
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 1, username: 'admin' }, process.env.GAMESHELF_JWT_SECRET, { expiresIn: '1h' });
    cookie = `token=${token}`;

    // Seed: two launchers with different priorities
    db.prepare('INSERT OR IGNORE INTO launchers (name, display_name, enabled, priority) VALUES (?, ?, 1, ?)').run('steam', 'Steam', 1);
    db.prepare('INSERT OR IGNORE INTO launchers (name, display_name, enabled, priority) VALUES (?, ?, 1, ?)').run('epic', 'Epic Games', 2);
    const steam = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    const epic = db.prepare('SELECT id FROM launchers WHERE name = ?').get('epic');

    // Seed: game + two editions (Standard on Steam, GOTY on Epic)
    db.prepare('INSERT INTO games (title, slug) VALUES (?, ?)').run('Fallout New Vegas', 'fallout-new-vegas');
    const game = db.prepare('SELECT id FROM games WHERE slug = ?').get('fallout-new-vegas');

    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title, game_id, owned) VALUES (?, ?, ?, ?, 1)').run(steam.id, 'fnv-steam', 'Fallout New Vegas', game.id);
    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title, game_id, owned) VALUES (?, ?, ?, ?, 1)').run(epic.id, 'fnv-epic', 'Fallout New Vegas GOTY', game.id);

    const steamEd = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('fnv-steam');
    const epicEd = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('fnv-epic');

    // Seed edition_tiers
    const { detectEditionTier } = require('../../src/utils/editionTier');
    db.prepare('INSERT INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)').run(steamEd.id, detectEditionTier('Fallout New Vegas'));
    db.prepare('INSERT INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)').run(epicEd.id, detectEditionTier('Fallout New Vegas GOTY'));
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('GET /api/games should prefer GOTY edition over Standard', async () => {
    const res = await makeFetch('/api/games');
    const data = await res.json();
    const fnv = data.games.find(g => g.title === 'Fallout New Vegas');
    assert.ok(fnv, 'Should find Fallout New Vegas');
    assert.equal(fnv.display_edition_title, 'Fallout New Vegas GOTY');
    assert.equal(fnv.display_tier, 4);
  });

  it('GET /api/games should include platforms array', async () => {
    const res = await makeFetch('/api/games');
    const data = await res.json();
    const fnv = data.games.find(g => g.title === 'Fallout New Vegas');
    assert.ok(fnv.platforms);
    assert.equal(fnv.platforms.length, 2);
    const names = fnv.platforms.map(p => p.launcher_name).sort();
    assert.deepEqual(names, ['epic', 'steam']);
  });

  it('Manual override should take precedence over tier', async () => {
    // Set Steam edition as display
    const steamEd = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('fnv-steam');
    db.prepare('UPDATE edition_tiers SET is_display_edition = 1 WHERE game_edition_id = ?').run(steamEd.id);

    const res = await makeFetch('/api/games');
    const data = await res.json();
    const fnv = data.games.find(g => g.title === 'Fallout New Vegas');
    assert.equal(fnv.display_edition_title, 'Fallout New Vegas');
    assert.equal(fnv.launcher_name, 'steam');

    // Clean up
    db.prepare('UPDATE edition_tiers SET is_display_edition = 0 WHERE game_edition_id = ?').run(steamEd.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/routes/games-editions.test.js`
Expected: FAIL — missing display_edition_title/platforms

- [ ] **Step 3: Modify the dedup CTE in games.js**

In `backend/src/routes/games.js`, update **both** CTE copies:

**Data CTE (lines ~286-309):**
1. Add `LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id` in the CTE FROM clause
2. Change `ORDER BY l.priority ASC` to `ORDER BY COALESCE(et.is_display_edition, 0) DESC, COALESCE(et.tier, 0) DESC, l.priority ASC`
3. Include `COALESCE(et.tier, 0) as edition_tier, ge.title as edition_title` in CTE SELECT
4. Pass `edition_tier` and `edition_title` through to the outer SELECT as `display_tier` and `display_edition_title`

**Count CTE (lines ~310-330):** Apply the same `LEFT JOIN` and `ORDER BY` changes — the count CTE has an identical `ROW_NUMBER()` that must match the data CTE, otherwise pagination totals disagree.

**duplicates=show query (lines ~262-284):** Add `LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id` and include `COALESCE(et.tier, 0) as display_tier, ge.title as display_edition_title` in the SELECT. No ranking change needed since all copies are shown.

- [ ] **Step 4: Replace also_on with platforms**

Replace the `alsoOnStmt` query (~line 336) with:

```js
const platformsStmt = db.prepare(`
  SELECT DISTINCT l.name as launcher_name, l.display_name as launcher_display_name
  FROM game_editions ge
  JOIN launchers l ON l.id = ge.launcher_id
  WHERE ge.game_id = ? AND ge.owned = 1
  ORDER BY l.priority ASC
`);
```

Update the response mapping (~line 353) to use `platforms` instead of `also_on`:

```js
platforms: gameId ? platformsStmt.all(gameId) : [{
  launcher_name: row.launcher_name,
  launcher_display_name: row.launcher_display_name,
}],
display_edition_title: row.display_edition_title || row.r_title,
display_tier: row.display_tier || 0,
```

- [ ] **Step 5: Run tests**

Run: `cd backend && node --test tests/routes/games-editions.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/games.js backend/tests/routes/games-editions.test.js
git commit -m "feat(phase11): tier-aware dedup CTE and platforms response"
```

---

### Task 5: API — Detail Endpoint + POST Display-Edition

**Files:**
- Modify: `backend/src/routes/games.js` (GET /:id ~lines 59-109, add POST /:id/display-edition)

- [ ] **Step 1: Add tests to games-editions.test.js**

Append to the existing test file:

```js
it('GET /api/games/:id editions should include tier info', async () => {
  const game = db.prepare('SELECT id FROM games WHERE slug = ?').get('fallout-new-vegas');
  const res = await makeFetch(`/api/games/${game.id}`);
  const data = await res.json();
  assert.ok(data.editions);
  const epicEd = data.editions.find(e => e.launcher_name === 'epic');
  assert.equal(epicEd.tier, 4);
  assert.equal(epicEd.tier_label, 'GOTY');
  assert.equal(epicEd.is_display_edition, true);
  assert.ok(epicEd.edition_title);
});

it('POST /api/games/:id/display-edition should set override', async () => {
  const game = db.prepare('SELECT id FROM games WHERE slug = ?').get('fallout-new-vegas');
  const steamEd = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('fnv-steam');

  const res = await makeFetch(`/api/games/${game.id}/display-edition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ edition_id: steamEd.id }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);

  // Verify override was set
  const tier = db.prepare('SELECT is_display_edition FROM edition_tiers WHERE game_edition_id = ?').get(steamEd.id);
  assert.equal(tier.is_display_edition, 1);

  // Verify other editions cleared
  const epicEd = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('fnv-epic');
  const epicTier = db.prepare('SELECT is_display_edition FROM edition_tiers WHERE game_edition_id = ?').get(epicEd.id);
  assert.equal(epicTier.is_display_edition, 0);
});

it('POST /api/games/:id/display-edition should return 400 for wrong game', async () => {
  const res = await makeFetch('/api/games/99999/display-edition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ edition_id: 1 }),
  });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Update GET /:id to include tier data**

In `backend/src/routes/games.js`, update the editions query (~line 69-76) to join `edition_tiers`:

```js
const editions = db.prepare(`
  SELECT ge.id, ge.launcher_game_id, ge.launcher_url, ge.playtime_minutes, ge.owned,
         ge.title as edition_title,
         l.name as launcher_name, l.display_name as launcher_display_name,
         l.priority,
         COALESCE(et.tier, 0) as tier,
         COALESCE(et.is_display_edition, 0) as is_display_edition
  FROM game_editions ge
  JOIN launchers l ON l.id = ge.launcher_id
  LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
  WHERE ge.game_id = ? AND ge.owned = 1
  ORDER BY COALESCE(et.is_display_edition, 0) DESC, COALESCE(et.tier, 0) DESC, l.priority ASC
`).all(req.params.id);
```

Replace the `is_primary` computation (~lines 78-89) with tier-based display edition:

```js
const { getTierLabel } = require('../utils/editionTier');

// Determine display edition: manual override > highest tier > lowest priority
const displayEdition = editions[0]; // Already sorted by the query
const mappedEditions = editions.map(e => ({
  id: e.id,
  launcher_name: e.launcher_name,
  launcher_display_name: e.launcher_display_name,
  launcher_game_id: e.launcher_game_id,
  launcher_url: e.launcher_url,
  edition_title: e.edition_title,
  playtime_minutes: e.playtime_minutes,
  owned: e.owned,
  tier: e.tier,
  tier_label: getTierLabel(e.tier),
  is_display_edition: displayEdition ? e.id === displayEdition.id : false,
}));
```

- [ ] **Step 3: Add POST /:id/display-edition endpoint**

Add to `backend/src/routes/games.js` before `module.exports`:

```js
// POST /api/games/:id/display-edition
router.post('/:id/display-edition', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { edition_id } = req.body || {};

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  if (!edition_id) return res.status(400).json({ error: 'edition_id is required' });

  // Verify edition belongs to this game
  const edition = db.prepare(
    'SELECT id FROM game_editions WHERE id = ? AND game_id = ?'
  ).get(edition_id, id);
  if (!edition) return res.status(400).json({ error: 'Edition does not belong to this game' });

  // Transaction: clear all overrides, then set the chosen one
  const setDisplay = db.transaction((gameId, editionId) => {
    db.prepare(`
      UPDATE edition_tiers SET is_display_edition = 0
      WHERE game_edition_id IN (SELECT id FROM game_editions WHERE game_id = ?)
    `).run(gameId);
    db.prepare(
      'UPDATE edition_tiers SET is_display_edition = 1 WHERE game_edition_id = ?'
    ).run(editionId);
  });
  setDisplay(id, edition_id);

  res.json({ ok: true });
});
```

- [ ] **Step 4: Run tests**

Run: `cd backend && node --test tests/routes/games-editions.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/games.js backend/tests/routes/games-editions.test.js
git commit -m "feat(phase11): tier-aware detail endpoint and display-edition override"
```

---

### Task 6: Frontend — LauncherBadge Size Variant

**Files:**
- Modify: `frontend/src/components/LauncherBadge.jsx`

- [ ] **Step 1: Add size prop**

Update `frontend/src/components/LauncherBadge.jsx` to add `size` prop while preserving existing classes:

```jsx
export default function LauncherBadge({ launcherName, displayName, primary, size = 'default' }) {
  const sizeClasses = size === 'small'
    ? 'text-xs px-1.5 py-0.5'
    : 'text-sm px-2.5 py-0.5';

  const colorClasses = primary
    ? 'bg-blue-600 text-white'
    : 'bg-gray-700 text-gray-300 opacity-70';

  return (
    <span className={`inline-flex items-center font-medium rounded-full ${sizeClasses} ${colorClasses}`}>
      {displayName || launcherName}
    </span>
  );
}
```

- [ ] **Step 2: Verify existing usage still works**

Check the app renders without errors — existing `LauncherBadge` calls don't pass `size` so they get `"default"`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/LauncherBadge.jsx
git commit -m "feat(phase11): add size prop to LauncherBadge"
```

---

### Task 7: Frontend — GameCard Platform Tags

**Files:**
- Modify: `frontend/src/components/GameCard.jsx`

- [ ] **Step 1: Replace badge + "+N more" with platform tags**

Key changes:
1. Remove `showAlsoOn` state (line 17)
2. Remove the primary badge + dropdown section (lines ~56-79)
3. Add platform tags using `game.platforms` array with `LauncherBadge size="small"`
4. Show `display_edition_title` below title if different from `game.title`

Replace the launcher badge section with:

```jsx
{/* Platform tags */}
<div className="flex flex-wrap gap-1 mt-1">
  {(game.platforms || []).map((p) => (
    <LauncherBadge
      key={p.launcher_name}
      launcherName={p.launcher_name}
      displayName={p.launcher_display_name}
      primary
      size="small"
    />
  ))}
</div>
```

And below the title `<h3>`, add:

```jsx
{game.display_edition_title && game.display_edition_title !== game.title && (
  <p className="text-gray-400 text-xs truncate">{game.display_edition_title}</p>
)}
```

- [ ] **Step 2: Verify renders correctly**

Build and visually verify: cards show small platform tags at bottom, no "+N more" dropdown.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/GameCard.jsx
git commit -m "feat(phase11): replace badge dropdown with platform tags on GameCard"
```

---

### Task 8: Frontend — GameRow Platform Tags

**Files:**
- Modify: `frontend/src/components/GameRow.jsx`

- [ ] **Step 1: Replace badge + "+N more" with platform tags**

Same pattern as GameCard:
1. Remove `showAlsoOn` state (line 12)
2. Remove the primary badge + dropdown section (lines ~42-62)
3. Add inline platform tags using `game.platforms` array with `LauncherBadge size="small"`

Replace the badge section with:

```jsx
<div className="flex flex-wrap gap-1">
  {(game.platforms || []).map((p) => (
    <LauncherBadge
      key={p.launcher_name}
      launcherName={p.launcher_name}
      displayName={p.launcher_display_name}
      primary
      size="small"
    />
  ))}
</div>
```

- [ ] **Step 2: Verify renders correctly**

Build and visually verify: rows show inline platform tags.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/GameRow.jsx
git commit -m "feat(phase11): replace badge dropdown with platform tags on GameRow"
```

---

### Task 9: Frontend — GameDetail Versions & Editions

**Files:**
- Modify: `frontend/src/pages/GameDetail.jsx`

- [ ] **Step 1: Replace "Owned On" with "Versions & Editions"**

Replace the "Owned On" section (lines ~271-313) with:

```jsx
{/* Versions & Editions */}
{game.editions && game.editions.length > 0 && (
  <div className="mt-6">
    <h2 className="text-lg font-semibold text-white mb-3">Versions & Editions</h2>
    <div className="space-y-2">
      {game.editions.map((edition) => (
        <div
          key={edition.id}
          className={`flex items-center justify-between p-3 rounded-lg ${
            edition.is_display_edition
              ? 'bg-blue-900/30 border border-blue-700'
              : 'bg-gray-800'
          }`}
        >
          <div className="flex items-center gap-3">
            <LauncherBadge
              launcherName={edition.launcher_name}
              displayName={edition.launcher_display_name}
              primary={edition.is_display_edition}
            />
            <div>
              <span className="text-white text-sm">{edition.edition_title || game.title}</span>
              {edition.tier > 0 && (
                <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-purple-800 text-purple-200">
                  {edition.tier_label}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {edition.playtime_minutes > 0 && (
              <span className="text-gray-400 text-sm">{formatPlaytime(edition.playtime_minutes)}</span>
            )}
            {!edition.is_display_edition && (
              <button
                onClick={async () => {
                  await fetch(`/api/games/${game.id}/display-edition`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ edition_id: edition.id }),
                  });
                  // Refetch game data
                  queryClient.invalidateQueries({ queryKey: ['game', game.id] });
                  queryClient.invalidateQueries({ queryKey: ['games'] });
                }}
                className="text-xs text-gray-500 hover:text-blue-400"
              >
                Set as display
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 2: Replace is_primary references**

Search for `is_primary` in GameDetail.jsx and replace with `is_display_edition`. Key locations:
- Line ~126: `const primaryEdition = game.editions?.find(e => e.is_display_edition);`
- Any other conditional rendering based on primary status

- [ ] **Step 3: Verify renders correctly**

Build and visually verify: detail page shows "Versions & Editions" with tier labels, display edition highlighted, "Set as display" buttons on non-display editions.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/GameDetail.jsx
git commit -m "feat(phase11): Versions & Editions section with tier labels and display override"
```

---

### Task 10: Update Existing Tests + Version Bump

**Files:**
- Modify: `backend/tests/routes/games.test.js` (update `also_on` → `platforms` assertions)
- Modify: version files (per project convention)
- Modify: changelog

- [ ] **Step 1: Update existing games.test.js**

Find any assertions on `also_on` in `backend/tests/routes/games.test.js` and update to use `platforms`.

- [ ] **Step 2: Run full backend test suite**

Run: `cd backend && shopt -s globstar && node --test tests/**/*.test.js`
Expected: All pass except pre-existing server.test.js version mismatch

- [ ] **Step 3: Version bump and changelog**

Update version to 1.6.0 per project convention. Update changelog.

- [ ] **Step 4: Final commit**

```bash
git add backend/tests/routes/games.test.js
git commit -m "feat(phase11): edition display redesign v1.6.0

Adds edition tier detection, tier-aware dedup, platform tags on
game cards, Versions & Editions detail section with manual
display override."
```

- [ ] **Step 5: Push**

```bash
git push origin master
```
