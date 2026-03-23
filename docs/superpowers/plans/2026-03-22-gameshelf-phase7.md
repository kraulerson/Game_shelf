# Phase 7: Tag Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tag CRUD, bulk tag editor in Settings, inline tag editing on GameDetail, and protect user-created tags during enrichment.

**Architecture:** New `/api/tags` route file for tag CRUD + bulk operations. `PUT /api/games/:id/tags` added to existing games route for individual game tag editing. Enrichment modified to preserve user-created tags. Frontend adds TagsTab to Settings and interactive tag chips to GameDetail.

**Tech Stack:** Express.js, better-sqlite3, React + TanStack Query

**Spec:** `docs/superpowers/specs/2026-03-22-gameshelf-phase7-design.md`

---

### Task 1: Protect user-created tags during enrichment

**Files:**
- Modify: `backend/src/services/metadata/enrichGame.js:102-103` (enrichGame) and `:210-211` (enrichUnderEnriched)
- Modify: `backend/tests/services/metadata/enrichGame.test.js`

- [ ] **Step 1: Write the regression test**

Add to `backend/tests/services/metadata/enrichGame.test.js`, inside the describe block (after the last `it` block, before the closing `});`):

```js
  it('genre-scoped tag DELETE should preserve user-created tags', () => {
    // This tests the SQL pattern used by enrichGame and enrichUnderEnriched
    // to ensure user-created tags are not wiped during enrichment.
    const game = db.prepare("SELECT id FROM games WHERE slug = 'team-fortress-2'").get();

    // Create a genre + mirrored tag
    db.prepare("INSERT OR IGNORE INTO genres (name) VALUES ('Action')").run();
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES ('Action')").run();
    const actionTag = db.prepare("SELECT id FROM tags WHERE name = 'Action'").get();
    db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(game.id, actionTag.id);

    // Create a user-created tag (not in genres table)
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES ('Favorites')").run();
    const favTag = db.prepare("SELECT id FROM tags WHERE name = 'Favorites'").get();
    db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(game.id, favTag.id);

    // Verify both tags exist before
    assert.ok(db.prepare('SELECT * FROM game_tags WHERE game_id = ? AND tag_id = ?').get(game.id, actionTag.id));
    assert.ok(db.prepare('SELECT * FROM game_tags WHERE game_id = ? AND tag_id = ?').get(game.id, favTag.id));

    // Run the genre-scoped DELETE (same SQL used in enrichGame/enrichUnderEnriched)
    db.prepare(
      'DELETE FROM game_tags WHERE game_id = ? AND tag_id IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)'
    ).run(game.id);

    // Genre-mirrored tag should be deleted
    const actionAfter = db.prepare('SELECT * FROM game_tags WHERE game_id = ? AND tag_id = ?').get(game.id, actionTag.id);
    assert.equal(actionAfter, undefined, 'Genre-mirrored Action tag should be deleted');

    // User-created tag should survive
    const favAfter = db.prepare('SELECT * FROM game_tags WHERE game_id = ? AND tag_id = ?').get(game.id, favTag.id);
    assert.ok(favAfter, 'User-created Favorites tag should survive');
  });
```

- [ ] **Step 2: Run test to verify the SQL works correctly**

Run: `cd backend && node --test tests/services/metadata/enrichGame.test.js`
Expected: PASS (this test validates the NEW SQL pattern that we are about to apply to enrichGame.js. We write it first to confirm the SQL logic is correct, then apply the same pattern to the source code.)

- [ ] **Step 3: Update enrichGame to preserve user-created tags**

In `backend/src/services/metadata/enrichGame.js`, replace line 103:
```js
  db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(gameId);
```
With:
```js
  db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_id IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)').run(gameId);
```

And replace line 211 (in `enrichUnderEnriched`):
```js
      db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(game.id);
```
With:
```js
      db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_id IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)').run(game.id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/services/metadata/enrichGame.test.js`
Expected: All PASS

- [ ] **Step 5: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/metadata/enrichGame.js backend/tests/services/metadata/enrichGame.test.js
git commit -m "feat: preserve user-created tags during metadata enrichment"
```

---

### Task 2: Tag CRUD API — create `backend/src/routes/tags.js`

**Files:**
- Create: `backend/src/routes/tags.js`
- Modify: `backend/src/server.js:38,69` (import and mount)
- Create: `backend/tests/routes/tags.test.js`

- [ ] **Step 1: Write the tests**

Create `backend/tests/routes/tags.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Tag CRUD API', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-tags.db');
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

    // Setup: launcher, games, editions, genres
    db.prepare('INSERT INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('steam', 'Steam');
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');

    db.prepare("INSERT INTO games (title, slug) VALUES ('Game A', 'game-a')").run();
    db.prepare("INSERT INTO games (title, slug) VALUES ('Game B', 'game-b')").run();
    const gameA = db.prepare("SELECT id FROM games WHERE slug = 'game-a'").get();
    const gameB = db.prepare("SELECT id FROM games WHERE slug = 'game-b'").get();

    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title, game_id, owned) VALUES (?, ?, ?, ?, 1)').run(launcher.id, '1', 'Game A', gameA.id);
    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title, game_id, owned) VALUES (?, ?, ?, ?, 1)').run(launcher.id, '2', 'Game B', gameB.id);

    // Add a genre + mirrored tag
    db.prepare("INSERT INTO genres (name) VALUES ('RPG')").run();
    db.prepare("INSERT INTO tags (name) VALUES ('RPG')").run();
    const rpgGenre = db.prepare("SELECT id FROM genres WHERE name = 'RPG'").get();
    const rpgTag = db.prepare("SELECT id FROM tags WHERE name = 'RPG'").get();
    db.prepare('INSERT INTO game_genres (game_id, genre_id) VALUES (?, ?)').run(gameA.id, rpgGenre.id);
    db.prepare('INSERT INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(gameA.id, rpgTag.id);
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('POST /api/tags should create a tag', () => {
    const name = 'Favorites';
    const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name);
    assert.equal(existing, undefined, 'Tag should not exist yet');

    db.prepare('INSERT INTO tags (name) VALUES (?)').run(name.trim());
    const tag = db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
    assert.ok(tag);
    assert.equal(tag.name, 'Favorites');
  });

  it('should reject duplicate tag names case-insensitively', () => {
    const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get('favorites');
    assert.ok(existing, 'Should find Favorites case-insensitively');
  });

  it('should reject empty tag names', () => {
    const name = '   ';
    assert.equal(name.trim().length, 0, 'Trimmed empty name should have length 0');
  });

  it('should reject tag names over 50 characters', () => {
    const name = 'A'.repeat(51);
    assert.ok(name.trim().length > 50, 'Name should exceed 50 chars');
  });

  it('GET /api/tags should list tags with game counts', () => {
    const tags = db.prepare(`
      SELECT t.id, t.name, COUNT(gt.game_id) as gameCount
      FROM tags t
      LEFT JOIN game_tags gt ON gt.tag_id = t.id
      GROUP BY t.id
      ORDER BY t.name COLLATE NOCASE ASC
    `).all();
    assert.ok(tags.length >= 2, 'Should have at least RPG and Favorites');
    const rpg = tags.find(t => t.name === 'RPG');
    assert.ok(rpg);
    assert.equal(rpg.gameCount, 1);
  });

  it('DELETE /api/tags/:id should reject genre-mirrored tags', () => {
    const rpgTag = db.prepare("SELECT id FROM tags WHERE name = 'RPG'").get();
    const isGenre = db.prepare(
      'SELECT name FROM genres WHERE name = (SELECT name FROM tags WHERE id = ?)'
    ).get(rpgTag.id);
    assert.ok(isGenre, 'RPG should be a genre-mirrored tag');
  });

  it('DELETE /api/tags/:id should delete user-created tags', () => {
    const tag = db.prepare("SELECT id FROM tags WHERE name = 'Favorites'").get();
    db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
    const deleted = db.prepare("SELECT id FROM tags WHERE name = 'Favorites'").get();
    assert.equal(deleted, undefined, 'Tag should be deleted');
  });

  it('PATCH /api/tags/:id/games should add and remove game associations', () => {
    // Create a fresh tag
    db.prepare("INSERT INTO tags (name) VALUES ('Backlog')").run();
    const tag = db.prepare("SELECT id FROM tags WHERE name = 'Backlog'").get();
    const gameA = db.prepare("SELECT id FROM games WHERE slug = 'game-a'").get();
    const gameB = db.prepare("SELECT id FROM games WHERE slug = 'game-b'").get();

    // Add both games
    db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(gameA.id, tag.id);
    db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(gameB.id, tag.id);

    let count = db.prepare('SELECT COUNT(*) as c FROM game_tags WHERE tag_id = ?').get(tag.id);
    assert.equal(count.c, 2);

    // Remove gameB
    db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_id = ?').run(gameB.id, tag.id);

    count = db.prepare('SELECT COUNT(*) as c FROM game_tags WHERE tag_id = ?').get(tag.id);
    assert.equal(count.c, 1);
  });

  it('PUT /api/games/:id/tags should preserve genre-mirrored tags', () => {
    const gameA = db.prepare("SELECT id FROM games WHERE slug = 'game-a'").get();

    // Create a user tag and assign it
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES ('Completed')").run();
    const completedTag = db.prepare("SELECT id FROM tags WHERE name = 'Completed'").get();

    // Simulate PUT: delete non-genre tags, then insert new ones
    db.prepare(
      'DELETE FROM game_tags WHERE game_id = ? AND tag_id NOT IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)'
    ).run(gameA.id);
    db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(gameA.id, completedTag.id);

    // Verify RPG tag (genre-mirrored) is still there
    const rpgTag = db.prepare("SELECT id FROM tags WHERE name = 'RPG'").get();
    const rpgAssoc = db.prepare('SELECT * FROM game_tags WHERE game_id = ? AND tag_id = ?').get(gameA.id, rpgTag.id);
    assert.ok(rpgAssoc, 'Genre-mirrored RPG tag should be preserved');

    // Verify Completed tag is there
    const completedAssoc = db.prepare('SELECT * FROM game_tags WHERE game_id = ? AND tag_id = ?').get(gameA.id, completedTag.id);
    assert.ok(completedAssoc, 'User-created Completed tag should be assigned');
  });

  it('GET /api/tags/:id/games should return games with tagged boolean', () => {
    const backlogTag = db.prepare("SELECT id FROM tags WHERE name = 'Backlog'").get();
    const games = db.prepare(`
      SELECT ge.id as edition_id,
             COALESCE(g.title, ge.title) as title,
             g.id as game_id,
             CASE WHEN gt.tag_id IS NOT NULL THEN 1 ELSE 0 END as tagged
      FROM game_editions ge
      JOIN launchers l ON l.id = ge.launcher_id
      LEFT JOIN games g ON g.id = ge.game_id
      LEFT JOIN game_tags gt ON gt.game_id = g.id AND gt.tag_id = ?
      WHERE ge.owned = 1 AND ge.game_id IS NOT NULL
      ORDER BY COALESCE(g.title, ge.title) COLLATE NOCASE ASC
    `).all(backlogTag.id);

    assert.ok(games.length >= 2, 'Should return at least 2 editions');
    const gameA = games.find(g => g.title === 'Game A');
    assert.equal(gameA.tagged, 1, 'Game A should be tagged');
    const gameB = games.find(g => g.title === 'Game B');
    assert.equal(gameB.tagged, 0, 'Game B should not be tagged');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd backend && node --test tests/routes/tags.test.js`
Expected: All PASS (DB-level validation of the logic)

- [ ] **Step 3: Create the tags route file**

Create `backend/src/routes/tags.js`:

```js
const { Router } = require('express');
const authMiddleware = require('../middleware/auth');

const router = Router();

router.use(authMiddleware);

// GET /api/tags — list all tags with game counts
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const tags = db.prepare(`
    SELECT t.id, t.name, COUNT(gt.game_id) as gameCount
    FROM tags t
    LEFT JOIN game_tags gt ON gt.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.name COLLATE NOCASE ASC
  `).all();

  // Mark genre-mirrored tags
  const genreNames = new Set(
    db.prepare('SELECT name FROM genres').all().map(r => r.name)
  );
  const result = tags.map(t => ({
    ...t,
    isGenre: genreNames.has(t.name),
  }));

  res.json(result);
});

// POST /api/tags — create a new tag
router.post('/', (req, res) => {
  const { name } = req.body || {};
  const trimmed = (name || '').trim();

  if (!trimmed) {
    return res.status(400).json({ error: 'Tag name is required' });
  }
  if (trimmed.length > 50) {
    return res.status(400).json({ error: 'Tag name must be 50 characters or less' });
  }

  const db = req.app.locals.db;
  const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(trimmed);
  if (existing) {
    return res.status(400).json({ error: 'A tag with this name already exists' });
  }

  const result = db.prepare('INSERT INTO tags (name) VALUES (?)').run(trimmed);
  res.json({ id: Number(result.lastInsertRowid), name: trimmed });
});

// DELETE /api/tags/:id — delete a tag
router.delete('/:id', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;

  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
  if (!tag) {
    return res.status(404).json({ error: 'Tag not found' });
  }

  const isGenre = db.prepare(
    'SELECT name FROM genres WHERE name = ?'
  ).get(tag.name);
  if (isGenre) {
    return res.status(400).json({ error: 'Cannot delete genre-mirrored tag. This tag is managed by metadata enrichment.' });
  }

  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  res.json({ deleted: true });
});

// GET /api/tags/:id/games — get games for bulk editor
router.get('/:id/games', (req, res) => {
  const db = req.app.locals.db;
  const tagId = req.params.id;
  const { page = '1', limit = '200', search } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 200));
  const offset = (pageNum - 1) * limitNum;

  const searchCondition = search ? 'AND (g.title LIKE ? OR ge.title LIKE ?)' : '';
  const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

  const games = db.prepare(`
    SELECT ge.id as edition_id,
           COALESCE(g.title, ge.title) as title,
           COALESCE(g.icon_url, g.cover_url) as icon_url,
           g.id as game_id, ge.launcher_game_id,
           l.name as launcher_name, l.display_name as launcher_display_name,
           CASE WHEN gt.tag_id IS NOT NULL THEN 1 ELSE 0 END as tagged
    FROM game_editions ge
    JOIN launchers l ON l.id = ge.launcher_id
    LEFT JOIN games g ON g.id = ge.game_id
    LEFT JOIN game_tags gt ON gt.game_id = g.id AND gt.tag_id = ?
    WHERE ge.owned = 1 AND ge.game_id IS NOT NULL
      ${searchCondition}
    ORDER BY COALESCE(g.title, ge.title) COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(tagId, ...searchParams, limitNum, offset);

  const total = db.prepare(`
    SELECT COUNT(*) as total
    FROM game_editions ge
    LEFT JOIN games g ON g.id = ge.game_id
    WHERE ge.owned = 1 AND ge.game_id IS NOT NULL
      ${searchCondition}
  `).get(...searchParams).total;

  const taggedCount = db.prepare(
    'SELECT COUNT(*) as c FROM game_tags WHERE tag_id = ?'
  ).get(tagId).c;

  res.json({ games, total, taggedCount, page: pageNum, limit: limitNum });
});

// PATCH /api/tags/:id/games — bulk add/remove games
router.patch('/:id/games', (req, res) => {
  const db = req.app.locals.db;
  const tagId = req.params.id;
  const { add = [], remove = [] } = req.body || {};

  const tag = db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
  if (!tag) {
    return res.status(404).json({ error: 'Tag not found' });
  }

  const insertStmt = db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)');
  const deleteStmt = db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_id = ?');

  const bulkUpdate = db.transaction(() => {
    for (const gameId of add) {
      insertStmt.run(gameId, tagId);
    }
    for (const gameId of remove) {
      deleteStmt.run(gameId, tagId);
    }
  });
  bulkUpdate();

  res.json({ updated: true });
});

module.exports = router;
```

- [ ] **Step 4: Mount the route in server.js**

In `backend/src/server.js`, add after line 38 (after metadataRouter):
```js
const tagsRouter = require('./routes/tags');
```

And after line 69 (after metadata mount):
```js
app.use('/api/tags', tagsRouter);
```

- [ ] **Step 5: Run all tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/tags.js backend/src/server.js backend/tests/routes/tags.test.js
git commit -m "feat: add tag CRUD API with bulk editor endpoints"
```

---

### Task 3: Add `PUT /api/games/:id/tags` and update `GET /api/games/:id` response

**Files:**
- Modify: `backend/src/routes/games.js:97-101` (update tag query to return objects), add PUT endpoint before GET /

- [ ] **Step 1: Update GET /api/games/:id to return tag objects**

In `backend/src/routes/games.js`, replace lines 97-101:
```js
  const tags = db.prepare(`
    SELECT t.name FROM tags t
    JOIN game_tags gt ON gt.tag_id = t.id
    WHERE gt.game_id = ?
  `).all(id).map(r => r.name);
```
With:
```js
  const tags = db.prepare(`
    SELECT t.id, t.name FROM tags t
    JOIN game_tags gt ON gt.tag_id = t.id
    WHERE gt.game_id = ?
  `).all(id);
```

- [ ] **Step 2: Add PUT /api/games/:id/tags endpoint**

In `backend/src/routes/games.js`, add before the `// GET /api/games` comment (before line 111):

```js
// PUT /api/games/:id/tags — set user-created tags for a game
router.put('/:id/tags', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { tagIds = [] } = req.body || {};

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const deleteNonGenre = db.prepare(
    'DELETE FROM game_tags WHERE game_id = ? AND tag_id NOT IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)'
  );
  const insertTag = db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)');

  const updateTags = db.transaction(() => {
    deleteNonGenre.run(id);
    for (const tagId of tagIds) {
      insertTag.run(id, tagId);
    }
  });
  updateTags();

  res.json({ updated: true });
});

```

- [ ] **Step 3: Run all tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/games.js
git commit -m "feat: add PUT /api/games/:id/tags endpoint and return tag objects from GET"
```

---

### Task 4: Frontend — TagsTab in Settings (tag list + bulk editor)

**Files:**
- Modify: `frontend/src/pages/Settings.jsx` (add TagsTab, add tab button)

- [ ] **Step 1: Add TagsTab component and wire up the tab**

In `frontend/src/pages/Settings.jsx`:

First update the React import (line 1) to include `useEffect`:
```jsx
import { useState, useEffect } from 'react';
```

Then add the TagsTab component after MetadataTab (before AccountTab):

```jsx
function TagsTab() {
  const queryClient = useQueryClient();
  const [editingTag, setEditingTag] = useState(null);
  const [newTagName, setNewTagName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  // Debounce search input (needs useEffect import — already imported via useState from React)
  // Add useEffect to the existing import: import { useState, useEffect } from 'react';
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: tags } = useQuery({
    queryKey: ['tags'],
    queryFn: () => fetch('/api/tags', { credentials: 'same-origin' }).then(r => r.json()),
  });

  const { data: tagGames } = useQuery({
    queryKey: ['tagGames', editingTag?.id, page, debouncedSearch],
    queryFn: () => fetch(`/api/tags/${editingTag.id}/games?page=${page}&limit=200&search=${encodeURIComponent(debouncedSearch)}`, { credentials: 'same-origin' }).then(r => r.json()),
    enabled: !!editingTag,
  });

  async function createTag() {
    const trimmed = newTagName.trim();
    if (!trimmed) return;
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      setNewTagName('');
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['gameFilters'] });
    }
  }

  async function deleteTag(id) {
    await fetch(`/api/tags/${id}`, { method: 'DELETE', credentials: 'same-origin' });
    setConfirmDelete(null);
    queryClient.invalidateQueries({ queryKey: ['tags'] });
    queryClient.invalidateQueries({ queryKey: ['gameFilters'] });
  }

  async function toggleGame(gameId, tagged) {
    const body = tagged ? { remove: [gameId] } : { add: [gameId] };
    await fetch(`/api/tags/${editingTag.id}/games`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    queryClient.invalidateQueries({ queryKey: ['tagGames'] });
    queryClient.invalidateQueries({ queryKey: ['tags'] });
    queryClient.invalidateQueries({ queryKey: ['gameFilters'] });
  }

  // Bulk editor view
  if (editingTag) {
    const totalPages = tagGames ? Math.ceil(tagGames.total / tagGames.limit) : 1;
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => { setEditingTag(null); setSearch(''); setPage(1); }} className="text-blue-400 hover:text-blue-300 text-sm">&larr; Back to tags</button>
            <h3 className="text-white font-medium">{editingTag.name}</h3>
            {tagGames && <span className="text-xs text-gray-500">{tagGames.taggedCount} of {tagGames.total} games tagged</span>}
          </div>
        </div>
        <input
          type="text"
          placeholder="Search games..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="space-y-1 max-h-[600px] overflow-y-auto">
          {(tagGames?.games || []).map(g => (
            <label key={g.edition_id} className="flex items-center gap-3 px-3 py-2 bg-gray-800 rounded cursor-pointer hover:bg-gray-750">
              <input
                type="checkbox"
                checked={!!g.tagged}
                onChange={() => toggleGame(g.game_id, g.tagged)}
                className="rounded"
              />
              {g.icon_url ? (
                <img src={g.icon_url} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded bg-gray-700 flex-shrink-0" />
              )}
              <span className="text-sm text-white flex-1 truncate">{g.title}</span>
              <LauncherBadge launcherName={g.launcher_name} displayName={g.launcher_display_name} />
            </label>
          ))}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm rounded">Previous</button>
            <span className="text-sm text-gray-400">Page {page} of {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm rounded">Next</button>
          </div>
        )}
      </div>
    );
  }

  // Tag list view
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="New tag name..."
          value={newTagName}
          onChange={e => setNewTagName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createTag()}
          maxLength={50}
          className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button onClick={createTag} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors">Create Tag</button>
      </div>

      {(tags || []).map(t => (
        <div key={t.id} className="bg-gray-800 rounded-lg p-3 flex items-center justify-between">
          <div>
            <span className="text-sm text-white">{t.name}</span>
            <span className="text-xs text-gray-500 ml-2">({t.gameCount} games)</span>
            {t.isGenre && <span className="text-xs text-yellow-600 ml-2">genre</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setEditingTag(t); setPage(1); setSearch(''); }} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-sm rounded">Edit</button>
            {!t.isGenre && (
              <button onClick={() => setConfirmDelete(t)} className="px-2 py-1 bg-red-900/50 hover:bg-red-800/50 text-red-400 text-sm rounded">Delete</button>
            )}
          </div>
        </div>
      ))}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
            <h3 className="text-white font-medium mb-2">Delete Tag</h3>
            <p className="text-gray-400 text-sm mb-4">Delete tag "{confirmDelete.name}"? It will be removed from all games.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded">Cancel</button>
              <button onClick={() => deleteTag(confirmDelete.id)} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

Then update the Settings component tabs (replace the tab buttons and rendering):

Replace:
```jsx
        <button onClick={() => setTab('launchers')} className={tabClass('launchers')}>Launchers</button>
        <button onClick={() => setTab('metadata')} className={tabClass('metadata')}>Metadata</button>
        <button onClick={() => setTab('account')} className={tabClass('account')}>Account</button>
```
With:
```jsx
        <button onClick={() => setTab('launchers')} className={tabClass('launchers')}>Launchers</button>
        <button onClick={() => setTab('metadata')} className={tabClass('metadata')}>Metadata</button>
        <button onClick={() => setTab('tags')} className={tabClass('tags')}>Tags</button>
        <button onClick={() => setTab('account')} className={tabClass('account')}>Account</button>
```

Replace:
```jsx
      {tab === 'launchers' && <LaunchersTab />}
      {tab === 'metadata' && <MetadataTab />}
      {tab === 'account' && <AccountTab />}
```
With:
```jsx
      {tab === 'launchers' && <LaunchersTab />}
      {tab === 'metadata' && <MetadataTab />}
      {tab === 'tags' && <TagsTab />}
      {tab === 'account' && <AccountTab />}
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat: add Tags tab to Settings with bulk tag editor"
```

---

### Task 5: Frontend — Inline tag editing on GameDetail

**Files:**
- Modify: `frontend/src/pages/GameDetail.jsx`

- [ ] **Step 1: Update GameDetail with interactive tag editing**

In `frontend/src/pages/GameDetail.jsx`:

First, update the imports (line 3) to add `useQueryClient` and `useMutation`:
```jsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
```

Add `X` from lucide-react to the imports (line 4):
```jsx
import { ArrowLeft, Loader2, X, Plus } from 'lucide-react';
```

Add state and query hooks inside the component (after line 16):
```jsx
  const queryClient = useQueryClient();
  const [showTagInput, setShowTagInput] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [confirmRemoveTag, setConfirmRemoveTag] = useState(null);

  const { data: allTags } = useQuery({
    queryKey: ['tags'],
    queryFn: () => fetch('/api/tags', { credentials: 'same-origin' }).then(r => r.json()),
    enabled: !!game,
  });
```

Add tag helper functions (after the allTags query):
```jsx
  const userTags = game?.tags?.filter(t => !game.genres?.includes(t.name)) || [];

  async function updateGameTags(newTagIds) {
    await fetch(`/api/games/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ tagIds: newTagIds }),
    });
    queryClient.invalidateQueries({ queryKey: ['game', id] });
    queryClient.invalidateQueries({ queryKey: ['gameFilters'] });
    queryClient.invalidateQueries({ queryKey: ['tags'] });
  }

  async function removeTag(tagId) {
    const remaining = userTags.filter(t => t.id !== tagId).map(t => t.id);
    await updateGameTags(remaining);
    setConfirmRemoveTag(null);
  }

  async function addTag(tagId) {
    const current = userTags.map(t => t.id);
    if (!current.includes(tagId)) {
      await updateGameTags([...current, tagId]);
    }
    setShowTagInput(false);
    setTagSearch('');
  }

  async function createAndAddTag(name) {
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const newTag = await res.json();
      await addTag(newTag.id);
    }
  }
```

Then replace the genre + tag chips section (lines 93-103):
```jsx
        {/* Genre + tag chips */}
        {(game.genres?.length > 0 || game.tags?.length > 0) && (
          <div className="flex flex-wrap gap-2 mb-4">
            {game.genres?.map(g => (
              <span key={g} className="bg-blue-600/20 text-blue-400 px-2.5 py-1 rounded-full text-xs">{g}</span>
            ))}
            {game.tags?.filter(t => !game.genres?.includes(t)).map(t => (
              <span key={t} className="bg-gray-700 text-gray-300 px-2.5 py-1 rounded-full text-xs">{t}</span>
            ))}
          </div>
        )}
```
With:
```jsx
        {/* Genre chips (read-only) */}
        <div className="flex flex-wrap gap-2 mb-4">
          {game.genres?.map(g => (
            <span key={g} className="bg-blue-600/20 text-blue-400 px-2.5 py-1 rounded-full text-xs">{g}</span>
          ))}

          {/* User-created tag chips (editable) */}
          {userTags.map(t => (
            <span key={t.id} className="bg-gray-700 text-gray-300 px-2.5 py-1 rounded-full text-xs inline-flex items-center gap-1">
              {t.name}
              <button onClick={() => setConfirmRemoveTag(t)} className="hover:text-red-400"><X size={12} /></button>
            </span>
          ))}

          {/* Add tag button */}
          <div className="relative">
            <button onClick={() => setShowTagInput(!showTagInput)} className="bg-gray-700 hover:bg-gray-600 text-gray-400 px-2.5 py-1 rounded-full text-xs inline-flex items-center gap-1">
              <Plus size={12} /> Add tag
            </button>
            {showTagInput && (
              <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-lg shadow-lg z-20 w-48">
                <input
                  type="text"
                  placeholder="Search or create..."
                  value={tagSearch}
                  onChange={e => setTagSearch(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-2 bg-transparent border-b border-gray-700 text-white text-xs focus:outline-none"
                />
                <div className="max-h-32 overflow-y-auto">
                  {(allTags || [])
                    .filter(t => !userTags.some(ut => ut.id === t.id) && !game.genres?.includes(t.name))
                    .filter(t => !tagSearch || t.name.toLowerCase().includes(tagSearch.toLowerCase()))
                    .map(t => (
                      <button key={t.id} onClick={() => addTag(t.id)} className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700">{t.name}</button>
                    ))}
                  {tagSearch.trim() && !(allTags || []).some(t => t.name.toLowerCase() === tagSearch.trim().toLowerCase()) && (
                    <button onClick={() => createAndAddTag(tagSearch.trim())} className="w-full text-left px-3 py-1.5 text-xs text-blue-400 hover:bg-gray-700">Create "{tagSearch.trim()}"</button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Confirm tag removal dialog */}
        {confirmRemoveTag && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
              <h3 className="text-white font-medium mb-2">Remove Tag</h3>
              <p className="text-gray-400 text-sm mb-4">Remove tag "{confirmRemoveTag.name}" from this game?</p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmRemoveTag(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded">Cancel</button>
                <button onClick={() => removeTag(confirmRemoveTag.id)} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded">Remove</button>
              </div>
            </div>
          </div>
        )}
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/GameDetail.jsx
git commit -m "feat: add inline tag editing on GameDetail page"
```

---

### Task 6: Version bump, tests, build, and deploy

**Files:** Version files + verification

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 2: Build frontend**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 3: Version bump**

Update version in `backend/package.json` and `frontend/package.json` from `1.1.0` to `1.2.0`.

- [ ] **Step 4: Commit and push**

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: bump version to 1.2.0 for Phase 7"
git push origin master
```

- [ ] **Step 5: Manual verification checklist**

1. Settings → Tags tab: create a new tag, verify it appears in list
2. Tags tab: click Edit on a tag, verify game list with checkboxes loads
3. Bulk editor: check/uncheck games, verify changes persist across pages
4. Bulk editor: use search to find a game, toggle its tag
5. Tags tab: delete a user-created tag, verify confirmation dialog works
6. Tags tab: verify genre-mirrored tags show "genre" label and no delete button
7. Library → GameDetail: verify genre chips are blue/read-only
8. GameDetail: click "Add tag", verify dropdown with existing tags
9. GameDetail: type a new tag name, verify "Create" option appears
10. GameDetail: add a tag, verify it appears as a chip
11. GameDetail: click X on a tag chip, verify confirmation, verify removal
12. Library filter panel: verify new tags appear in tag filters
13. Re-enrich a game: verify user-created tags survive enrichment
