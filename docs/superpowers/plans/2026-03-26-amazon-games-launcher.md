# Amazon Games Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Amazon Games as a new launcher with SQLite database file import and preview/approval flow.

**Architecture:** User uploads their local `games.db` SQLite file. Backend parses it and returns the game list for preview. User selects which games to import. Backend upserts selected games and locks sync. Frontend uses a two-step approval page (upload → review → import).

**Tech Stack:** Node.js, better-sqlite3, Express/multer, React, Tailwind CSS, TanStack React Query

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/services/launchers/amazon.js` | Create | Parse games.db SQLite file, extract games |
| `backend/src/services/launchers/index.js` | Modify | Register AmazonLauncher in LAUNCHER_CLASSES |
| `backend/src/routes/launchers.js` | Modify | Add amazon to AVAILABLE_LAUNCHERS, add preview + import endpoints |
| `frontend/src/pages/AmazonApproval.jsx` | Create | Two-step upload → review → import approval page |
| `frontend/src/pages/Settings.jsx` | Modify | Add "Import Database" button for Amazon launcher |
| `frontend/src/App.jsx` | Modify | Add route for AmazonApproval page |
| `backend/tests/services/launchers/amazon.test.js` | Create | Unit tests for parseGamesDb |
| `backend/tests/routes/launchers.test.js` | Modify | Route tests for preview/import endpoints, bump launcher count |

---

### Task 1: Amazon launcher service — parseGamesDb

**Files:**
- Create: `backend/src/services/launchers/amazon.js`
- Create: `backend/tests/services/launchers/amazon.test.js`

- [ ] **Step 1: Write the failing test for parseGamesDb**

Create `backend/tests/services/launchers/amazon.test.js`:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

describe('Amazon parseGamesDb', () => {
  it('should extract games from a SQLite games.db buffer', () => {
    // Create a minimal SQLite DB in a temp file
    const tmpPath = path.join(__dirname, 'test-amazon-games.db');
    const db = new Database(tmpPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS "DbSet" (
        Id TEXT PRIMARY KEY,
        ProductTitle TEXT,
        ProductIdStr TEXT,
        InstallDirectory TEXT,
        Installed INTEGER
      )
    `);
    db.prepare('INSERT INTO DbSet (Id, ProductTitle, ProductIdStr, Installed) VALUES (?, ?, ?, ?)').run(
      'amzn1.adg.product.aaaa-bbbb', 'Ghostwire: Tokyo', 'amzn1.adg.product.aaaa-bbbb', 1
    );
    db.prepare('INSERT INTO DbSet (Id, ProductTitle, ProductIdStr, Installed) VALUES (?, ?, ?, ?)').run(
      'amzn1.adg.product.cccc-dddd', 'Fallout 76', 'amzn1.adg.product.cccc-dddd', 0
    );
    db.close();

    const buffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);

    const { parseGamesDb } = require('../../../src/services/launchers/amazon');
    const games = parseGamesDb(buffer);

    assert.ok(Array.isArray(games), 'should return an array');
    assert.equal(games.length, 2);
    assert.equal(games[0].title, 'Fallout 76');  // sorted alphabetically
    assert.equal(games[1].title, 'Ghostwire: Tokyo');
    assert.ok(games[0].launcher_game_id, 'should have launcher_game_id');
  });

  it('should handle entitlements table as alternative schema', () => {
    const tmpPath = path.join(__dirname, 'test-amazon-entitlements.db');
    const db = new Database(tmpPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS entitlements (
        product_id TEXT PRIMARY KEY,
        product_title TEXT,
        product_type TEXT
      )
    `);
    db.prepare('INSERT INTO entitlements (product_id, product_title, product_type) VALUES (?, ?, ?)').run(
      'amzn1.adg.product.eeee', 'Test Game', 'GAME'
    );
    db.prepare('INSERT INTO entitlements (product_id, product_title, product_type) VALUES (?, ?, ?)').run(
      'amzn1.adg.product.ffff', 'Some DLC', 'DLC'
    );
    db.close();

    const buffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);

    const { parseGamesDb } = require('../../../src/services/launchers/amazon');
    const games = parseGamesDb(buffer);

    assert.equal(games.length, 1, 'should filter out non-GAME entries');
    assert.equal(games[0].title, 'Test Game');
  });

  it('should throw on invalid SQLite data', () => {
    const { parseGamesDb } = require('../../../src/services/launchers/amazon');
    assert.throws(() => parseGamesDb(Buffer.from('not a database')), /Failed to parse/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/services/launchers/amazon.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement parseGamesDb**

Create `backend/src/services/launchers/amazon.js`:

```javascript
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const BaseLauncher = require('./base');

/**
 * Parse an Amazon Games games.db SQLite file and extract game entries.
 * Supports two known schemas:
 *   - DbSet table (ProductTitle, ProductIdStr)
 *   - entitlements table (product_id, product_title, product_type)
 */
function parseGamesDb(buffer) {
  const tmpPath = path.join(os.tmpdir(), `amazon-games-${Date.now()}.db`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    const db = new Database(tmpPath, { readonly: true });

    let games;

    // Check which table exists
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map(r => r.name.toLowerCase());

    if (tables.includes('dbset')) {
      const rows = db.prepare(
        'SELECT ProductIdStr as product_id, ProductTitle as title FROM DbSet WHERE ProductTitle IS NOT NULL'
      ).all();
      games = rows.map(r => ({
        launcher_game_id: r.product_id || r.title,
        title: r.title,
      }));
    } else if (tables.includes('entitlements')) {
      const rows = db.prepare(
        "SELECT product_id, product_title as title FROM entitlements WHERE product_type = 'GAME'"
      ).all();
      games = rows.map(r => ({
        launcher_game_id: r.product_id,
        title: r.title,
      }));
    } else {
      db.close();
      throw new Error('No recognized table found (expected DbSet or entitlements)');
    }

    db.close();
    games.sort((a, b) => a.title.localeCompare(b.title));
    return games;
  } catch (err) {
    if (err.message.includes('No recognized table') || err.message.includes('Failed to parse')) throw err;
    throw new Error('Failed to parse games.db: ' + err.message);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

class AmazonLauncher extends BaseLauncher {
  async fetchOwnedGames() {
    throw new Error('Amazon Games uses file import only — no API sync available.');
  }
}

module.exports = AmazonLauncher;
module.exports.parseGamesDb = parseGamesDb;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/services/launchers/amazon.test.js`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/launchers/amazon.js backend/tests/services/launchers/amazon.test.js
git commit -m "feat(amazon): add parseGamesDb for SQLite database import"
```

---

### Task 2: Register Amazon launcher

**Files:**
- Modify: `backend/src/services/launchers/index.js:1-23`
- Modify: `backend/src/routes/launchers.js:11-21`
- Modify: `backend/tests/routes/launchers.test.js:40-48`

- [ ] **Step 1: Write the failing test — launcher count should be 10**

In `backend/tests/routes/launchers.test.js`, change line 40:

```javascript
  it('GET /api/launchers/available should return 10 launchers', async () => {
```

And line 46:

```javascript
    assert.equal(body.length, 10);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "should return 10 launchers"`
Expected: FAIL — still returns 9

- [ ] **Step 3: Add Amazon to AVAILABLE_LAUNCHERS**

In `backend/src/routes/launchers.js`, add after line 20 (the xbox entry):

```javascript
  { id: 'amazon', display_name: 'Amazon Games', auth_type: 'file_import', otp_supported: false, qr_supported: false, implemented: true },
```

- [ ] **Step 4: Add Amazon to LAUNCHER_CLASSES**

In `backend/src/services/launchers/index.js`, add the import at line 9:

```javascript
const AmazonLauncher = require('./amazon');
```

And add to the LAUNCHER_CLASSES object at line 20:

```javascript
  amazon: AmazonLauncher,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "should return 10 launchers"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/launchers/index.js backend/src/routes/launchers.js backend/tests/routes/launchers.test.js
git commit -m "feat(amazon): register Amazon Games launcher (10 launchers)"
```

---

### Task 3: Backend preview + import endpoints

**Files:**
- Modify: `backend/src/routes/launchers.js:43-45` (add after multer declaration, before ubisoft route)
- Modify: `backend/tests/routes/launchers.test.js`

- [ ] **Step 1: Write failing tests for preview and import endpoints**

Add to `backend/tests/routes/launchers.test.js`, before the XboxApproval regression test block:

```javascript
  // Amazon Games: preview should parse games.db and return game list without DB writes
  it('POST /api/launchers/amazon/preview should return parsed games', async () => {
    const Database = require('better-sqlite3');
    const tmpPath = require('node:path').join(__dirname, 'test-amazon-preview.db');
    const tmpDb = new Database(tmpPath);
    tmpDb.exec(`
      CREATE TABLE IF NOT EXISTS "DbSet" (
        Id TEXT PRIMARY KEY,
        ProductTitle TEXT,
        ProductIdStr TEXT,
        Installed INTEGER
      )
    `);
    tmpDb.prepare('INSERT INTO DbSet (Id, ProductTitle, ProductIdStr, Installed) VALUES (?, ?, ?, ?)').run(
      'amzn1.preview.aaa', 'Preview Game', 'amzn1.preview.aaa', 1
    );
    tmpDb.close();

    const fileBuffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);

    const boundary = '----TestBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="games_db"; filename="games.db"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await makeFetch(app, '/api/launchers/amazon/preview', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Cookie: authCookie(),
      },
      body,
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.games), 'should return games array');
    assert.equal(data.games.length, 1);
    assert.equal(data.games[0].title, 'Preview Game');

    // Verify no DB writes happened
    const db = app.locals.db;
    const amazonRow = db.prepare("SELECT id FROM launchers WHERE name = 'amazon'").get();
    if (amazonRow) {
      const editions = db.prepare('SELECT COUNT(*) as c FROM game_editions WHERE launcher_id = ?').get(amazonRow.id);
      assert.equal(editions.c, 0, 'preview should not write to game_editions');
    }
  });

  // Amazon Games: import should upsert games and set sync_locked
  it('POST /api/launchers/amazon/import should upsert games and lock sync', async () => {
    const db = app.locals.db;

    const res = await makeFetch(app, '/api/launchers/amazon/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: authCookie(),
      },
      body: JSON.stringify({
        approved_games: [
          { launcher_game_id: 'amzn1.import.aaa', title: 'Imported Game A' },
          { launcher_game_id: 'amzn1.import.bbb', title: 'Imported Game B' },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.imported, 2);

    // Verify games exist in DB
    const launcher = db.prepare("SELECT id, sync_locked FROM launchers WHERE name = 'amazon'").get();
    assert.ok(launcher, 'amazon launcher row should exist');
    assert.equal(launcher.sync_locked, 1, 'sync_locked should be 1 after import');

    const editions = db.prepare(
      'SELECT COUNT(*) as c FROM game_editions WHERE launcher_id = ? AND owned = 1'
    ).get(launcher.id);
    assert.equal(editions.c, 2, 'should have 2 game editions');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "amazon"`
Expected: FAIL — routes not found (404)

- [ ] **Step 3: Implement preview and import endpoints**

In `backend/src/routes/launchers.js`, add after line 45 (the multer declaration) and before the ubisoft import-cache route:

```javascript
// POST /api/launchers/amazon/preview — upload games.db, return parsed game list (no DB writes)
router.post('/amazon/preview', uploadCache.single('games_db'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'games_db file is required' });
  }

  const { parseGamesDb } = require('../services/launchers/amazon');

  let games;
  try {
    games = parseGamesDb(file.buffer);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse games.db: ' + err.message });
  }

  res.json({ games });
});

// POST /api/launchers/amazon/import — import approved games and lock sync
router.post('/amazon/import', (req, res) => {
  const { approved_games } = req.body || {};

  if (!Array.isArray(approved_games) || approved_games.length === 0) {
    return res.status(400).json({ error: 'approved_games must be a non-empty array' });
  }

  const db = req.app.locals.db;
  const { detectEditionTier } = require('../utils/editionTier');

  // Ensure amazon launcher row exists
  db.prepare(
    "INSERT OR IGNORE INTO launchers (name, display_name, enabled) VALUES ('amazon', 'Amazon Games', 1)"
  ).run();
  const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'amazon'").get();

  const upsert = db.prepare(`
    INSERT INTO game_editions (launcher_id, launcher_game_id, title, playtime_minutes, owned)
    VALUES (?, ?, ?, 0, 1)
    ON CONFLICT(launcher_id, launcher_game_id) DO UPDATE SET
      title = excluded.title,
      owned = 1
  `);
  const insertTier = db.prepare('INSERT OR IGNORE INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)');

  const importGames = db.transaction((gameList) => {
    for (const game of gameList) {
      const result = upsert.run(launcher.id, game.launcher_game_id, game.title);
      const editionId = result.lastInsertRowid ? Number(result.lastInsertRowid) : null;
      if (editionId) {
        insertTier.run(editionId, detectEditionTier(game.title));
      }
    }
  });

  importGames(approved_games);

  // Lock sync to prevent removal of imported games
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE id = ?').run(launcher.id);

  // Trigger enrichment
  const { enrichAll } = require('../services/metadata/enrichGame');
  enrichAll(db).catch(err => console.error('[Metadata] enrichAll error:', err.message));

  console.log(`[Amazon] Imported ${approved_games.length} games from games.db`);
  res.json({ imported: approved_games.length });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "amazon"`
Expected: PASS

- [ ] **Step 5: Run full launcher test suite**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js
git commit -m "feat(amazon): add preview and import endpoints for games.db"
```

---

### Task 4: Frontend — AmazonApproval page

**Files:**
- Create: `frontend/src/pages/AmazonApproval.jsx`

- [ ] **Step 1: Create AmazonApproval.jsx**

```jsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckSquare, Square, Upload } from 'lucide-react';

export default function AmazonApproval() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [games, setGames] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('games_db', file);
      const res = await fetch('/api/launchers/amazon/preview', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to parse database');
        return;
      }
      setGames(data.games);
      setSelected(new Set(data.games.map((_, i) => i)));
    } catch (err) {
      setError('Network error — please try again');
    } finally {
      setUploading(false);
    }
  };

  const toggleGame = (index) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(games.map((_, i) => i)));
  const deselectAll = () => setSelected(new Set());

  const handleImport = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const approved_games = games.filter((_, i) => selected.has(i));
      const res = await fetch('/api/launchers/amazon/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved_games }),
      });
      const result = await res.json();
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
        navigate('/settings', {
          state: { flash: `Imported ${result.imported} Amazon games.` },
        });
      } else {
        setError(result.error || 'Import failed');
      }
    } catch (err) {
      setError('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6">
      <button
        onClick={() => navigate('/settings')}
        className="flex items-center gap-1 text-gray-400 hover:text-white mb-4 transition-colors"
      >
        <ArrowLeft size={16} /> Back to Settings
      </button>

      <h1 className="text-xl font-bold text-white mb-2">Amazon Games Import</h1>
      <p className="text-sm text-gray-400 mb-4">
        Upload your <code className="text-gray-300">games.db</code> file from{' '}
        <code className="text-gray-300">%LocalAppData%\Amazon Games\Data\</code> to import your library.
      </p>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {!games ? (
        <label className="flex items-center justify-center gap-2 px-4 py-8 border-2 border-dashed border-gray-600 rounded-lg cursor-pointer hover:border-gray-500 transition-colors">
          <Upload size={20} className="text-gray-400" />
          <span className="text-gray-400">{uploading ? 'Parsing...' : 'Select games.db file'}</span>
          <input
            type="file"
            accept=".db"
            className="hidden"
            onChange={handleFileUpload}
            disabled={uploading}
          />
        </label>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={selectAll}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
            >
              <CheckSquare size={14} /> Select All
            </button>
            <button
              onClick={deselectAll}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
            >
              <Square size={14} /> Deselect All
            </button>
            <span className="text-sm text-gray-500">
              {selected.size} of {games.length} selected
            </span>
          </div>

          <div className="space-y-1 mb-6">
            {games.map((game, i) => (
              <label
                key={game.launcher_game_id}
                className="flex items-center gap-3 p-2 rounded hover:bg-gray-800 cursor-pointer transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(i)}
                  onChange={() => toggleGame(i)}
                  className="w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500 bg-gray-700"
                />
                <span className="text-sm text-white">{game.title}</span>
              </label>
            ))}
          </div>

          <div className="sticky bottom-0 bg-gray-900 border-t border-gray-700 p-4 -mx-6 px-6 flex items-center gap-3">
            <button
              onClick={handleImport}
              disabled={selected.size === 0 || submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded transition-colors"
            >
              {submitting ? 'Importing...' : `Import ${selected.size} game${selected.size !== 1 ? 's' : ''}`}
            </button>
            <button
              onClick={() => { setGames(null); setSelected(new Set()); setError(null); }}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
            >
              Upload Different File
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/AmazonApproval.jsx
git commit -m "feat(amazon): add AmazonApproval page with upload, preview, and import"
```

---

### Task 5: Frontend — Settings button + routing

**Files:**
- Modify: `frontend/src/App.jsx:10-32`
- Modify: `frontend/src/pages/Settings.jsx:202-209`

- [ ] **Step 1: Add route in App.jsx**

In `frontend/src/App.jsx`, add import at line 10:

```javascript
import AmazonApproval from './pages/AmazonApproval';
```

Add route after line 32 (the xbox approve route):

```jsx
            <Route path="/settings/amazon/approve" element={<AmazonApproval />} />
```

- [ ] **Step 2: Add Import Database button in Settings.jsx**

In `frontend/src/pages/Settings.jsx`, add after the xbox approve button block (after line 209):

```jsx
                {l.id === 'amazon' && (
                  <button
                    onClick={() => navigate('/settings/amazon/approve')}
                    className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                  >
                    Import Database
                  </button>
                )}
```

- [ ] **Step 3: Verify frontend builds**

Run: `cd frontend && npx vite build 2>&1 | tail -5`
Expected: Build succeeds with no errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.jsx frontend/src/pages/Settings.jsx
git commit -m "feat(amazon): add Settings button and routing for Amazon import"
```

---

### Task 6: Handle file_import auth_type in credentials endpoint

**Files:**
- Modify: `backend/src/routes/launchers.js:122-139`

The credentials endpoint validates `auth_type` and will fall through to the `else` branch for `file_import`, requiring username/password. We need to handle `file_import` type gracefully since Amazon doesn't use credentials.

- [ ] **Step 1: Write failing test**

Add to `backend/tests/routes/launchers.test.js`:

```javascript
  it('POST /api/launchers/amazon/credentials should return 400 for file_import launcher', async () => {
    const res = await makeFetch(app, '/api/launchers/amazon/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('file import'), 'should mention file import');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "file_import"`
Expected: FAIL — currently falls through to username/password validation

- [ ] **Step 3: Add file_import guard to credentials endpoint**

In `backend/src/routes/launchers.js`, add after the `implemented` check (after line 117):

```javascript
  if (launcher.auth_type === 'file_import') {
    return res.status(400).json({ error: `${launcher.display_name} uses file import — no credentials needed` });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/routes/launchers.test.js --test-name-pattern "file_import"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js
git commit -m "fix(amazon): reject credentials endpoint for file_import launchers"
```

---

### Task 7: Version bump + full verification

**Files:**
- Modify: `backend/package.json:3`

- [ ] **Step 1: Bump version to v1.16.0**

In `backend/package.json`, change version to `"1.16.0"`.

- [ ] **Step 2: Run full backend test suite**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All tests pass (except the pre-existing setup.test.js QR failure)

- [ ] **Step 3: Verify frontend builds**

Run: `cd frontend && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add backend/package.json
git commit -m "chore: bump version to v1.16.0 for Amazon Games launcher"
```
