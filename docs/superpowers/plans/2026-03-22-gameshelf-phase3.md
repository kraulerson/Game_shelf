# Gameshelf Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add launcher service integrations (Steam, Humble, itch.io, GOG + 5 stubs) and a sync engine that fetches owned games and upserts them into the database on a 6-hour cron schedule.

**Architecture:** Each launcher extends a `BaseLauncher` class with `authenticate()` and `fetchOwnedGames()` methods. A `syncEngine` orchestrates syncing — looking up credentials, instantiating the right launcher, upserting games into `game_editions`, and tracking jobs in `sync_jobs`. Routes expose sync triggers and status. `node-cron` runs `syncAll()` every 6 hours.

**Tech Stack:** Node.js 20, Express 5, better-sqlite3, axios, otpauth, steam-totp

**Spec:** `docs/superpowers/specs/2026-03-22-gameshelf-phase3-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|----------------|
| `backend/src/services/launchers/base.js` | Abstract base class with `authenticate()`, `fetchOwnedGames()`, `refreshIfNeeded()` |
| `backend/src/services/launchers/steam.js` | Steam Web API integration |
| `backend/src/services/launchers/humble.js` | Humble Bundle session-based integration |
| `backend/src/services/launchers/itchio.js` | itch.io API key integration |
| `backend/src/services/launchers/gog.js` | GOG OAuth2 integration |
| `backend/src/services/launchers/ea.js` | Stub |
| `backend/src/services/launchers/ubisoft.js` | Stub |
| `backend/src/services/launchers/epic.js` | Stub |
| `backend/src/services/launchers/battlenet.js` | Stub |
| `backend/src/services/launchers/xbox.js` | Stub |
| `backend/src/services/launchers/index.js` | Launcher registry map |
| `backend/src/services/syncEngine.js` | Sync orchestration |
| `backend/tests/services/syncEngine.test.js` | Sync engine tests |
| `backend/tests/services/launchers/steam.test.js` | Steam launcher tests |
| `backend/tests/services/launchers/base.test.js` | Base class tests |
| `backend/tests/db/migrate-phase3.test.js` | Migration tests for schema changes |

### Modified files
| File | Change |
|------|--------|
| `backend/src/db/schema.sql` | Recreate `game_editions` (nullable game_id, add title, drop old unique, add new index); add columns to sync_jobs |
| `backend/src/db/migrate.js` | Add Phase 3 migration step |
| `backend/src/routes/sync.js` | Replace stub with real routes |
| `backend/src/routes/launchers.js` | Update Steam auth_type, credential validation for steamid64 |
| `backend/src/server.js` | Add cron scheduler |
| `frontend/src/pages/Setup.jsx` | Update Steam credential card |

---

### Task 1: Install axios and schema migration

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/src/db/schema.sql`
- Modify: `backend/src/db/migrate.js`
- Create: `backend/tests/db/migrate-phase3.test.js`

- [ ] **Step 1: Install axios**

Run:
```bash
cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && npm install axios
```

- [ ] **Step 2: Write migration test**

Create `backend/tests/db/migrate-phase3.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Phase 3 migration', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-migrate-p3.db');
  let db;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt-secret';
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

  it('game_editions.game_id should be nullable', () => {
    const cols = db.pragma('table_info(game_editions)');
    const gameIdCol = cols.find(c => c.name === 'game_id');
    assert.ok(gameIdCol, 'game_id column should exist');
    assert.equal(gameIdCol.notnull, 0, 'game_id should be nullable');
  });

  it('game_editions should have a title column', () => {
    const cols = db.pragma('table_info(game_editions)');
    const titleCol = cols.find(c => c.name === 'title');
    assert.ok(titleCol, 'title column should exist');
  });

  it('should have unique index on (launcher_id, launcher_game_id)', () => {
    const indexes = db.pragma('index_list(game_editions)');
    const idx = indexes.find(i => i.name === 'idx_game_editions_launcher_game');
    assert.ok(idx, 'idx_game_editions_launcher_game should exist');
    assert.equal(idx.unique, 1, 'index should be unique');
  });

  it('should NOT have the old UNIQUE(game_id, launcher_id) constraint', () => {
    // The old constraint was an auto-generated index like sqlite_autoindex_game_editions_1
    // After table recreation without the UNIQUE constraint, it should not exist
    const indexes = db.pragma('index_list(game_editions)');
    const autoIdx = indexes.find(i => i.name.includes('autoindex'));
    assert.equal(autoIdx, undefined, 'Should not have autoindex from old UNIQUE constraint');
  });

  it('sync_jobs should have games_found and games_updated columns', () => {
    const cols = db.pragma('table_info(sync_jobs)');
    const gamesFound = cols.find(c => c.name === 'games_found');
    const gamesUpdated = cols.find(c => c.name === 'games_updated');
    assert.ok(gamesFound, 'games_found column should exist');
    assert.ok(gamesUpdated, 'games_updated column should exist');
  });

  it('should allow inserting game_editions with null game_id', () => {
    // Insert a launcher first
    db.prepare('INSERT OR IGNORE INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('test_launcher', 'Test');
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('test_launcher');

    // Insert game_edition with null game_id
    db.prepare(
      'INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title) VALUES (NULL, ?, ?, ?)'
    ).run(launcher.id, 'test_game_1', 'Test Game');

    const row = db.prepare('SELECT * FROM game_editions WHERE launcher_game_id = ?').get('test_game_1');
    assert.equal(row.game_id, null);
    assert.equal(row.title, 'Test Game');
  });
});
```

- [ ] **Step 3: Run migration test to verify it fails**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && node --test tests/db/migrate-phase3.test.js`

Expected: FAIL — game_id is NOT NULL, title column missing, sync_jobs columns missing

- [ ] **Step 4: Update schema.sql**

Replace the `game_editions` table and `sync_jobs` table in `backend/src/db/schema.sql`:

The `game_editions` CREATE TABLE becomes:
```sql
CREATE TABLE IF NOT EXISTS game_editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER,
  launcher_id INTEGER NOT NULL,
  launcher_game_id TEXT,
  title TEXT,
  launcher_url TEXT,
  owned INTEGER NOT NULL DEFAULT 1,
  install_state TEXT,
  playtime_minutes INTEGER DEFAULT 0,
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (launcher_id) REFERENCES launchers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_editions_launcher_game
  ON game_editions(launcher_id, launcher_game_id);
```

The `sync_jobs` CREATE TABLE becomes:
```sql
CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  launcher_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  games_found INTEGER DEFAULT 0,
  games_updated INTEGER DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY (launcher_id) REFERENCES launchers(id) ON DELETE CASCADE
);
```

- [ ] **Step 5: Add Phase 3 migration to migrate.js**

Add the following code between the admin user seed block (line 35: closing `}` of the `if (userCount.count === 0)` block) and the `return db;` statement (line 37). The migration MUST run before `return db;`:

```javascript
  // Phase 3 migration: update game_editions and sync_jobs
  const gameEditionsCols = db.pragma('table_info(game_editions)');
  const hasTitle = gameEditionsCols.some(c => c.name === 'title');
  const gameIdCol = gameEditionsCols.find(c => c.name === 'game_id');
  const needsMigration = !hasTitle || (gameIdCol && gameIdCol.notnull === 1);

  if (needsMigration) {
    db.transaction(() => {
      // Recreate game_editions with nullable game_id, title column, no old UNIQUE constraint
      db.exec('ALTER TABLE game_editions RENAME TO game_editions_old');
      db.exec(`
        CREATE TABLE game_editions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER,
          launcher_id INTEGER NOT NULL,
          launcher_game_id TEXT,
          title TEXT,
          launcher_url TEXT,
          owned INTEGER NOT NULL DEFAULT 1,
          install_state TEXT,
          playtime_minutes INTEGER DEFAULT 0,
          last_played_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (launcher_id) REFERENCES launchers(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO game_editions (id, game_id, launcher_id, launcher_game_id, launcher_url, owned, install_state, playtime_minutes, last_played_at, created_at)
        SELECT id, game_id, launcher_id, launcher_game_id, launcher_url, owned, install_state, playtime_minutes, last_played_at, created_at
        FROM game_editions_old
      `);
      db.exec('DROP TABLE game_editions_old');
    })();
  }

  // Ensure unique index exists (idempotent)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_game_editions_launcher_game
      ON game_editions(launcher_id, launcher_game_id)
  `);

  // Phase 3: add games_found and games_updated to sync_jobs
  const syncJobsCols = db.pragma('table_info(sync_jobs)');
  if (!syncJobsCols.some(c => c.name === 'games_found')) {
    db.exec('ALTER TABLE sync_jobs ADD COLUMN games_found INTEGER DEFAULT 0');
  }
  if (!syncJobsCols.some(c => c.name === 'games_updated')) {
    db.exec('ALTER TABLE sync_jobs ADD COLUMN games_updated INTEGER DEFAULT 0');
  }
```

- [ ] **Step 6: Run migration test to verify it passes**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && node --test tests/db/migrate-phase3.test.js`

Expected: All 6 tests PASS

- [ ] **Step 7: Run full test suite**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && npm test`

Expected: All existing tests still pass

- [ ] **Step 8: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/db/schema.sql backend/src/db/migrate.js backend/tests/db/migrate-phase3.test.js
git commit -m "feat: add Phase 3 schema migration and install axios"
```

---

### Task 2: Update Steam auth_type and credential validation

**Files:**
- Modify: `backend/src/routes/launchers.js`
- Modify: `frontend/src/pages/Setup.jsx`

- [ ] **Step 1: Update AVAILABLE_LAUNCHERS and validation in launchers.js**

In `backend/src/routes/launchers.js`, change Steam's entry (line 12) to:
```javascript
{ id: 'steam', display_name: 'Steam', auth_type: 'api_key', otp_supported: false, qr_supported: false },
```

Update the destructuring at line 39 to include `steamid64`:
```javascript
  const { username, password, api_key, steamid64, totp_secret } = req.body || {};
```

Update the credential validation block (lines 41-51) to handle `steamid64`:
```javascript
  // Validate required fields by auth_type
  if (launcher.auth_type === 'api_key') {
    if (!api_key) {
      return res.status(400).json({ error: 'api_key is required for this launcher' });
    }
  } else {
    // credentials or credentials+totp
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required for this launcher' });
    }
  }

  // Steam requires steamid64 alongside api_key
  if (id === 'steam' && !steamid64) {
    return res.status(400).json({ error: 'steamid64 is required for Steam' });
  }
```

Update the payload construction (lines 53-57) to include `steamid64`:
```javascript
  const payload = {};
  if (username) payload.username = username;
  if (password) payload.password = password;
  if (api_key) payload.api_key = api_key;
  if (steamid64) payload.steamid64 = steamid64;
  if (totp_secret) payload.totp_secret = totp_secret;
```

- [ ] **Step 2: Update Setup.jsx Steam credential card**

In `frontend/src/pages/Setup.jsx`, within the Step 3 credentials rendering, find the block that renders fields for each launcher. Add a special case for Steam that shows API Key + Steam ID fields instead of username/password. In the credential card rendering, after the `showApiKey` block and before the `otp_supported` block, add:

```jsx
{launcher.id === 'steam' && (
  <div className="mb-3">
    <label className="block text-sm text-gray-300 mb-1">Steam ID (64-bit)</label>
    <input
      type="text"
      value={creds.steamid64 || ''}
      onChange={(e) => updateField(launcher.id, 'steamid64', e.target.value)}
      placeholder="e.g. 76561198012345678"
      className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  </div>
)}
```

Also remove the Steam Guard warning from the `otp_supported` block since Steam no longer uses credentials+totp auth. The `{launcher.id === 'steam' && (...Steam Guard warning...)}` block inside the `totpEnabled` section should be removed. Since Steam's `otp_supported` is now `false`, the TOTP section won't render for Steam anyway, but removing the dead code is cleaner.

- [ ] **Step 3: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 4: Update existing Steam credential test**

In `backend/tests/routes/launchers.test.js`, update the Steam credential save test. Change:
```javascript
body: JSON.stringify({ username: 'mysteam', password: 'pass123' }),
```
to:
```javascript
body: JSON.stringify({ api_key: 'test-steam-key', steamid64: '76561198012345678' }),
```

Also update the test connection test that depends on Steam credentials being saved — it should use the same `api_key` + `steamid64` shape.

- [ ] **Step 5: Run backend tests**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && npm test`

Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js frontend/src/pages/Setup.jsx
git commit -m "feat: update Steam to api_key auth type with steamid64 field"
```

---

### Task 3: Base launcher class

**Files:**
- Create: `backend/src/services/launchers/base.js`
- Create: `backend/tests/services/launchers/base.test.js`

- [ ] **Step 1: Write base class test**

Create `backend/tests/services/launchers/base.test.js`:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const BaseLauncher = require('../../../src/services/launchers/base');

describe('BaseLauncher', () => {
  it('should store launcherId and db in constructor', () => {
    const fakeDb = { prepare: () => {} };
    const launcher = new BaseLauncher('steam', fakeDb);
    assert.equal(launcher.launcherId, 'steam');
    assert.equal(launcher.db, fakeDb);
  });

  it('authenticate() should throw not implemented', async () => {
    const launcher = new BaseLauncher('test', {});
    await assert.rejects(() => launcher.authenticate({}), { message: /not implemented/i });
  });

  it('fetchOwnedGames() should throw not implemented', async () => {
    const launcher = new BaseLauncher('test', {});
    await assert.rejects(() => launcher.fetchOwnedGames(null), { message: /not implemented/i });
  });

  it('refreshIfNeeded() should call authenticate() by default', async () => {
    let authCalled = false;
    const launcher = new BaseLauncher('test', {});
    launcher.authenticate = async (creds) => { authCalled = true; return 'session-token'; };
    const session = await launcher.refreshIfNeeded({ username: 'u', password: 'p' });
    assert.equal(authCalled, true);
    assert.equal(session, 'session-token');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && node --test tests/services/launchers/base.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Implement base class**

Create `backend/src/services/launchers/base.js`:

```javascript
class BaseLauncher {
  constructor(launcherId, db) {
    this.launcherId = launcherId;
    this.db = db;
  }

  async authenticate(credentials) {
    throw new Error(`authenticate() not implemented for ${this.launcherId}`);
  }

  async fetchOwnedGames(session) {
    throw new Error(`fetchOwnedGames() not implemented for ${this.launcherId}`);
  }

  async refreshIfNeeded(credentials) {
    return this.authenticate(credentials);
  }
}

module.exports = BaseLauncher;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && node --test tests/services/launchers/base.test.js`

Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/launchers/base.js backend/tests/services/launchers/base.test.js
git commit -m "feat: add BaseLauncher abstract class with tests"
```

---

### Task 4: Steam integration

**Files:**
- Create: `backend/src/services/launchers/steam.js`
- Create: `backend/tests/services/launchers/steam.test.js`

- [ ] **Step 1: Write Steam launcher test**

Create `backend/tests/services/launchers/steam.test.js`:

```javascript
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

describe('SteamLauncher', () => {
  it('authenticate() should return null (API key based, no session)', async () => {
    const SteamLauncher = require('../../../src/services/launchers/steam');
    const launcher = new SteamLauncher('steam', {});
    const session = await launcher.authenticate({ api_key: 'test', steamid64: '123' });
    assert.equal(session, null);
  });

  it('refreshIfNeeded() should return null (no session needed)', async () => {
    const SteamLauncher = require('../../../src/services/launchers/steam');
    const launcher = new SteamLauncher('steam', {});
    const session = await launcher.refreshIfNeeded({ api_key: 'test', steamid64: '123' });
    assert.equal(session, null);
  });

  it('fetchOwnedGames() should map Steam API response correctly', async () => {
    // Mock axios
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async (url) => ({
      data: {
        response: {
          games: [
            { appid: 440, name: 'Team Fortress 2', playtime_forever: 1200 },
            { appid: 570, name: 'Dota 2', playtime_forever: 500 },
          ]
        }
      }
    });

    try {
      const SteamLauncher = require('../../../src/services/launchers/steam');
      const launcher = new SteamLauncher('steam', {});
      launcher.credentials = { api_key: 'testkey', steamid64: '76561198012345678' };
      const games = await launcher.fetchOwnedGames(null);

      assert.equal(games.length, 2);
      assert.equal(games[0].launcher_game_id, '440');
      assert.equal(games[0].title, 'Team Fortress 2');
      assert.equal(games[0].playtime_minutes, 1200);
      assert.equal(games[1].launcher_game_id, '570');
    } finally {
      axios.get = originalGet;
    }
  });

  it('fetchOwnedGames() should return empty array when no games', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => ({ data: { response: {} } });

    try {
      const SteamLauncher = require('../../../src/services/launchers/steam');
      const launcher = new SteamLauncher('steam', {});
      launcher.credentials = { api_key: 'testkey', steamid64: '123' };
      const games = await launcher.fetchOwnedGames(null);
      assert.equal(games.length, 0);
    } finally {
      axios.get = originalGet;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && node --test tests/services/launchers/steam.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Implement Steam launcher**

Create `backend/src/services/launchers/steam.js`:

```javascript
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Steam integration using the Steam Web API.
 *
 * This uses the official Steam Web API with a user-provided API key and SteamID64.
 * We do NOT use password-based Steam login — it is fragile, requires handling
 * Steam Guard, and violates Steam's Terms of Service.
 *
 * Credentials shape: { api_key: string, steamid64: string }
 * - api_key: from https://steamcommunity.com/dev/apikey
 * - steamid64: the user's 64-bit Steam ID (e.g., 76561198012345678)
 */
class SteamLauncher extends BaseLauncher {
  async authenticate(credentials) {
    // Steam Web API uses api_key in query params — no session needed
    this.credentials = credentials;
    return null;
  }

  async refreshIfNeeded(credentials) {
    // No session to refresh — API key based
    this.credentials = credentials;
    return null;
  }

  async fetchOwnedGames(session) {
    const { api_key, steamid64 } = this.credentials;

    const res = await axios.get('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/', {
      params: {
        key: api_key,
        steamid: steamid64,
        include_appinfo: 1,
        include_played_free_games: 1,
        format: 'json',
      },
    });

    const games = res.data?.response?.games || [];

    return games.map(game => ({
      launcher_game_id: game.appid.toString(),
      title: game.name,
      playtime_minutes: game.playtime_forever || 0,
    }));
  }
}

module.exports = SteamLauncher;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && node --test tests/services/launchers/steam.test.js`

Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/launchers/steam.js backend/tests/services/launchers/steam.test.js
git commit -m "feat: add Steam Web API launcher integration with tests"
```

---

### Task 5: Humble Bundle integration

**Files:**
- Create: `backend/src/services/launchers/humble.js`

- [ ] **Step 1: Implement Humble Bundle launcher**

Create `backend/src/services/launchers/humble.js`:

```javascript
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Humble Bundle integration using unofficial session-based web API.
 *
 * TODO: Humble's API is unofficial and undocumented. This integration may break
 * if Humble Bundle changes their API or login flow. Monitor for 401/403 errors
 * and update accordingly.
 *
 * Credentials shape: { username: string, password: string }
 */
class HumbleLauncher extends BaseLauncher {
  async authenticate(credentials) {
    const { username, password } = credentials;

    const res = await axios.post(
      'https://www.humblebundle.com/processlogin',
      new URLSearchParams({ username, password }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 0,
        validateStatus: (status) => status < 400 || status === 302,
      }
    );

    const cookies = res.headers['set-cookie'] || [];
    const sessionCookie = cookies.find(c => c.includes('_simpleauth_sess'));

    if (!sessionCookie) {
      throw new Error('Humble Bundle login failed: no session cookie received');
    }

    return sessionCookie.split(';')[0]; // "_simpleauth_sess=value"
  }

  async fetchOwnedGames(session) {
    const headers = { Cookie: session };

    // Get all order keys
    const ordersRes = await axios.get(
      'https://www.humblebundle.com/api/v1/user/order?ajax=true',
      { headers }
    );

    const gamekeys = ordersRes.data || [];
    const games = [];
    const seen = new Set();

    // Fetch each order's details
    for (const item of gamekeys) {
      const key = item.gamekey || item;
      try {
        const orderRes = await axios.get(
          `https://www.humblebundle.com/api/v1/order/${key}?ajax=true`,
          { headers }
        );

        const subproducts = orderRes.data?.subproducts || [];
        for (const sub of subproducts) {
          // Only include items with downloads (actual games, not coupons/etc)
          if (sub.downloads && sub.downloads.length > 0 && !seen.has(sub.machine_name)) {
            seen.add(sub.machine_name);
            games.push({
              launcher_game_id: sub.machine_name,
              title: sub.human_name,
              playtime_minutes: 0,
            });
          }
        }
      } catch (err) {
        console.warn(`[Humble] Failed to fetch order ${key}: ${err.message}`);
      }
    }

    return games;
  }
}

module.exports = HumbleLauncher;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/launchers/humble.js
git commit -m "feat: add Humble Bundle launcher integration"
```

---

### Task 6: itch.io integration

**Files:**
- Create: `backend/src/services/launchers/itchio.js`

- [ ] **Step 1: Implement itch.io launcher**

Create `backend/src/services/launchers/itchio.js`:

```javascript
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * itch.io integration using the official API.
 *
 * Uses an API key from https://itch.io/user/settings/api-keys
 * Only fetches purchased/owned games via /profile/owned-keys.
 * The /my-games endpoint returns games the user has UPLOADED, not purchased.
 *
 * Credentials shape: { api_key: string }
 */
class ItchioLauncher extends BaseLauncher {
  async authenticate(credentials) {
    // API key based — no session needed
    this.credentials = credentials;
    return null;
  }

  async refreshIfNeeded(credentials) {
    this.credentials = credentials;
    return null;
  }

  async fetchOwnedGames(session) {
    const { api_key } = this.credentials;
    const games = [];
    const seen = new Set();
    let page = 1;
    const MAX_PAGES = 100; // Safety cap to prevent infinite loops

    // Paginate through owned keys
    while (page <= MAX_PAGES) {
      const res = await axios.get('https://api.itch.io/profile/owned-keys', {
        headers: { Authorization: `Bearer ${api_key}` },
        params: { page },
      });

      const ownedKeys = res.data?.owned_keys || [];
      if (ownedKeys.length === 0) break;

      for (const key of ownedKeys) {
        const game = key.game;
        if (game && !seen.has(game.id)) {
          seen.add(game.id);
          games.push({
            launcher_game_id: game.id.toString(),
            title: game.title,
            playtime_minutes: 0,
          });
        }
      }

      page++;
    }

    return games;
  }
}

module.exports = ItchioLauncher;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/launchers/itchio.js
git commit -m "feat: add itch.io launcher integration"
```

---

### Task 7: GOG integration

**Files:**
- Create: `backend/src/services/launchers/gog.js`

- [ ] **Step 1: Implement GOG launcher**

Create `backend/src/services/launchers/gog.js`:

```javascript
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * GOG integration using unofficial OAuth2 password grant.
 *
 * TODO: GOG's API is unofficial. The client_id and client_secret below are
 * community-maintained values from GOG reverse-engineering projects (e.g.,
 * lgogdownloader). They may be revoked by GOG at any time. Consider making
 * these configurable via environment variables if they change frequently.
 *
 * TODO: GOG's auth may require re-auth flows (e.g., CAPTCHA, 2FA) that are
 * not handled here. Monitor for auth failures and document workarounds.
 *
 * Credentials shape: { username: string, password: string }
 */

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173d183b1a9';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class GOGLauncher extends BaseLauncher {
  async authenticate(credentials) {
    const { username, password } = credentials;

    const res = await axios.post('https://auth.gog.com/token', null, {
      params: {
        client_id: GOG_CLIENT_ID,
        client_secret: GOG_CLIENT_SECRET,
        grant_type: 'password',
        username,
        password,
      },
    });

    return res.data.access_token;
  }

  async fetchOwnedGames(session) {
    // Get list of owned game IDs
    const ownedRes = await axios.get('https://embed.gog.com/user/data/games', {
      headers: { Authorization: `Bearer ${session}` },
    });

    const ownedIds = ownedRes.data?.owned || [];
    const games = [];

    // Fetch product details for each owned game (rate limited: 1 req/sec)
    for (const id of ownedIds) {
      try {
        const productRes = await axios.get(`https://api.gog.com/products/${id}`, {
          params: { expand: 'description' },
        });

        games.push({
          launcher_game_id: id.toString(),
          title: productRes.data.title,
          playtime_minutes: 0,
        });
      } catch (err) {
        console.warn(`[GOG] Failed to fetch product ${id}: ${err.message}`);
      }

      // Rate limit: 1 request per second
      await sleep(1000);
    }

    return games;
  }
}

module.exports = GOGLauncher;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/launchers/gog.js
git commit -m "feat: add GOG launcher integration with rate limiting"
```

---

### Task 8: EA, Ubisoft, Epic stubs

**Files:**
- Create: `backend/src/services/launchers/ea.js`
- Create: `backend/src/services/launchers/ubisoft.js`
- Create: `backend/src/services/launchers/epic.js`

- [ ] **Step 1: Create all three stub files**

Create `backend/src/services/launchers/ea.js`:

```javascript
const BaseLauncher = require('./base');

/**
 * EA App integration — STUB
 *
 * TODO: EA App uses EA account OAuth. Implementation requires Playwright-based
 * headless browser login to automate the flow and scrape the game list from
 * https://www.ea.com/games/library
 *
 * Expected credential shape: { username: string, password: string, totp_secret?: string }
 */
class EALauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[EA App] EA App integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = EALauncher;
```

Create `backend/src/services/launchers/ubisoft.js`:

```javascript
const BaseLauncher = require('./base');

/**
 * Ubisoft Connect integration — STUB
 *
 * TODO: Implement using https://github.com/Hachi1/ubisoft-api-node as reference.
 * Ubisoft Connect has an unofficial API used by community tools.
 *
 * Expected credential shape: { email: string, password: string, totp_secret?: string }
 */
class UbisoftLauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[Ubisoft Connect] Ubisoft Connect integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = UbisoftLauncher;
```

Create `backend/src/services/launchers/epic.js`:

```javascript
const BaseLauncher = require('./base');

/**
 * Epic Games integration — STUB
 *
 * TODO: Implement using https://github.com/MixV2/EpicResearch as reference.
 * Epic uses OAuth2 with launcher client credentials.
 *
 * Expected credential shape: { email: string, password: string, totp_secret?: string }
 */
class EpicLauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[Epic Games] Epic Games integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = EpicLauncher;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/launchers/ea.js backend/src/services/launchers/ubisoft.js backend/src/services/launchers/epic.js
git commit -m "feat: add EA, Ubisoft Connect, and Epic Games launcher stubs"
```

---

### Task 9: Battle.net and Xbox stubs

**Files:**
- Create: `backend/src/services/launchers/battlenet.js`
- Create: `backend/src/services/launchers/xbox.js`

- [ ] **Step 1: Create both stub files**

Create `backend/src/services/launchers/battlenet.js`:

```javascript
const BaseLauncher = require('./base');

/**
 * Battle.net integration — STUB
 *
 * TODO: Blizzard has no public game library API. The recommended path forward
 * is Playwright-based headless browser automation to log into Battle.net and
 * scrape the games section.
 *
 * Expected credential shape: { username: string, password: string, totp_secret?: string }
 */
class BattlenetLauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[Battle.net] Battle.net integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = BattlenetLauncher;
```

Create `backend/src/services/launchers/xbox.js`:

```javascript
const BaseLauncher = require('./base');

/**
 * Xbox / Microsoft integration — STUB
 *
 * TODO: Xbox uses Microsoft OAuth. Reference https://xbl.io as a community
 * API option for fetching Xbox game library data.
 *
 * Expected credential shape: { username: string, password: string }
 */
class XboxLauncher extends BaseLauncher {
  async authenticate(credentials) {
    return null;
  }

  async refreshIfNeeded(credentials) {
    return null;
  }

  async fetchOwnedGames(session) {
    console.warn('[Xbox] Xbox integration not yet implemented. Returning empty game list.');
    return [];
  }
}

module.exports = XboxLauncher;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/launchers/battlenet.js backend/src/services/launchers/xbox.js
git commit -m "feat: add Battle.net and Xbox launcher stubs"
```

---

### Task 10: Launcher registry index

**Files:**
- Create: `backend/src/services/launchers/index.js`

- [ ] **Step 1: Create launcher registry**

Create `backend/src/services/launchers/index.js`:

```javascript
const SteamLauncher = require('./steam');
const HumbleLauncher = require('./humble');
const ItchioLauncher = require('./itchio');
const GOGLauncher = require('./gog');
const EALauncher = require('./ea');
const UbisoftLauncher = require('./ubisoft');
const EpicLauncher = require('./epic');
const BattlenetLauncher = require('./battlenet');
const XboxLauncher = require('./xbox');

const LAUNCHER_CLASSES = {
  steam: SteamLauncher,
  humble: HumbleLauncher,
  itchio: ItchioLauncher,
  gog: GOGLauncher,
  ea: EALauncher,
  ubisoft: UbisoftLauncher,
  epic: EpicLauncher,
  battlenet: BattlenetLauncher,
  xbox: XboxLauncher,
};

module.exports = { LAUNCHER_CLASSES };
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/launchers/index.js
git commit -m "feat: add launcher registry index"
```

---

### Task 11: Sync engine

**Files:**
- Create: `backend/src/services/syncEngine.js`
- Create: `backend/tests/services/syncEngine.test.js`

- [ ] **Step 1: Write sync engine tests**

Create `backend/tests/services/syncEngine.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Sync engine', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-sync-engine.db');
  let db;
  let syncLauncher, syncAll;

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

    // Insert a test launcher with encrypted credentials
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ api_key: 'test-key', steamid64: '123' }));
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('steam', 'Steam', creds);

    ({ syncLauncher, syncAll } = require('../../src/services/syncEngine'));
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('syncLauncher should create a sync_jobs row', async () => {
    // Mock Steam's fetchOwnedGames to return test data
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => ({
      data: { response: { games: [
        { appid: 440, name: 'TF2', playtime_forever: 100 },
      ]}}
    });

    try {
      const jobId = await syncLauncher('steam', db);
      assert.ok(jobId, 'Should return a job ID');

      const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'success');
      assert.equal(job.games_found, 1);
    } finally {
      axios.get = originalGet;
    }
  });

  it('syncLauncher should upsert game_editions', async () => {
    const editions = db.prepare(
      'SELECT * FROM game_editions WHERE launcher_game_id = ?'
    ).get('440');

    assert.ok(editions, 'Should have created a game_edition');
    assert.equal(editions.title, 'TF2');
    assert.equal(editions.playtime_minutes, 100);
    assert.equal(editions.owned, 1);
    assert.equal(editions.game_id, null);
  });

  it('syncLauncher should mark missing games as owned=0', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    // Return a different game — TF2 (440) is now "missing"
    axios.get = async () => ({
      data: { response: { games: [
        { appid: 570, name: 'Dota 2', playtime_forever: 200 },
      ]}}
    });

    try {
      await syncLauncher('steam', db);

      const tf2 = db.prepare('SELECT owned FROM game_editions WHERE launcher_game_id = ?').get('440');
      assert.equal(tf2.owned, 0, 'TF2 should be marked as not owned');

      const dota = db.prepare('SELECT owned FROM game_editions WHERE launcher_game_id = ?').get('570');
      assert.equal(dota.owned, 1, 'Dota 2 should be owned');
    } finally {
      axios.get = originalGet;
    }
  });

  it('syncLauncher should handle errors gracefully', async () => {
    // Insert a launcher with bad credentials
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ api_key: 'bad', steamid64: '0' }));
    db.prepare(
      'INSERT OR IGNORE INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', creds);

    const axios = require('axios');
    const originalPost = axios.post;
    axios.post = async () => { throw new Error('Auth failed'); };

    try {
      const jobId = await syncLauncher('gog', db);
      const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'failed');
      assert.ok(job.error_message.includes('Auth failed'));
    } finally {
      axios.post = originalPost;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && node --test tests/services/syncEngine.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Implement sync engine**

Create `backend/src/services/syncEngine.js`:

```javascript
const { decrypt } = require('../utils/encrypt');
const { LAUNCHER_CLASSES } = require('./launchers');

async function syncLauncher(launcherName, db) {
  const launcher = db.prepare('SELECT * FROM launchers WHERE name = ?').get(launcherName);

  if (!launcher) {
    throw new Error(`Launcher not found: ${launcherName}`);
  }

  if (!launcher.credentials_json) {
    throw new Error(`No credentials for launcher: ${launcherName}`);
  }

  // Create sync job
  const now = new Date().toISOString();
  const jobResult = db.prepare(
    'INSERT INTO sync_jobs (launcher_id, status, started_at) VALUES (?, ?, ?)'
  ).run(launcher.id, 'running', now);
  const jobId = Number(jobResult.lastInsertRowid);

  try {
    // Decrypt credentials
    const credentials = JSON.parse(decrypt(launcher.credentials_json));

    // Instantiate launcher class
    const LauncherClass = LAUNCHER_CLASSES[launcherName];
    if (!LauncherClass) {
      throw new Error(`No launcher implementation for: ${launcherName}`);
    }
    const instance = new LauncherClass(launcherName, db);

    // Authenticate and fetch games
    const session = await instance.refreshIfNeeded(credentials);
    const games = await instance.fetchOwnedGames(session);

    // Upsert game_editions
    const upsert = db.prepare(`
      INSERT INTO game_editions (launcher_id, launcher_game_id, title, playtime_minutes, owned)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(launcher_id, launcher_game_id) DO UPDATE SET
        title = excluded.title,
        playtime_minutes = excluded.playtime_minutes,
        owned = 1
    `);

    // Note: gamesUpdated counts rows touched by upsert, not rows with actual value changes.
    // SQLite reports changes=1 for ON CONFLICT DO UPDATE even if values are identical.
    let gamesUpdated = 0;
    const returnedIds = new Set();

    const upsertAll = db.transaction((items) => {
      for (const game of items) {
        returnedIds.add(game.launcher_game_id);
        const result = upsert.run(
          launcher.id,
          game.launcher_game_id,
          game.title,
          game.playtime_minutes
        );
        if (result.changes > 0) gamesUpdated++;
      }
    });
    upsertAll(games);

    // Mark missing games as owned=0 (soft removal).
    // Skip if no games returned — avoids accidentally marking everything as unowned
    // when the API returns empty due to an error or transient issue.
    if (returnedIds.size > 0) {
      const allEditions = db.prepare(
        'SELECT launcher_game_id FROM game_editions WHERE launcher_id = ? AND owned = 1'
      ).all(launcher.id);

      const markUnowned = db.prepare(
        'UPDATE game_editions SET owned = 0 WHERE launcher_id = ? AND launcher_game_id = ?'
      );

      const markAll = db.transaction((editions) => {
        for (const edition of editions) {
          if (!returnedIds.has(edition.launcher_game_id)) {
            markUnowned.run(launcher.id, edition.launcher_game_id);
          }
        }
      });
      markAll(allEditions);
    }

    // Update sync job to success
    const completedAt = new Date().toISOString();
    db.prepare(
      'UPDATE sync_jobs SET status = ?, completed_at = ?, games_found = ?, games_updated = ? WHERE id = ?'
    ).run('success', completedAt, games.length, gamesUpdated, jobId);

    // Update launcher last_sync_at
    db.prepare('UPDATE launchers SET last_sync_at = ? WHERE id = ?').run(completedAt, launcher.id);

    return jobId;
  } catch (err) {
    const completedAt = new Date().toISOString();
    db.prepare(
      'UPDATE sync_jobs SET status = ?, completed_at = ?, error_message = ? WHERE id = ?'
    ).run('failed', completedAt, err.message, jobId);
    console.error(`[Sync] ${launcherName} failed:`, err.message);
    return jobId;
  }
}

async function syncAll(db) {
  const launchers = db.prepare(
    'SELECT name FROM launchers WHERE enabled = 1 AND credentials_json IS NOT NULL'
  ).all();

  const succeeded = [];
  const failed = [];
  const skipped = [];

  for (const launcher of launchers) {
    const jobId = await syncLauncher(launcher.name, db);
    const job = db.prepare('SELECT status, games_found FROM sync_jobs WHERE id = ?').get(jobId);

    if (job.status === 'failed') {
      failed.push(launcher.name);
    } else if (job.games_found === 0) {
      skipped.push(launcher.name);
    } else {
      succeeded.push(launcher.name);
    }
  }

  return { succeeded, failed, skipped };
}

module.exports = { syncLauncher, syncAll };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && node --test tests/services/syncEngine.test.js`

Expected: All 4 tests PASS

- [ ] **Step 5: Run full backend test suite**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && npm test`

Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/syncEngine.js backend/tests/services/syncEngine.test.js
git commit -m "feat: add sync engine with upsert, soft removal, and job tracking"
```

---

### Task 12: Sync routes and scheduler

**Files:**
- Modify: `backend/src/routes/sync.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Replace sync.js stub with real routes**

Replace contents of `backend/src/routes/sync.js`:

```javascript
const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { syncLauncher, syncAll } = require('../services/syncEngine');

const router = Router();

router.use(authMiddleware);

// POST /api/sync/all
router.post('/all', (req, res) => {
  const db = req.app.locals.db;
  // Fire and forget — do not await
  syncAll(db).catch(err => console.error('[Sync] syncAll error:', err.message));
  res.json({ message: 'Gameshelf sync started' });
});

// GET /api/sync/status — MUST be defined before /:launcherName to avoid route conflicts
router.get('/status', (req, res) => {
  const db = req.app.locals.db;

  const jobs = db.prepare(`
    SELECT sj.*, l.name as launcher_name, l.display_name
    FROM sync_jobs sj
    JOIN launchers l ON l.id = sj.launcher_id
    WHERE sj.id IN (
      SELECT MAX(id) FROM sync_jobs GROUP BY launcher_id
    )
    ORDER BY l.priority ASC
  `).all();

  res.json(jobs);
});

// POST /api/sync/:launcherName — after static routes to avoid matching "status" as a launcherName
router.post('/:launcherName', (req, res) => {
  const db = req.app.locals.db;
  const { launcherName } = req.params;
  // Fire and forget
  syncLauncher(launcherName, db).catch(err =>
    console.error(`[Sync] ${launcherName} sync error:`, err.message)
  );
  res.json({ message: `Sync started for ${launcherName}` });
});

module.exports = router;
```

- [ ] **Step 2: Add cron scheduler to server.js**

In `backend/src/server.js`, add the cron import near the top (after line 25):

```javascript
const cron = require('node-cron');
const { syncAll } = require('./services/syncEngine');
```

Replace the `if (require.main === module)` block (lines 67-71) with:

```javascript
if (require.main === module) {
  cron.schedule('0 */6 * * *', () => {
    console.log('[Gameshelf Scheduler] Starting 6-hour library sync');
    syncAll(db).catch(err => console.error('[Scheduler] syncAll error:', err.message));
  });

  app.listen(PORT, () => {
    console.log(`Gameshelf server running on port ${PORT}`);
  });
}
```

- [ ] **Step 3: Run full backend test suite**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && npm test`

Expected: All tests pass

- [ ] **Step 4: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/sync.js backend/src/server.js
git commit -m "feat: add sync routes and 6-hour cron scheduler"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run full backend test suite**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/backend && npm test`

Expected: All tests PASS

- [ ] **Step 2: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/.worktrees/phase3/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 3: Verify all files exist**

```bash
for f in \
  backend/src/services/launchers/base.js \
  backend/src/services/launchers/steam.js \
  backend/src/services/launchers/humble.js \
  backend/src/services/launchers/itchio.js \
  backend/src/services/launchers/gog.js \
  backend/src/services/launchers/ea.js \
  backend/src/services/launchers/ubisoft.js \
  backend/src/services/launchers/epic.js \
  backend/src/services/launchers/battlenet.js \
  backend/src/services/launchers/xbox.js \
  backend/src/services/launchers/index.js \
  backend/src/services/syncEngine.js; do
  [ -f "$f" ] && echo "OK $f" || echo "MISSING $f"
done
```

Expected: All 12 files OK

- [ ] **Step 4: Confirm task completion**

- Task 1: Steam integration ✓
- Task 2: Humble Bundle integration ✓
- Task 3: itch.io integration ✓
- Task 4: GOG integration ✓
- Task 5: EA, Ubisoft, Epic stubs ✓
- Task 6: Battle.net, Xbox stubs ✓
- Task 7: Sync engine ✓
- Task 8: Sync routes and scheduler ✓
