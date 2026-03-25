# GOG Auth Code Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GOG's broken browser-based OAuth login with an auth_code flow where the user logs in via their own browser and pastes the authorization code.

**Architecture:** Change GOG to `auth_type: 'auth_code'` matching Epic's pattern. Rewrite `gog.js` to exchange an auth code for tokens and refresh them. Make Setup.jsx's auth_code UI launcher-aware instead of Epic-specific. Remove unused `tough-cookie`/`axios-cookiejar-support` deps.

**Tech Stack:** React (frontend), Express/SQLite (backend), axios

---

### Task 1: Backend — Rewrite GOG Launcher

**Files:**
- Modify: `backend/src/services/launchers/gog.js`

- [ ] **Step 1: Replace gog.js with auth_code implementation**

Replace the entire contents of `backend/src/services/launchers/gog.js`:

```javascript
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * GOG integration using OAuth authorization code flow.
 *
 * Auth flow: User logs in at GOG's website in their browser (handling CAPTCHA
 * and 2FA themselves), gets redirected to a page with a code in the URL,
 * pastes it into GameShelf. We exchange it for access + refresh tokens.
 *
 * Credentials shape (after initial auth):
 * { access_token, refresh_token }
 */

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class GOGLauncher extends BaseLauncher {
  /**
   * Exchange a one-time authorization code for tokens.
   * Called once from the credentials endpoint during initial setup.
   * Returns flat credentials object (stored directly as encrypted credentials).
   */
  async authenticate(credentials) {
    const { auth_code } = credentials;

    const tokenRes = await axios.get('https://auth.gog.com/token', {
      params: {
        client_id: GOG_CLIENT_ID,
        client_secret: GOG_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: auth_code,
        redirect_uri: GOG_REDIRECT_URI,
      },
    });

    return {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
    };
  }

  /**
   * Refresh the access token using the stored refresh token.
   * Does NOT fall back to authenticate() — there's no auth_code in stored credentials.
   * Returns { session, updatedCredentials } for syncEngine to persist.
   */
  async refreshIfNeeded(credentials) {
    if (!credentials.refresh_token) {
      throw new Error('GOG credentials need to be reconfigured. Please remove GOG and re-add it in Setup.');
    }

    try {
      const tokenRes = await axios.get('https://auth.gog.com/token', {
        params: {
          client_id: GOG_CLIENT_ID,
          client_secret: GOG_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: credentials.refresh_token,
        },
      });

      const { access_token, refresh_token } = tokenRes.data;

      return {
        session: access_token,
        updatedCredentials: { access_token, refresh_token },
      };
    } catch (err) {
      throw new Error('GOG refresh token expired. Please remove GOG and re-add it in Setup.');
    }
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
git commit -m "feat: rewrite GOG launcher to use auth_code flow"
```

---

### Task 2: Backend — Config and Dependency Cleanup

**Files:**
- Modify: `backend/src/routes/launchers.js:18`
- Modify: `backend/package.json`

- [ ] **Step 1: Change GOG auth_type to auth_code**

In `backend/src/routes/launchers.js`, find the GOG entry:

```javascript
  { id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: true, qr_supported: false, implemented: true, otp_instruction: 'Enter the code from your authenticator app' },
```

Replace with:
```javascript
  { id: 'gog', display_name: 'GOG', auth_type: 'auth_code', otp_supported: false, qr_supported: false, implemented: true },
```

- [ ] **Step 2: Remove tough-cookie and axios-cookiejar-support**

```bash
cd backend && npm uninstall tough-cookie axios-cookiejar-support
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/launchers.js backend/package.json backend/package-lock.json
git commit -m "feat: switch GOG to auth_code type, remove unused cookie deps"
```

---

### Task 3: Frontend — Launcher-Aware Auth Code UI

**Files:**
- Modify: `frontend/src/pages/Setup.jsx:278-302`

- [ ] **Step 1: Replace the hardcoded Epic auth_code block with launcher-aware config**

In `frontend/src/pages/Setup.jsx`, find the `auth_code` UI block (lines 278-302):

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

Replace with:
```jsx
                  {launcher.auth_type === 'auth_code' && (() => {
                    const authCodeConfig = {
                      epic: {
                        url: 'https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect%3FclientId%3D34a02cf8f4414e29b15921876da36f9a%26responseType%3Dcode',
                        linkText: 'Open Epic Games Login',
                        step1: 'Click the link below and log in to your Epic Games account',
                        step2: 'After logging in, copy the "authorizationCode" value and paste it below',
                      },
                      gog: {
                        url: 'https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=client2',
                        linkText: 'Open GOG Login',
                        step1: 'Click the link below and log in to your GOG account',
                        step2: 'After logging in, you will be redirected to a page that may appear blank. Copy the "code" value from your browser\'s address bar and paste it below',
                      },
                    };
                    const config = authCodeConfig[launcher.id] || {
                      url: '#',
                      linkText: `Open ${launcher.display_name} Login`,
                      step1: `Click the link below and log in to your ${launcher.display_name} account`,
                      step2: 'After logging in, copy the authorization code and paste it below',
                    };
                    return (
                      <div className="mb-3">
                        <p className="text-sm text-gray-400 mb-2">1. {config.step1}</p>
                        <a
                          href={config.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 text-sm underline block mb-3"
                        >
                          {config.linkText}
                        </a>
                        <p className="text-sm text-gray-400 mb-2">2. {config.step2}</p>
                        <label className="block text-sm text-gray-300 mb-1">Authorization Code</label>
                        <input
                          type="text"
                          value={creds.auth_code || ''}
                          onChange={(e) => updateField(launcher.id, 'auth_code', e.target.value)}
                          placeholder="Paste code here..."
                          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    );
                  })()}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/Setup.jsx
git commit -m "feat: make auth_code Setup UI launcher-aware for GOG and Epic"
```

---

### Task 4: Update Tests and Version Bump

**Files:**
- Modify: `backend/tests/services/syncEngine.test.js`
- Modify: `backend/tests/services/launchers/gog.test.js`
- Modify: `backend/package.json` (version)
- Modify: `frontend/package.json` (version)

- [ ] **Step 1: Update the GOG error handling test in syncEngine.test.js**

The existing GOG error test mocks `axios.create` (for the old browser flow). Since GOG now uses `axios.get` directly, update the test. Find the `should handle errors gracefully` test:

```javascript
  it('syncLauncher should handle errors gracefully', async () => {
```

Replace the entire test with:
```javascript
  it('syncLauncher should handle errors gracefully', async () => {
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ access_token: 'old', refresh_token: 'expired' }));
    db.prepare(
      'INSERT OR REPLACE INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', creds);

    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => { throw new Error('Token refresh failed'); };

    try {
      const jobId = await syncLauncher('gog', db);
      const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'failed');
      assert.ok(job.error_message, 'error_message should be set');
    } finally {
      axios.get = originalGet;
    }
  });
```

- [ ] **Step 2: Update gog.test.js to remove URL parsing tests (no longer relevant) and add auth_code tests**

Replace the entire contents of `backend/tests/services/launchers/gog.test.js`:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('GOG Launcher', () => {
  it('refreshIfNeeded should throw clear error when no refresh_token exists', async () => {
    // REGRESSION: Old username/password credentials have no refresh_token.
    // refreshIfNeeded must throw a clear re-configure message, not a cryptic error.
    const GOGLauncher = require('../../../src/services/launchers/gog');
    const instance = new GOGLauncher('gog', null);

    await assert.rejects(
      () => instance.refreshIfNeeded({ username: 'old', password: 'creds' }),
      { message: /reconfigured|re-add|Setup/i }
    );
  });

  it('refreshIfNeeded should throw clear error when refresh token is expired', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => { throw new Error('invalid_grant'); };

    try {
      const GOGLauncher = require('../../../src/services/launchers/gog');
      const instance = new GOGLauncher('gog', null);

      await assert.rejects(
        () => instance.refreshIfNeeded({ refresh_token: 'expired_token' }),
        { message: /expired|re-add|Setup/i }
      );
    } finally {
      axios.get = originalGet;
    }
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd backend && node --test tests/services/launchers/gog.test.js && node --test tests/services/syncEngine.test.js
```

Expected: All tests pass.

- [ ] **Step 4: Bump version to 1.10.0**

Bump version in both `backend/package.json` and `frontend/package.json` from 1.9.2 to 1.10.0 (new feature: GOG auth code flow).

- [ ] **Step 5: Commit**

```bash
git add backend/tests/services/syncEngine.test.js backend/tests/services/launchers/gog.test.js backend/package.json frontend/package.json
git commit -m "test: update GOG tests for auth_code flow, bump to v1.10.0"
```
