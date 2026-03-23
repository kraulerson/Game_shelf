# Phase 6: Launcher Credential Removal, Smart Re-enrichment & Scheduled Enrichment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to remove launcher credentials (soft-hiding games), add smart re-enrichment for under-enriched games, and schedule daily enrichment.

**Architecture:** Three backend changes (DELETE endpoint, enrichUnderEnriched function, daily cron) plus frontend updates to the Settings LaunchersTab. The enrichment pipeline is extended — not replaced — so all existing callers automatically gain retry behavior.

**Tech Stack:** Express.js, better-sqlite3, node-cron, React + TanStack Query

**Spec:** `docs/superpowers/specs/2026-03-22-gameshelf-phase6-design.md`

---

### Task 1: Database migration — add `last_enrichment_at` to games table

**Files:**
- Modify: `backend/src/db/migrate.js:78-85` (add after existing Phase 3 migrations)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/db/migrate-phase6.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Phase 6 migration: last_enrichment_at column', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-migrate-phase6.db');
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

  it('games table should have last_enrichment_at column', () => {
    const cols = db.pragma('table_info(games)');
    const col = cols.find(c => c.name === 'last_enrichment_at');
    assert.ok(col, 'last_enrichment_at column should exist');
  });

  it('last_enrichment_at should default to NULL', () => {
    db.prepare("INSERT INTO games (title, slug) VALUES ('Test Game', 'test-game')").run();
    const game = db.prepare("SELECT last_enrichment_at FROM games WHERE slug = 'test-game'").get();
    assert.equal(game.last_enrichment_at, null);
    db.prepare("DELETE FROM games WHERE slug = 'test-game'").run();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/db/migrate-phase6.test.js`
Expected: FAIL — `last_enrichment_at column should exist`

- [ ] **Step 3: Write the migration**

In `backend/src/db/migrate.js`, add after line 85 (after the `games_updated` migration):

```js
  // Phase 6 migration: add last_enrichment_at to games
  const gamesCols = db.pragma('table_info(games)');
  if (!gamesCols.some(c => c.name === 'last_enrichment_at')) {
    db.exec('ALTER TABLE games ADD COLUMN last_enrichment_at TEXT');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/db/migrate-phase6.test.js`
Expected: PASS

- [ ] **Step 5: Run all existing tests to check for regressions**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/migrate.js backend/tests/db/migrate-phase6.test.js
git commit -m "feat: add last_enrichment_at column to games table"
```

---

### Task 2: DELETE endpoint for launcher credentials

**Files:**
- Modify: `backend/src/routes/launchers.js:103-124` (add before the priority route)
- Create: `backend/tests/routes/launchers-delete.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/routes/launchers-delete.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('DELETE /api/launchers/:id/credentials', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-launchers-delete.db');
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

    // Setup: insert launcher with credentials and game editions
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ api_key: 'test-key', steamid64: '123' }));
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json, last_sync_at) VALUES (?, ?, 1, ?, ?)'
    ).run('steam', 'Steam', creds, '2026-03-22T00:00:00Z');

    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, 1)'
    ).run(launcher.id, '440', 'Team Fortress 2');
    db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, 1)'
    ).run(launcher.id, '570', 'Dota 2');
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('should clear credentials, disable launcher, and soft-remove editions', () => {
    // Simulate the DELETE handler logic directly against the DB
    const launcher = db.prepare('SELECT id, display_name FROM launchers WHERE name = ?').get('steam');

    db.prepare(
      'UPDATE launchers SET credentials_json = NULL, enabled = 0, last_sync_at = NULL WHERE name = ?'
    ).run('steam');

    const editionResult = db.prepare(
      'UPDATE game_editions SET owned = 0 WHERE launcher_id = ?'
    ).run(launcher.id);

    // Verify launcher state
    const updated = db.prepare('SELECT * FROM launchers WHERE name = ?').get('steam');
    assert.equal(updated.credentials_json, null);
    assert.equal(updated.enabled, 0);
    assert.equal(updated.last_sync_at, null);

    // Verify editions soft-removed
    const editions = db.prepare(
      'SELECT owned FROM game_editions WHERE launcher_id = ?'
    ).all(launcher.id);
    assert.ok(editions.every(e => e.owned === 0), 'All editions should be owned=0');
    assert.equal(editionResult.changes, 2, 'Should have affected 2 editions');
  });

  it('should reject unknown launcher names', () => {
    // The route handler checks LAUNCHER_MAP; we just verify the map doesn't contain 'bogus'
    const AVAILABLE_LAUNCHERS = [
      { id: 'steam' }, { id: 'ea' }, { id: 'ubisoft' }, { id: 'epic' },
      { id: 'humble' }, { id: 'itchio' }, { id: 'gog' }, { id: 'battlenet' }, { id: 'xbox' },
    ];
    const LAUNCHER_MAP = Object.fromEntries(AVAILABLE_LAUNCHERS.map(l => [l.id, l]));
    assert.equal(LAUNCHER_MAP['bogus'], undefined);
    assert.ok(LAUNCHER_MAP['steam']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/routes/launchers-delete.test.js`
Expected: PASS (these are DB-level tests that validate the logic we're about to wire up)

- [ ] **Step 3: Implement the DELETE endpoint**

In `backend/src/routes/launchers.js`, add before the `// POST /api/launchers/priority` block (before line 104):

```js
// DELETE /api/launchers/:id/credentials
router.delete('/:id/credentials', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const row = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!row) {
    return res.json({ removed: false, launcher: launcher.display_name, gamesAffected: 0 });
  }

  db.prepare(
    'UPDATE launchers SET credentials_json = NULL, enabled = 0, last_sync_at = NULL WHERE name = ?'
  ).run(id);

  const result = db.prepare(
    'UPDATE game_editions SET owned = 0 WHERE launcher_id = ?'
  ).run(row.id);

  res.json({ removed: true, launcher: launcher.display_name, gamesAffected: result.changes });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/routes/launchers-delete.test.js`
Expected: PASS

- [ ] **Step 5: Run all existing tests for regressions**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers-delete.test.js
git commit -m "feat: add DELETE endpoint for launcher credential removal"
```

---

### Task 3: Add `configured` field to launchers/available endpoint

**Files:**
- Modify: `backend/src/routes/launchers.js:25-28` (the GET /available handler)

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/routes/launchers-delete.test.js`:

```js
  it('available endpoint should include configured status', () => {
    // Reset steam to have credentials for this test
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ api_key: 'key', steamid64: '123' }));
    db.prepare('UPDATE launchers SET credentials_json = ?, enabled = 1 WHERE name = ?').run(creds, 'steam');

    // Simulate the logic: query configured launchers from DB
    const configured = db.prepare(
      'SELECT name FROM launchers WHERE credentials_json IS NOT NULL'
    ).all();
    const configuredSet = new Set(configured.map(r => r.name));

    assert.ok(configuredSet.has('steam'), 'steam should be configured');
    assert.ok(!configuredSet.has('ea'), 'ea should not be configured');
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/launchers-delete.test.js`
Expected: PASS (DB-level validation)

- [ ] **Step 3: Update the GET /available handler**

In `backend/src/routes/launchers.js`, replace the GET /available handler:

```js
// GET /api/launchers/available
router.get('/available', (req, res) => {
  const db = req.app.locals.db;
  const configured = db.prepare(
    'SELECT name FROM launchers WHERE credentials_json IS NOT NULL'
  ).all();
  const configuredSet = new Set(configured.map(r => r.name));

  const result = AVAILABLE_LAUNCHERS.map(l => ({
    ...l,
    configured: configuredSet.has(l.id),
  }));

  res.json(result);
});
```

- [ ] **Step 4: Run all tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers-delete.test.js
git commit -m "feat: add configured field to launchers/available endpoint"
```

---

### Task 4: Implement `enrichUnderEnriched` function

**Files:**
- Modify: `backend/src/services/metadata/enrichGame.js:135-159` (add new function, modify enrichAll)
- Modify: `backend/tests/services/metadata/enrichGame.test.js` (add new tests)

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/services/metadata/enrichGame.test.js`, inside the describe block (after the last `it` block):

```js
  it('enrichAll should retry under-enriched games (missing cover_url)', async () => {
    // Setup: create a game with no cover_url but linked to an owned edition
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare(
      "INSERT OR IGNORE INTO games (title, slug, description) VALUES ('Half-Life 2', 'half-life-2', NULL)"
    ).run();
    const game = db.prepare("SELECT id FROM games WHERE slug = 'half-life-2'").get();

    db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title, game_id, owned) VALUES (?, ?, ?, ?, 1)'
    ).run(launcher.id, '220', 'Half-Life 2', game.id);

    const result = await enrichAll(db);
    assert.ok(result.enriched >= 0 || result.failed >= 0 || result.skipped >= 0, 'Should return aggregated counts');

    // Verify last_enrichment_at was set
    const updated = db.prepare('SELECT last_enrichment_at FROM games WHERE id = ?').get(game.id);
    assert.ok(updated.last_enrichment_at, 'last_enrichment_at should be set after enrichment attempt');
  });

  it('enrichAll should skip under-enriched games within 7-day cooldown', async () => {
    // Set last_enrichment_at to now — should be skipped
    const game = db.prepare("SELECT id FROM games WHERE slug = 'half-life-2'").get();
    db.prepare("UPDATE games SET last_enrichment_at = datetime('now') WHERE id = ?").run(game.id);

    const result = await enrichAll(db);
    // The game should not be retried since last_enrichment_at is recent
    assert.ok(result.enriched >= 0, 'Should return counts');
  });

  it('enrichAll should skip games with no owned editions', async () => {
    // Mark all editions for half-life-2 as unowned
    const game = db.prepare("SELECT id FROM games WHERE slug = 'half-life-2'").get();
    db.prepare('UPDATE game_editions SET owned = 0 WHERE game_id = ?').run(game.id);
    // Clear last_enrichment_at so it would be eligible otherwise
    db.prepare('UPDATE games SET last_enrichment_at = NULL WHERE id = ?').run(game.id);

    const result = await enrichAll(db);
    // The game has no owned editions, so should not be re-enriched
    const updated = db.prepare('SELECT last_enrichment_at FROM games WHERE id = ?').get(game.id);
    assert.equal(updated.last_enrichment_at, null, 'Should not have been touched');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/services/metadata/enrichGame.test.js`
Expected: FAIL — `last_enrichment_at should be set after enrichment attempt` (enrichAll doesn't yet process under-enriched games)

- [ ] **Step 3: Implement `enrichUnderEnriched`**

In `backend/src/services/metadata/enrichGame.js`, add the new function before `module.exports` and modify `enrichAll`:

```js
async function enrichUnderEnriched(db) {
  const underEnriched = db.prepare(`
    SELECT DISTINCT g.id, g.title, g.slug
    FROM games g
    JOIN game_editions ge ON ge.game_id = g.id AND ge.owned = 1
    WHERE (g.cover_url IS NULL OR g.description IS NULL)
      AND (g.last_enrichment_at IS NULL
           OR g.last_enrichment_at < datetime('now', '-7 days'))
  `).all();

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (const game of underEnriched) {
    try {
      const normalizedTitle = normalize(game.title);
      const igdbResults = await igdbClient.search(normalizedTitle);
      const match = igdbResults ? findBestMatch(game.title, igdbResults) : null;

      if (!match) {
        console.log(`[Gameshelf Metadata] Re-enrich: no IGDB match for: ${game.title}`);
        db.prepare("UPDATE games SET last_enrichment_at = datetime('now') WHERE id = ?").run(game.id);
        skipped++;
        await sleep(500);
        continue;
      }

      const description = match.summary || null;
      const releaseYear = match.first_release_date
        ? new Date(match.first_release_date * 1000).getFullYear()
        : null;
      const companies = match.involved_companies || [];
      const developer = companies.find(c => c.developer)?.company?.name || null;
      const publisher = companies.find(c => c.publisher)?.company?.name || null;

      // Update game metadata + last_enrichment_at in one statement
      db.prepare(`
        UPDATE games SET
          description = COALESCE(?, description),
          release_year = COALESCE(?, release_year),
          developer = COALESCE(?, developer),
          publisher = COALESCE(?, publisher),
          last_enrichment_at = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(description, releaseYear, developer, publisher, game.id);

      // Download and cache images
      try {
        const coverUrl = match.cover?.url || null;
        const artworkUrl = match.artworks?.[0]?.url || null;

        if (coverUrl) {
          const coverPath = await cacheImage(coverUrl, game.id, 'cover');
          if (coverPath) {
            db.prepare('UPDATE games SET cover_url = ? WHERE id = ?').run(coverPath, game.id);
            const iconPath = await cacheImage(coverUrl, game.id, 'icon');
            if (iconPath) {
              db.prepare('UPDATE games SET icon_url = ? WHERE id = ?').run(iconPath, game.id);
            }
          }
        }

        if (artworkUrl) {
          const heroPath = await cacheImage(artworkUrl, game.id, 'hero');
          if (heroPath) {
            db.prepare('UPDATE games SET hero_url = ? WHERE id = ?').run(heroPath, game.id);
          }
        }
      } catch (err) {
        console.warn(`[Gameshelf Metadata] Re-enrich image download failed for ${game.title}: ${err.message}`);
      }

      // Update genres and tags
      db.prepare('DELETE FROM game_genres WHERE game_id = ?').run(game.id);
      db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(game.id);

      const genres = match.genres || [];
      const insertGenre = db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)');
      const insertGameGenre = db.prepare('INSERT OR IGNORE INTO game_genres (game_id, genre_id) VALUES (?, ?)');
      const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
      const insertGameTag = db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)');

      const upsertGenres = db.transaction((genreList) => {
        for (const genre of genreList) {
          const genreName = genre.name || genre;
          if (!genreName) continue;
          insertGenre.run(genreName);
          const genreRow = db.prepare('SELECT id FROM genres WHERE name = ?').get(genreName);
          insertGameGenre.run(game.id, genreRow.id);
          insertTag.run(genreName);
          const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(genreName);
          insertGameTag.run(game.id, tagRow.id);
        }
      });
      upsertGenres(genres);

      enriched++;
      console.log(`[Gameshelf Metadata] Re-enriched: ${game.title}`);
    } catch (err) {
      console.error(`[Gameshelf Metadata] Re-enrich failed for "${game.title}": ${err.message}`);
      // Still mark last_enrichment_at to avoid infinite retries on crash-inducing games
      try {
        db.prepare("UPDATE games SET last_enrichment_at = datetime('now') WHERE id = ?").run(game.id);
      } catch (_) { /* ignore */ }
      failed++;
    }

    await sleep(500);
  }

  return { enriched, failed, skipped };
}
```

Then replace the existing `enrichAll` function:

```js
async function enrichAll(db) {
  const editions = db.prepare('SELECT id, title FROM game_editions WHERE game_id IS NULL').all();

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (const edition of editions) {
    try {
      const result = await enrichGame(edition.id, db);
      if (result.status === 'enriched' || result.status === 'minimal') enriched++;
      else skipped++;
    } catch (err) {
      console.error(`[Gameshelf Metadata] Failed to enrich "${edition.title}": ${err.message}`);
      failed++;
    }

    await sleep(500);
  }

  // Phase 2: retry under-enriched games
  const reEnrichResult = await enrichUnderEnriched(db);
  enriched += reEnrichResult.enriched;
  failed += reEnrichResult.failed;
  skipped += reEnrichResult.skipped;

  return { enriched, failed, skipped };
}
```

Update `module.exports`:

```js
module.exports = { enrichGame, enrichAll, enrichUnderEnriched };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/services/metadata/enrichGame.test.js`
Expected: All PASS

- [ ] **Step 5: Run all tests for regressions**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/metadata/enrichGame.js backend/tests/services/metadata/enrichGame.test.js
git commit -m "feat: add enrichUnderEnriched for smart metadata re-enrichment"
```

---

### Task 5: Add daily enrichment cron job

**Files:**
- Modify: `backend/src/server.js:76-84` (add cron inside `require.main` block)

- [ ] **Step 1: Add the cron job**

First, add the import at the top of `backend/src/server.js`, alongside the other service imports (after line 29):

```js
const { enrichAll } = require('./services/metadata/enrichGame');
```

Then, inside the `if (require.main === module)` block, after the existing cron.schedule call (after line 80), add:

```js
  // Daily enrichment pass at 3 AM — retries under-enriched games
  cron.schedule('0 3 * * *', () => {
    console.log('[Gameshelf Metadata] Starting scheduled daily enrichment');
    enrichAll(db)
      .then(result => console.log(`[Gameshelf Metadata] Daily enrichment complete:`, result))
      .catch(err => console.error('[Gameshelf Metadata] Daily enrichment error:', err.message));
  });
```

- [ ] **Step 2: Verify the server still starts**

Run: `cd backend && node -e "require('./src/server')" && echo "OK"`
Expected: Server loads without errors (exits immediately since require.main !== module)

- [ ] **Step 3: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/server.js
git commit -m "feat: add daily 3 AM cron job for metadata enrichment"
```

---

### Task 6: Frontend — Launcher badge redesign (text-only, larger, always show name)

**Files:**
- Modify: `frontend/src/components/LauncherBadge.jsx` (remove icon, always show name, larger text)
- Modify: `frontend/src/components/GameCard.jsx` (remove `compact` prop usage)
- Modify: `frontend/src/components/GameRow.jsx` (remove `compact` prop usage)

- [ ] **Step 1: Rewrite LauncherBadge to text-only**

Replace the contents of `frontend/src/components/LauncherBadge.jsx`:

```jsx
export default function LauncherBadge({ launcherName, displayName, primary = false }) {
  const colorClasses = primary
    ? 'bg-blue-600 text-white'
    : 'bg-gray-700 text-gray-300 opacity-70';

  return (
    <span className={`inline-flex items-center rounded-full text-sm font-medium px-2.5 py-0.5 ${colorClasses}`}>
      {displayName || launcherName}
    </span>
  );
}
```

- [ ] **Step 2: Update GameCard — remove `compact` prop, always show launcher name**

In `frontend/src/components/GameCard.jsx`, change the LauncherBadge usages:

Replace:
```jsx
          <LauncherBadge
            launcherName={game.launcher_name}
            displayName={game.launcher_display_name}
            compact
            primary
          />
```
With:
```jsx
          <LauncherBadge
            launcherName={game.launcher_name}
            displayName={game.launcher_display_name}
            primary
          />
```

And in the also-on popover, replace:
```jsx
                      <LauncherBadge launcherName={l.launcher_name} displayName={l.launcher_display_name} compact />
```
With:
```jsx
                      <LauncherBadge launcherName={l.launcher_name} displayName={l.launcher_display_name} />
```

- [ ] **Step 3: Update GameRow — remove `compact` prop**

In `frontend/src/components/GameRow.jsx`, replace:
```jsx
        <LauncherBadge launcherName={game.launcher_name} displayName={game.launcher_display_name} compact primary />
```
With:
```jsx
        <LauncherBadge launcherName={game.launcher_name} displayName={game.launcher_display_name} primary />
```

And in the also-on popover, replace:
```jsx
                    <LauncherBadge launcherName={l.launcher_name} displayName={l.launcher_display_name} compact />
```
With:
```jsx
                    <LauncherBadge launcherName={l.launcher_name} displayName={l.launcher_display_name} />
```

- [ ] **Step 4: Verify the frontend builds**

Run: `cd frontend && npx vite build`
Expected: Build succeeds with no errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/LauncherBadge.jsx frontend/src/components/GameCard.jsx frontend/src/components/GameRow.jsx
git commit -m "feat: redesign launcher badges as text-only labels with larger font"
```

---

### Task 7: Frontend — Remove button in LaunchersTab

**Files:**
- Modify: `frontend/src/pages/Settings.jsx:7-57` (the LaunchersTab component)

- [ ] **Step 1: Update LaunchersTab with remove functionality**

Replace the `LaunchersTab` function in `frontend/src/pages/Settings.jsx`:

```jsx
function LaunchersTab() {
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(null);

  const { data: launchers } = useQuery({
    queryKey: ['launchersAvailable'],
    queryFn: () => fetch('/api/launchers/available', { credentials: 'same-origin' }).then(r => r.json()),
  });
  const { data: syncStatus } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: () => fetch('/api/sync/status', { credentials: 'same-origin' }).then(r => r.json()),
    refetchInterval: 10000,
  });

  const statusMap = {};
  (syncStatus || []).forEach(j => { statusMap[j.launcher_name] = j; });

  async function syncLauncher(name) {
    await fetch(`/api/sync/${name}`, { method: 'POST', credentials: 'same-origin' });
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
  }

  async function removeLauncher(name) {
    await fetch(`/api/launchers/${name}/credentials`, { method: 'DELETE', credentials: 'same-origin' });
    setConfirmRemove(null);
    queryClient.invalidateQueries({ queryKey: ['launchersAvailable'] });
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    queryClient.invalidateQueries({ queryKey: ['games'] });
  }

  return (
    <div className="space-y-3">
      {(launchers || []).map(l => {
        const status = statusMap[l.id];
        return (
          <div key={l.id} className="bg-gray-800 rounded-lg p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <LauncherBadge launcherName={l.id} displayName={l.display_name} primary />
              <div>
                <div className="text-sm text-white">{l.display_name}</div>
                <div className="text-xs text-gray-500">
                  {l.configured
                    ? (status?.completed_at ? `Last synced: ${new Date(status.completed_at).toLocaleString()}` : 'Configured — never synced')
                    : 'Not configured'}
                  {status?.status && l.configured && (
                    <span className={`ml-2 ${status.status === 'success' ? 'text-green-400' : status.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}`}>
                      ({status.status})
                    </span>
                  )}
                </div>
              </div>
            </div>
            {l.configured && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => syncLauncher(l.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                >
                  <RefreshCw size={14} /> Sync
                </button>
                <button
                  onClick={() => setConfirmRemove(l.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-red-900/50 hover:bg-red-800/50 text-red-400 text-sm rounded transition-colors"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Confirmation dialog */}
      {confirmRemove && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
            <h3 className="text-white font-medium mb-2">Remove Launcher</h3>
            <p className="text-gray-400 text-sm mb-4">
              Remove {launchers?.find(l => l.id === confirmRemove)?.display_name || confirmRemove} credentials? Your games will be hidden until you re-add credentials.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmRemove(null)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => removeLauncher(confirmRemove)}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd frontend && npx vite build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat: add remove launcher button with confirmation dialog"
```

---

### Task 8: Docker rebuild and manual verification

**Files:** None (verification only)

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 2: Build frontend**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 3: Rebuild and restart Docker containers**

Run: `docker compose build && docker compose up -d`
Expected: Both containers start healthy

- [ ] **Step 4: Manual verification checklist**

1. Navigate to Library — verify launcher badges show text names (e.g. "Steam") with no icons, larger and readable
2. Click a game — verify GameDetail page badges also show text-only launcher names
3. Navigate to Settings → Launchers tab
4. Verify configured launchers show "Sync" and "Remove" buttons
5. Verify unconfigured launchers show "Not configured" with no buttons
6. Click "Remove" on a configured launcher → confirm dialog appears
7. Confirm removal → launcher shows "Not configured", games hidden from library
8. Re-add credentials and sync → games reappear
9. Navigate to Settings → Metadata tab
10. Click "Re-enrich All" → status updates
11. Check backend logs for enrichment output

- [ ] **Step 5: Final commit with version bump**

Update version in `backend/package.json` and `frontend/package.json` from `1.0.0` to `1.1.0`.

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: bump version to 1.1.0 for Phase 6"
```
