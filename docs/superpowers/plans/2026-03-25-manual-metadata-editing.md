# Manual Metadata Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to manually set description and cover image for games, with override flags that protect manual edits from auto-enrichment.

**Architecture:** Two boolean columns (`manual_description`, `manual_cover`) on the `games` table act as override flags. When set, enrichment skips those fields. The existing PATCH endpoint is extended for description; a new multipart upload endpoint handles cover images; a DELETE endpoint resets overrides. Frontend adds inline editing on GameDetail.

**Tech Stack:** Express 5, better-sqlite3, multer (new dependency for file uploads), React 18, TailwindCSS, React Query, Lucide icons

---

## File Structure

**Create:**
- `backend/tests/db/migrate-manual-metadata.test.js` — migration test
- `backend/tests/routes/games-manual-metadata.test.js` — API tests for description edit, cover upload, override reset
- `backend/tests/services/metadata/enrichGame-manual-override.test.js` — enrichment protection tests

**Modify:**
- `backend/src/db/migrate.js` — add manual_description, manual_cover columns
- `backend/src/routes/games.js` — extend PATCH, add POST cover upload, add DELETE manual-override
- `backend/src/services/metadata/enrichGame.js` — check override flags before writing
- `backend/src/routes/metadata.js` — re-enrich respects override flags
- `frontend/src/pages/GameDetail.jsx` — description editor, cover upload UI, override indicators

---

### Task 1: Database Migration

**Files:**
- Modify: `backend/src/db/migrate.js:166-176` (add after Phase 12 epic columns)
- Create: `backend/tests/db/migrate-manual-metadata.test.js`

- [ ] **Step 1: Write the migration test**

Create `backend/tests/db/migrate-manual-metadata.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Manual metadata migration', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-manual-metadata-migrate.db');

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('should add manual_description and manual_cover columns to games', () => {
    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const cols = db.pragma('table_info(games)');
    const manualDesc = cols.find(c => c.name === 'manual_description');
    const manualCover = cols.find(c => c.name === 'manual_cover');

    assert.ok(manualDesc, 'manual_description column should exist');
    assert.equal(manualDesc.dflt_value, '0', 'manual_description should default to 0');
    assert.ok(manualCover, 'manual_cover column should exist');
    assert.equal(manualCover.dflt_value, '0', 'manual_cover should default to 0');

    db.close();
  });

  it('should be idempotent — running migrations twice should not error', () => {
    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const cols = db.pragma('table_info(games)');
    assert.ok(cols.find(c => c.name === 'manual_description'));
    assert.ok(cols.find(c => c.name === 'manual_cover'));

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/db/migrate-manual-metadata.test.js`
Expected: FAIL — `manual_description column should exist` fails because the migration hasn't been added yet.

- [ ] **Step 3: Add the migration to migrate.js**

In `backend/src/db/migrate.js`, after the sync_locked migration (around line 224), add:

```js
  // Phase 13: manual metadata override flags
  const gamesColsP13 = db.pragma('table_info(games)');
  if (!gamesColsP13.some(c => c.name === 'manual_description')) {
    db.exec('ALTER TABLE games ADD COLUMN manual_description INTEGER DEFAULT 0');
    db.exec('ALTER TABLE games ADD COLUMN manual_cover INTEGER DEFAULT 0');
    console.log('[Migration] Phase 13: Added manual_description, manual_cover columns');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/db/migrate-manual-metadata.test.js`
Expected: PASS — both tests green.

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `cd backend && node --test 'tests/**/*.test.js'`
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/migrate.js backend/tests/db/migrate-manual-metadata.test.js
git commit -m "feat: add manual_description and manual_cover migration (Phase 13)"
```

---

### Task 2: PATCH /api/games/:id — Accept Description

**Files:**
- Modify: `backend/src/routes/games.js:130-150`
- Create: `backend/tests/routes/games-manual-metadata.test.js`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/routes/games-manual-metadata.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-manual-metadata';

function makeFetch(app, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${urlPath}`;
      fetch(url, options)
        .then(resolve)
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

describe('Manual metadata editing API', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-manual-metadata.db');
  let app;
  let gameId;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';

    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));

    const db = app.locals.db;

    db.prepare('INSERT INTO launchers (name, display_name, enabled, priority) VALUES (?, ?, 1, 1)').run('itch', 'itch.io');
    const launcherId = db.prepare('SELECT id FROM launchers WHERE name = ?').get('itch').id;

    db.prepare('INSERT INTO games (title, slug) VALUES (?, ?)').run('Earth Clicker', 'earth-clicker');
    gameId = db.prepare('SELECT id FROM games WHERE slug = ?').get('earth-clicker').id;

    db.prepare('INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, ?, 1)').run(
      gameId, launcherId, 'earth-clicker', 'Earth Clicker'
    );
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  function authCookie() {
    const token = jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    return `gameshelf_session=${token}`;
  }

  it('PATCH /api/games/:id with description should update and set manual flag', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ description: 'A clicker game about Earth.' }),
    });
    assert.equal(res.status, 200);

    const db = app.locals.db;
    const game = db.prepare('SELECT description, manual_description FROM games WHERE id = ?').get(gameId);
    assert.equal(game.description, 'A clicker game about Earth.');
    assert.equal(game.manual_description, 1);
  });

  it('PATCH /api/games/:id with empty description should clear it and keep flag', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ description: '' }),
    });
    assert.equal(res.status, 200);

    const db = app.locals.db;
    const game = db.prepare('SELECT description, manual_description FROM games WHERE id = ?').get(gameId);
    assert.equal(game.description, null);
    assert.equal(game.manual_description, 1);
  });

  it('PATCH /api/games/:id with title still works as before', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ title: 'Earth Clicker Renamed' }),
    });
    assert.equal(res.status, 200);

    const db = app.locals.db;
    const game = db.prepare('SELECT title FROM games WHERE id = ?').get(gameId);
    assert.equal(game.title, 'Earth Clicker Renamed');
  });

  it('PATCH /api/games/:id with neither title nor description returns 400', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/routes/games-manual-metadata.test.js`
Expected: FAIL — description PATCH returns 400 because current handler requires title.

- [ ] **Step 3: Implement the extended PATCH handler**

Replace the PATCH handler in `backend/src/routes/games.js` (lines 130-150) with:

```js
// PATCH /api/games/:id — update game title and/or description
router.patch('/:id', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { title, description } = req.body || {};

  const hasTitle = title !== undefined && title !== null;
  const hasDescription = description !== undefined;

  if (!hasTitle && !hasDescription) {
    return res.status(400).json({ error: 'title or description is required' });
  }

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  if (hasTitle) {
    if (!title.trim()) {
      return res.status(400).json({ error: 'Title cannot be empty' });
    }
    db.prepare(
      "UPDATE games SET title = ?, slug = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(title.trim(), require('../services/metadata/titleMatcher').slugify(title.trim()), id);
  }

  if (hasDescription) {
    const descValue = description.trim() || null;
    db.prepare(
      "UPDATE games SET description = ?, manual_description = 1, updated_at = datetime('now') WHERE id = ?"
    ).run(descValue, id);
  }

  res.json({ updated: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/games-manual-metadata.test.js`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run full test suite**

Run: `cd backend && node --test 'tests/**/*.test.js'`
Expected: All tests pass (existing PATCH title tests still work since title path is preserved).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/games.js backend/tests/routes/games-manual-metadata.test.js
git commit -m "feat: extend PATCH /api/games/:id to accept description with manual flag"
```

---

### Task 3: POST /api/games/:id/cover — Image Upload

**Files:**
- Modify: `backend/src/routes/games.js` (add new route)
- Modify: `backend/package.json` (add multer dependency)
- Modify: `backend/tests/routes/games-manual-metadata.test.js` (add upload tests)

- [ ] **Step 1: Install multer**

Run: `cd backend && npm install multer`

- [ ] **Step 2: Add failing tests for cover upload**

Append to the `describe` block in `backend/tests/routes/games-manual-metadata.test.js`:

```js
  it('POST /api/games/:id/cover should upload and set manual flag', async () => {
    // Create a minimal 1x1 red PNG (68 bytes)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
      0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);

    const formData = new FormData();
    formData.append('cover', new Blob([pngHeader], { type: 'image/png' }), 'test-cover.png');

    const res = await makeFetch(app, `/api/games/${gameId}/cover`, {
      method: 'POST',
      headers: { Cookie: authCookie() },
      body: formData,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.cover_url, 'Should return cover_url');
    assert.ok(body.cover_url.includes(`/data/images/${gameId}/cover`), 'Path should include game ID');

    const db = app.locals.db;
    const game = db.prepare('SELECT cover_url, manual_cover FROM games WHERE id = ?').get(gameId);
    assert.equal(game.manual_cover, 1);
    assert.equal(game.cover_url, body.cover_url);
  });

  it('POST /api/games/:id/cover should reject non-image files', async () => {
    const formData = new FormData();
    formData.append('cover', new Blob(['not an image'], { type: 'text/plain' }), 'test.txt');

    const res = await makeFetch(app, `/api/games/${gameId}/cover`, {
      method: 'POST',
      headers: { Cookie: authCookie() },
      body: formData,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/games/:id/cover should reject missing file', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}/cover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
    });
    assert.equal(res.status, 400);
  });
```

- [ ] **Step 3: Run test to verify new tests fail**

Run: `cd backend && node --test tests/routes/games-manual-metadata.test.js`
Expected: FAIL — new cover upload tests fail (404, route doesn't exist).

- [ ] **Step 4: Implement the cover upload route**

Add to `backend/src/routes/games.js`, after the PATCH handler:

At the top of the file, add the multer require:
```js
const multer = require('multer');
const fsMod = require('node:fs');
const pathMod = require('node:path');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});
```

Then add the route:

```js
// POST /api/games/:id/cover — upload cover image
router.post('/:id/cover', upload.single('cover'), (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;

  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  const ext = extMap[req.file.mimetype] || '.jpg';

  const dataDir = pathMod.resolve(pathMod.dirname(process.env.GAMESHELF_DB_PATH || './data/gameshelf.db'));
  const gameDir = pathMod.join(dataDir, 'images', String(id));
  fsMod.mkdirSync(gameDir, { recursive: true });

  const filename = `cover${ext}`;
  fsMod.writeFileSync(pathMod.join(gameDir, filename), req.file.buffer);

  const coverUrl = `/data/images/${id}/${filename}`;
  db.prepare(
    "UPDATE games SET cover_url = ?, manual_cover = 1, updated_at = datetime('now') WHERE id = ?"
  ).run(coverUrl, id);

  res.json({ cover_url: coverUrl });
});

// Multer error handler (must be after the route)
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Only JPEG')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/games-manual-metadata.test.js`
Expected: PASS — all tests including cover upload tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/games.js backend/tests/routes/games-manual-metadata.test.js backend/package.json backend/package-lock.json
git commit -m "feat: add POST /api/games/:id/cover for manual cover image upload"
```

---

### Task 4: DELETE /api/games/:id/manual-override — Reset Override

**Files:**
- Modify: `backend/src/routes/games.js` (add new route)
- Modify: `backend/tests/routes/games-manual-metadata.test.js` (add tests)

- [ ] **Step 1: Add failing tests for override reset**

Append to the `describe` block in `backend/tests/routes/games-manual-metadata.test.js`:

```js
  it('DELETE /api/games/:id/manual-override should reset description flag', async () => {
    // Ensure flag is set first
    const db = app.locals.db;
    db.prepare('UPDATE games SET manual_description = 1, description = ? WHERE id = ?').run('Manual desc', gameId);

    const res = await makeFetch(app, `/api/games/${gameId}/manual-override`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ field: 'description' }),
    });
    assert.equal(res.status, 200);

    const game = db.prepare('SELECT manual_description, description FROM games WHERE id = ?').get(gameId);
    assert.equal(game.manual_description, 0);
    assert.equal(game.description, 'Manual desc', 'Content should be preserved');
  });

  it('DELETE /api/games/:id/manual-override should reset cover flag', async () => {
    const db = app.locals.db;
    db.prepare('UPDATE games SET manual_cover = 1 WHERE id = ?').run(gameId);

    const res = await makeFetch(app, `/api/games/${gameId}/manual-override`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ field: 'cover' }),
    });
    assert.equal(res.status, 200);

    const game = db.prepare('SELECT manual_cover FROM games WHERE id = ?').get(gameId);
    assert.equal(game.manual_cover, 0);
  });

  it('DELETE /api/games/:id/manual-override with invalid field returns 400', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}/manual-override`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ field: 'title' }),
    });
    assert.equal(res.status, 400);
  });
```

- [ ] **Step 2: Run test to verify new tests fail**

Run: `cd backend && node --test tests/routes/games-manual-metadata.test.js`
Expected: FAIL — 404 for the DELETE endpoint.

- [ ] **Step 3: Implement the override reset route**

Add to `backend/src/routes/games.js`, before the multer error handler:

```js
// DELETE /api/games/:id/manual-override — reset manual override flag
router.delete('/:id/manual-override', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { field } = req.body || {};

  const validFields = { description: 'manual_description', cover: 'manual_cover' };
  const column = validFields[field];
  if (!column) {
    return res.status(400).json({ error: 'field must be "description" or "cover"' });
  }

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  db.prepare(`UPDATE games SET ${column} = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/games-manual-metadata.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/games.js backend/tests/routes/games-manual-metadata.test.js
git commit -m "feat: add DELETE /api/games/:id/manual-override to reset override flags"
```

---

### Task 5: Enrichment Protection

**Files:**
- Modify: `backend/src/services/metadata/enrichGame.js:186-196` (enrichGame upsert)
- Modify: `backend/src/services/metadata/enrichGame.js:239-311` (enrichUnderEnriched)
- Modify: `backend/src/routes/metadata.js:30-55` (re-enrich endpoint)
- Create: `backend/tests/services/metadata/enrichGame-manual-override.test.js`

- [ ] **Step 1: Write the failing enrichment protection test**

Create `backend/tests/services/metadata/enrichGame-manual-override.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Enrichment respects manual override flags', () => {
  const testDbPath = path.join(__dirname, '..', '..', 'data', 'test-enrich-override.db');
  let db;
  let enrichGame, enrichUnderEnriched;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../../src/db/migrate')];
    const { runMigrations } = require('../../../src/db/migrate');
    db = runMigrations(testDbPath);

    // Seed: launcher + game with manual description + edition
    db.prepare('INSERT INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('itch', 'itch.io');
    const launcherId = db.prepare('SELECT id FROM launchers WHERE name = ?').get('itch').id;

    db.prepare(
      'INSERT INTO games (title, slug, description, manual_description, cover_url, manual_cover) VALUES (?, ?, ?, 1, ?, 1)'
    ).run('Earth Clicker', 'earth-clicker', 'My manual description', '/data/images/999/cover.png');

    const gameId = db.prepare('SELECT id FROM games WHERE slug = ?').get('earth-clicker').id;
    db.prepare(
      'INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, ?, 1)'
    ).run(gameId, launcherId, 'earth-clicker', 'Earth Clicker');

    delete require.cache[require.resolve('../../../src/services/metadata/enrichGame')];
    ({ enrichGame, enrichAll: _, enrichUnderEnriched } = require('../../../src/services/metadata/enrichGame'));
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('enrichGame should preserve manually-set description', async () => {
    const edition = db.prepare("SELECT id FROM game_editions WHERE launcher_game_id = 'earth-clicker'").get();

    // enrichGame will hit the no-IGDB-match path (no credentials configured)
    await enrichGame(edition.id, db);

    const game = db.prepare("SELECT description, manual_description FROM games WHERE slug = 'earth-clicker'").get();
    assert.equal(game.description, 'My manual description', 'Manual description should survive enrichment');
    assert.equal(game.manual_description, 1, 'Flag should remain set');
  });

  it('enrichGame should preserve manually-set cover_url', async () => {
    const game = db.prepare("SELECT cover_url, manual_cover FROM games WHERE slug = 'earth-clicker'").get();
    assert.equal(game.cover_url, '/data/images/999/cover.png', 'Manual cover should survive enrichment');
    assert.equal(game.manual_cover, 1, 'Flag should remain set');
  });

  it('enrichUnderEnriched should skip games with all-manual metadata', async () => {
    // Set last_enrichment_at to null so it would be eligible
    const game = db.prepare("SELECT id FROM games WHERE slug = 'earth-clicker'").get();
    db.prepare('UPDATE games SET last_enrichment_at = NULL WHERE id = ?').run(game.id);

    const result = await enrichUnderEnriched(db);

    // The game has manual description AND manual cover — should not appear as under-enriched
    const updated = db.prepare('SELECT description, cover_url FROM games WHERE id = ?').get(game.id);
    assert.equal(updated.description, 'My manual description', 'Description should be unchanged');
    assert.equal(updated.cover_url, '/data/images/999/cover.png', 'Cover should be unchanged');
  });

  it('enrichment should still fill non-manual fields', async () => {
    // Create a game with manual description but no cover (no manual_cover flag)
    db.prepare(
      'INSERT INTO games (title, slug, description, manual_description) VALUES (?, ?, ?, 1)'
    ).run('Fjords', 'fjords', 'A fjords game');

    const fjordsId = db.prepare('SELECT id FROM games WHERE slug = ?').get('fjords').id;
    const launcherId = db.prepare('SELECT id FROM launchers WHERE name = ?').get('itch').id;

    db.prepare(
      'INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, ?, 1)'
    ).run(fjordsId, launcherId, 'fjords', 'Fjords');

    // Clear last_enrichment_at so enrichUnderEnriched picks it up
    db.prepare('UPDATE games SET last_enrichment_at = NULL WHERE id = ?').run(fjordsId);

    await enrichUnderEnriched(db);

    const game = db.prepare('SELECT description, manual_description FROM games WHERE id = ?').get(fjordsId);
    assert.equal(game.description, 'A fjords game', 'Manual description should be preserved');
    assert.equal(game.manual_description, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/services/metadata/enrichGame-manual-override.test.js`
Expected: FAIL — `enrichGame` overwrites the manual description because it doesn't check the flag yet.

- [ ] **Step 3: Modify enrichGame() to respect override flags**

In `backend/src/services/metadata/enrichGame.js`, modify the `enrichGame` function.

**3a.** In the upsert block (around line 186), replace:

```js
  db.prepare(`
    INSERT INTO games (title, slug, description, release_year, developer, publisher, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      release_year = excluded.release_year,
      developer = excluded.developer,
      publisher = excluded.publisher,
      updated_at = datetime('now')
  `).run(gameTitle, gameSlug, description, releaseYear, developer, publisher);
```

With:

```js
  db.prepare(`
    INSERT INTO games (title, slug, description, release_year, developer, publisher, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      description = CASE WHEN games.manual_description = 1 THEN games.description ELSE excluded.description END,
      release_year = excluded.release_year,
      developer = excluded.developer,
      publisher = excluded.publisher,
      updated_at = datetime('now')
  `).run(gameTitle, gameSlug, description, releaseYear, developer, publisher);
```

**3b.** In the `cacheGameImages` call after the upsert (around line 202-203), wrap it to check the manual_cover flag:

Replace:
```js
  // Download and cache images: IGDB → SteamGridDB → Steam CDN
  const { coverUrl, artworkUrl } = await getBestImages(match, gameTitle, edition.launcher_name, edition.launcher_game_id);
  await cacheGameImages(coverUrl, artworkUrl, gameId, gameTitle, db);
```

With:
```js
  // Download and cache images: IGDB → SteamGridDB → Steam CDN
  const existingGame = db.prepare('SELECT manual_cover FROM games WHERE id = ?').get(gameId);
  if (!existingGame?.manual_cover) {
    const { coverUrl, artworkUrl } = await getBestImages(match, gameTitle, edition.launcher_name, edition.launcher_game_id);
    await cacheGameImages(coverUrl, artworkUrl, gameId, gameTitle, db);
  }
```

**3c.** In the no-IGDB-match path (around line 165-168), also guard the image caching:

Replace:
```js
    // Try SteamGridDB → Steam CDN for images
    const { coverUrl, artworkUrl } = await getBestImages(null, title, edition.launcher_name, edition.launcher_game_id);
    await cacheGameImages(coverUrl, artworkUrl, game.id, title, db);
```

With:
```js
    // Try SteamGridDB → Steam CDN for images (skip if manual cover set)
    const existingFlags = db.prepare('SELECT manual_cover FROM games WHERE id = ?').get(game.id);
    if (!existingFlags?.manual_cover) {
      const { coverUrl, artworkUrl } = await getBestImages(null, title, edition.launcher_name, edition.launcher_game_id);
      await cacheGameImages(coverUrl, artworkUrl, game.id, title, db);
    }
```

- [ ] **Step 4: Modify enrichUnderEnriched() to respect override flags**

In `backend/src/services/metadata/enrichGame.js`, in the `enrichUnderEnriched` function:

**4a.** Update the initial query (around line 240) to exclude fully-manual games:

Replace:
```js
  const underEnriched = db.prepare(`
    SELECT DISTINCT g.id, g.title, g.slug,
           ge.launcher_game_id, l.name as launcher_name
    FROM games g
    JOIN game_editions ge ON ge.game_id = g.id AND ge.owned = 1
    JOIN launchers l ON l.id = ge.launcher_id
    WHERE (g.cover_url IS NULL OR g.description IS NULL)
      AND (g.last_enrichment_at IS NULL
           OR g.last_enrichment_at < datetime('now', '-7 days'))
  `).all();
```

With:
```js
  const underEnriched = db.prepare(`
    SELECT DISTINCT g.id, g.title, g.slug,
           ge.launcher_game_id, l.name as launcher_name,
           COALESCE(g.manual_description, 0) as manual_description,
           COALESCE(g.manual_cover, 0) as manual_cover
    FROM games g
    JOIN game_editions ge ON ge.game_id = g.id AND ge.owned = 1
    JOIN launchers l ON l.id = ge.launcher_id
    WHERE ((g.cover_url IS NULL AND COALESCE(g.manual_cover, 0) = 0)
        OR (g.description IS NULL AND COALESCE(g.manual_description, 0) = 0))
      AND (g.last_enrichment_at IS NULL
           OR g.last_enrichment_at < datetime('now', '-7 days'))
  `).all();
```

**4b.** In the no-match path of enrichUnderEnriched (around line 280-281), guard image caching:

Replace:
```js
        // Try SteamGridDB → Steam CDN for images
        const { coverUrl, artworkUrl } = await getBestImages(null, game.title, game.launcher_name, game.launcher_game_id);
        await cacheGameImages(coverUrl, artworkUrl, game.id, game.title, db);
```

With:
```js
        // Try SteamGridDB → Steam CDN for images (skip if manual cover set)
        if (!game.manual_cover) {
          const { coverUrl, artworkUrl } = await getBestImages(null, game.title, game.launcher_name, game.launcher_game_id);
          await cacheGameImages(coverUrl, artworkUrl, game.id, game.title, db);
        }
```

**4c.** In the match path update SQL (around line 298-307), protect manual description:

Replace:
```js
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
```

With:
```js
      db.prepare(`
        UPDATE games SET
          description = CASE WHEN manual_description = 1 THEN description ELSE COALESCE(?, description) END,
          release_year = COALESCE(?, release_year),
          developer = COALESCE(?, developer),
          publisher = COALESCE(?, publisher),
          last_enrichment_at = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(description, releaseYear, developer, publisher, game.id);
```

**4d.** In the match path image caching (around line 310-311), guard with manual_cover:

Replace:
```js
      // Download and cache images: IGDB → SteamGridDB → Steam CDN
      const { coverUrl, artworkUrl } = await getBestImages(match, game.title, game.launcher_name, game.launcher_game_id);
      await cacheGameImages(coverUrl, artworkUrl, game.id, game.title, db);
```

With:
```js
      // Download and cache images: IGDB → SteamGridDB → Steam CDN (skip if manual cover)
      if (!game.manual_cover) {
        const { coverUrl, artworkUrl } = await getBestImages(match, game.title, game.launcher_name, game.launcher_game_id);
        await cacheGameImages(coverUrl, artworkUrl, game.id, game.title, db);
      }
```

- [ ] **Step 5: Modify re-enrich endpoint to respect flags**

In `backend/src/routes/metadata.js`, replace the reset SQL (lines 36-39):

Replace:
```js
    db.prepare(
      "UPDATE games SET cover_url = NULL, hero_url = NULL, icon_url = NULL, " +
      "description = NULL, last_enrichment_at = NULL WHERE id = ?"
    ).run(gameId);
```

With:
```js
    db.prepare(`
      UPDATE games SET
        cover_url = CASE WHEN manual_cover = 1 THEN cover_url ELSE NULL END,
        hero_url = CASE WHEN manual_cover = 1 THEN hero_url ELSE NULL END,
        icon_url = CASE WHEN manual_cover = 1 THEN icon_url ELSE NULL END,
        description = CASE WHEN manual_description = 1 THEN description ELSE NULL END,
        last_enrichment_at = NULL
      WHERE id = ?
    `).run(gameId);
```

- [ ] **Step 6: Run the override test**

Run: `cd backend && node --test tests/services/metadata/enrichGame-manual-override.test.js`
Expected: PASS — all 4 tests green.

- [ ] **Step 7: Run full test suite**

Run: `cd backend && node --test 'tests/**/*.test.js'`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/metadata/enrichGame.js backend/src/routes/metadata.js backend/tests/services/metadata/enrichGame-manual-override.test.js
git commit -m "feat: enrichment skips fields protected by manual override flags"
```

---

### Task 6: Frontend — Description Editing and Cover Upload

**Files:**
- Modify: `frontend/src/pages/GameDetail.jsx`

- [ ] **Step 1: Add state variables for description editing and cover upload**

In `GameDetail.jsx`, add new state variables after the existing ones (around line 24):

```jsx
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionInput, setDescriptionInput] = useState('');
  const [uploadingCover, setUploadingCover] = useState(false);
```

- [ ] **Step 2: Add the description save function**

After the `reEnrich` function (around line 106), add:

```jsx
  async function saveDescription() {
    const res = await fetch(`/api/games/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ description: descriptionInput }),
    });
    if (res.ok) {
      setEditingDescription(false);
      queryClient.invalidateQueries({ queryKey: ['game', id] });
    }
  }

  async function uploadCover(file) {
    setUploadingCover(true);
    const formData = new FormData();
    formData.append('cover', file);
    const res = await fetch(`/api/games/${id}/cover`, {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
    });
    setUploadingCover(false);
    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ['game', id] });
      queryClient.invalidateQueries({ queryKey: ['games'] });
    }
  }

  async function resetOverride(field) {
    await fetch(`/api/games/${id}/manual-override`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ field }),
    });
    queryClient.invalidateQueries({ queryKey: ['game', id] });
  }
```

- [ ] **Step 3: Add Upload icon import**

Update the Lucide import at the top:

Replace:
```jsx
import { ArrowLeft, Loader2, X, Plus, Pencil, RefreshCw } from 'lucide-react';
```

With:
```jsx
import { ArrowLeft, Loader2, X, Plus, Pencil, RefreshCw, Upload, RotateCcw } from 'lucide-react';
```

- [ ] **Step 4: Add cover upload overlay to the cover image**

Replace the cover image in the hero overlay section (around lines 153-159):

Replace:
```jsx
          {game.cover_url && (
            <img
              src={game.cover_url}
              alt={game.title}
              className="w-24 md:w-32 rounded-lg shadow-lg border-2 border-gray-700 -mb-8 relative z-10"
            />
          )}
```

With:
```jsx
          <div className="relative group -mb-8 z-10">
            {game.cover_url ? (
              <img
                src={game.cover_url}
                alt={game.title}
                className="w-24 md:w-32 rounded-lg shadow-lg border-2 border-gray-700"
              />
            ) : (
              <div className="w-24 md:w-32 h-32 md:h-44 rounded-lg border-2 border-dashed border-gray-600 flex items-center justify-center bg-gray-800">
                <Upload size={20} className="text-gray-500" />
              </div>
            )}
            <label className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 rounded-lg cursor-pointer transition-opacity">
              {uploadingCover ? (
                <Loader2 size={20} className="animate-spin text-white" />
              ) : (
                <Upload size={20} className="text-white" />
              )}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={e => { if (e.target.files[0]) uploadCover(e.target.files[0]); }}
              />
            </label>
            {game.manual_cover === 1 && (
              <button
                onClick={() => resetOverride('cover')}
                className="absolute -top-2 -right-2 bg-gray-700 hover:bg-gray-600 rounded-full p-1 z-20"
                title="Reset to auto-enriched cover"
              >
                <RotateCcw size={10} className="text-gray-300" />
              </button>
            )}
          </div>
```

- [ ] **Step 5: Replace the description section with editable version**

Replace the description block (around lines 255-270):

Replace:
```jsx
        {/* Description */}
        {game.description && (
          <div className="mb-6">
            <p className={`text-gray-300 text-sm leading-relaxed ${!showFullDesc ? 'line-clamp-4' : ''}`}>
              {game.description}
            </p>
            {game.description.length > 200 && (
              <button
                onClick={() => setShowFullDesc(!showFullDesc)}
                className="text-blue-400 text-sm mt-1 hover:text-blue-300"
              >
                {showFullDesc ? 'Show less' : 'Read more'}
              </button>
            )}
          </div>
        )}
```

With:
```jsx
        {/* Description */}
        <div className="mb-6">
          {editingDescription ? (
            <div>
              <textarea
                value={descriptionInput}
                onChange={e => setDescriptionInput(e.target.value)}
                rows={5}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-gray-300 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                placeholder="Enter a description..."
                autoFocus
              />
              <div className="flex gap-2 mt-2">
                <button onClick={saveDescription} className="text-green-400 hover:text-green-300 text-sm">Save</button>
                <button onClick={() => setEditingDescription(false)} className="text-gray-400 hover:text-white text-sm">Cancel</button>
              </div>
            </div>
          ) : game.description ? (
            <div>
              <div className="flex items-start gap-2">
                <p className={`text-gray-300 text-sm leading-relaxed flex-1 ${!showFullDesc ? 'line-clamp-4' : ''}`}>
                  {game.description}
                </p>
                <button
                  onClick={() => { setEditingDescription(true); setDescriptionInput(game.description); }}
                  className="text-gray-500 hover:text-white flex-shrink-0 mt-0.5"
                >
                  <Pencil size={12} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                {game.description.length > 200 && (
                  <button
                    onClick={() => setShowFullDesc(!showFullDesc)}
                    className="text-blue-400 text-sm mt-1 hover:text-blue-300"
                  >
                    {showFullDesc ? 'Show less' : 'Read more'}
                  </button>
                )}
                {game.manual_description === 1 && (
                  <button
                    onClick={() => resetOverride('description')}
                    className="text-gray-500 hover:text-amber-400 text-xs mt-1 inline-flex items-center gap-1"
                    title="Reset to auto-enriched description"
                  >
                    <RotateCcw size={10} /> Manual
                  </button>
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={() => { setEditingDescription(true); setDescriptionInput(''); }}
              className="text-gray-500 hover:text-blue-400 text-sm inline-flex items-center gap-1"
            >
              <Plus size={14} /> Add description
            </button>
          )}
        </div>
```

- [ ] **Step 6: Test manually in the browser**

1. Start the app: `docker-compose up -d` (or dev servers)
2. Navigate to a game with no description (e.g., one of the itch.io games)
3. Verify "Add description" button appears
4. Click it, type a description, click Save — verify it persists on reload
5. Verify the "Manual" indicator with reset icon appears
6. Navigate to a game with no cover image
7. Verify the upload placeholder appears
8. Hover over a cover image — verify upload overlay appears
9. Upload an image — verify it replaces the cover
10. Verify "Manual" reset icon appears on the cover

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/GameDetail.jsx
git commit -m "feat: add inline description editing and cover image upload on GameDetail"
```

---

### Task 7: Version Bump, Changelog, and Final Verification

**Files:**
- Modify: `backend/package.json` (version bump)
- Modify: `frontend/package.json` (version bump)
- Modify: `CHANGELOG.md` (if it exists, otherwise skip)

- [ ] **Step 1: Bump version to 1.13.0**

Update version in both `backend/package.json` and `frontend/package.json` from `"1.12.3"` to `"1.13.0"`.

- [ ] **Step 2: Run full backend test suite**

Run: `cd backend && node --test 'tests/**/*.test.js'`
Expected: All tests pass.

- [ ] **Step 3: Build frontend**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit version bump**

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: bump version to 1.13.0 for manual metadata editing"
```
