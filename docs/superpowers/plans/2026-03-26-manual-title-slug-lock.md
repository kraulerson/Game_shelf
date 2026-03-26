# Manual Title, Slug Fix, and Sync Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect manually edited game titles from enrichment overwrite, handle slug collisions gracefully, and add manual sync lock/unlock for any launcher.

**Architecture:** Add `manual_title` column (same pattern as `manual_description`/`manual_cover`), fix PATCH to set flag and handle slug collisions, protect title in enrichment upsert, add lock-sync endpoint.

**Tech Stack:** Node.js, better-sqlite3, Express, React, Tailwind CSS

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/db/migrate.js` | Modify | Add `manual_title` column migration |
| `backend/src/routes/games.js` | Modify | Set `manual_title=1` on PATCH, handle slug collision, add "title" to manual-override reset |
| `backend/src/services/metadata/enrichGame.js` | Modify | Respect `manual_title` in enrichment upsert |
| `backend/src/routes/metadata.js` | Modify | Respect `manual_title` in re-enrich reset |
| `backend/src/routes/launchers.js` | Modify | Add `POST /:id/lock-sync` endpoint |
| `frontend/src/pages/Settings.jsx` | Modify | Add Lock button next to Sync |
| `backend/tests/db/migrate.test.js` | Modify | Test `manual_title` column exists |
| `backend/tests/routes/games.test.js` | Modify | Test PATCH sets flag, handles slug collision |
| `backend/tests/routes/launchers.test.js` | Modify | Test lock-sync endpoint |

---

### Task 1: Migration — add manual_title column

**Files:**
- Modify: `backend/src/db/migrate.js:226-232`
- Modify: `backend/tests/db/migrate.test.js`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/db/migrate.test.js`:

```javascript
  it('should add manual_title column to games table', () => {
    const cols = db.pragma('table_info(games)');
    const manualTitleCol = cols.find(c => c.name === 'manual_title');
    assert.ok(manualTitleCol, 'manual_title column should exist');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/db/migrate.test.js --test-name-pattern "manual_title"`
Expected: FAIL

- [ ] **Step 3: Add migration**

In `backend/src/db/migrate.js`, after the Phase 13 block (after line 232), add:

```javascript
  // Phase 14: manual_title override flag
  const gamesColsP14 = db.pragma('table_info(games)');
  if (!gamesColsP14.some(c => c.name === 'manual_title')) {
    db.exec('ALTER TABLE games ADD COLUMN manual_title INTEGER DEFAULT 0');
    console.log('[Migration] Phase 14: Added manual_title column');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/db/migrate.test.js --test-name-pattern "manual_title"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/migrate.js backend/tests/db/migrate.test.js
git commit -m "feat: add manual_title column migration (Phase 14)"
```

---

### Task 2: PATCH — set manual_title and handle slug collision

**Files:**
- Modify: `backend/src/routes/games.js:166-173`
- Modify: `backend/tests/routes/games.test.js`

- [ ] **Step 1: Write failing tests**

Add to `backend/tests/routes/games.test.js`:

```javascript
  it('PATCH /api/games/:id should set manual_title flag', async () => {
    const db = app.locals.db;
    // Create a test game
    db.prepare("INSERT OR IGNORE INTO games (title, slug) VALUES ('Test Manual Title', 'test-manual-title')").run();
    const game = db.prepare("SELECT id FROM games WHERE slug = 'test-manual-title'").get();

    const res = await makeFetch(app, `/api/games/${game.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ title: 'New Title' }),
    });
    assert.equal(res.status, 200);

    const updated = db.prepare('SELECT manual_title, title FROM games WHERE id = ?').get(game.id);
    assert.equal(updated.manual_title, 1, 'manual_title should be set to 1');
    assert.equal(updated.title, 'New Title');
  });

  it('PATCH /api/games/:id should handle slug collision gracefully', async () => {
    const db = app.locals.db;
    // Create two games
    db.prepare("INSERT OR IGNORE INTO games (title, slug) VALUES ('Existing Game', 'existing-game')").run();
    db.prepare("INSERT OR IGNORE INTO games (title, slug) VALUES ('Other Game', 'other-game')").run();
    const other = db.prepare("SELECT id FROM games WHERE slug = 'other-game'").get();

    // Rename "Other Game" to "Existing Game" — slug collision
    const res = await makeFetch(app, `/api/games/${other.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ title: 'Existing Game' }),
    });
    assert.equal(res.status, 200);

    const updated = db.prepare('SELECT title, slug FROM games WHERE id = ?').get(other.id);
    assert.equal(updated.title, 'Existing Game');
    assert.ok(updated.slug.startsWith('existing-game'), 'slug should be based on title');
    assert.notEqual(updated.slug, 'existing-game', 'slug should have suffix to avoid collision');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/routes/games.test.js --test-name-pattern "manual_title|slug collision"`
Expected: FAIL

- [ ] **Step 3: Update PATCH endpoint**

In `backend/src/routes/games.js`, replace the title update block (lines 166-173):

```javascript
  if (hasTitle) {
    if (!title.trim()) {
      return res.status(400).json({ error: 'Title cannot be empty' });
    }
    const { slugify } = require('../services/metadata/titleMatcher');
    let slug = slugify(title.trim());

    // Handle slug collision — append suffix if slug exists on a different game
    const existing = db.prepare('SELECT id FROM games WHERE slug = ? AND id != ?').get(slug, id);
    if (existing) {
      let suffix = 2;
      while (db.prepare('SELECT id FROM games WHERE slug = ?').get(`${slug}-${suffix}`)) {
        suffix++;
      }
      slug = `${slug}-${suffix}`;
    }

    db.prepare(
      "UPDATE games SET title = ?, slug = ?, manual_title = 1, updated_at = datetime('now') WHERE id = ?"
    ).run(title.trim(), slug, id);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/routes/games.test.js --test-name-pattern "manual_title|slug collision"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/games.js backend/tests/routes/games.test.js
git commit -m "fix: set manual_title on edit and handle slug collisions"
```

---

### Task 3: Enrichment — respect manual_title

**Files:**
- Modify: `backend/src/services/metadata/enrichGame.js:189-199`
- Modify: `backend/src/routes/metadata.js:36-44`
- Modify: `backend/src/routes/games.js:280` (manual-override reset)

- [ ] **Step 1: Update enrichment upsert to respect manual_title**

In `backend/src/services/metadata/enrichGame.js`, replace the upsert (lines 189-199):

```javascript
  // Upsert games row (respect manual override flags)
  db.prepare(`
    INSERT INTO games (title, slug, description, release_year, developer, publisher, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      title = CASE WHEN games.manual_title = 1 THEN games.title ELSE excluded.title END,
      slug = CASE WHEN games.manual_title = 1 THEN games.slug ELSE excluded.slug END,
      description = CASE WHEN games.manual_description = 1 THEN games.description ELSE excluded.description END,
      release_year = excluded.release_year,
      developer = excluded.developer,
      publisher = excluded.publisher,
      updated_at = datetime('now')
  `).run(gameTitle, gameSlug, description, releaseYear, developer, publisher);
```

- [ ] **Step 2: Update re-enrich reset to respect manual_title**

In `backend/src/routes/metadata.js`, replace the reset query (lines 36-44):

```javascript
    // Reset the game so enrichment picks it up (respect manual override flags)
    db.prepare(`
      UPDATE games SET
        title = CASE WHEN manual_title = 1 THEN title ELSE NULL END,
        slug = CASE WHEN manual_title = 1 THEN slug ELSE NULL END,
        cover_url = CASE WHEN manual_cover = 1 THEN cover_url ELSE NULL END,
        hero_url = CASE WHEN manual_cover = 1 THEN hero_url ELSE NULL END,
        icon_url = CASE WHEN manual_cover = 1 THEN icon_url ELSE NULL END,
        description = CASE WHEN manual_description = 1 THEN description ELSE NULL END,
        last_enrichment_at = NULL
      WHERE id = ?
    `).run(gameId);
```

- [ ] **Step 3: Add "title" to manual-override reset endpoint**

In `backend/src/routes/games.js`, update line 280:

```javascript
  const validFields = { description: 'manual_description', cover: 'manual_cover', title: 'manual_title' };
```

And update the error message on line 283:

```javascript
    return res.status(400).json({ error: 'field must be "description", "cover", or "title"' });
```

- [ ] **Step 4: Run full games test suite**

Run: `cd backend && node --test tests/routes/games.test.js`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/metadata/enrichGame.js backend/src/routes/metadata.js backend/src/routes/games.js
git commit -m "fix: enrichment respects manual_title flag, re-enrich preserves manual edits"
```

---

### Task 4: Manual sync lock endpoint + frontend

**Files:**
- Modify: `backend/src/routes/launchers.js:450`
- Modify: `backend/tests/routes/launchers.test.js`
- Modify: `frontend/src/pages/Settings.jsx:300-306`

- [ ] **Step 1: Write failing test for lock-sync**

Add to `backend/tests/routes/launchers.test.js`:

```javascript
  it('POST /api/launchers/:id/lock-sync should set sync_locked', async () => {
    const db = app.locals.db;
    db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run('steam');

    const res = await makeFetch(app, '/api/launchers/steam/lock-sync', {
      method: 'POST',
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);

    const row = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('steam');
    assert.equal(row.sync_locked, 1, 'sync_locked should be 1 after lock');

    // Cleanup
    db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run('steam');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "lock-sync should set"`
Expected: FAIL (404)

- [ ] **Step 3: Add lock-sync endpoint**

In `backend/src/routes/launchers.js`, add after the unlock-sync endpoint (after line 450):

```javascript
// POST /api/launchers/:id/lock-sync
router.post('/:id/lock-sync', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const row = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!row) {
    return res.status(404).json({ error: 'Launcher not configured' });
  }

  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run(id);
  res.json({ success: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "lock-sync should set"`
Expected: PASS

- [ ] **Step 5: Add Lock button in Settings.jsx**

In `frontend/src/pages/Settings.jsx`, add a Lock button next to the Sync button. Replace the block at lines 300-306:

```jsx
                    <button
                      onClick={() => handleSyncClick(l)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                    >
                      <RefreshCw size={14} /> Sync
                    </button>
```

With:

```jsx
                    <button
                      onClick={() => handleSyncClick(l)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                    >
                      <RefreshCw size={14} /> Sync
                    </button>
                    <button
                      onClick={async () => {
                        await fetch(`/api/launchers/${l.id}/lock-sync`, {
                          method: 'POST',
                          credentials: 'same-origin',
                        });
                        queryClient.invalidateQueries({ queryKey: ['launchers'] });
                      }}
                      className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                    >
                      <Lock size={14} /> Lock
                    </button>
```

- [ ] **Step 6: Verify frontend builds**

Run: `cd frontend && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js frontend/src/pages/Settings.jsx
git commit -m "feat: add manual sync lock endpoint and Lock button in Settings"
```

---

### Task 5: Version bump + full verification

- [ ] **Step 1: Bump version to v1.17.0**
- [ ] **Step 2: Run full backend test suite**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All pass (except pre-existing setup.test.js QR failure)

- [ ] **Step 3: Commit**

```bash
git add backend/package.json
git commit -m "chore: bump version to v1.17.0"
```
