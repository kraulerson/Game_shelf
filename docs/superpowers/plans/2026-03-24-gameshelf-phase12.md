# Phase 12: Epic Catalog Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve Epic codename titles via catalog API, nest DLC under parent games by namespace, and show DLC counts in the library.

**Architecture:** Store `epic_namespace`, `epic_catalog_id`, `sandbox_type` on game_editions during Epic sync. Remove namespace dedup. Post-sync: nest DLC by namespace, resolve codenames via Epic catalog API, then enrich. Filter DLC from library queries.

**Tech Stack:** SQLite (better-sqlite3), Express, React, Tailwind CSS, axios, node:test

**Spec:** `docs/superpowers/specs/2026-03-24-epic-catalog-resolution-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `backend/src/db/schema.sql` | Add 4 columns to game_editions |
| Modify | `backend/src/db/migrate.js` | Phase 12 migration |
| Create | `backend/tests/db/migrate-phase12.test.js` | Migration tests |
| Create | `backend/src/utils/codenameDetector.js` | Codename detection heuristic |
| Create | `backend/tests/utils/codenameDetector.test.js` | Heuristic tests |
| Create | `backend/src/services/launchers/epicCatalog.js` | Catalog API + DLC nesting + codename resolution |
| Create | `backend/tests/services/launchers/epicCatalog.test.js` | Catalog module tests |
| Modify | `backend/src/services/launchers/epic.js` | Return all items with metadata, remove namespace dedup, remove debug logs |
| Modify | `backend/src/services/syncEngine.js` | Upsert new columns, call nestDLC + resolveCodenames post-sync |
| Modify | `backend/src/routes/games.js` | DLC filter on all queries, dlc_count, detail dlc array |
| Modify | `backend/src/services/metadata/enrichGame.js` | Skip DLC in enrichAll |
| Modify | `frontend/src/components/GameCard.jsx` | DLC count badge |
| Modify | `frontend/src/pages/GameDetail.jsx` | DLC & Content section |

---

### Task 1: Codename Detection Utility

**Files:**
- Create: `backend/src/utils/codenameDetector.js`
- Create: `backend/tests/utils/codenameDetector.test.js`

- [ ] **Step 1: Write failing tests**

```js
// backend/tests/utils/codenameDetector.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isLikelyCodename } = require('../../src/utils/codenameDetector');

describe('isLikelyCodename', () => {
  it('should flag "Live" as codename', () => {
    assert.equal(isLikelyCodename('Live'), true);
  });

  it('should flag PascalCase single words', () => {
    assert.equal(isLikelyCodename('CadmiumRed'), true);
    assert.equal(isLikelyCodename('CharlestonGreen'), true);
    assert.equal(isLikelyCodename('BrilliantRose'), true);
    assert.equal(isLikelyCodename('MtWilliamson'), true);
  });

  it('should flag lowercase single words without capitals', () => {
    assert.equal(isLikelyCodename('lisbon'), true);
  });

  it('should flag hex GUIDs', () => {
    assert.equal(isLikelyCodename('7b8fb449c8d3404ba7eda9cd4da1401b'), true);
    assert.equal(isLikelyCodename('d6407c9e6fd54cb492b8c6635480d792'), true);
  });

  it('should NOT flag ALL-CAPS game titles', () => {
    assert.equal(isLikelyCodename('DEATHLOOP'), false);
    assert.equal(isLikelyCodename('SUPERHOT'), false);
    assert.equal(isLikelyCodename('SOMA'), false);
    assert.equal(isLikelyCodename('ABZU'), false);
    assert.equal(isLikelyCodename('RUINER'), false);
    assert.equal(isLikelyCodename('GNOG'), false);
    assert.equal(isLikelyCodename('INDUSTRIA'), false);
  });

  it('should NOT flag real single-word game titles', () => {
    assert.equal(isLikelyCodename('Celeste'), false);
    assert.equal(isLikelyCodename('Subnautica'), false);
    assert.equal(isLikelyCodename('Fortnite'), false);
    assert.equal(isLikelyCodename('Control'), false);
    assert.equal(isLikelyCodename('Satisfactory'), false);
    assert.equal(isLikelyCodename('Fez'), false);
    assert.equal(isLikelyCodename('Limbo'), false);
    assert.equal(isLikelyCodename('Hue'), false);
    assert.equal(isLikelyCodename('Prey'), false);
  });

  it('should NOT flag multi-word titles', () => {
    assert.equal(isLikelyCodename('Half-Life 2'), false);
    assert.equal(isLikelyCodename('The Witcher 3'), false);
    assert.equal(isLikelyCodename('Fallout New Vegas'), false);
  });

  it('should flag when title equals launcher_game_id', () => {
    assert.equal(isLikelyCodename('Peony', 'Peony'), true);
    assert.equal(isLikelyCodename('Celeste', '12345'), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/utils/codenameDetector.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// backend/src/utils/codenameDetector.js

// Known real single-word game titles that look like codenames but aren't.
// Add to this list as false positives are discovered.
const KNOWN_REAL_TITLES = new Set([
  'celeste', 'subnautica', 'fortnite', 'control', 'satisfactory',
  'fez', 'limbo', 'hue', 'prey', 'steep', 'inside', 'horace',
  'everything', 'minit', 'overcooked', 'torchlight', 'carcassonne',
  'observer', 'maneater', 'faeria', 'gamedec', 'windbound',
  'crashlands', 'frostpunk', 'relicta', 'sheltered', 'dandara',
  'figment', 'tunche', 'pikuniku', 'solitairica', 'levelhead',
  'mutazione', 'tharsis', 'paradigm', 'pathway', 'breathedge',
  'automachef', 'transistor', 'moonlighter', 'vampyr', 'oxenfree',
  'dauntless', 'maneater', 'ghostrunner', 'tannenberg', 'verdun',
  'mothergunship', 'sifu', 'soulstice', 'godfall', 'quake',
  'tyranny', 'mudrunner',
]);

function isLikelyCodename(title, launcherGameId) {
  if (!title) return false;

  // "Live" is always a codename (sandbox name for live-service DLC)
  if (title === 'Live') return true;

  // Multi-word titles are real games
  if (/\s/.test(title) || /-/.test(title)) return false;

  // Hex GUID pattern
  if (/^[0-9a-f]{20,}$/i.test(title)) return true;

  // Title equals launcher_game_id (no human-readable name was available)
  if (launcherGameId && title === launcherGameId) return true;

  // ALL-CAPS titles are real (DEATHLOOP, SUPERHOT, SOMA, etc.)
  if (title === title.toUpperCase() && title.length >= 3) return false;

  // Known real titles
  if (KNOWN_REAL_TITLES.has(title.toLowerCase())) return false;

  // PascalCase with 3+ capitals (CadmiumRed, CharlestonGreen, BrilliantRose)
  // Requires 3+ to avoid false positives on real titles like SpongeBob, StarCraft
  const caps = (title.match(/[A-Z]/g) || []).length;
  if (caps >= 3 && !/\d/.test(title)) return true;

  // camelCase-style mid-word capital (but only 2 caps, e.g., "MtWilliamson")
  if (caps === 2 && /^[A-Z][a-z]+[A-Z]/.test(title) && !/\d/.test(title)) return true;

  // Single lowercase word (lisbon, corn)
  if (title === title.toLowerCase() && title.length <= 12) return true;

  return false;
}

module.exports = { isLikelyCodename, KNOWN_REAL_TITLES };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/utils/codenameDetector.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/codenameDetector.js backend/tests/utils/codenameDetector.test.js
git commit -m "feat(phase12): add codename detection heuristic"
```

---

### Task 2: Database Migration

**Files:**
- Modify: `backend/src/db/schema.sql` (game_editions table, ~line 36-50)
- Modify: `backend/src/db/migrate.js` (after Phase 11b, ~line 163)
- Create: `backend/tests/db/migrate-phase12.test.js`

- [ ] **Step 1: Add columns to schema.sql**

In `backend/src/db/schema.sql`, add four columns to the `game_editions` CREATE TABLE:

```sql
  epic_namespace TEXT,
  epic_catalog_id TEXT,
  sandbox_type TEXT,
  parent_edition_id INTEGER REFERENCES game_editions(id),
```

- [ ] **Step 2: Add migration logic to migrate.js**

After Phase 11b consolidation (before `return db`), add:

```js
  // Phase 12: Epic catalog resolution columns
  const geColsP12 = db.pragma('table_info(game_editions)');
  if (!geColsP12.some(c => c.name === 'epic_namespace')) {
    db.exec('ALTER TABLE game_editions ADD COLUMN epic_namespace TEXT');
    db.exec('ALTER TABLE game_editions ADD COLUMN epic_catalog_id TEXT');
    db.exec('ALTER TABLE game_editions ADD COLUMN sandbox_type TEXT');
    console.log('[Migration] Phase 12: Added epic_namespace, epic_catalog_id, sandbox_type columns');
  }
  if (!geColsP12.some(c => c.name === 'parent_edition_id')) {
    db.exec('ALTER TABLE game_editions ADD COLUMN parent_edition_id INTEGER REFERENCES game_editions(id)');
    console.log('[Migration] Phase 12: Added parent_edition_id column');
  }
```

- [ ] **Step 3: Write migration test**

```js
// backend/tests/db/migrate-phase12.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Phase 12 migration', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-phase12.db');
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

  it('game_editions should have epic_namespace column', () => {
    const cols = db.pragma('table_info(game_editions)').map(c => c.name);
    assert.ok(cols.includes('epic_namespace'));
    assert.ok(cols.includes('epic_catalog_id'));
    assert.ok(cols.includes('sandbox_type'));
    assert.ok(cols.includes('parent_edition_id'));
  });
});
```

- [ ] **Step 4: Run migration test**

Run: `cd backend && node --test tests/db/migrate-phase12.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.sql backend/src/db/migrate.js backend/tests/db/migrate-phase12.test.js
git commit -m "feat(phase12): add Epic metadata and parent_edition_id migration"
```

---

### Task 3: Epic Catalog Module (DLC Nesting + Codename Resolution)

**Files:**
- Create: `backend/src/services/launchers/epicCatalog.js`
- Create: `backend/tests/services/launchers/epicCatalog.test.js`

- [ ] **Step 1: Write failing tests**

```js
// backend/tests/services/launchers/epicCatalog.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('epicCatalog', () => {
  describe('nestDLC', () => {
    it('should set parent_edition_id for non-PUBLIC items in same namespace', () => {
      // Test with in-memory mock db pattern
      const { nestDLC } = require('../../../src/services/launchers/epicCatalog');

      // Create a minimal test db
      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE launchers (id INTEGER PRIMARY KEY, name TEXT, display_name TEXT, enabled INTEGER);
        CREATE TABLE game_editions (
          id INTEGER PRIMARY KEY, launcher_id INTEGER, launcher_game_id TEXT,
          title TEXT, game_id INTEGER, owned INTEGER DEFAULT 1,
          epic_namespace TEXT, epic_catalog_id TEXT, sandbox_type TEXT,
          parent_edition_id INTEGER, playtime_minutes INTEGER DEFAULT 0
        );
        CREATE TABLE edition_tiers (
          id INTEGER PRIMARY KEY, game_edition_id INTEGER, tier INTEGER DEFAULT 0,
          is_display_edition INTEGER DEFAULT 0
        );
        INSERT INTO launchers VALUES (1, 'epic', 'Epic Games', 1);
      `);

      // Base game + 2 DLC in same namespace
      db.exec(`
        INSERT INTO game_editions (id, launcher_id, launcher_game_id, title, epic_namespace, sandbox_type) VALUES
          (1, 1, 'base', 'Fortnite', 'ns-fortnite', 'PUBLIC'),
          (2, 1, 'dlc1', 'Live', 'ns-fortnite', 'LIVE'),
          (3, 1, 'dlc2', 'Live', 'ns-fortnite', 'LIVE'),
          (4, 1, 'other', 'Celeste', 'ns-celeste', 'PUBLIC');
      `);

      const launcherId = 1;
      nestDLC(db, launcherId);

      // DLC items should have parent_edition_id = base game
      const dlc1 = db.prepare('SELECT parent_edition_id FROM game_editions WHERE id = 2').get();
      const dlc2 = db.prepare('SELECT parent_edition_id FROM game_editions WHERE id = 3').get();
      assert.equal(dlc1.parent_edition_id, 1);
      assert.equal(dlc2.parent_edition_id, 1);

      // Base game and single-item namespace should have no parent
      const base = db.prepare('SELECT parent_edition_id FROM game_editions WHERE id = 1').get();
      const celeste = db.prepare('SELECT parent_edition_id FROM game_editions WHERE id = 4').get();
      assert.equal(base.parent_edition_id, null);
      assert.equal(celeste.parent_edition_id, null);

      db.close();
    });
  });

  describe('resolveCodenames', () => {
    it('should update titles from catalog API response', async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const { resolveCodenames } = require('../../../src/services/launchers/epicCatalog');

      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE launchers (id INTEGER PRIMARY KEY, name TEXT, display_name TEXT, enabled INTEGER);
        CREATE TABLE games (id INTEGER PRIMARY KEY, title TEXT, slug TEXT UNIQUE);
        CREATE TABLE game_editions (
          id INTEGER PRIMARY KEY, launcher_id INTEGER, launcher_game_id TEXT,
          title TEXT, game_id INTEGER, owned INTEGER DEFAULT 1,
          epic_namespace TEXT, epic_catalog_id TEXT, sandbox_type TEXT,
          parent_edition_id INTEGER, playtime_minutes INTEGER DEFAULT 0
        );
        INSERT INTO launchers VALUES (1, 'epic', 'Epic Games', 1);
        INSERT INTO game_editions (id, launcher_id, launcher_game_id, title, epic_namespace, epic_catalog_id)
          VALUES (1, 1, 'Capsicum', 'Capsicum', 'ns-pepper', 'cat-123');
      `);

      // Mock catalog API
      axios.get = async (url) => ({
        data: {
          'cat-123': { id: 'cat-123', title: 'Pepper Grinder', namespace: 'ns-pepper' }
        }
      });

      try {
        const mockSession = { access_token: 'test', token_type: 'bearer' };
        await resolveCodenames(db, 1, mockSession);

        const ed = db.prepare('SELECT title FROM game_editions WHERE id = 1').get();
        assert.equal(ed.title, 'Pepper Grinder');
      } finally {
        axios.get = originalGet;
        db.close();
      }
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/services/launchers/epicCatalog.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// backend/src/services/launchers/epicCatalog.js
const axios = require('axios');
const { isLikelyCodename } = require('../../utils/codenameDetector');

const CATALOG_URL = 'https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Group DLC under parent games by epic_namespace.
 * Base game = sandbox_type 'PUBLIC' or highest edition tier.
 * Sets parent_edition_id on DLC items and copies game_id from parent.
 */
function nestDLC(db, launcherId) {
  // Find namespaces with multiple editions
  const namespaces = db.prepare(`
    SELECT epic_namespace, COUNT(*) as c FROM game_editions
    WHERE launcher_id = ? AND epic_namespace IS NOT NULL
    GROUP BY epic_namespace HAVING c > 1
  `).all(launcherId);

  if (namespaces.length === 0) return;

  const getEditions = db.prepare(`
    SELECT ge.id, ge.sandbox_type, ge.title, COALESCE(et.tier, 0) as tier
    FROM game_editions ge
    LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
    WHERE ge.launcher_id = ? AND ge.epic_namespace = ?
    ORDER BY
      CASE WHEN ge.sandbox_type = 'PUBLIC' THEN 0 ELSE 1 END ASC,
      COALESCE(et.tier, 0) DESC,
      length(ge.title) DESC
  `);
  const setParent = db.prepare('UPDATE game_editions SET parent_edition_id = ? WHERE id = ?');

  const resetParent = db.prepare('UPDATE game_editions SET parent_edition_id = NULL WHERE launcher_id = ? AND epic_namespace = ?');

  const nestAll = db.transaction(() => {
    for (const { epic_namespace } of namespaces) {
      // Reset for idempotency on re-sync
      resetParent.run(launcherId, epic_namespace);

      const editions = getEditions.all(launcherId, epic_namespace);
      if (editions.length < 2) continue;

      const baseGame = editions[0]; // Best candidate: PUBLIC, highest tier, longest title
      for (let i = 1; i < editions.length; i++) {
        setParent.run(baseGame.id, editions[i].id);
      }
    }
  });
  nestAll();

  // Copy game_id from parent to children
  db.prepare(`
    UPDATE game_editions SET game_id = (
      SELECT pe.game_id FROM game_editions pe WHERE pe.id = game_editions.parent_edition_id
    ) WHERE parent_edition_id IS NOT NULL AND game_id IS NULL
  `).run();

  console.log(`[Epic Catalog] Nested DLC for ${namespaces.length} namespaces`);
}

/**
 * Resolve codename titles via Epic catalog API.
 * Queries bulk items endpoint per namespace, updates edition + game titles.
 */
async function resolveCodenames(db, launcherId, session) {
  // Find editions needing resolution
  const candidates = db.prepare(`
    SELECT DISTINCT epic_namespace FROM game_editions
    WHERE launcher_id = ? AND epic_namespace IS NOT NULL AND epic_catalog_id IS NOT NULL
  `).all(launcherId);

  // All namespaces are candidates — the JS heuristic filters per-item
  // (SQL pre-filtering was too narrow and missed PascalCase codenames)
  const namespacesWithCodenames = candidates.map(c => c.epic_namespace);

  if (namespacesWithCodenames.length === 0) return;

  const authHeader = `${session.token_type || 'bearer'} ${session.access_token}`;
  let resolved = 0;

  for (const ns of namespacesWithCodenames) {
    try {
      const res = await axios.get(`${CATALOG_URL}/${ns}/bulk/items`, {
        headers: { Authorization: authHeader },
        params: { includeMainGameDetails: true, country: 'US', locale: 'en-US' },
      });

      const items = res.data || {};
      const updateTitle = db.prepare('UPDATE game_editions SET title = ? WHERE epic_catalog_id = ? AND launcher_id = ?');
      const updateGameTitle = db.prepare(`
        UPDATE games SET title = ? WHERE id = (
          SELECT game_id FROM game_editions WHERE epic_catalog_id = ? AND launcher_id = ?
        )
      `);

      for (const [catalogId, item] of Object.entries(items)) {
        if (!item.title) continue;
        const edition = db.prepare(
          'SELECT id, title, launcher_game_id FROM game_editions WHERE epic_catalog_id = ? AND launcher_id = ?'
        ).get(catalogId, launcherId);
        if (!edition) continue;
        if (!isLikelyCodename(edition.title, edition.launcher_game_id)) continue;

        updateTitle.run(item.title, catalogId, launcherId);
        updateGameTitle.run(item.title, catalogId, launcherId);
        resolved++;
      }
    } catch (err) {
      console.warn(`[Epic Catalog] Failed to resolve namespace ${ns}: ${err.message}`);
    }

    await sleep(500);
  }

  console.log(`[Epic Catalog] Resolved ${resolved} codename titles across ${namespacesWithCodenames.length} namespaces`);
}

module.exports = { nestDLC, resolveCodenames };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/services/launchers/epicCatalog.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/launchers/epicCatalog.js backend/tests/services/launchers/epicCatalog.test.js
git commit -m "feat(phase12): add Epic catalog DLC nesting and codename resolution"
```

---

### Task 4: Update Epic Sync — Return All Items with Metadata

**Files:**
- Modify: `backend/src/services/launchers/epic.js` (~lines 116-199)

- [ ] **Step 1: Remove namespace dedup and add metadata fields**

In `fetchOwnedGames()`:
1. Remove the `seenNamespaces` dedup filter (lines ~183-190)
2. Remove namespace distribution debug logging (lines ~172-180)
3. Remove sample item debug logging (lines ~138-143)
4. Remove auth debug logging (line ~120)
5. Update item mapping to include `epic_namespace`, `epic_catalog_id`, `sandbox_type`

The return mapping becomes:
```js
    return allItems
      .filter(item => item.appName || item.catalogItemId)
      .map(item => {
        const id = item.appName || item.catalogItemId;
        return {
          launcher_game_id: id,
          title: item.sandboxName || item.appName || id,
          playtime_minutes: playtimeMap[id] || 0,
          epic_namespace: item.namespace || null,
          epic_catalog_id: item.catalogItemId || null,
          sandbox_type: item.sandboxType || null,
        };
      });
```

- [ ] **Step 2: Update existing epic.test.js**

Update the `fetchOwnedGames()` tests to include `namespace`, `sandboxType` in mock data and verify the new fields are returned. Update the namespace dedup test to verify all items are returned (not deduplicated).

- [ ] **Step 3: Run Epic tests**

Run: `cd backend && node --test tests/services/launchers/epic.test.js`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/launchers/epic.js backend/tests/services/launchers/epic.test.js
git commit -m "feat(phase12): return all Epic items with namespace metadata, remove dedup"
```

---

### Task 5: Update SyncEngine — Upsert New Columns + Post-Sync Hooks

**Files:**
- Modify: `backend/src/services/syncEngine.js` (~lines 51-58 upsert, ~lines 129-131 enrichment)

- [ ] **Step 1: Update upsert to include new columns**

Change the upsert SQL (lines ~51-58) to include the three Epic columns:

```js
    const upsert = db.prepare(`
      INSERT INTO game_editions (launcher_id, launcher_game_id, title, playtime_minutes, owned,
                                  epic_namespace, epic_catalog_id, sandbox_type)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(launcher_id, launcher_game_id) DO UPDATE SET
        title = excluded.title,
        playtime_minutes = excluded.playtime_minutes,
        epic_namespace = excluded.epic_namespace,
        epic_catalog_id = excluded.epic_catalog_id,
        sandbox_type = excluded.sandbox_type,
        owned = 1
    `);
```

Update the `upsertAll` transaction to pass the new fields:
```js
    const upsertAll = db.transaction((items) => {
      for (const game of items) {
        returnedIds.add(game.launcher_game_id);
        const result = upsert.run(
          launcher.id,
          game.launcher_game_id,
          game.title,
          game.playtime_minutes,
          game.epic_namespace || null,
          game.epic_catalog_id || null,
          game.sandbox_type || null
        );
        if (result.changes > 0) gamesUpdated++;
      }
    });
```

- [ ] **Step 2: Add post-sync DLC nesting and catalog resolution**

After the edition tier computation and before `enrichAll`, add:

```js
    // Epic-specific post-sync: DLC nesting + codename resolution
    if (launcherName === 'epic') {
      const { nestDLC, resolveCodenames } = require('./launchers/epicCatalog');
      nestDLC(db, launcher.id);

      // resolveCodenames needs a valid session token
      if (session && session.access_token) {
        try {
          await resolveCodenames(db, launcher.id, session);
        } catch (err) {
          console.warn('[Epic Catalog] Codename resolution failed:', err.message);
        }
      }
    }
```

- [ ] **Step 3: Run syncEngine tests**

Run: `cd backend && node --test tests/services/syncEngine.test.js`
Expected: All PASS (existing tests unaffected — non-Epic launchers don't populate epic_* fields)

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/syncEngine.js
git commit -m "feat(phase12): upsert Epic metadata columns and post-sync catalog hooks"
```

---

### Task 6: Filter DLC from API Queries

**Files:**
- Modify: `backend/src/routes/games.js` (filters endpoint, dedup CTE, platforms, detail)
- Modify: `backend/src/services/metadata/enrichGame.js` (enrichAll query)

- [ ] **Step 1: Add DLC filter to filters endpoint**

In `backend/src/routes/games.js`, update all five filter queries (lines ~12-46) to add `AND ge.parent_edition_id IS NULL` where they join `game_editions ge`. Example for genres:

```sql
SELECT g.name, COUNT(DISTINCT gg.game_id) as count
FROM genres g
JOIN game_genres gg ON gg.genre_id = g.id
JOIN game_editions ge ON ge.game_id = gg.game_id AND ge.owned = 1 AND ge.parent_edition_id IS NULL
GROUP BY g.name ORDER BY count DESC
```

Same filter on tags, launchers, yearRange, and playtimeMax queries.

- [ ] **Step 2: Add DLC filter to dedup CTE**

In the ranked CTE inner WHERE (line ~340), add `AND ge.parent_edition_id IS NULL` to both the data query and count query.

In the duplicates=show branch (line ~312), add same filter.

- [ ] **Step 3: Add DLC filter to platforms query**

Update `platformsStmt` (line ~381) to add `AND ge.parent_edition_id IS NULL`.

- [ ] **Step 4: Add dlc_count to list response**

In the response mapping, add:
```js
dlc_count: gameId ? db.prepare(
  'SELECT COUNT(*) as c FROM game_editions WHERE game_id = ? AND parent_edition_id IS NOT NULL AND owned = 1'
).get(gameId)?.c || 0 : 0,
```

- [ ] **Step 5: Filter DLC from detail editions query**

In GET `/:id`, update the existing editions query (line ~79) to add `AND ge.parent_edition_id IS NULL`:
```sql
WHERE ge.game_id = ? AND ge.owned = 1 AND ge.parent_edition_id IS NULL
```
This prevents DLC from appearing in the "Versions & Editions" list.

- [ ] **Step 6: Add DLC array to detail endpoint**

In GET `/:id`, after the editions query, add a separate DLC query:

```js
const dlc = db.prepare(`
  SELECT ge.id, ge.title as edition_title, ge.playtime_minutes,
         l.name as launcher_name, l.display_name as launcher_display_name
  FROM game_editions ge
  JOIN launchers l ON l.id = ge.launcher_id
  WHERE ge.game_id = ? AND ge.parent_edition_id IS NOT NULL AND ge.owned = 1
  ORDER BY ge.title ASC
`).all(id);
```

Add `dlc` to the response object.

- [ ] **Step 7: Filter DLC from enrichment**

In `backend/src/services/metadata/enrichGame.js`, line ~355, change:
```js
const editions = db.prepare('SELECT id, title FROM game_editions WHERE game_id IS NULL').all();
```
To:
```js
const editions = db.prepare('SELECT id, title FROM game_editions WHERE game_id IS NULL AND parent_edition_id IS NULL').all();
```

- [ ] **Step 8: Write API tests for DLC filtering**

Add a test file `backend/tests/routes/games-dlc.test.js` that seeds:
- A game with a base edition and 2 DLC editions (parent_edition_id set)
- Verifies GET /api/games excludes DLC, returns dlc_count
- Verifies GET /api/games/:id has separate `editions` and `dlc` arrays
- Verifies DLC not in editions, editions not in dlc

Follow the `makeFetch` helper pattern from existing `games.test.js`.

- [ ] **Step 9: Run full backend test suite**

Run: `cd backend && shopt -s globstar && node --test tests/**/*.test.js`
Expected: All pass

- [ ] **Step 10: Commit**

```bash
git add backend/src/routes/games.js backend/src/services/metadata/enrichGame.js backend/tests/routes/games-dlc.test.js
git commit -m "feat(phase12): filter DLC from library queries, add dlc_count and dlc array"
```

---

### Task 7: Frontend — DLC Count Badge + DLC Section

**Files:**
- Modify: `frontend/src/components/GameCard.jsx`
- Modify: `frontend/src/pages/GameDetail.jsx`

- [ ] **Step 1: Add DLC count to GameCard**

In `GameCard.jsx`, after the platform tags div, add:
```jsx
{game.dlc_count > 0 && (
  <span className="text-xs text-gray-500">+{game.dlc_count} DLC</span>
)}
```

- [ ] **Step 2: Add DLC & Content section to GameDetail**

In `GameDetail.jsx`, after the "Versions & Editions" section, add:

```jsx
{/* DLC & Content */}
{game.dlc && game.dlc.length > 0 && (
  <div className="mt-6">
    <button
      onClick={() => setShowDLC(!showDLC)}
      className="text-lg font-semibold text-white mb-3 flex items-center gap-2"
    >
      DLC & Content ({game.dlc.length})
      <span className="text-sm text-gray-400">{showDLC ? '▼' : '▶'}</span>
    </button>
    {showDLC && (
      <div className="space-y-1">
        {game.dlc.map(item => (
          <div key={item.id} className="flex items-center gap-3 p-2 bg-gray-800 rounded">
            <LauncherBadge
              launcherName={item.launcher_name}
              displayName={item.launcher_display_name}
              size="small"
            />
            <span className="text-gray-300 text-sm">{item.edition_title}</span>
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

Add `const [showDLC, setShowDLC] = useState(false);` to the component state.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/GameCard.jsx frontend/src/pages/GameDetail.jsx
git commit -m "feat(phase12): add DLC count badge and DLC section on detail page"
```

---

### Task 8: Version Bump + Final Tests

**Files:**
- Modify: `backend/package.json`, `frontend/package.json`
- Modify: `backend/tests/server.test.js`

- [ ] **Step 1: Bump version to 1.7.0**

Update both `package.json` files from `1.6.0` to `1.7.0`.
Update `server.test.js` version assertion.

- [ ] **Step 2: Run full test suite**

Run: `cd backend && shopt -s globstar && node --test tests/**/*.test.js`
Expected: All pass

- [ ] **Step 3: Commit and push**

```bash
git add backend/package.json frontend/package.json backend/tests/server.test.js
git commit -m "chore(phase12): bump version to 1.7.0"
git push origin master
```
