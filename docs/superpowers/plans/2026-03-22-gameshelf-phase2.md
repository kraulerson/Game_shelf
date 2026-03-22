# Gameshelf Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JWT authentication, a multi-step setup wizard for configuring game launchers with TOTP support, and frontend route guards.

**Architecture:** Express backend with JWT auth via httpOnly cookies, auth middleware protecting routes, setup/launcher API endpoints, TOTP utility. React frontend with TailwindCSS dark theme, login page, 5-step setup wizard, and route guard components wrapping protected routes.

**Tech Stack:** Node.js 20, Express 5, better-sqlite3, bcrypt, jsonwebtoken, otpauth, steam-totp, React 18, Vite, TailwindCSS 3, react-router-dom, qrcode.react, @dnd-kit/core, @dnd-kit/sortable

**Spec:** `docs/superpowers/specs/2026-03-22-gameshelf-phase2-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|----------------|
| `backend/src/middleware/auth.js` | JWT verification middleware — reads cookie, attaches `req.user` |
| `backend/src/utils/totp.js` | TOTP code generation, QR URI building, Steam Guard codes |
| `backend/tests/middleware/auth.test.js` | Auth middleware tests |
| `backend/tests/routes/auth.test.js` | Auth route tests (login/logout/me) |
| `backend/tests/routes/setup.test.js` | Setup route tests |
| `backend/tests/routes/launchers.test.js` | Launcher route tests |
| `backend/tests/utils/totp.test.js` | TOTP utility tests |
| `frontend/tailwind.config.cjs` | TailwindCSS configuration (CJS for `"type":"module"` package) |
| `frontend/postcss.config.cjs` | PostCSS configuration |
| `frontend/src/index.css` | Tailwind directives |
| `frontend/src/pages/Login.jsx` | Login form page |
| `frontend/src/pages/Setup.jsx` | 5-step setup wizard |
| `frontend/src/pages/Library.jsx` | Placeholder library page |
| `frontend/src/pages/Settings.jsx` | Placeholder settings page |
| `frontend/src/components/RequireAuth.jsx` | Auth route guard |
| `frontend/src/components/RequireSetup.jsx` | Setup completion route guard |

### Modified files
| File | Change |
|------|--------|
| `backend/src/server.js` | Add `app.locals.db = db` after migrations |
| `backend/src/routes/auth.js` | Replace 501 stub with login/logout/me routes |
| `backend/src/routes/setup.js` | Replace 501 stub with setup status/complete/qr routes |
| `backend/src/routes/launchers.js` | Replace 501 stub with available/credentials/test/priority routes |
| `backend/src/routes/sync.js` | Replace 501 stub with sync/all stub that returns `{status:"started"}` |
| `backend/tests/server.test.js` | Update test that expects 501 from `/api/auth` since auth routes are now implemented |
| `frontend/src/main.jsx` | Import `index.css` |
| `frontend/src/App.jsx` | React Router setup with route guards |

---

### Task 1: Prerequisites — server.js and dependency installation

**Files:**
- Modify: `backend/src/server.js:37`
- Modify: `backend/package.json` (install deps)
- Modify: `frontend/package.json` (install deps)

- [ ] **Step 1: Add `app.locals.db` to server.js**

In `backend/src/server.js`, add this line immediately after line 37 (`const db = runMigrations(dbPath);`):

```javascript
// Make db available to route handlers
app.locals.db = db;
```

The existing `module.exports = { app, db }` on line 70 remains unchanged.

- [ ] **Step 2: Install backend dependencies**

Run:
```bash
cd /development/Claude\ Projects/gamelist_manager/backend && npm install otpauth steam-totp
```

Expected: packages added to `dependencies` in `package.json`

- [ ] **Step 3: Install frontend dependencies**

Run:
```bash
cd /development/Claude\ Projects/gamelist_manager/frontend && npm install react-router-dom qrcode.react @dnd-kit/core @dnd-kit/sortable
```

Expected: packages added to `dependencies` in `package.json`

- [ ] **Step 4: Commit**

```bash
git add backend/src/server.js backend/package.json backend/package-lock.json frontend/package.json frontend/package-lock.json
git commit -m "feat: add app.locals.db and install Phase 2 dependencies"
```

---

### Task 2: Auth middleware

**Files:**
- Create: `backend/src/middleware/auth.js`
- Create: `backend/tests/middleware/auth.test.js`

- [ ] **Step 1: Write failing tests for auth middleware**

Create `backend/tests/middleware/auth.test.js`:

```javascript
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'test-jwt-secret-for-middleware';

describe('Auth middleware', () => {
  let authMiddleware;

  before(() => {
    process.env.GAMESHELF_JWT_SECRET = TEST_SECRET;
    authMiddleware = require('../src/middleware/auth');
  });

  function createMockReqRes(cookieToken) {
    const req = {
      cookies: cookieToken ? { gameshelf_session: cookieToken } : {},
    };
    const res = {
      _status: null,
      _body: null,
      status(code) { this._status = code; return this; },
      json(data) { this._body = data; return this; },
    };
    return { req, res };
  }

  it('should attach req.user and call next() with valid JWT', (_, done) => {
    const token = jwt.sign({ id: 1, username: 'admin' }, TEST_SECRET, { expiresIn: '1h' });
    const { req, res } = createMockReqRes(token);

    authMiddleware(req, res, () => {
      assert.equal(req.user.id, 1);
      assert.equal(req.user.username, 'admin');
      done();
    });
  });

  it('should return 401 when no cookie is present', () => {
    const { req, res } = createMockReqRes(null);
    let nextCalled = false;

    authMiddleware(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Unauthorized' });
    assert.equal(nextCalled, false);
  });

  it('should return 401 when JWT is invalid', () => {
    const { req, res } = createMockReqRes('invalid-token');
    let nextCalled = false;

    authMiddleware(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Unauthorized' });
    assert.equal(nextCalled, false);
  });

  it('should return 401 when JWT is expired', () => {
    const token = jwt.sign({ id: 1, username: 'admin' }, TEST_SECRET, { expiresIn: '-1s' });
    const { req, res } = createMockReqRes(token);
    let nextCalled = false;

    authMiddleware(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Unauthorized' });
    assert.equal(nextCalled, false);
  });

  it('should return 401 when JWT was signed with wrong secret', () => {
    const token = jwt.sign({ id: 1, username: 'admin' }, 'wrong-secret', { expiresIn: '1h' });
    const { req, res } = createMockReqRes(token);
    let nextCalled = false;

    authMiddleware(req, res, () => { nextCalled = true; });

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Unauthorized' });
    assert.equal(nextCalled, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/middleware/auth.test.js`

Expected: FAIL — `Cannot find module '../src/middleware/auth'`

- [ ] **Step 3: Implement auth middleware**

Create `backend/src/middleware/auth.js`:

```javascript
const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies.gameshelf_session;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, process.env.GAMESHELF_JWT_SECRET);
    req.user = { id: decoded.id, username: decoded.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = authMiddleware;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/middleware/auth.test.js`

Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/middleware/auth.js backend/tests/middleware/auth.test.js
git commit -m "feat: add JWT auth middleware with tests"
```

---

### Task 3: Auth routes (login/logout/me)

**Files:**
- Modify: `backend/src/routes/auth.js`
- Create: `backend/tests/routes/auth.test.js`
- Modify: `backend/tests/server.test.js` (update 501 test)

- [ ] **Step 1: Write failing tests for auth routes**

Create `backend/tests/routes/auth.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Auth routes', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-auth.db');
  let app;

  before(() => {
    // Clean up any previous test db
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt-secret-auth';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';

    // Clear cached modules so server picks up test env
    delete require.cache[require.resolve('../src/server')];
    ({ app } = require('../src/server'));
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('POST /api/auth/login should return username and set cookie on valid credentials', async () => {
    const res = await makeFetch(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'changeme123' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, 'admin');

    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Should set a cookie');
    assert.ok(setCookie.includes('gameshelf_session='), 'Cookie should be named gameshelf_session');
    assert.ok(setCookie.includes('HttpOnly'), 'Cookie should be HttpOnly');
    assert.ok(setCookie.includes('SameSite=Strict'), 'Cookie should be SameSite=Strict');
  });

  it('POST /api/auth/login should return 401 on wrong password', async () => {
    const res = await makeFetch(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrongpassword' }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Invalid credentials');
  });

  it('POST /api/auth/login should return 401 on non-existent user (timing-safe)', async () => {
    const res = await makeFetch(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'wrongpassword' }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Invalid credentials');
  });

  it('GET /api/auth/me should return 401 without cookie', async () => {
    const res = await makeFetch(app, '/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('GET /api/auth/me should return username with valid cookie', async () => {
    // Login first to get the cookie
    const loginRes = await makeFetch(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'changeme123' }),
    });
    const setCookie = loginRes.headers.get('set-cookie');
    const cookie = setCookie.split(';')[0]; // "gameshelf_session=<token>"

    const res = await makeFetch(app, '/api/auth/me', {
      headers: { Cookie: cookie },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, 'admin');
  });

  it('POST /api/auth/logout should clear the cookie', async () => {
    const res = await makeFetch(app, '/api/auth/logout', { method: 'POST' });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Should set a cookie to clear it');
    assert.ok(setCookie.includes('gameshelf_session='), 'Should reference the session cookie');
  });
});

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/routes/auth.test.js`

Expected: FAIL — routes return 501

- [ ] **Step 3: Implement auth routes**

Replace contents of `backend/src/routes/auth.js`:

```javascript
const { Router } = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const authMiddleware = require('../middleware/auth');

const router = Router();

// Dummy hash for timing-safe comparison when user is not found
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const db = req.app.locals.db;
    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);

    // Compare against real hash or dummy hash (prevents timing-based enumeration)
    const hashToCompare = user ? user.password_hash : DUMMY_HASH;
    const valid = await bcrypt.compare(password, hashToCompare);

    if (!user || !valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.GAMESHELF_JWT_SECRET,
      { expiresIn: '24h' }
    );

    const isProduction = process.env.NODE_ENV === 'production';

    res.cookie('gameshelf_session', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'Strict',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      path: '/',
    });

    res.json({ username: user.username });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';

  res.clearCookie('gameshelf_session', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'Strict',
    path: '/',
  });

  res.json({ ok: true });
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

module.exports = router;
```

- [ ] **Step 4: Run auth route tests to verify they pass**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/routes/auth.test.js`

Expected: All 6 tests PASS

- [ ] **Step 5: Update server.test.js — fix the 501 assertion for /api/auth**

The test at `backend/tests/server.test.js:36-42` expects `/api/auth` to return 501. Auth routes are now implemented, so this test needs updating. Change it to expect 401 (since GET /api/auth/me without a cookie returns 401 via the auth middleware, and there's no catch-all 501 handler anymore):

Actually, the catch-all `router.use` handler in the old auth.js was replaced. A GET to `/api/auth` with no matching route will now fall through to Express's default 404 or the error handler. The proper fix: change the test to hit `GET /api/auth/me` and expect 401 (no cookie).

```javascript
it('GET /api/auth/me should return 401 without auth', async () => {
  delete require.cache[require.resolve('../src/server')];
  const { app } = require('../src/server');

  const res = await makeFetch(app, '/api/auth/me');
  assert.equal(res.status, 401);
});
```

- [ ] **Step 6: Run all tests to verify nothing is broken**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && npm test`

Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/auth.js backend/tests/routes/auth.test.js backend/tests/server.test.js
git commit -m "feat: implement auth routes (login/logout/me) with tests"
```

---

### Task 4: TOTP utility

**Files:**
- Create: `backend/src/utils/totp.js`
- Create: `backend/tests/utils/totp.test.js`

- [ ] **Step 1: Write failing tests for TOTP utility**

Create `backend/tests/utils/totp.test.js`:

```javascript
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

describe('TOTP utility', () => {
  let totp;

  before(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    totp = require('../src/utils/totp');
  });

  describe('generateTOTPCode', () => {
    it('should return a 6-digit string', () => {
      // Base32 encoded test secret
      const secret = 'JBSWY3DPEHPK3PXP';
      const code = totp.generateTOTPCode(secret);
      assert.match(code, /^\d{6}$/, 'Should be exactly 6 digits');
    });

    it('should return consistent codes for same secret within same time window', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const code1 = totp.generateTOTPCode(secret);
      const code2 = totp.generateTOTPCode(secret);
      assert.equal(code1, code2);
    });
  });

  describe('generateQRSetupData', () => {
    it('should return a valid otpauth URI', () => {
      const uri = totp.generateQRSetupData('steam', 'testuser', 'JBSWY3DPEHPK3PXP');
      assert.ok(uri.startsWith('otpauth://totp/'), 'Should start with otpauth://totp/');
      assert.ok(uri.includes('Gameshelf'), 'Should include issuer');
      assert.ok(uri.includes('secret='), 'Should include secret parameter');
    });

    it('should include launcher and username in the label', () => {
      const uri = totp.generateQRSetupData('epic', 'myuser', 'JBSWY3DPEHPK3PXP');
      assert.ok(uri.includes('epic'), 'Should include launcher id');
      assert.ok(uri.includes('myuser'), 'Should include username');
    });
  });

  describe('generateSteamCode', () => {
    it('should return a 5-character alphanumeric code', () => {
      // Example Steam shared_secret (base64)
      const sharedSecret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const code = totp.generateSteamCode(sharedSecret);
      assert.equal(typeof code, 'string');
      assert.equal(code.length, 5, 'Steam codes are 5 characters');
      // Steam alphabet: 23456789BCDFGHJKMNPQRTVWXY
      assert.match(code, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/utils/totp.test.js`

Expected: FAIL — `Cannot find module '../src/utils/totp'`

- [ ] **Step 3: Implement TOTP utility**

Create `backend/src/utils/totp.js`:

```javascript
const { TOTP } = require('otpauth');
const SteamTotp = require('steam-totp');

/**
 * Generate a standard 6-digit TOTP code from a base32-encoded secret.
 * Uses SHA-1 algorithm, 6 digits, 30-second period (RFC 6238 defaults).
 */
function generateTOTPCode(secret) {
  const instance = new TOTP({
    secret,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
  return instance.generate();
}

/**
 * Generate an otpauth:// URI suitable for QR code rendering.
 * The user can scan this to verify their TOTP secret matches their authenticator app.
 */
function generateQRSetupData(launcherId, username, secret) {
  const instance = new TOTP({
    issuer: 'Gameshelf',
    label: `${launcherId}:${username}`,
    secret,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
  return instance.toString();
}

/**
 * Generate a Steam Guard authentication code from a shared_secret.
 *
 * Steam uses a non-standard TOTP implementation:
 * - Secret is base64-encoded (not base32)
 * - Produces 5-character codes instead of 6-digit codes
 * - Uses a custom alphabet: 23456789BCDFGHJKMNPQRTVWXY
 * - Follows the Steam Guard Mobile Authenticator protocol
 *
 * The shared_secret must be obtained from an already-linked Steam Mobile
 * Authenticator or exported via Steam Desktop Authenticator.
 */
function generateSteamCode(sharedSecret) {
  return SteamTotp.generateAuthCode(sharedSecret);
}

module.exports = { generateTOTPCode, generateQRSetupData, generateSteamCode };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/utils/totp.test.js`

Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/totp.js backend/tests/utils/totp.test.js
git commit -m "feat: add TOTP utility with standard and Steam Guard support"
```

---

### Task 5: Setup routes

**Files:**
- Modify: `backend/src/routes/setup.js`
- Create: `backend/tests/routes/setup.test.js`

- [ ] **Step 1: Write failing tests for setup routes**

Create `backend/tests/routes/setup.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-setup';

describe('Setup routes', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-setup.db');
  let app;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';

    delete require.cache[require.resolve('../src/server')];
    ({ app } = require('../src/server'));
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

  it('GET /api/setup/status should return 401 without auth', async () => {
    const res = await makeFetch(app, '/api/setup/status');
    assert.equal(res.status, 401);
  });

  it('GET /api/setup/status should return {complete: false} initially', async () => {
    const res = await makeFetch(app, '/api/setup/status', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.complete, false);
  });

  it('GET /api/setup/qr/:launcher_id should return 404 when no credentials stored', async () => {
    const res = await makeFetch(app, '/api/setup/qr/steam', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 404);
  });

  it('GET /api/setup/qr/:launcher_id should return URI when credentials with TOTP secret exist', async () => {
    // First, save credentials with a totp_secret via the launchers route
    await makeFetch(app, '/api/launchers/steam/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'steamuser', password: 'pass', totp_secret: 'JBSWY3DPEHPK3PXP' }),
    });

    const res = await makeFetch(app, '/api/setup/qr/steam', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.uri.startsWith('otpauth://totp/'), 'Should return an otpauth URI');
    assert.ok(body.uri.includes('secret='), 'URI should contain the secret');
  });

  it('GET /api/setup/qr/:launcher_id should return 400 when no TOTP secret in credentials', async () => {
    // Save credentials without totp_secret for gog
    await makeFetch(app, '/api/launchers/gog/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'goguser', password: 'pass' }),
    });

    const res = await makeFetch(app, '/api/setup/qr/gog', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/setup/complete should mark setup as complete', async () => {
    const res = await makeFetch(app, '/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    // Verify status is now complete
    const statusRes = await makeFetch(app, '/api/setup/status', {
      headers: { Cookie: authCookie() },
    });
    const statusBody = await statusRes.json();
    assert.equal(statusBody.complete, true);
  });
});

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/routes/setup.test.js`

Expected: FAIL — routes return 501

- [ ] **Step 3: Implement setup routes**

Replace contents of `backend/src/routes/setup.js`:

```javascript
const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { generateQRSetupData } = require('../utils/totp');
const { decrypt } = require('../utils/encrypt');

const router = Router();

// All setup routes require authentication
router.use(authMiddleware);

// GET /api/setup/status
router.get('/status', (req, res) => {
  const db = req.app.locals.db;

  // Check if any launcher is enabled with credentials
  const enabledLauncher = db.prepare(
    'SELECT id FROM launchers WHERE enabled = 1 AND credentials_json IS NOT NULL'
  ).get();

  if (enabledLauncher) {
    return res.json({ complete: true });
  }

  // Fallback: check settings table
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('setup_complete');
  res.json({ complete: setting ? setting.value === 'true' : false });
});

// POST /api/setup/complete
router.post('/complete', (req, res) => {
  const db = req.app.locals.db;

  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('setup_complete', 'true');

  res.json({ ok: true });
});

// GET /api/setup/qr/:launcher_id
router.get('/qr/:launcher_id', (req, res) => {
  const db = req.app.locals.db;
  const { launcher_id } = req.params;

  const launcher = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get(launcher_id);

  if (!launcher || !launcher.credentials_json) {
    return res.status(404).json({ error: 'Launcher not found or no credentials stored' });
  }

  const credentials = JSON.parse(decrypt(launcher.credentials_json));

  if (!credentials.totp_secret) {
    return res.status(400).json({ error: 'No TOTP secret configured for this launcher' });
  }

  const uri = generateQRSetupData(launcher_id, credentials.username || launcher_id, credentials.totp_secret);
  res.json({ uri });
});

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/routes/setup.test.js`

Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/setup.js backend/tests/routes/setup.test.js
git commit -m "feat: implement setup routes (status/complete/qr)"
```

---

### Task 6: Launcher routes

**Files:**
- Modify: `backend/src/routes/launchers.js`
- Create: `backend/tests/routes/launchers.test.js`

- [ ] **Step 1: Write failing tests for launcher routes**

Create `backend/tests/routes/launchers.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-launchers';

describe('Launcher routes', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-launchers.db');
  let app;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';

    delete require.cache[require.resolve('../src/server')];
    ({ app } = require('../src/server'));
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

  it('GET /api/launchers/available should return 9 launchers', async () => {
    const res = await makeFetch(app, '/api/launchers/available', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 9);
    assert.equal(body[0].id, 'steam');
    assert.equal(body[0].display_name, 'Steam');
  });

  it('POST /api/launchers/:id/credentials should save encrypted credentials', async () => {
    const res = await makeFetch(app, '/api/launchers/steam/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'mysteam', password: 'pass123' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });

  it('POST /api/launchers/:id/credentials should reject invalid launcher', async () => {
    const res = await makeFetch(app, '/api/launchers/fakeLauncher/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'user', password: 'pass' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/launchers/:id/credentials should validate required fields for api_key type', async () => {
    const res = await makeFetch(app, '/api/launchers/itchio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'user', password: 'pass' }),
    });
    assert.equal(res.status, 400);
  });

  it('GET /api/launchers/:id/test should return stub response', async () => {
    // First save credentials for steam
    await makeFetch(app, '/api/launchers/steam/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'mysteam', password: 'pass123' }),
    });

    const res = await makeFetch(app, '/api/launchers/steam/test', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.message.includes('Steam'));
  });

  it('POST /api/launchers/priority should update priorities', async () => {
    // Save credentials for gog too
    await makeFetch(app, '/api/launchers/gog/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'goguser', password: 'gogpass' }),
    });

    const res = await makeFetch(app, '/api/launchers/priority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify([
        { name: 'steam', priority: 1 },
        { name: 'gog', priority: 2 },
      ]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });
});

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/routes/launchers.test.js`

Expected: FAIL — routes return 501

- [ ] **Step 3: Implement launcher routes**

Replace contents of `backend/src/routes/launchers.js`:

```javascript
const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/encrypt');

const router = Router();

// All launcher routes require authentication
router.use(authMiddleware);

// Static list of supported launchers
const AVAILABLE_LAUNCHERS = [
  { id: 'steam', display_name: 'Steam', auth_type: 'credentials+totp', otp_supported: true, qr_supported: true },
  { id: 'ea', display_name: 'EA App', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'epic', display_name: 'Epic Games', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'humble', display_name: 'Humble Bundle', auth_type: 'credentials', otp_supported: false, qr_supported: false },
  { id: 'itchio', display_name: 'itch.io', auth_type: 'api_key', otp_supported: false, qr_supported: false },
  { id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: false, qr_supported: false },
  { id: 'battlenet', display_name: 'Battle.net', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'xbox', display_name: 'Xbox / Microsoft', auth_type: 'credentials', otp_supported: false, qr_supported: false },
];

const LAUNCHER_MAP = Object.fromEntries(AVAILABLE_LAUNCHERS.map(l => [l.id, l]));

// GET /api/launchers/available
router.get('/available', (req, res) => {
  res.json(AVAILABLE_LAUNCHERS);
});

// POST /api/launchers/:id/credentials
router.post('/:id/credentials', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const { username, password, api_key, totp_secret } = req.body || {};

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

  const payload = {};
  if (username) payload.username = username;
  if (password) payload.password = password;
  if (api_key) payload.api_key = api_key;
  if (totp_secret) payload.totp_secret = totp_secret;

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

// GET /api/launchers/:id/test
router.get('/:id/test', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const row = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get(id);

  if (!row || !row.credentials_json) {
    return res.status(404).json({ error: 'No credentials stored for this launcher' });
  }

  // Decrypt to verify credentials are valid (readable)
  decrypt(row.credentials_json);

  // TODO: Implement actual auth endpoint pinging per launcher
  res.json({ success: true, message: `Connection test not yet implemented for ${launcher.display_name}` });
});

// POST /api/launchers/priority
router.post('/priority', (req, res) => {
  const priorities = req.body;

  if (!Array.isArray(priorities)) {
    return res.status(400).json({ error: 'Expected an array of {name, priority}' });
  }

  const db = req.app.locals.db;
  const update = db.prepare('UPDATE launchers SET priority = ? WHERE name = ?');

  const updateAll = db.transaction((items) => {
    for (const { name, priority } of items) {
      update.run(priority, name);
    }
  });

  updateAll(priorities);

  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && node --test tests/routes/launchers.test.js`

Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/launchers.js backend/tests/routes/launchers.test.js
git commit -m "feat: implement launcher routes (available/credentials/test/priority)"
```

---

### Task 7: Sync stub route

**Files:**
- Modify: `backend/src/routes/sync.js`

- [ ] **Step 1: Replace sync.js stub**

Replace contents of `backend/src/routes/sync.js`:

```javascript
const { Router } = require('express');
const authMiddleware = require('../middleware/auth');

const router = Router();

router.use(authMiddleware);

// POST /api/sync/all
// TODO: Implement real sync — iterate enabled launchers, create sync_jobs, fetch game lists
router.post('/all', (req, res) => {
  res.json({ status: 'started' });
});

module.exports = router;
```

- [ ] **Step 2: Run all backend tests to ensure nothing is broken**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && npm test`

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/sync.js
git commit -m "feat: stub sync/all route with auth middleware"
```

---

### Task 8: TailwindCSS infrastructure

**Files:**
- Create: `frontend/tailwind.config.cjs`
- Create: `frontend/postcss.config.cjs`
- Create: `frontend/src/index.css`
- Modify: `frontend/src/main.jsx`

- [ ] **Step 1: Create TailwindCSS config**

Create `frontend/tailwind.config.cjs`:

```javascript
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
```

- [ ] **Step 2: Create PostCSS config**

Create `frontend/postcss.config.cjs`:

```javascript
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 3: Create index.css with Tailwind directives**

Create `frontend/src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 4: Import index.css in main.jsx**

Update `frontend/src/main.jsx` — add `import './index.css';` before the App import:

```javascript
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 5: Verify Tailwind builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/frontend && npx vite build`

Expected: Build succeeds without errors

- [ ] **Step 6: Commit**

```bash
git add frontend/tailwind.config.cjs frontend/postcss.config.cjs frontend/src/index.css frontend/src/main.jsx
git commit -m "feat: add TailwindCSS infrastructure"
```

---

### Task 9: Route guards (RequireAuth & RequireSetup)

**Files:**
- Create: `frontend/src/components/RequireAuth.jsx`
- Create: `frontend/src/components/RequireSetup.jsx`

- [ ] **Step 1: Create RequireAuth component**

Create `frontend/src/components/RequireAuth.jsx`:

```jsx
import { useState, useEffect } from 'react';
import { Outlet, Navigate } from 'react-router-dom';

export default function RequireAuth() {
  const [status, setStatus] = useState('loading'); // 'loading' | 'authenticated' | 'unauthenticated'

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((res) => {
        setStatus(res.ok ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => {
        setStatus('unauthenticated');
      });
  }, []);

  if (status === 'loading') return null;
  if (status === 'unauthenticated') return <Navigate to="/login" replace />;
  return <Outlet />;
}
```

- [ ] **Step 2: Create RequireSetup component**

Create `frontend/src/components/RequireSetup.jsx`:

```jsx
import { useState, useEffect } from 'react';
import { Outlet, Navigate } from 'react-router-dom';

export default function RequireSetup() {
  const [status, setStatus] = useState('loading'); // 'loading' | 'complete' | 'incomplete'

  useEffect(() => {
    fetch('/api/setup/status', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((data) => {
        setStatus(data.complete ? 'complete' : 'incomplete');
      })
      .catch(() => {
        setStatus('incomplete');
      });
  }, []);

  if (status === 'loading') return null;
  if (status === 'incomplete') return <Navigate to="/setup" replace />;
  return <Outlet />;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/RequireAuth.jsx frontend/src/components/RequireSetup.jsx
git commit -m "feat: add RequireAuth and RequireSetup route guard components"
```

---

### Task 10: App.jsx routing and placeholder pages

**Files:**
- Modify: `frontend/src/App.jsx`
- Create: `frontend/src/pages/Library.jsx`
- Create: `frontend/src/pages/Settings.jsx`
- Create: `frontend/src/pages/Login.jsx` (placeholder — full implementation in Task 11)

- [ ] **Step 1: Create placeholder Library page**

Create `frontend/src/pages/Library.jsx`:

```jsx
export default function Library() {
  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
      <h1 className="text-3xl font-bold">Library</h1>
    </div>
  );
}
```

- [ ] **Step 2: Create placeholder Settings page**

Create `frontend/src/pages/Settings.jsx`:

```jsx
export default function Settings() {
  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
      <h1 className="text-3xl font-bold">Settings</h1>
    </div>
  );
}
```

- [ ] **Step 3: Create placeholder Login page**

Create `frontend/src/pages/Login.jsx` (will be fully implemented in Task 11):

```jsx
export default function Login() {
  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
      <h1 className="text-3xl font-bold">Login</h1>
    </div>
  );
}
```

- [ ] **Step 4: Update App.jsx with React Router**

Replace contents of `frontend/src/App.jsx`:

```jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import RequireSetup from './components/RequireSetup';
import Login from './pages/Login';
import Library from './pages/Library';
import Settings from './pages/Settings';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        {/* Authenticated routes */}
        <Route element={<RequireAuth />}>
          <Route path="/setup" element={<div>Setup placeholder</div>} />
          <Route path="/settings" element={<Settings />} />

          {/* Authenticated + setup complete */}
          <Route element={<RequireSetup />}>
            <Route path="/library" element={<Library />} />
          </Route>
        </Route>

        {/* Default redirect */}
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 5: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.jsx frontend/src/pages/Login.jsx frontend/src/pages/Library.jsx frontend/src/pages/Settings.jsx
git commit -m "feat: add React Router with route guards and placeholder pages"
```

---

### Task 11: Login page (full implementation)

**Files:**
- Modify: `frontend/src/pages/Login.jsx`

- [ ] **Step 1: Implement Login page with TailwindCSS dark theme**

Replace contents of `frontend/src/pages/Login.jsx`:

```jsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });

      if (res.status === 401) {
        setError('Invalid credentials');
        setLoading(false);
        return;
      }

      if (!res.ok) {
        setError('Something went wrong');
        setLoading(false);
        return;
      }

      // Check setup status to decide where to navigate
      const setupRes = await fetch('/api/setup/status', { credentials: 'same-origin' });
      const setupData = await setupRes.json();

      if (!setupData.complete) {
        navigate('/setup');
      } else {
        navigate('/library');
      }
    } catch {
      setError('Something went wrong');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-bold text-white text-center mb-8">Gameshelf</h1>

        <form onSubmit={handleSubmit} className="bg-gray-800 rounded-lg shadow-lg p-6 space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-300 mb-1">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Login.jsx
git commit -m "feat: implement login page with dark theme and error handling"
```

---

### Task 12: Setup wizard — Steps 1–2 (Welcome + Select Launchers)

**Files:**
- Create: `frontend/src/pages/Setup.jsx`
- Modify: `frontend/src/App.jsx` (replace setup placeholder with Setup component)

- [ ] **Step 1: Create Setup.jsx with Steps 1 and 2**

Create `frontend/src/pages/Setup.jsx`:

```jsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Setup() {
  const [step, setStep] = useState(1);
  const [availableLaunchers, setAvailableLaunchers] = useState([]);
  const [selectedLaunchers, setSelectedLaunchers] = useState([]);
  const [credentials, setCredentials] = useState({});
  const navigate = useNavigate();

  // Fetch available launchers on mount
  useEffect(() => {
    fetch('/api/launchers/available', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then(setAvailableLaunchers)
      .catch(() => {});
  }, []);

  function toggleLauncher(launcher) {
    setSelectedLaunchers((prev) => {
      const exists = prev.find((l) => l.id === launcher.id);
      if (exists) {
        return prev.filter((l) => l.id !== launcher.id);
      }
      return [...prev, launcher];
    });
  }

  // Step 1: Welcome
  if (step === 1) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <h1 className="text-4xl font-bold text-white mb-4">Welcome to Gameshelf</h1>
          <p className="text-gray-400 mb-8">
            Gameshelf unifies your game libraries from multiple launchers into a single view.
            Let's set up your accounts.
          </p>
          <button
            onClick={() => setStep(2)}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            Begin Setup
          </button>
        </div>
      </div>
    );
  }

  // Step 2: Select Launchers
  if (step === 2) {
    return (
      <div className="min-h-screen bg-gray-900 px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-2">Select Your Launchers</h2>
          <p className="text-gray-400 mb-6">Choose which game stores you use.</p>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
            {availableLaunchers.map((launcher) => {
              const isSelected = selectedLaunchers.some((l) => l.id === launcher.id);
              return (
                <button
                  key={launcher.id}
                  onClick={() => toggleLauncher(launcher)}
                  className={`p-4 rounded-lg border-2 text-left transition-colors ${
                    isSelected
                      ? 'border-blue-500 bg-gray-800'
                      : 'border-gray-700 bg-gray-800 hover:border-gray-500'
                  }`}
                >
                  <div className="text-white font-medium">{launcher.display_name}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    {launcher.auth_type === 'api_key' ? 'API Key' : 'Username/Password'}
                    {launcher.otp_supported && ' + 2FA'}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex justify-between">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              disabled={selectedLaunchers.length === 0}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Placeholder for steps 3-5 (implemented in subsequent tasks)
  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <p className="text-white">Step {step} — coming next</p>
    </div>
  );
}
```

- [ ] **Step 2: Update App.jsx to use Setup component**

In `frontend/src/App.jsx`, add the import and replace the setup placeholder:

Change the import section to include Setup:
```jsx
import Setup from './pages/Setup';
```

Change the setup route from:
```jsx
<Route path="/setup" element={<div>Setup placeholder</div>} />
```
to:
```jsx
<Route path="/setup" element={<Setup />} />
```

- [ ] **Step 3: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Setup.jsx frontend/src/App.jsx
git commit -m "feat: add setup wizard with welcome and launcher selection steps"
```

---

### Task 13: Setup wizard — Step 3 (Configure Credentials)

**Files:**
- Modify: `frontend/src/pages/Setup.jsx`

- [ ] **Step 1: Add Step 3 credential configuration to Setup.jsx**

In `frontend/src/pages/Setup.jsx`, add the `qrcode.react` import at the top:

```jsx
import { QRCodeSVG } from 'qrcode.react';
```

Replace the placeholder comment `// Placeholder for steps 3-5 (implemented in subsequent tasks)` and the return block after step 2 with the Step 3 implementation. Insert this block before the final fallback return:

```jsx
  // Step 3: Configure Credentials
  if (step === 3) {
    async function saveCredentials(launcher) {
      const creds = credentials[launcher.id] || {};
      try {
        const res = await fetch(`/api/launchers/${launcher.id}/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(creds),
        });
        if (res.ok) {
          setCredentials((prev) => ({
            ...prev,
            [launcher.id]: { ...prev[launcher.id], saved: true, error: '' },
          }));
        } else {
          const data = await res.json();
          setCredentials((prev) => ({
            ...prev,
            [launcher.id]: { ...prev[launcher.id], saved: false, error: data.error || 'Failed to save' },
          }));
        }
      } catch {
        setCredentials((prev) => ({
          ...prev,
          [launcher.id]: { ...prev[launcher.id], saved: false, error: 'Network error' },
        }));
      }
    }

    async function testConnection(launcher) {
      setCredentials((prev) => ({
        ...prev,
        [launcher.id]: { ...prev[launcher.id], testing: true, testResult: null },
      }));
      try {
        const res = await fetch(`/api/launchers/${launcher.id}/test`, { credentials: 'same-origin' });
        const data = await res.json();
        setCredentials((prev) => ({
          ...prev,
          [launcher.id]: { ...prev[launcher.id], testing: false, testResult: data },
        }));
      } catch {
        setCredentials((prev) => ({
          ...prev,
          [launcher.id]: { ...prev[launcher.id], testing: false, testResult: { success: false, error: 'Network error' } },
        }));
      }
    }

    async function loadQR(launcher) {
      try {
        const res = await fetch(`/api/setup/qr/${launcher.id}`, { credentials: 'same-origin' });
        const data = await res.json();
        setCredentials((prev) => ({
          ...prev,
          [launcher.id]: { ...prev[launcher.id], qrUri: data.uri },
        }));
      } catch {
        // QR load failed silently
      }
    }

    function updateField(launcherId, field, value) {
      setCredentials((prev) => ({
        ...prev,
        [launcherId]: { ...prev[launcherId], [field]: value, saved: false },
      }));
    }

    const allSaved = selectedLaunchers.every((l) => credentials[l.id]?.saved);

    return (
      <div className="min-h-screen bg-gray-900 px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-2">Configure Credentials</h2>
          <p className="text-gray-400 mb-6">Enter your login details for each launcher.</p>

          <div className="space-y-6">
            {selectedLaunchers.map((launcher) => {
              const creds = credentials[launcher.id] || {};
              const showCredentials = launcher.auth_type.includes('credentials');
              const showApiKey = launcher.auth_type === 'api_key';

              return (
                <div key={launcher.id} className="bg-gray-800 rounded-lg p-4">
                  <h3 className="text-lg font-semibold text-white mb-3">{launcher.display_name}</h3>

                  {showCredentials && (
                    <>
                      <div className="mb-3">
                        <label className="block text-sm text-gray-300 mb-1">Username</label>
                        <input
                          type="text"
                          value={creds.username || ''}
                          onChange={(e) => updateField(launcher.id, 'username', e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div className="mb-3">
                        <label className="block text-sm text-gray-300 mb-1">Password</label>
                        <input
                          type="password"
                          value={creds.password || ''}
                          onChange={(e) => updateField(launcher.id, 'password', e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </>
                  )}

                  {showApiKey && (
                    <div className="mb-3">
                      <label className="block text-sm text-gray-300 mb-1">API Key</label>
                      <input
                        type="password"
                        value={creds.api_key || ''}
                        onChange={(e) => updateField(launcher.id, 'api_key', e.target.value)}
                        className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}

                  {launcher.otp_supported && (
                    <div className="mb-3">
                      <label className="flex items-center gap-2 text-sm text-gray-300 mb-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!creds.totpEnabled}
                          onChange={(e) => updateField(launcher.id, 'totpEnabled', e.target.checked)}
                          className="rounded"
                        />
                        Enable 2FA
                      </label>

                      {creds.totpEnabled && (
                        <div className="ml-4 space-y-2">
                          {launcher.id === 'steam' && (
                            <div className="text-yellow-400 text-xs bg-yellow-400/10 p-2 rounded">
                              Steam Guard requires scanning with the Steam Mobile App. Enter your
                              shared_secret from an already-linked authenticator or use the Steam
                              Desktop Authenticator tool to export it.
                            </div>
                          )}
                          <div>
                            <label className="block text-sm text-gray-300 mb-1">TOTP Secret</label>
                            <input
                              type="text"
                              value={creds.totp_secret || ''}
                              onChange={(e) => updateField(launcher.id, 'totp_secret', e.target.value)}
                              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                          {creds.saved && (
                            <button
                              onClick={() => loadQR(launcher)}
                              className="text-sm text-blue-400 hover:text-blue-300"
                            >
                              Or scan QR code
                            </button>
                          )}
                          {creds.qrUri && (
                            <div className="bg-white p-3 rounded inline-block">
                              <QRCodeSVG value={creds.qrUri} size={160} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {creds.error && <p className="text-red-400 text-sm mb-2">{creds.error}</p>}
                  {creds.saved && <p className="text-green-400 text-sm mb-2">Saved</p>}

                  {creds.testResult && (
                    <p className={`text-sm mb-2 ${creds.testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                      {creds.testResult.success ? creds.testResult.message : creds.testResult.error}
                    </p>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => saveCredentials(launcher)}
                      className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
                    >
                      Save
                    </button>
                    {creds.saved && (
                      <button
                        onClick={() => testConnection(launcher)}
                        disabled={creds.testing}
                        className="px-4 py-1.5 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 text-white text-sm rounded transition-colors"
                      >
                        {creds.testing ? 'Testing...' : 'Test Connection'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between mt-8">
            <button
              onClick={() => setStep(2)}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Back
            </button>
            <button
              onClick={() => setStep(4)}
              disabled={!allSaved}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }
```

Keep the final fallback return for steps 4-5.

- [ ] **Step 2: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Setup.jsx
git commit -m "feat: add setup wizard step 3 — credential configuration with TOTP and QR"
```

---

### Task 14: Setup wizard — Step 4 (Launcher Priority)

**Files:**
- Modify: `frontend/src/pages/Setup.jsx`

- [ ] **Step 1: Add dnd-kit imports and Step 4 to Setup.jsx**

Add imports at the top of `frontend/src/pages/Setup.jsx`:

```jsx
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
```

Add a `SortableItem` component inside the file (before the `Setup` function or as a sibling component):

```jsx
function SortableItem({ launcher, index }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: launcher.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="flex items-center gap-3 bg-gray-800 rounded-lg p-3 cursor-grab active:cursor-grabbing"
    >
      <span className="text-gray-500 font-mono text-sm w-6">{index + 1}</span>
      <span className="text-white">{launcher.display_name}</span>
      <span className="text-gray-500 text-xs ml-auto">drag to reorder</span>
    </div>
  );
}
```

**Important — React hooks rule:** The `useSensors`/`useSensor` calls MUST be placed at the top level of the `Setup` component (alongside the other `useState`/`useEffect` hooks), never inside a conditional block. Add these lines right after the existing hooks at the top of `Setup`:

```jsx
  // dnd-kit sensors (must be at top level — hooks cannot be conditional)
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
```

Also add the Step 5 `useEffect` at the top level (will be used by Task 15):

```jsx
  // Step 5 side effects — must be at top level per React hooks rules
  useEffect(() => {
    if (step === 5) {
      fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      }).catch(() => {});

      fetch('/api/sync/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      }).catch(() => {});

      const timer = setTimeout(() => navigate('/library'), 2000);
      return () => clearTimeout(timer);
    }
  }, [step, navigate]);
```

Insert Step 4 block before the final fallback return:

```jsx
  // Step 4: Launcher Priority
  if (step === 4) {
    function handleDragEnd(event) {
      const { active, over } = event;
      if (active.id !== over?.id) {
        setSelectedLaunchers((items) => {
          const oldIndex = items.findIndex((i) => i.id === active.id);
          const newIndex = items.findIndex((i) => i.id === over.id);
          return arrayMove(items, oldIndex, newIndex);
        });
      }
    }

    async function savePriorities() {
      const priorities = selectedLaunchers.map((l, i) => ({ name: l.id, priority: i + 1 }));
      try {
        await fetch('/api/launchers/priority', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(priorities),
        });
        setStep(5);
      } catch {
        // Priority save failed — proceed anyway
        setStep(5);
      }
    }

    return (
      <div className="min-h-screen bg-gray-900 px-4 py-8">
        <div className="max-w-md mx-auto">
          <h2 className="text-2xl font-bold text-white mb-2">Launcher Priority</h2>
          <p className="text-gray-400 mb-6">
            Drag to set deduplication priority. The top launcher wins when the same game appears in multiple stores.
          </p>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={selectedLaunchers.map((l) => l.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {selectedLaunchers.map((launcher, index) => (
                  <SortableItem key={launcher.id} launcher={launcher} index={index} />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          <div className="flex justify-between mt-8">
            <button
              onClick={() => setStep(3)}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Back
            </button>
            <button
              onClick={savePriorities}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Setup.jsx
git commit -m "feat: add setup wizard step 4 — drag-and-drop launcher priority"
```

---

### Task 15: Setup wizard — Step 5 (Done) and final cleanup

**Files:**
- Modify: `frontend/src/pages/Setup.jsx`

- [ ] **Step 1: Add Step 5 render to Setup.jsx**

The `useEffect` for Step 5 was already added at the top level of the component in Task 14 (per React hooks rules). Now replace the final fallback return in `Setup.jsx` with the Step 5 render:

```jsx
  // Step 5 render (useEffect for side effects is at top level of component)
  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <h1 className="text-4xl font-bold text-white mb-4">You're All Set!</h1>
        <p className="text-gray-400">
          Gameshelf is ready. Your library is syncing now.
        </p>
      </div>
    </div>
  );
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd /development/Claude\ Projects/gamelist_manager/frontend && npx vite build`

Expected: Build succeeds

- [ ] **Step 3: Run all backend tests one final time**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && npm test`

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Setup.jsx
git commit -m "feat: add setup wizard step 5 — completion with background sync"
```

---

### Task 16: Final verification and integration commit

- [ ] **Step 1: Verify full backend test suite passes**

Run: `cd /development/Claude\ Projects/gamelist_manager/backend && npm test`

Expected: All tests PASS

- [ ] **Step 2: Verify frontend builds successfully**

Run: `cd /development/Claude\ Projects/gamelist_manager/frontend && npx vite build`

Expected: Build succeeds with no errors

- [ ] **Step 3: Verify file structure matches spec**

Verify all expected files exist:
```bash
ls -la /development/Claude\ Projects/gamelist_manager/backend/src/middleware/auth.js
ls -la /development/Claude\ Projects/gamelist_manager/backend/src/utils/totp.js
ls -la /development/Claude\ Projects/gamelist_manager/backend/src/routes/auth.js
ls -la /development/Claude\ Projects/gamelist_manager/backend/src/routes/setup.js
ls -la /development/Claude\ Projects/gamelist_manager/backend/src/routes/launchers.js
ls -la /development/Claude\ Projects/gamelist_manager/backend/src/routes/sync.js
ls -la /development/Claude\ Projects/gamelist_manager/frontend/src/pages/Login.jsx
ls -la /development/Claude\ Projects/gamelist_manager/frontend/src/pages/Setup.jsx
ls -la /development/Claude\ Projects/gamelist_manager/frontend/src/pages/Library.jsx
ls -la /development/Claude\ Projects/gamelist_manager/frontend/src/pages/Settings.jsx
ls -la /development/Claude\ Projects/gamelist_manager/frontend/src/components/RequireAuth.jsx
ls -la /development/Claude\ Projects/gamelist_manager/frontend/src/components/RequireSetup.jsx
ls -la /development/Claude\ Projects/gamelist_manager/frontend/tailwind.config.cjs
ls -la /development/Claude\ Projects/gamelist_manager/frontend/postcss.config.cjs
```

Expected: All files exist

- [ ] **Step 4: Confirm task completion checklist**

Verify each spec task is implemented:
- Task 1: JWT auth middleware ✓ (backend/src/middleware/auth.js)
- Task 1: Auth routes ✓ (backend/src/routes/auth.js)
- Task 2: Login page ✓ (frontend/src/pages/Login.jsx)
- Task 3: Setup backend ✓ (backend/src/routes/setup.js + launchers.js)
- Task 4: TOTP support ✓ (backend/src/utils/totp.js)
- Task 5: Setup wizard ✓ (frontend/src/pages/Setup.jsx — 5 steps)
- Task 6: Route guards ✓ (RequireAuth.jsx + RequireSetup.jsx + App.jsx routing)
