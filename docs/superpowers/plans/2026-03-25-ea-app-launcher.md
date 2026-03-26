# EA App Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement EA App launcher using OAuth auth_code flow and EA's Juno GraphQL API for fetching owned games.

**Architecture:** Follows the exact same pattern as Epic/GOG launchers — user logs in via browser, copies auth code, server exchanges for tokens and queries EA's GraphQL API. The EA stub already exists; this replaces it with a working implementation and flips `implemented: true`.

**Tech Stack:** Node.js, Express, axios, EA Juno GraphQL API, OAuth 2.0

---

## File Structure

**Modify:**
- `backend/src/services/launchers/ea.js` — replace stub with working implementation
- `backend/src/routes/launchers.js:13` — change EA registration to `auth_code`, `implemented: true`
- `frontend/src/pages/Setup.jsx:279-292` — add EA auth_code config to `authCodeConfig` object

**Create:**
- `backend/tests/services/launchers/ea.test.js` — unit tests

---

### Task 1: EA Launcher — authenticate()

**Files:**
- Create: `backend/tests/services/launchers/ea.test.js`
- Modify: `backend/src/services/launchers/ea.js`

- [ ] **Step 1: Write the failing test for authenticate()**

Create `backend/tests/services/launchers/ea.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('EALauncher', () => {
  it('authenticate() should exchange auth code for tokens', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedUrl = null;
    let capturedBody = null;
    axios.post = async (url, body) => {
      capturedUrl = url;
      capturedBody = body;
      return {
        data: {
          access_token: 'ea_test_access',
          refresh_token: 'ea_test_refresh',
          expires_in: 3600,
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});
      const result = await launcher.authenticate({ auth_code: 'test_code_123' });

      // Verify token endpoint called
      assert.equal(capturedUrl, 'https://accounts.ea.com/connect/token');

      // Verify request body
      const params = new URLSearchParams(capturedBody);
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('code'), 'test_code_123');
      assert.equal(params.get('client_id'), 'JUNO_PC_CLIENT');

      // Verify returned credentials shape
      assert.equal(result.access_token, 'ea_test_access');
      assert.equal(result.refresh_token, 'ea_test_refresh');
      assert.ok(result.expires_at, 'Should have expires_at timestamp');
    } finally {
      axios.post = originalPost;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/services/launchers/ea.test.js`
Expected: FAIL — authenticate() returns null (stub).

- [ ] **Step 3: Implement authenticate()**

Replace the entire contents of `backend/src/services/launchers/ea.js` with:

```js
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * EA App integration using OAuth authorization code flow + Juno GraphQL API.
 *
 * Auth flow: User logs in at EA's OAuth URL, gets a one-time auth code,
 * pastes it into Gameshelf. We exchange it for access + refresh tokens.
 *
 * Credentials shape (after initial auth):
 * { access_token, refresh_token, expires_at }
 */

const EA_CLIENT_ID = 'JUNO_PC_CLIENT';
const EA_CLIENT_SECRET = '4mRLtYMb6vq9qglomWEaT4auACSQmaccrOyR2';
const EA_TOKEN_URL = 'https://accounts.ea.com/connect/token';
const EA_REDIRECT_URI = 'qrc:///html/login_successful.html';
const EA_GRAPHQL_URL = 'https://service-aggregation-layer.juno.ea.com/graphql';

const OWNED_GAMES_QUERY = `
query getPreloadedOwnedGames($next: String, $locale: Locale, $limit: Int,
    $type: [GameProductType!]!, $entitlementEnabled: Boolean,
    $storefronts: [UserGameProductStorefront!],
    $ownershipMethods: [OwnershipMethod!],
    $platforms: [GamePlatform!]!) {
  me {
    ownedGameProducts(
      storefronts: $storefronts
      locale: $locale
      paging: {limit: $limit, next: $next}
      productFound: true
      orderBy: {field: NAME, direction: ASC}
      ownershipMethod: $ownershipMethods
      type: $type
      downloadableOnly: false
      entitlementEnabled: $entitlementEnabled
      platforms: $platforms
    ) {
      items {
        id: originOfferId
        status
        product {
          id
          name
          gameSlug
          baseItem(availabilities: [VISIBLE]) {
            title
            gameType
          }
        }
      }
    }
  }
}`;

const OWNED_GAMES_VARIABLES = {
  locale: 'DEFAULT',
  limit: 9999,
  type: ['DIGITAL_FULL_GAME', 'PACKAGED_FULL_GAME'],
  entitlementEnabled: true,
  storefronts: ['EA'],
  platforms: ['PC'],
  ownershipMethods: ['PURCHASE', 'REDEMPTION', 'ENTITLEMENT_GRANT'],
};

class EALauncher extends BaseLauncher {
  /**
   * Exchange a one-time authorization code for tokens.
   */
  async authenticate(credentials) {
    const { auth_code } = credentials;

    const res = await axios.post(EA_TOKEN_URL, new URLSearchParams({
      grant_type: 'authorization_code',
      code: auth_code,
      client_id: EA_CLIENT_ID,
      client_secret: EA_CLIENT_SECRET,
      redirect_uri: EA_REDIRECT_URI,
      token_format: 'JWS',
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = res.data;
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();

    console.log('[EA] Token exchange successful');
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
    };
  }

  /**
   * Check token expiry and refresh if needed.
   * Returns { session, updatedCredentials } for syncEngine to persist.
   */
  async refreshIfNeeded(credentials) {
    const { access_token, refresh_token, expires_at } = credentials;

    // Check if access token is still valid (with 60s buffer)
    const expiresAtMs = new Date(expires_at).getTime();
    if (Date.now() < expiresAtMs - 60000) {
      return { session: access_token, updatedCredentials: null };
    }

    // Access token expired — refresh it
    console.log('[EA] Access token expired, refreshing...');
    try {
      const res = await axios.post(EA_TOKEN_URL, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
        client_id: EA_CLIENT_ID,
        client_secret: EA_CLIENT_SECRET,
        token_format: 'JWS',
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const data = res.data;
      const newExpiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();

      const updatedCredentials = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: newExpiresAt,
      };

      console.log('[EA] Token refreshed successfully');
      return { session: data.access_token, updatedCredentials };
    } catch (err) {
      console.error('[EA] Token refresh failed:', err.message);
      throw new Error('EA authentication expired. Please re-authenticate.');
    }
  }

  /**
   * Fetch owned games from EA's Juno GraphQL API.
   */
  async fetchOwnedGames(session) {
    const res = await axios.post(EA_GRAPHQL_URL, {
      query: OWNED_GAMES_QUERY,
      variables: OWNED_GAMES_VARIABLES,
    }, {
      headers: {
        'Authorization': `Bearer ${session}`,
        'User-Agent': 'EAApp/PC/13.468.0.5981/GOG_Galaxy',
        'x-client-id': 'EAX-JUNO-CLIENT',
        'Content-Type': 'application/json',
      },
    });

    const items = res.data?.data?.me?.ownedGameProducts?.items || [];

    return items
      .filter(item => {
        const gameType = item.product?.baseItem?.gameType;
        return !gameType || gameType === 'BASE_GAME';
      })
      .map(item => ({
        launcher_game_id: item.id || item.product?.id,
        title: item.product?.name || item.product?.baseItem?.title || item.id,
        playtime_minutes: 0,
      }));
  }
}

module.exports = EALauncher;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/services/launchers/ea.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/launchers/ea.js backend/tests/services/launchers/ea.test.js
git commit -m "feat: implement EA App authenticate() with OAuth auth_code flow"
```

---

### Task 2: EA Launcher — refreshIfNeeded() Tests

**Files:**
- Modify: `backend/tests/services/launchers/ea.test.js`

- [ ] **Step 1: Add refreshIfNeeded tests**

Append to the `describe` block in `backend/tests/services/launchers/ea.test.js`:

```js
  it('refreshIfNeeded() should skip refresh when token is not expired', async () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ea')];
    const EALauncher = require('../../../src/services/launchers/ea');
    const launcher = new EALauncher('ea', {});

    const result = await launcher.refreshIfNeeded({
      access_token: 'valid_token',
      refresh_token: 'refresh_token',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    assert.equal(result.session, 'valid_token');
    assert.equal(result.updatedCredentials, null, 'Should not refresh when token is valid');
  });

  it('refreshIfNeeded() should refresh when token is expired', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        access_token: 'new_access',
        refresh_token: 'new_refresh',
        expires_in: 3600,
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});

      const result = await launcher.refreshIfNeeded({
        access_token: 'expired_token',
        refresh_token: 'old_refresh',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });

      assert.equal(result.session, 'new_access');
      assert.equal(result.updatedCredentials.access_token, 'new_access');
      assert.equal(result.updatedCredentials.refresh_token, 'new_refresh');
      assert.ok(result.updatedCredentials.expires_at);
    } finally {
      axios.post = originalPost;
    }
  });
```

- [ ] **Step 2: Run tests**

Run: `cd backend && node --test tests/services/launchers/ea.test.js`
Expected: PASS — all 3 tests green.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/services/launchers/ea.test.js
git commit -m "test: add EA refreshIfNeeded() tests for valid and expired tokens"
```

---

### Task 3: EA Launcher — fetchOwnedGames() Tests

**Files:**
- Modify: `backend/tests/services/launchers/ea.test.js`

- [ ] **Step 1: Add fetchOwnedGames tests**

Append to the `describe` block in `backend/tests/services/launchers/ea.test.js`:

```js
  it('fetchOwnedGames() should return games from GraphQL response', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          data: {
            me: {
              ownedGameProducts: {
                items: [
                  {
                    id: 'OFB-EAST:109552153',
                    product: {
                      id: 'prod123',
                      name: 'Battlefield 1',
                      gameSlug: 'battlefield-1',
                      baseItem: { title: 'Battlefield 1', gameType: 'BASE_GAME' },
                    },
                  },
                  {
                    id: 'OFB-EAST:109552154',
                    product: {
                      id: 'prod456',
                      name: 'Mass Effect Legendary Edition',
                      gameSlug: 'mass-effect-le',
                      baseItem: { title: 'Mass Effect Legendary Edition', gameType: 'BASE_GAME' },
                    },
                  },
                ],
              },
            },
          },
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});
      const games = await launcher.fetchOwnedGames('test_bearer_token');

      assert.equal(games.length, 2);
      assert.equal(games[0].launcher_game_id, 'OFB-EAST:109552153');
      assert.equal(games[0].title, 'Battlefield 1');
      assert.equal(games[0].playtime_minutes, 0);
      assert.equal(games[1].title, 'Mass Effect Legendary Edition');

      // Verify auth header
      assert.equal(capturedHeaders.Authorization, 'Bearer test_bearer_token');
      assert.equal(capturedHeaders['x-client-id'], 'EAX-JUNO-CLIENT');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should filter out non-base-game items', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        data: {
          me: {
            ownedGameProducts: {
              items: [
                {
                  id: 'game1',
                  product: {
                    id: 'p1', name: 'FIFA 24',
                    baseItem: { title: 'FIFA 24', gameType: 'BASE_GAME' },
                  },
                },
                {
                  id: 'dlc1',
                  product: {
                    id: 'p2', name: 'FIFA 24 Ultimate Team Pack',
                    baseItem: { title: 'FIFA 24 Ultimate Team Pack', gameType: 'EXPANSION' },
                  },
                },
                {
                  id: 'trial1',
                  product: {
                    id: 'p3', name: 'FIFA 24 Trial',
                    baseItem: { title: 'FIFA 24 Trial', gameType: 'TRIAL' },
                  },
                },
              ],
            },
          },
        },
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});
      const games = await launcher.fetchOwnedGames('test_token');

      assert.equal(games.length, 1, 'Should only return BASE_GAME items');
      assert.equal(games[0].title, 'FIFA 24');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should handle empty library', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: { data: { me: { ownedGameProducts: { items: [] } } } },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});
      const games = await launcher.fetchOwnedGames('test_token');

      assert.equal(games.length, 0);
    } finally {
      axios.post = originalPost;
    }
  });
```

- [ ] **Step 2: Run tests**

Run: `cd backend && node --test tests/services/launchers/ea.test.js`
Expected: PASS — all 6 tests green.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/services/launchers/ea.test.js
git commit -m "test: add EA fetchOwnedGames() tests for parsing, filtering, and empty library"
```

---

### Task 4: Registration & Frontend — Enable EA App

**Files:**
- Modify: `backend/src/routes/launchers.js:13`
- Modify: `frontend/src/pages/Setup.jsx:279-292`

- [ ] **Step 1: Update launcher registration**

In `backend/src/routes/launchers.js`, replace line 13:

```js
  { id: 'ea', display_name: 'EA App', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
```

With:

```js
  { id: 'ea', display_name: 'EA App', auth_type: 'auth_code', otp_supported: false, qr_supported: false, implemented: true },
```

- [ ] **Step 2: Add EA auth_code config to Setup.jsx**

In `frontend/src/pages/Setup.jsx`, in the `authCodeConfig` object (around line 279), add the EA entry after the `gog` entry:

```js
                      ea: {
                        url: 'https://accounts.ea.com/connect/auth?response_type=code&client_id=JUNO_PC_CLIENT&display=junoClient/login&redirect_uri=qrc%3A%2F%2F%2Fhtml%2Flogin_successful.html&locale=en_US',
                        linkText: 'Open EA Login',
                        step1: 'Click the link below and log in to your EA account',
                        step2: 'After logging in, you will be redirected. Copy the "code" value from the URL and paste it below',
                      },
```

- [ ] **Step 3: Run existing launcher route tests to check for regressions**

Run: `cd backend && node --test tests/routes/launchers.test.js`
Expected: PASS — the available launchers test may need its count updated if it checks exact counts.

- [ ] **Step 4: Build frontend**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/launchers.js frontend/src/pages/Setup.jsx
git commit -m "feat: enable EA App launcher — auth_code registration and Setup page config"
```

---

### Task 5: Version Bump and Final Verification

**Files:**
- Modify: `backend/package.json`
- Modify: `frontend/package.json`
- Modify: `backend/tests/server.test.js`

- [ ] **Step 1: Bump version to 1.14.0**

Update version in both `backend/package.json` and `frontend/package.json` from `"1.13.0"` to `"1.14.0"`.

Update `backend/tests/server.test.js` version assertion from `'1.13.0'` to `'1.14.0'`.

- [ ] **Step 2: Run full backend test suite**

Run: `cd backend && node --test 'tests/**/*.test.js'`
Expected: All tests pass (except pre-existing QR test).

- [ ] **Step 3: Build frontend**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add backend/package.json frontend/package.json backend/tests/server.test.js
git commit -m "chore: bump version to 1.14.0 for EA App launcher"
```
