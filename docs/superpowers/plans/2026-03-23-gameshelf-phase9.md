# Phase 9: IGDB Hardening, SteamGridDB Fallback & Coming Soon Launchers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make metadata enrichment robust (exponential backoff, OAuth error handling), add SteamGridDB as image fallback, and mark unimplemented launchers as Coming Soon.

**Architecture:** Harden `igdbClient.js` error handling. New `steamgriddbClient.js` for image fallback. Modify enrichment pipeline to use SteamGridDB when IGDB has no images. Update launcher list with `implemented` field and guard the UI.

**Tech Stack:** Express.js, better-sqlite3, axios, node-steamgriddb, React

**Spec:** `docs/superpowers/specs/2026-03-23-gameshelf-phase9-design.md`

---

### Task 1: Harden IGDB client

**Files:**
- Modify: `backend/src/services/metadata/igdbClient.js`

- [ ] **Step 1: Rewrite igdbClient.js with hardened error handling**

Replace the entire contents of `backend/src/services/metadata/igdbClient.js`:

```js
const axios = require('axios');

const IGDB_FIELDS = 'id,name,summary,cover.url,artworks.url,genres.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,first_release_date';

let cachedToken = null;
let tokenExpiresAt = 0;

function getCredentials() {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('[IGDB] IGDB_CLIENT_ID or IGDB_CLIENT_SECRET not set. Metadata enrichment disabled.');
    return null;
  }
  return { clientId, clientSecret };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function authenticate() {
  const creds = getCredentials();
  if (!creds) return null;

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  try {
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: 'client_credentials',
      },
    });

    cachedToken = res.data.access_token;
    tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
    return cachedToken;
  } catch (err) {
    console.error('[IGDB] OAuth token refresh failed:', err.message);
    cachedToken = null;
    tokenExpiresAt = 0;
    return null;
  }
}

async function igdbRequest(body) {
  const creds = getCredentials();
  if (!creds) return null;

  const token = await authenticate();
  if (!token) return null;

  const config = {
    method: 'post',
    url: 'https://api.igdb.com/v4/games',
    headers: {
      'Client-ID': creds.clientId,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    data: body,
  };

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios(config);
      return res.data;
    } catch (err) {
      const status = err.response?.status;

      // 401: token expired mid-batch — clear and re-auth once
      if (status === 401 && attempt === 1) {
        console.warn('[IGDB] Got 401, re-authenticating...');
        cachedToken = null;
        tokenExpiresAt = 0;
        const newToken = await authenticate();
        if (newToken) {
          config.headers['Authorization'] = `Bearer ${newToken}`;
          continue;
        }
        console.error('[IGDB] Re-authentication failed');
        return null;
      }

      // 429: rate limited — exponential backoff
      if (status === 429) {
        const retryAfter = err.response?.headers?.['retry-after'];
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt) * 1000;
        console.warn(`[IGDB] Rate limited (429), retry ${attempt}/${maxRetries} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      // Other errors: log and return null
      console.error(`[IGDB] Request failed (attempt ${attempt}/${maxRetries}):`, err.message);
      return null;
    }
  }

  console.error('[IGDB] All retries exhausted');
  return null;
}

async function search(title) {
  const escapedTitle = title.replace(/"/g, '\\"');
  const body = `search "${escapedTitle}"; fields ${IGDB_FIELDS}; limit 5;`;
  return igdbRequest(body);
}

async function getById(igdbId) {
  const body = `where id = ${igdbId}; fields ${IGDB_FIELDS}; limit 1;`;
  const results = await igdbRequest(body);
  return results && results.length > 0 ? results[0] : null;
}

module.exports = { search, getById };
```

- [ ] **Step 2: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS (no tests directly test igdbClient — they run without IGDB credentials)

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/metadata/igdbClient.js
git commit -m "feat: harden IGDB client with exponential backoff, OAuth error handling, 401 re-auth"
```

---

### Task 2: Install steamgriddb and create client

**Files:**
- Create: `backend/src/services/metadata/steamgriddbClient.js`
- Modify: `backend/package.json` (npm install)

- [ ] **Step 1: Install the dependency**

Run: `cd backend && npm install steamgriddb`

- [ ] **Step 2: Create steamgriddbClient.js**

Create `backend/src/services/metadata/steamgriddbClient.js`:

```js
const SGDB = require('steamgriddb');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getClient() {
  const apiKey = process.env.STEAMGRIDDB_API_KEY;
  if (!apiKey) return null;
  return new SGDB(apiKey);
}

async function searchGame(title) {
  const client = getClient();
  if (!client) return null;

  try {
    const results = await client.searchGame(title);
    return results || null;
  } catch (err) {
    console.error('[SteamGridDB] Search failed:', err.message);
    return null;
  }
}

async function getImages(sgdbGameId) {
  const client = getClient();
  if (!client) return { coverUrl: null, heroUrl: null };

  let coverUrl = null;
  let heroUrl = null;

  // Get cover (grid) image
  try {
    const grids = await client.getGridsById(sgdbGameId);
    if (grids && grids.length > 0) {
      coverUrl = grids[0].url;
    }
  } catch (err) {
    console.warn('[SteamGridDB] Grid fetch failed:', err.message);
  }

  await sleep(500);

  // Get hero image
  try {
    const heroes = await client.getHeroesById(sgdbGameId);
    if (heroes && heroes.length > 0) {
      heroUrl = heroes[0].url;
    }
  } catch (err) {
    console.warn('[SteamGridDB] Hero fetch failed:', err.message);
  }

  return { coverUrl, heroUrl };
}

module.exports = { searchGame, getImages };
```

- [ ] **Step 3: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/metadata/steamgriddbClient.js backend/package.json backend/package-lock.json
git commit -m "feat: add SteamGridDB client for image fallback"
```

---

### Task 3: Integrate SteamGridDB fallback into enrichment pipeline

**Files:**
- Modify: `backend/src/services/metadata/enrichGame.js:1-4` (imports), `:74-99` (enrichGame images), `:183-207` (enrichUnderEnriched images)

- [ ] **Step 1: Add import**

In `backend/src/services/metadata/enrichGame.js`, add after line 3 (after the cacheImage import):

```js
const steamgriddbClient = require('./steamgriddbClient');
```

- [ ] **Step 2: Replace the image download section in `enrichGame()`**

Replace lines 74-99 (the image download try/catch block in `enrichGame`):

```js
  // Download and cache images (only if URLs exist)
  try {
    const coverUrl = match.cover?.url || null;
    const artworkUrl = match.artworks?.[0]?.url || null;

    if (coverUrl) {
      const coverPath = await cacheImage(coverUrl, gameId, 'cover');
      if (coverPath) {
        db.prepare('UPDATE games SET cover_url = ? WHERE id = ?').run(coverPath, gameId);
        // Copy cover as icon
        const iconPath = await cacheImage(coverUrl, gameId, 'icon');
        if (iconPath) {
          db.prepare('UPDATE games SET icon_url = ? WHERE id = ?').run(iconPath, gameId);
        }
      }
    }

    if (artworkUrl) {
      const heroPath = await cacheImage(artworkUrl, gameId, 'hero');
      if (heroPath) {
        db.prepare('UPDATE games SET hero_url = ? WHERE id = ?').run(heroPath, gameId);
      }
    }
  } catch (err) {
    console.warn(`[Gameshelf Metadata] Image download failed for ${gameTitle}: ${err.message}`);
  }
```

With:

```js
  // Download and cache images
  let coverUrl = match.cover?.url || null;
  let artworkUrl = match.artworks?.[0]?.url || null;

  // SteamGridDB fallback if IGDB has no images
  if (!coverUrl || !artworkUrl) {
    try {
      const sgdbResults = await steamgriddbClient.searchGame(gameTitle);
      const sgdbMatch = sgdbResults ? findBestMatch(gameTitle, sgdbResults) : null;
      if (sgdbMatch) {
        const sgdbImages = await steamgriddbClient.getImages(sgdbMatch.id);
        if (!coverUrl && sgdbImages?.coverUrl) coverUrl = sgdbImages.coverUrl;
        if (!artworkUrl && sgdbImages?.heroUrl) artworkUrl = sgdbImages.heroUrl;
      }
    } catch (err) {
      console.warn(`[Gameshelf Metadata] SteamGridDB fallback failed for ${gameTitle}: ${err.message}`);
    }
  }

  // Cache cover image
  try {
    if (coverUrl) {
      const coverPath = await cacheImage(coverUrl, gameId, 'cover');
      if (coverPath) {
        db.prepare('UPDATE games SET cover_url = ? WHERE id = ?').run(coverPath, gameId);
        const iconPath = await cacheImage(coverUrl, gameId, 'icon');
        if (iconPath) {
          db.prepare('UPDATE games SET icon_url = ? WHERE id = ?').run(iconPath, gameId);
        }
      }
    }
  } catch (err) {
    console.warn(`[Gameshelf Metadata] Cover download failed for ${gameTitle}: ${err.message}`);
  }

  // Cache hero image
  try {
    if (artworkUrl) {
      const heroPath = await cacheImage(artworkUrl, gameId, 'hero');
      if (heroPath) {
        db.prepare('UPDATE games SET hero_url = ? WHERE id = ?').run(heroPath, gameId);
      }
    }
  } catch (err) {
    console.warn(`[Gameshelf Metadata] Hero download failed for ${gameTitle}: ${err.message}`);
  }
```

- [ ] **Step 3: Replace the image download section in `enrichUnderEnriched()`**

Replace lines 183-207 (the image download try/catch block in `enrichUnderEnriched`):

```js
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
```

With:

```js
      // Download and cache images
      let coverUrl = match.cover?.url || null;
      let artworkUrl = match.artworks?.[0]?.url || null;

      // SteamGridDB fallback if IGDB has no images
      if (!coverUrl || !artworkUrl) {
        try {
          const sgdbResults = await steamgriddbClient.searchGame(game.title);
          const sgdbMatch = sgdbResults ? findBestMatch(game.title, sgdbResults) : null;
          if (sgdbMatch) {
            const sgdbImages = await steamgriddbClient.getImages(sgdbMatch.id);
            if (!coverUrl && sgdbImages?.coverUrl) coverUrl = sgdbImages.coverUrl;
            if (!artworkUrl && sgdbImages?.heroUrl) artworkUrl = sgdbImages.heroUrl;
          }
        } catch (err) {
          console.warn(`[Gameshelf Metadata] SteamGridDB fallback failed for ${game.title}: ${err.message}`);
        }
      }

      // Cache cover image
      try {
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
      } catch (err) {
        console.warn(`[Gameshelf Metadata] Re-enrich cover download failed for ${game.title}: ${err.message}`);
      }

      // Cache hero image
      try {
        if (artworkUrl) {
          const heroPath = await cacheImage(artworkUrl, game.id, 'hero');
          if (heroPath) {
            db.prepare('UPDATE games SET hero_url = ? WHERE id = ?').run(heroPath, game.id);
          }
        }
      } catch (err) {
        console.warn(`[Gameshelf Metadata] Re-enrich hero download failed for ${game.title}: ${err.message}`);
      }
```

- [ ] **Step 4: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/metadata/enrichGame.js
git commit -m "feat: integrate SteamGridDB as image fallback in enrichment pipeline"
```

---

### Task 4: Update .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add SteamGridDB API key**

Add after the IGDB lines in `.env.example`:

```
STEAMGRIDDB_API_KEY=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "chore: add STEAMGRIDDB_API_KEY to .env.example"
```

---

### Task 5: Mark unimplemented launchers as Coming Soon

**Files:**
- Modify: `backend/src/routes/launchers.js:11-21` (AVAILABLE_LAUNCHERS), `:42-44` (credentials guard)
- Modify: `frontend/src/pages/Settings.jsx:40-85` (LaunchersTab)

- [ ] **Step 1: Add `implemented` field to AVAILABLE_LAUNCHERS**

In `backend/src/routes/launchers.js`, replace lines 11-21:

```js
const AVAILABLE_LAUNCHERS = [
  { id: 'steam', display_name: 'Steam', auth_type: 'api_key', otp_supported: false, qr_supported: false },
  { id: 'ea', display_name: 'EA App', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'epic', display_name: 'Epic Games', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'humble', display_name: 'Humble Bundle', auth_type: 'credentials', otp_supported: false, qr_supported: false },
  { id: 'itchio', display_name: 'itch.io', auth_type: 'api_key', otp_supported: false, qr_supported: false },
  { id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: false, qr_supported: false },
  { id: 'battlenet', display_name: 'Battle.net', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'xbox', display_name: 'Xbox / Microsoft', auth_type: 'credentials', otp_supported: false, qr_supported: false },
];
```

With:

```js
const AVAILABLE_LAUNCHERS = [
  { id: 'steam', display_name: 'Steam', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'ea', display_name: 'EA App', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'epic', display_name: 'Epic Games', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'humble', display_name: 'Humble Bundle', auth_type: 'credentials', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'itchio', display_name: 'itch.io', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'battlenet', display_name: 'Battle.net', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'xbox', display_name: 'Xbox / Microsoft', auth_type: 'credentials', otp_supported: false, qr_supported: false, implemented: false },
];
```

- [ ] **Step 2: Guard credentials endpoint for unimplemented launchers**

In `backend/src/routes/launchers.js`, in the `POST /:id/credentials` handler, add after the `if (!launcher)` check (after line 46):

```js
  if (!launcher.implemented) {
    return res.status(400).json({ error: 'This launcher is not yet implemented' });
  }
```

- [ ] **Step 3: Update frontend LaunchersTab**

In `frontend/src/pages/Settings.jsx`, replace the launcher row rendering (lines 42-84):

```jsx
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
            {l.configured ? (
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
            ) : (
              <button
                onClick={() => navigate('/setup')}
                className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
              >
                Configure
              </button>
            )}
          </div>
```

With:

```jsx
          <div key={l.id} className={`bg-gray-800 rounded-lg p-4 flex items-center justify-between ${!l.implemented ? 'opacity-50' : ''}`}>
            <div className="flex items-center gap-3">
              <LauncherBadge launcherName={l.id} displayName={l.display_name} primary />
              <div>
                <div className="text-sm text-white">{l.display_name}</div>
                <div className="text-xs text-gray-500">
                  {!l.implemented
                    ? 'Coming Soon'
                    : l.configured
                      ? (status?.completed_at ? `Last synced: ${new Date(status.completed_at).toLocaleString()}` : 'Configured — never synced')
                      : 'Not configured'}
                  {status?.status && l.configured && l.implemented && (
                    <span className={`ml-2 ${status.status === 'success' ? 'text-green-400' : status.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}`}>
                      ({status.status})
                    </span>
                  )}
                </div>
              </div>
            </div>
            {!l.implemented ? (
              <span className="text-xs text-gray-500 bg-gray-700 px-2.5 py-1 rounded-full">Coming Soon</span>
            ) : l.configured ? (
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
            ) : (
              <button
                onClick={() => navigate('/setup')}
                className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
              >
                Configure
              </button>
            )}
          </div>
```

- [ ] **Step 4: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 5: Build frontend**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/launchers.js frontend/src/pages/Settings.jsx
git commit -m "feat: mark unimplemented launchers as Coming Soon"
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

Update version in `backend/package.json` and `frontend/package.json` from `1.3.0` to `1.4.0`.

- [ ] **Step 4: Commit and push**

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: bump version to 1.4.0 for Phase 9"
git push origin master
```

- [ ] **Step 5: Manual verification**

1. Add `STEAMGRIDDB_API_KEY=your_key` to `.env` on server
2. Deploy: `docker compose down && git pull origin master && docker compose build && docker compose up -d`
3. Settings → Metadata → Click "Re-enrich All"
4. Check backend logs for `[IGDB]` retry messages and `[SteamGridDB]` fallback messages
5. Verify games that previously had no artwork now get covers from SteamGridDB
6. Settings → Launchers: verify Epic, EA, Ubisoft, Battle.net, Xbox show "Coming Soon"
7. Verify implemented launchers (Steam, GOG, Humble, itch.io) still show Configure/Sync/Remove as appropriate
