# Phase 10: Epic Games & Xbox Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Epic Games Store (OAuth auth code + rolling token refresh) and Xbox (OpenXBL API key) launcher integrations.

**Architecture:** Replace Epic and Xbox stubs with full BaseLauncher implementations. Modify syncEngine to persist refreshed credentials (Epic tokens). Add `auth_code` credential type to the route handler and Setup page frontend. Update AVAILABLE_LAUNCHERS to mark both as implemented.

**Tech Stack:** Express.js, better-sqlite3, axios, React

**Spec:** `docs/superpowers/specs/2026-03-23-gameshelf-phase10-design.md`

---

### Task 1: Modify syncEngine to support credential persistence

**Files:**
- Modify: `backend/src/services/syncEngine.js:34-36`

- [ ] **Step 1: Update syncEngine to persist updated credentials**

In `backend/src/services/syncEngine.js`, replace lines 34-36:

```js
    // Authenticate and fetch games
    const session = await instance.refreshIfNeeded(credentials);
    const games = await instance.fetchOwnedGames(session);
```

With:

```js
    // Authenticate and fetch games
    let session = await instance.refreshIfNeeded(credentials);

    // If launcher returned updated credentials (e.g. Epic token refresh), persist them
    if (session && session.updatedCredentials) {
      const { encrypt } = require('../utils/encrypt');
      const encrypted = encrypt(JSON.stringify(session.updatedCredentials));
      db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(encrypted, launcherName);
      session = session.session;
    }

    const games = await instance.fetchOwnedGames(session);
```

- [ ] **Step 2: Run all tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS (existing launchers return null/string for session, which has no `updatedCredentials` property)

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/syncEngine.js
git commit -m "feat: syncEngine persists updated credentials from refreshIfNeeded"
```

---

### Task 2: Implement Epic Games launcher

**Files:**
- Rewrite: `backend/src/services/launchers/epic.js`

- [ ] **Step 1: Implement EpicLauncher**

Replace the entire contents of `backend/src/services/launchers/epic.js`:

```js
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Epic Games Store integration using OAuth authorization code flow.
 *
 * Auth flow: User logs in at Epic's website, gets a one-time auth code,
 * pastes it into Gameshelf. We exchange it for access + refresh tokens.
 * Tokens are refreshed automatically on each sync cycle (rolling 8h window).
 *
 * Credentials shape (after initial auth):
 * { access_token, refresh_token, expires_at, refresh_expires_at, account_id }
 */

const EPIC_CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const EPIC_CLIENT_SECRET = '9209d4a5e25a457fb9b07489d313b41a';
const EPIC_TOKEN_URL = 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token';
const EPIC_LIBRARY_URL = 'https://library-service.live.use1a.on.epicgames.com/library/api/public/items';
const EPIC_PLAYTIME_URL = 'https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account';

const EPIC_AUTH_HEADER = 'Basic ' + Buffer.from(`${EPIC_CLIENT_ID}:${EPIC_CLIENT_SECRET}`).toString('base64');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class EpicLauncher extends BaseLauncher {
  /**
   * Exchange a one-time authorization code for tokens.
   * Called once from the credentials endpoint during initial setup.
   */
  async authenticate(credentials) {
    const { auth_code } = credentials;

    const res = await axios.post(EPIC_TOKEN_URL, new URLSearchParams({
      grant_type: 'authorization_code',
      code: auth_code,
    }).toString(), {
      headers: {
        'Authorization': EPIC_AUTH_HEADER,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const data = res.data;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      refresh_expires_at: data.refresh_expires_at,
      account_id: data.account_id,
    };
  }

  /**
   * Check token expiry and refresh if needed.
   * Does NOT call authenticate() — uses refresh_token grant instead.
   * Returns { session, updatedCredentials } for syncEngine to persist.
   */
  async refreshIfNeeded(credentials) {
    const { access_token, refresh_token, expires_at, account_id } = credentials;

    const session = { access_token, account_id };

    // Check if access token is still valid (with 60s buffer)
    const expiresAt = new Date(expires_at).getTime();
    if (Date.now() < expiresAt - 60000) {
      return { session, updatedCredentials: null };
    }

    // Access token expired — refresh it
    console.log('[Epic] Access token expired, refreshing...');
    try {
      const res = await axios.post(EPIC_TOKEN_URL, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
      }).toString(), {
        headers: {
          'Authorization': EPIC_AUTH_HEADER,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const data = res.data;
      const updatedCredentials = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        refresh_expires_at: data.refresh_expires_at,
        account_id: data.account_id,
      };

      console.log('[Epic] Token refreshed successfully');
      return {
        session: { access_token: data.access_token, account_id: data.account_id },
        updatedCredentials,
      };
    } catch (err) {
      console.error('[Epic] Token refresh failed:', err.message);
      throw new Error('Epic authentication expired. Please re-authenticate.');
    }
  }

  async fetchOwnedGames(session) {
    const { access_token, account_id } = session;
    const headers = { Authorization: `Bearer ${access_token}` };

    // Fetch library items (paginated)
    let allItems = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const params = { includeMetadata: true };
      if (cursor) params.cursor = cursor;

      try {
        const res = await axios.get(EPIC_LIBRARY_URL, { headers, params });
        const records = res.data?.records || res.data?.responseMetadata ? res.data.records : (res.data || []);

        if (Array.isArray(records)) {
          allItems.push(...records);
        }

        // Check for pagination
        cursor = res.data?.responseMetadata?.nextCursor || null;
        hasMore = !!cursor;
      } catch (err) {
        console.error('[Epic] Library fetch failed:', err.message);
        hasMore = false;
      }

      await sleep(500);
    }

    // Fetch playtime
    let playtimeMap = {};
    try {
      const ptRes = await axios.get(`${EPIC_PLAYTIME_URL}/${account_id}/all`, { headers });
      const playtimes = Array.isArray(ptRes.data) ? ptRes.data : [];
      for (const pt of playtimes) {
        if (pt.artifactId) {
          playtimeMap[pt.artifactId] = Math.round((pt.totalTime || 0) / 60);
        }
      }
    } catch (err) {
      console.warn('[Epic] Playtime fetch failed:', err.message);
    }

    // Map to game format
    return allItems
      .filter(item => item.appName || item.catalogItemId)
      .map(item => {
        const id = item.appName || item.catalogItemId;
        return {
          launcher_game_id: id,
          title: item.appTitle || item.catalogItemTitle || id,
          playtime_minutes: playtimeMap[id] || 0,
        };
      });
  }
}

module.exports = EpicLauncher;
```

- [ ] **Step 2: Run all tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/launchers/epic.js
git commit -m "feat: implement Epic Games Store launcher with OAuth and library retrieval"
```

---

### Task 3: Implement Xbox launcher

**Files:**
- Rewrite: `backend/src/services/launchers/xbox.js`

- [ ] **Step 1: Implement XboxLauncher**

Replace the entire contents of `backend/src/services/launchers/xbox.js`:

```js
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Xbox / Microsoft integration using OpenXBL API.
 *
 * Users get a free API key from https://xbl.io (requires Xbox Live account).
 * The API key is permanent and does not expire.
 *
 * Credentials shape: { api_key: string }
 */

const OPENXBL_BASE = 'https://xbl.io/api/v2';

class XboxLauncher extends BaseLauncher {
  async authenticate(credentials) {
    this.credentials = credentials;
    return null;
  }

  async refreshIfNeeded(credentials) {
    this.credentials = credentials;
    return null;
  }

  async fetchOwnedGames(session) {
    const { api_key } = this.credentials;

    const headers = {
      'X-Authorization': api_key,
      'Accept': 'application/json',
    };

    try {
      const res = await axios.get(`${OPENXBL_BASE}/player/titleHistory`, { headers });
      const titles = res.data?.titles || [];

      return titles
        .filter(t => t.titleId && t.name)
        .map(t => ({
          launcher_game_id: t.titleId.toString(),
          title: t.name,
          playtime_minutes: t.minutesPlayed || 0,
        }));
    } catch (err) {
      console.error('[Xbox] Title history fetch failed:', err.message);
      throw err;
    }
  }
}

module.exports = XboxLauncher;
```

- [ ] **Step 2: Run all tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/launchers/xbox.js
git commit -m "feat: implement Xbox launcher with OpenXBL API"
```

---

### Task 4: Update AVAILABLE_LAUNCHERS and credentials endpoint

**Files:**
- Modify: `backend/src/routes/launchers.js:11-21` (AVAILABLE_LAUNCHERS), `:42-94` (credentials handler)

- [ ] **Step 1: Update AVAILABLE_LAUNCHERS**

In `backend/src/routes/launchers.js`, replace the AVAILABLE_LAUNCHERS array:

```js
const AVAILABLE_LAUNCHERS = [
  { id: 'steam', display_name: 'Steam', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'ea', display_name: 'EA App', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'epic', display_name: 'Epic Games', auth_type: 'auth_code', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'humble', display_name: 'Humble Bundle', auth_type: 'credentials', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'itchio', display_name: 'itch.io', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'battlenet', display_name: 'Battle.net', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'xbox', display_name: 'Xbox / Microsoft', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
];
```

- [ ] **Step 2: Update credentials endpoint to handle auth_code type**

Replace the entire `POST /:id/credentials` handler:

```js
// POST /api/launchers/:id/credentials
router.post('/:id/credentials', async (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  if (!launcher.implemented) {
    return res.status(400).json({ error: 'This launcher is not yet implemented' });
  }

  const { username, password, api_key, steamid64, totp_secret, auth_code } = req.body || {};

  // Validate required fields by auth_type
  if (launcher.auth_type === 'api_key') {
    if (!api_key) {
      return res.status(400).json({ error: 'api_key is required for this launcher' });
    }
  } else if (launcher.auth_type === 'auth_code') {
    if (!auth_code) {
      return res.status(400).json({ error: 'auth_code is required for this launcher' });
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

  let payload;

  if (launcher.auth_type === 'auth_code') {
    // Exchange auth code for tokens via the launcher class
    try {
      const { LAUNCHER_CLASSES } = require('../services/launchers');
      const LauncherClass = LAUNCHER_CLASSES[id];
      const instance = new LauncherClass(id, null);
      payload = await instance.authenticate({ auth_code });
    } catch (err) {
      return res.status(400).json({ error: `Authentication failed: ${err.message}` });
    }
  } else {
    payload = {};
    if (username) payload.username = username;
    if (password) payload.password = password;
    if (api_key) payload.api_key = api_key;
    if (steamid64) payload.steamid64 = steamid64;
    if (totp_secret) payload.totp_secret = totp_secret;
  }

  const encryptedCredentials = encrypt(JSON.stringify(payload));

  const db = req.app.locals.db;

  // Upsert: insert or update by name
  db.prepare(`
    INSERT INTO launchers (name, display_name, enabled, credentials_json)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(name) DO UPDATE SET
      credentials_json = excluded.credentials_json,
      enabled = 1
  `).run(id, launcher.display_name, encryptedCredentials);

  res.json({ ok: true });
});
```

- [ ] **Step 3: Run all tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/launchers.js
git commit -m "feat: update launcher config for Epic and Xbox, add auth_code credential handling"
```

---

### Task 5: Frontend — Setup page auth_code support

**Files:**
- Modify: `frontend/src/pages/Setup.jsx:111-131` (launcher grid), `:236-276` (credential forms)

- [ ] **Step 1: Filter unimplemented launchers from Setup grid**

In `frontend/src/pages/Setup.jsx`, replace line 112:

```jsx
            {availableLaunchers.map((launcher) => {
```

With:

```jsx
            {availableLaunchers.filter(l => l.implemented).map((launcher) => {
```

- [ ] **Step 2: Update the auth type label in the launcher grid**

Replace line 126:

```jsx
                    {launcher.auth_type === 'api_key' ? 'API Key' : 'Username/Password'}
```

With:

```jsx
                    {launcher.auth_type === 'api_key' ? 'API Key' : launcher.auth_type === 'auth_code' ? 'Browser Login' : 'Username/Password'}
```

- [ ] **Step 3: Add auth_code credential form**

In the Step 3 credential form section, after the `showApiKey` block (after line 276), add a new block for auth_code. Replace the section that starts with `{showCredentials && (` through the `showApiKey` block with:

Find the existing credential form logic and add the auth_code block. After the closing `)}` of the `showApiKey` block and before the Steam-specific `steamid64` block, add:

```jsx
                  {launcher.auth_type === 'auth_code' && (
                    <div className="mb-3">
                      <p className="text-sm text-gray-400 mb-2">
                        1. Click the link below and log in to your Epic Games account
                      </p>
                      <a
                        href="https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect%3FclientId%3D34a02cf8f4414e29b15921876da36f9a%26responseType%3Dcode"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-sm underline block mb-3"
                      >
                        Open Epic Games Login
                      </a>
                      <p className="text-sm text-gray-400 mb-2">
                        2. After logging in, copy the &quot;authorizationCode&quot; value and paste it below
                      </p>
                      <label className="block text-sm text-gray-300 mb-1">Authorization Code</label>
                      <input
                        type="text"
                        value={creds.auth_code || ''}
                        onChange={(e) => updateField(launcher.id, 'auth_code', e.target.value)}
                        placeholder="Paste code here..."
                        className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}
```

Also update the `showCredentials` and `showApiKey` logic to exclude auth_code. Find lines 236-237:

```jsx
              const showCredentials = launcher.auth_type.includes('credentials');
              const showApiKey = launcher.auth_type === 'api_key';
```

These already work correctly — `auth_code` doesn't include 'credentials' and isn't 'api_key', so neither block shows for Epic.

- [ ] **Step 4: Verify frontend builds**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Setup.jsx
git commit -m "feat: add auth_code support to Setup page for Epic Games"
```

---

### Task 6: Version bump and deploy

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 2: Build frontend**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 3: Version bump**

Update version in `backend/package.json` and `frontend/package.json` from `1.4.1` to `1.5.0`.

- [ ] **Step 4: Commit and push**

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: bump version to 1.5.0 for Phase 10"
git push origin master
```

- [ ] **Step 5: Manual verification**

1. Deploy: `docker compose down && git pull origin master && docker compose build --no-cache && docker compose up -d`
2. Settings → Launchers: verify Epic shows "Not configured" with Configure button (not "Coming Soon")
3. Settings → Launchers: verify Xbox shows "Not configured" with Configure button
4. Settings → Launchers: verify EA, Ubisoft, Battle.net still show "Coming Soon"
5. Click Configure on Epic → redirected to Setup → see "Open Epic Games Login" link + code input
6. Click Configure on Xbox → see API Key input field
7. For Epic: open the login link, authenticate, copy code, paste and save
8. For Xbox: enter OpenXBL API key and save
9. Sync both launchers → verify games appear in Library
10. Wait for next auto-sync (or trigger manually) → verify Epic token refresh works (check logs for `[Epic] Token refreshed successfully`)
