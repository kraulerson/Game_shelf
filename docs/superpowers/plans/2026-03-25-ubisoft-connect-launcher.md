# Ubisoft Connect Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Ubisoft Connect launcher using email/password Basic Auth with email-based 2FA and Ubisoft's GraphQL API for fetching owned PC games.

**Architecture:** Email/password stored during setup. First sync triggers login via Basic Auth, handles 2FA if needed (existing two-phase sync flow), stores session `ticket` + `rememberMeTicket` for refresh. GraphQL query fetches owned games filtered to PC platform. The `credentials+totp` auth type and `implemented: false` stub already exist — this replaces the stub and flips the flag.

**Tech Stack:** Node.js, Express, axios, Ubisoft public-ubiservices API, GraphQL

---

## File Structure

**Modify:**
- `backend/src/services/launchers/ubisoft.js` — replace stub with working implementation
- `backend/src/routes/launchers.js:14` — flip `implemented: true`

**Create:**
- `backend/tests/services/launchers/ubisoft.test.js` — unit tests

---

### Task 1: Ubisoft Launcher — Login + 2FA + Refresh

**Files:**
- Create: `backend/tests/services/launchers/ubisoft.test.js`
- Modify: `backend/src/services/launchers/ubisoft.js`

- [ ] **Step 1: Write failing tests for login and 2FA**

Create `backend/tests/services/launchers/ubisoft.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('UbisoftLauncher', () => {
  it('refreshIfNeeded() should login with Basic Auth when no ticket exists', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          ticket: 'ubi_ticket_123',
          sessionId: 'sess_123',
          rememberMeTicket: 'rm_ticket_123',
          userId: 'user_123',
          expiration: '2099-01-01T00:00:00.000Z',
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      const result = await launcher.refreshIfNeeded({
        username: 'user@example.com',
        password: 'mypass',
      });

      // Verify Basic auth header
      assert.ok(capturedHeaders.Authorization.startsWith('Basic '));
      const decoded = Buffer.from(capturedHeaders.Authorization.split(' ')[1], 'base64').toString();
      assert.equal(decoded, 'user@example.com:mypass');

      // Verify session returned
      assert.equal(result.session.ticket, 'ubi_ticket_123');
      assert.equal(result.session.sessionId, 'sess_123');

      // Verify updated credentials include ticket + rememberMeTicket
      assert.equal(result.updatedCredentials.ticket, 'ubi_ticket_123');
      assert.equal(result.updatedCredentials.rememberMeTicket, 'rm_ticket_123');
      assert.equal(result.updatedCredentials.username, 'user@example.com');
      assert.equal(result.updatedCredentials.password, 'mypass');
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should throw OTP_REQUIRED when 2FA is triggered', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        twoFactorAuthenticationTicket: '2fa_ticket_abc',
        maskedPhone: '***1234',
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      await assert.rejects(
        () => launcher.refreshIfNeeded({
          username: 'user@example.com',
          password: 'mypass',
        }),
        (err) => {
          assert.ok(err.message.startsWith('OTP_REQUIRED:'));
          return true;
        }
      );
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should complete login with OTP code after 2FA', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let callCount = 0;
    axios.post = async (url, body, opts) => {
      callCount++;
      if (callCount === 1) {
        // First call: return 2FA challenge
        return {
          data: {
            twoFactorAuthenticationTicket: '2fa_ticket_abc',
          },
        };
      }
      // Second call: return success with 2FA code
      assert.ok(opts.headers['Ubi-2faCode'], 'Should include 2FA code header');
      assert.ok(opts.headers.Authorization.includes('2fa_ticket_abc'));
      return {
        data: {
          ticket: 'ubi_ticket_after_2fa',
          sessionId: 'sess_456',
          rememberMeTicket: 'rm_ticket_456',
          userId: 'user_123',
          expiration: '2099-01-01T00:00:00.000Z',
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      const result = await launcher.refreshIfNeeded({
        username: 'user@example.com',
        password: 'mypass',
        otp_code: '123456',
      });

      assert.equal(result.session.ticket, 'ubi_ticket_after_2fa');
      assert.equal(result.updatedCredentials.ticket, 'ubi_ticket_after_2fa');
      assert.equal(callCount, 2, 'Should make two requests (login + 2FA)');
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should skip login when ticket is not expired', async () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
    const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
    const launcher = new UbisoftLauncher('ubisoft', {});

    const result = await launcher.refreshIfNeeded({
      username: 'user@example.com',
      password: 'mypass',
      ticket: 'valid_ticket',
      sessionId: 'sess_123',
      rememberMeTicket: 'rm_ticket',
      expiration: new Date(Date.now() + 3600000).toISOString(),
    });

    assert.equal(result.session.ticket, 'valid_ticket');
    assert.equal(result.updatedCredentials, null, 'Should not refresh when ticket is valid');
  });

  it('refreshIfNeeded() should use rememberMeTicket when ticket is expired', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          ticket: 'new_ticket',
          sessionId: 'new_sess',
          rememberMeTicket: 'new_rm',
          userId: 'user_123',
          expiration: '2099-01-01T00:00:00.000Z',
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      const result = await launcher.refreshIfNeeded({
        username: 'user@example.com',
        password: 'mypass',
        ticket: 'expired_ticket',
        sessionId: 'old_sess',
        rememberMeTicket: 'old_rm',
        expiration: new Date(Date.now() - 1000).toISOString(),
      });

      // Should use rememberMeTicket auth
      assert.ok(capturedHeaders.Authorization.startsWith('rm_v1 t='));
      assert.equal(result.session.ticket, 'new_ticket');
      assert.equal(result.updatedCredentials.rememberMeTicket, 'new_rm');
    } finally {
      axios.post = originalPost;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/services/launchers/ubisoft.test.js`
Expected: FAIL — refreshIfNeeded() returns null (stub).

- [ ] **Step 3: Implement the full Ubisoft launcher**

Replace the entire contents of `backend/src/services/launchers/ubisoft.js` with:

```js
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Ubisoft Connect integration using email/password Basic Auth + GraphQL.
 *
 * Auth flow: User provides email/password during setup. First sync logs in
 * via Basic Auth, handles email-based 2FA via two-phase sync flow, stores
 * ticket + rememberMeTicket for refresh.
 *
 * Credentials shape (after login):
 * { username, password, ticket, sessionId, rememberMeTicket, userId, expiration }
 */

const UBI_APP_ID = 'f35adcb5-1911-440c-b1c9-48fdc1701c68';
const UBI_AUTH_URL = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';
const UBI_GRAPHQL_URL = 'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql';
const UBI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OWNED_GAMES_QUERY = `
query AllGames {
  viewer {
    id
    ...ownedGamesList
  }
}
fragment gameProps on Game {
  id
  spaceId
  name
}
fragment ownedGameProps on Game {
  ...gameProps
  viewer {
    meta {
      id
      ownedPlatformGroups {
        id
        name
        type
      }
    }
  }
}
fragment ownedGamesList on User {
  ownedGames: games(filterBy: {isOwned: true}) {
    totalCount
    nodes {
      ...ownedGameProps
    }
  }
}`;

function buildHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Ubi-AppId': UBI_APP_ID,
    'User-Agent': UBI_USER_AGENT,
    ...extra,
  };
}

class UbisoftLauncher extends BaseLauncher {
  /**
   * Login with email/password Basic Auth.
   * If 2FA is triggered and otp_code is provided, completes 2FA.
   * If 2FA is triggered without otp_code, throws OTP_REQUIRED.
   */
  async _login(username, password, otpCode) {
    const basicAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
      headers: buildHeaders({ Authorization: basicAuth }),
    });

    const data = res.data;

    // 2FA challenge
    if (data.twoFactorAuthenticationTicket) {
      if (!otpCode) {
        throw new Error('OTP_REQUIRED:Check your email for a verification code');
      }

      // Complete 2FA with code
      const res2fa = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
        headers: buildHeaders({
          Authorization: `ubi_2fa_v1 t=${data.twoFactorAuthenticationTicket}`,
          'Ubi-2faCode': otpCode,
        }),
      });

      return res2fa.data;
    }

    return data;
  }

  /**
   * Refresh using rememberMeTicket.
   */
  async _refreshWithRememberMe(rememberMeTicket) {
    const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
      headers: buildHeaders({ Authorization: `rm_v1 t=${rememberMeTicket}` }),
    });
    return res.data;
  }

  /**
   * Not used for credentials+totp type — setup stores email/password directly.
   * Login happens during sync via refreshIfNeeded().
   */
  async authenticate(credentials) {
    return credentials;
  }

  /**
   * Check ticket expiry and refresh if needed.
   * Handles: initial login (no ticket), rememberMeTicket refresh, and full re-login.
   */
  async refreshIfNeeded(credentials) {
    const { username, password, ticket, sessionId, rememberMeTicket, expiration, otp_code } = credentials;

    // If ticket exists and not expired (with 60s buffer), use it
    if (ticket && expiration) {
      const expiresAtMs = new Date(expiration).getTime();
      if (Date.now() < expiresAtMs - 60000) {
        return { session: { ticket, sessionId }, updatedCredentials: null };
      }
    }

    let data;

    // Try rememberMeTicket refresh first (avoids 2FA)
    if (rememberMeTicket) {
      try {
        console.log('[Ubisoft] Refreshing with rememberMeTicket...');
        data = await this._refreshWithRememberMe(rememberMeTicket);
      } catch (err) {
        console.warn('[Ubisoft] rememberMeTicket refresh failed, falling back to login:', err.message);
        data = null;
      }
    }

    // Fall back to full login
    if (!data) {
      console.log('[Ubisoft] Logging in with credentials...');
      data = await this._login(username, password, otp_code);
    }

    const session = { ticket: data.ticket, sessionId: data.sessionId };
    const updatedCredentials = {
      username,
      password,
      ticket: data.ticket,
      sessionId: data.sessionId,
      rememberMeTicket: data.rememberMeTicket,
      userId: data.userId,
      expiration: data.expiration,
    };

    console.log('[Ubisoft] Authentication successful');
    return { session, updatedCredentials };
  }

  /**
   * Fetch owned PC games from Ubisoft's GraphQL API.
   */
  async fetchOwnedGames(session) {
    const { ticket, sessionId } = session;

    const res = await axios.post(UBI_GRAPHQL_URL, {
      query: OWNED_GAMES_QUERY,
    }, {
      headers: buildHeaders({
        Authorization: `Ubi_v1 t=${ticket}`,
        'Ubi-SessionId': sessionId,
      }),
    });

    const nodes = res.data?.data?.viewer?.ownedGames?.nodes || [];

    return nodes
      .filter(node => {
        const platforms = node.viewer?.meta?.ownedPlatformGroups || [];
        return platforms.some(p => p.type === 'PC');
      })
      .map(node => ({
        launcher_game_id: node.id,
        title: node.name,
        playtime_minutes: 0,
      }));
  }
}

module.exports = UbisoftLauncher;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/services/launchers/ubisoft.test.js`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/launchers/ubisoft.js backend/tests/services/launchers/ubisoft.test.js
git commit -m "feat: implement Ubisoft Connect login, 2FA, refresh, and game library fetch"
```

---

### Task 2: fetchOwnedGames() Tests

**Files:**
- Modify: `backend/tests/services/launchers/ubisoft.test.js`

- [ ] **Step 1: Add fetchOwnedGames tests**

Append to the `describe` block in `backend/tests/services/launchers/ubisoft.test.js`:

```js
  it('fetchOwnedGames() should return PC games from GraphQL response', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          data: {
            viewer: {
              ownedGames: {
                totalCount: 2,
                nodes: [
                  {
                    id: 'game-1',
                    spaceId: 'space-1',
                    name: 'Assassin\'s Creed Valhalla',
                    viewer: { meta: { id: 'm1', ownedPlatformGroups: [{ id: 'pg1', name: 'PC', type: 'PC' }] } },
                  },
                  {
                    id: 'game-2',
                    spaceId: 'space-2',
                    name: 'Far Cry 6',
                    viewer: { meta: { id: 'm2', ownedPlatformGroups: [{ id: 'pg2', name: 'PC', type: 'PC' }] } },
                  },
                ],
              },
            },
          },
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});
      const games = await launcher.fetchOwnedGames({ ticket: 'test_ticket', sessionId: 'test_sess' });

      assert.equal(games.length, 2);
      assert.equal(games[0].launcher_game_id, 'game-1');
      assert.equal(games[0].title, 'Assassin\'s Creed Valhalla');
      assert.equal(games[0].playtime_minutes, 0);

      assert.ok(capturedHeaders.Authorization.includes('test_ticket'));
      assert.equal(capturedHeaders['Ubi-SessionId'], 'test_sess');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should filter out non-PC games', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        data: {
          viewer: {
            ownedGames: {
              totalCount: 3,
              nodes: [
                {
                  id: 'pc-game',
                  name: 'Watch Dogs 2',
                  viewer: { meta: { id: 'm1', ownedPlatformGroups: [{ id: 'pg1', name: 'PC', type: 'PC' }] } },
                },
                {
                  id: 'console-game',
                  name: 'Just Dance 2024',
                  viewer: { meta: { id: 'm2', ownedPlatformGroups: [{ id: 'pg2', name: 'PS5', type: 'CONSOLE' }] } },
                },
                {
                  id: 'multi-plat',
                  name: 'Rainbow Six Siege',
                  viewer: { meta: { id: 'm3', ownedPlatformGroups: [
                    { id: 'pg3', name: 'PC', type: 'PC' },
                    { id: 'pg4', name: 'PS5', type: 'CONSOLE' },
                  ] } },
                },
              ],
            },
          },
        },
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});
      const games = await launcher.fetchOwnedGames({ ticket: 'test', sessionId: 'test' });

      assert.equal(games.length, 2, 'Should include PC and multi-plat, exclude console-only');
      assert.equal(games[0].title, 'Watch Dogs 2');
      assert.equal(games[1].title, 'Rainbow Six Siege');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should handle empty library', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: { data: { viewer: { ownedGames: { totalCount: 0, nodes: [] } } } },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});
      const games = await launcher.fetchOwnedGames({ ticket: 'test', sessionId: 'test' });

      assert.equal(games.length, 0);
    } finally {
      axios.post = originalPost;
    }
  });
```

- [ ] **Step 2: Run tests**

Run: `cd backend && node --test tests/services/launchers/ubisoft.test.js`
Expected: PASS — all 8 tests green.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/services/launchers/ubisoft.test.js
git commit -m "test: add Ubisoft fetchOwnedGames() tests for PC filtering and empty library"
```

---

### Task 3: Enable Ubisoft Connect + Version Bump

**Files:**
- Modify: `backend/src/routes/launchers.js:14`
- Modify: `backend/package.json`
- Modify: `frontend/package.json`
- Modify: `backend/tests/server.test.js`

- [ ] **Step 1: Flip implemented flag**

In `backend/src/routes/launchers.js`, change line 14 from:

```js
  { id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
```

To:

```js
  { id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: true },
```

- [ ] **Step 2: Bump version to 1.15.0**

Update version in `backend/package.json` and `frontend/package.json` from `"1.14.4"` to `"1.15.0"`.

Update `backend/tests/server.test.js` version assertion from `'1.14.4'` to `'1.15.0'`.

- [ ] **Step 3: Run full backend test suite**

Run: `cd backend && node --test 'tests/**/*.test.js'`
Expected: All tests pass (except pre-existing QR test).

- [ ] **Step 4: Build frontend**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/launchers.js backend/package.json frontend/package.json backend/tests/server.test.js
git commit -m "feat: enable Ubisoft Connect launcher (v1.15.0)"
```
