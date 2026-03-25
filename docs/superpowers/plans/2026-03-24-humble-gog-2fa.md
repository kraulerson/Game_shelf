# Humble Bundle & GOG 2FA Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pre-sync 2FA code prompts for Humble Bundle and GOG so users can authenticate with their 2FA-enabled accounts.

**Architecture:** Frontend shows a 2FA modal when syncing launchers with `otp_supported: true`. The code is passed in the sync POST body, through the sync engine to the launcher's `authenticate()` method. Humble re-POSTs to `/processlogin` with the guard code. GOG uses a multi-step browser-based OAuth flow with cookie jar management.

**Tech Stack:** React (frontend), Express/SQLite (backend), axios + tough-cookie + axios-cookiejar-support@5 (GOG cookie management; v5 pinned for CJS compatibility)

---

### Task 1: Backend — Sync Route and Engine Accept OTP Code

**Files:**
- Modify: `backend/src/routes/sync.js:34-43`
- Modify: `backend/src/services/syncEngine.js:5`

- [ ] **Step 1: Update sync route to read otp_code from request body**

In `backend/src/routes/sync.js`, modify the `POST /:launcherName` handler to read and pass the OTP code:

Find:
```javascript
router.post('/:launcherName', (req, res) => {
  const db = req.app.locals.db;
  const { launcherName } = req.params;
  // Fire and forget
  syncLauncher(launcherName, db).catch(err =>
    console.error(`[Sync] ${launcherName} sync error:`, err.message)
  );
  res.json({ message: `Sync started for ${launcherName}` });
});
```

Replace with:
```javascript
router.post('/:launcherName', (req, res) => {
  const db = req.app.locals.db;
  const { launcherName } = req.params;
  const { otp_code } = req.body || {};
  // Fire and forget
  syncLauncher(launcherName, db, otp_code).catch(err =>
    console.error(`[Sync] ${launcherName} sync error:`, err.message)
  );
  res.json({ message: `Sync started for ${launcherName}` });
});
```

- [ ] **Step 2: Update syncLauncher to accept and inject otpCode**

In `backend/src/services/syncEngine.js`, modify the function signature and inject the code into credentials:

Find:
```javascript
async function syncLauncher(launcherName, db) {
```

Replace with:
```javascript
async function syncLauncher(launcherName, db, otpCode) {
```

Then after the line `const credentials = JSON.parse(decrypt(launcher.credentials_json));` (line 25), add:

```javascript
    if (otpCode) credentials.otp_code = otpCode;
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/sync.js backend/src/services/syncEngine.js
git commit -m "feat: pass OTP code through sync route to launcher credentials"
```

---

### Task 2: Backend — Humble Bundle 2FA Support

**Files:**
- Modify: `backend/src/services/launchers/humble.js`
- Modify: `backend/src/routes/launchers.js:16` (otp_supported flag)

- [ ] **Step 1: Rewrite Humble authenticate() with 2FA support**

Replace the entire contents of `backend/src/services/launchers/humble.js`:

```javascript
const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Humble Bundle integration using unofficial session-based web API.
 *
 * 2FA: Humble emails a verification code ("Humble Guard") on new logins.
 * The code is passed via credentials.otp_code at sync time.
 *
 * Credentials shape: { username: string, password: string, otp_code?: string }
 */
class HumbleLauncher extends BaseLauncher {
  async authenticate(credentials) {
    const { username, password, otp_code } = credentials;

    // First attempt: login with empty guard field
    const res = await axios.post(
      'https://www.humblebundle.com/processlogin',
      new URLSearchParams({ username, password, guard: '' }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 0,
        validateStatus: (status) => status < 500,
      }
    );

    const data = res.data;

    // Check if 2FA is required
    if (data && data.humble_guard_required && !data.success) {
      if (!otp_code) {
        throw new Error('Humble Bundle requires a verification code. Sync this launcher individually with the code emailed to you.');
      }

      // Re-POST with the guard code
      const guardRes = await axios.post(
        'https://www.humblebundle.com/processlogin',
        new URLSearchParams({ username, password, guard: otp_code }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          maxRedirects: 0,
          validateStatus: (status) => status < 500,
        }
      );

      const guardData = guardRes.data;
      if (!guardData || !guardData.success) {
        const errMsg = guardData?.errors ? JSON.stringify(guardData.errors) : 'Invalid verification code';
        throw new Error(`Humble Bundle 2FA failed: ${errMsg}`);
      }

      return this._extractSession(guardRes);
    }

    // No 2FA needed — check for direct success
    if (data && data.success) {
      return this._extractSession(res);
    }

    // Login failed for other reasons
    const errMsg = data?.errors ? JSON.stringify(data.errors) : 'Login failed';
    throw new Error(`Humble Bundle login failed: ${errMsg}`);
  }

  _extractSession(res) {
    const cookies = res.headers['set-cookie'] || [];
    const sessionCookie = cookies.find(c => c.includes('_simpleauth_sess'));

    if (!sessionCookie) {
      throw new Error('Humble Bundle login succeeded but no session cookie received');
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

- [ ] **Step 2: Update Humble otp_supported flag in launcher config**

In `backend/src/routes/launchers.js`, find the Humble entry in AVAILABLE_LAUNCHERS:

```javascript
  { id: 'humble', display_name: 'Humble Bundle', auth_type: 'credentials', otp_supported: false, qr_supported: false, implemented: true },
```

Replace with:
```javascript
  { id: 'humble', display_name: 'Humble Bundle', auth_type: 'credentials', otp_supported: true, qr_supported: false, implemented: true, otp_instruction: 'Enter the code emailed to you' },
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/launchers/humble.js backend/src/routes/launchers.js
git commit -m "feat: add 2FA support to Humble Bundle launcher"
```

---

### Task 3: Backend — GOG 2FA Support

**Files:**
- Modify: `backend/src/services/launchers/gog.js`
- Modify: `backend/src/routes/launchers.js:18` (otp_supported flag)

- [ ] **Step 1: Install tough-cookie and axios-cookiejar-support dependencies**

Pin axios-cookiejar-support to v5 (v6 is ESM-only, incompatible with this project's CommonJS setup):

```bash
cd backend && npm install tough-cookie axios-cookiejar-support@5
```

- [ ] **Step 2: Rewrite GOG launcher with browser-based OAuth and 2FA**

Replace the entire contents of `backend/src/services/launchers/gog.js`:

```javascript
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const BaseLauncher = require('./base');

/**
 * GOG integration using browser-based OAuth flow.
 *
 * 2FA: GOG uses Google Authenticator (6-digit TOTP).
 * The code is passed via credentials.otp_code at sync time.
 *
 * Credentials shape: { username: string, password: string, otp_code?: string,
 *                       access_token?: string, refresh_token?: string }
 */

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';
const GOG_AUTH_URL = `https://auth.gog.com/auth?client_id=${GOG_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOG_REDIRECT_URI)}&response_type=code&layout=client2`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class GOGLauncher extends BaseLauncher {
  async authenticate(credentials) {
    const { username, password, otp_code } = credentials;

    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, maxRedirects: 5 }));

    // Step 1: GET auth page to obtain login form and CSRF token
    const authPageRes = await client.get(GOG_AUTH_URL);
    const authHtml = authPageRes.data;

    const tokenMatch = authHtml.match(/name="login\[_token\]"[^>]*value="([^"]+)"/);
    if (!tokenMatch) {
      throw new Error('GOG: Could not extract login CSRF token');
    }
    const csrfToken = tokenMatch[1];

    // Step 2: POST credentials to login_check
    let loginRes;
    try {
      loginRes = await client.post(
        'https://login.gog.com/login_check',
        new URLSearchParams({
          'login[username]': username,
          'login[password]': password,
          'login[login]': '',
          'login[_token]': csrfToken,
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          maxRedirects: 0,
          validateStatus: (status) => status < 500,
        }
      );
    } catch (err) {
      // Axios may throw on redirects depending on config — extract from error
      if (err.response) {
        loginRes = err.response;
      } else {
        throw err;
      }
    }

    // Step 3: Check where we ended up
    const redirectUrl = loginRes.headers?.location || loginRes.request?.res?.responseUrl || '';

    // Success — extract code from redirect URL
    if (redirectUrl.includes('on_login_success')) {
      const code = new URL(redirectUrl).searchParams.get('code');
      if (!code) throw new Error('GOG: Login succeeded but no OAuth code in redirect');
      return this._exchangeCode(code, credentials);
    }

    // 2FA required — check for totp or two_step in redirect
    if (redirectUrl.includes('two_step') || redirectUrl.includes('totp')) {
      if (!otp_code) {
        throw new Error('GOG requires an authenticator code. Sync this launcher individually with the code from your authenticator app.');
      }

      // Step 4: GET the 2FA page to extract its CSRF token
      const twoFaPageRes = await client.get(redirectUrl);
      const twoFaHtml = twoFaPageRes.data;

      let twoFaResult;

      if (redirectUrl.includes('totp')) {
        // TOTP (6-digit authenticator code)
        const totpTokenMatch = twoFaHtml.match(/name="two_factor_totp_authentication\[_token\]"[^>]*value="([^"]+)"/);
        if (!totpTokenMatch) throw new Error('GOG: Could not extract TOTP CSRF token');

        const digits = otp_code.toString().split('');
        const fields = {};
        for (let i = 0; i < digits.length && i < 6; i++) {
          fields[`two_factor_totp_authentication[token][letter_${i + 1}]`] = digits[i];
        }
        fields['two_factor_totp_authentication[send]'] = '';
        fields['two_factor_totp_authentication[_token]'] = totpTokenMatch[1];

        try {
          twoFaResult = await client.post(redirectUrl, new URLSearchParams(fields), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
          });
        } catch (err) {
          if (err.response) twoFaResult = err.response;
          else throw err;
        }
      } else {
        // Email-based 2FA (4-digit code)
        const emailTokenMatch = twoFaHtml.match(/name="second_step_authentication\[_token\]"[^>]*value="([^"]+)"/);
        if (!emailTokenMatch) throw new Error('GOG: Could not extract email 2FA CSRF token');

        const digits = otp_code.toString().split('');
        const fields = {};
        for (let i = 0; i < digits.length && i < 4; i++) {
          fields[`second_step_authentication[token][letter_${i + 1}]`] = digits[i];
        }
        fields['second_step_authentication[send]'] = '';
        fields['second_step_authentication[_token]'] = emailTokenMatch[1];

        try {
          twoFaResult = await client.post(redirectUrl, new URLSearchParams(fields), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
          });
        } catch (err) {
          if (err.response) twoFaResult = err.response;
          else throw err;
        }
      }

      // Extract code from final redirect
      const finalUrl = twoFaResult.headers?.location || twoFaResult.request?.res?.responseUrl || '';
      if (!finalUrl.includes('on_login_success')) {
        throw new Error('GOG: 2FA submission failed — invalid code or unexpected response');
      }

      const code = new URL(finalUrl).searchParams.get('code');
      if (!code) throw new Error('GOG: 2FA succeeded but no OAuth code in redirect');
      return this._exchangeCode(code, credentials);
    }

    // If we got HTML back (login page again), credentials were wrong
    throw new Error('GOG login failed — check username and password');
  }

  async _exchangeCode(code, credentials) {
    const tokenRes = await axios.get('https://auth.gog.com/token', {
      params: {
        client_id: GOG_CLIENT_ID,
        client_secret: GOG_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: GOG_REDIRECT_URI,
      },
    });

    const { access_token, refresh_token } = tokenRes.data;

    // Strip otp_code (time-sensitive, should not be persisted) and store tokens
    const { otp_code: _, ...cleanCredentials } = credentials;
    cleanCredentials.access_token = access_token;
    cleanCredentials.refresh_token = refresh_token;

    return { session: access_token, updatedCredentials: cleanCredentials };
  }

  async refreshIfNeeded(credentials) {
    // If we have a refresh token, try using it first (no 2FA needed)
    if (credentials.refresh_token) {
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

        // Strip otp_code and update tokens
        const { otp_code: _, ...cleanCredentials } = credentials;
        cleanCredentials.access_token = access_token;
        cleanCredentials.refresh_token = refresh_token;

        return { session: access_token, updatedCredentials: cleanCredentials };
      } catch (err) {
        console.warn('[GOG] Refresh token expired, falling back to full auth:', err.message);
      }
    }

    // Fall back to full authentication (requires 2FA code)
    return this.authenticate(credentials);
  }

  async fetchOwnedGames(session) {
    // session is already unwrapped to a raw access_token string by syncEngine.js
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

- [ ] **Step 3: Update GOG otp_supported flag in launcher config**

In `backend/src/routes/launchers.js`, find the GOG entry in AVAILABLE_LAUNCHERS:

```javascript
  { id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: false, qr_supported: false, implemented: true },
```

Replace with:
```javascript
  { id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: true, qr_supported: false, implemented: true, otp_instruction: 'Enter the code from your authenticator app' },
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/launchers/gog.js backend/src/routes/launchers.js backend/package.json backend/package-lock.json
git commit -m "feat: add 2FA support to GOG launcher with browser-based OAuth"
```

---

### Task 4: Frontend — 2FA Sync Modal

**Files:**
- Modify: `frontend/src/pages/Settings.jsx`

- [ ] **Step 1: Add 2FA modal state and updated sync function**

In `frontend/src/pages/Settings.jsx`, in the `LaunchersTab` function, after the flash/reordering state declarations (around line 32), add:

```javascript
  const [otpPrompt, setOtpPrompt] = useState(null); // launcher object or null
  const [otpCode, setOtpCode] = useState('');
```

Replace the existing `syncLauncher` function:

Find:
```javascript
  async function syncLauncher(name) {
    await fetch(`/api/sync/${name}`, { method: 'POST', credentials: 'same-origin' });
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
  }
```

Replace with:
```javascript
  function handleSyncClick(launcher) {
    if (launcher.otp_supported && launcher.configured) {
      setOtpPrompt(launcher);
      setOtpCode('');
    } else {
      fireSyncRequest(launcher.id);
    }
  }

  async function fireSyncRequest(name, code) {
    const opts = { method: 'POST', credentials: 'same-origin' };
    if (code) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify({ otp_code: code });
    }
    await fetch(`/api/sync/${name}`, opts);
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
  }

  function submitOtp() {
    if (!otpPrompt || !otpCode.trim()) return;
    fireSyncRequest(otpPrompt.id, otpCode.trim());
    setOtpPrompt(null);
    setOtpCode('');
  }
```

- [ ] **Step 2: Update the Sync button onClick to use handleSyncClick**

Find the Sync button in the launcher row (around line 172):

```jsx
                <button
                  onClick={() => syncLauncher(l.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                >
                  <RefreshCw size={14} /> Sync
                </button>
```

Replace with:
```jsx
                <button
                  onClick={() => handleSyncClick(l)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                >
                  <RefreshCw size={14} /> Sync
                </button>
```

- [ ] **Step 3: Add the 2FA modal after the existing confirmation dialog**

After the closing `)}` of the `{confirmRemove && (` dialog block (around line 213), add:

```jsx
      {/* 2FA code prompt */}
      {otpPrompt && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
            <h3 className="text-white font-medium mb-2">{otpPrompt.display_name} — Verification Code</h3>
            <p className="text-gray-400 text-sm mb-4">
              {otpPrompt.otp_instruction || 'Enter your verification code'}
            </p>
            <input
              type="text"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitOtp()}
              placeholder="Enter code"
              autoFocus
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm mb-4 focus:outline-none focus:border-blue-500"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setOtpPrompt(null); setOtpCode(''); }}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitOtp}
                disabled={!otpCode.trim()}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded transition-colors"
              >
                Sync
              </button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Test in browser**

1. Navigate to Settings
2. Verify Humble and GOG rows now show as `otp_supported` (the frontend receives this from `/api/launchers/available`)
3. Click Sync on Humble — verify 2FA modal appears with "Enter the code emailed to you"
4. Click Sync on GOG — verify 2FA modal appears with "Enter the code from your authenticator app"
5. Click Sync on Steam/Epic/etc — verify sync fires immediately (no modal)
6. Enter a code in the modal and click Sync — verify the sync starts
7. Click Cancel — verify the modal closes without syncing

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat: add 2FA code prompt modal for OTP-enabled launchers"
```

---

### Task 5: Version Bump and Changelog

**Files:**
- Modify: `backend/package.json` (version)
- Modify: `frontend/package.json` (version)

- [ ] **Step 1: Bump version**

Bump from 1.8.0 to 1.9.0 (new feature) in both `backend/package.json` and `frontend/package.json`.

- [ ] **Step 2: Commit**

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: bump version to 1.9.0 for 2FA support"
```
