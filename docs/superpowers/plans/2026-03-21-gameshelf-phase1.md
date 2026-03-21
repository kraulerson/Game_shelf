# Gameshelf Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Gameshelf foundation — database schema, migration runner, encryption utility, Docker config, and Express server skeleton.

**Architecture:** SQLite database accessed via better-sqlite3, Express 5 REST API with placeholder routes, AES-256-GCM encryption for stored credentials, Docker containers for backend (Node) and frontend (Vite/Nginx). All files under `/backend/` and `/frontend/` directories at the project root.

**Tech Stack:** Node.js 20, Express 5, better-sqlite3, bcrypt, jsonwebtoken, cookie-parser, node-cron, dotenv, React 18, Vite, TailwindCSS, Docker, Nginx

---

## File Structure

```
/gameshelf (project root: /development/Claude Projects/gamelist_manager)
├── backend/
│   ├── package.json
│   ├── src/
│   │   ├── server.js                    ← Express app + startup
│   │   ├── db/
│   │   │   ├── schema.sql               ← All CREATE TABLE statements
│   │   │   └── migrate.js               ← Migration runner
│   │   ├── routes/
│   │   │   ├── auth.js                  ← Placeholder
│   │   │   ├── setup.js                 ← Placeholder
│   │   │   ├── launchers.js             ← Placeholder
│   │   │   ├── games.js                 ← Placeholder
│   │   │   └── sync.js                  ← Placeholder
│   │   ├── services/                        ← (empty, future launcher integrations)
│   │   ├── middleware/
│   │   │   └── errorHandler.js          ← Global error handler
│   │   └── utils/
│   │       └── encrypt.js               ← AES-256-GCM encrypt/decrypt
│   └── tests/
│       ├── utils/
│       │   └── encrypt.test.js
│       ├── db/
│       │   └── migrate.test.js
│       └── server.test.js
├── frontend/
│   ├── package.json
│   ├── index.html
│   ├── vite.config.js
│   ├── nginx.conf
│   └── src/
│       ├── main.jsx
│       └── App.jsx
├── docker-compose.yml
├── Dockerfile.backend
├── Dockerfile.frontend
├── .env.example
├── .gitignore
└── README.md
```

**Test framework:** Node.js 20 built-in `node:test` + `node:assert` — no extra dependencies needed.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `backend/package.json`
- Create: `.gitignore`

- [ ] **Step 1: Create backend package.json**

```json
{
  "name": "gameshelf-backend",
  "version": "1.0.0",
  "description": "Gameshelf backend API",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "test": "node --test tests/**/*.test.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "bcrypt": "^5.1.1",
    "cookie-parser": "^1.4.7",
    "dotenv": "^16.4.7",
    "express": "^5.1.0",
    "jsonwebtoken": "^9.0.2",
    "node-cron": "^3.0.3"
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
.env
*.db
*.db-wal
*.db-shm
dist/
data/
.DS_Store
```

- [ ] **Step 3: Install backend dependencies**

Run: `cd backend && npm install`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 4: Commit**

```bash
git add backend/package.json backend/package-lock.json .gitignore
git commit -m "feat: scaffold backend project with dependencies"
```

---

### Task 2: Encryption Utility (TDD)

**Files:**
- Create: `backend/src/utils/encrypt.js`
- Test: `backend/tests/utils/encrypt.test.js`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/utils/encrypt.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('encrypt utility', () => {
  const TEST_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';

  before(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = TEST_KEY;
  });

  after(() => {
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
  });

  it('should encrypt and decrypt a string round-trip', () => {
    // Clear module cache to pick up env var
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt, decrypt } = require('../../src/utils/encrypt');

    const plaintext = 'hello world';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    assert.equal(decrypted, plaintext);
  });

  it('should produce different ciphertext for the same input (random IV)', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt } = require('../../src/utils/encrypt');

    const a = encrypt('same input');
    const b = encrypt('same input');
    assert.notEqual(a, b);
  });

  it('should encrypt/decrypt JSON objects', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt, decrypt } = require('../../src/utils/encrypt');

    const creds = JSON.stringify({ username: 'user', password: 'pass123' });
    const encrypted = encrypt(creds);
    const decrypted = decrypt(encrypted);
    assert.deepEqual(JSON.parse(decrypted), { username: 'user', password: 'pass123' });
  });

  it('should produce base64-encoded output containing iv, tag, data', () => {
    delete require.cache[require.resolve('../../src/utils/encrypt')];
    const { encrypt } = require('../../src/utils/encrypt');

    const encrypted = encrypt('test');
    const parsed = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8'));
    assert.ok(parsed.iv, 'missing iv');
    assert.ok(parsed.tag, 'missing tag');
    assert.ok(parsed.data, 'missing data');
  });

  it('should throw if encryption key is missing', () => {
    delete process.env.GAMESHELF_ENCRYPTION_KEY;
    delete require.cache[require.resolve('../../src/utils/encrypt')];

    assert.throws(
      () => require('../../src/utils/encrypt'),
      /GAMESHELF_ENCRYPTION_KEY/
    );

    // Restore for other tests
    process.env.GAMESHELF_ENCRYPTION_KEY = TEST_KEY;
  });

  it('should throw if encryption key is too short', () => {
    process.env.GAMESHELF_ENCRYPTION_KEY = 'tooshort';
    delete require.cache[require.resolve('../../src/utils/encrypt')];

    assert.throws(
      () => require('../../src/utils/encrypt'),
      /32/
    );

    // Restore
    process.env.GAMESHELF_ENCRYPTION_KEY = TEST_KEY;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/utils/encrypt.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/utils/encrypt.js`:

```javascript
const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const rawKey = process.env.GAMESHELF_ENCRYPTION_KEY;

if (!rawKey) {
  throw new Error(
    'GAMESHELF_ENCRYPTION_KEY environment variable is required. ' +
    'Set it to a random string of 32+ characters.'
  );
}

if (rawKey.length < 32) {
  throw new Error(
    'GAMESHELF_ENCRYPTION_KEY must be at least 32 characters long. ' +
    `Current length: ${rawKey.length}`
  );
}

// Derive a fixed 32-byte key from the passphrase using SHA-256
const key = crypto.createHash('sha256').update(rawKey).digest();

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag().toString('hex');

  const payload = JSON.stringify({
    iv: iv.toString('hex'),
    tag,
    data: encrypted,
  });

  return Buffer.from(payload).toString('base64');
}

function decrypt(ciphertext) {
  const payload = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf8'));

  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const encrypted = payload.data;

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = { encrypt, decrypt };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/utils/encrypt.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/encrypt.js backend/tests/utils/encrypt.test.js
git commit -m "feat: add AES-256-GCM encryption utility with tests"
```

---

### Task 3: Database Schema

**Files:**
- Create: `backend/src/db/schema.sql`

- [ ] **Step 1: Write schema.sql**

```sql
-- Gameshelf Database Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS launchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  credentials_json TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  cover_url TEXT,
  hero_url TEXT,
  icon_url TEXT,
  description TEXT,
  release_year INTEGER,
  developer TEXT,
  publisher TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  launcher_id INTEGER NOT NULL,
  launcher_game_id TEXT,
  launcher_url TEXT,
  owned INTEGER NOT NULL DEFAULT 1,
  install_state TEXT,
  playtime_minutes INTEGER DEFAULT 0,
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(game_id, launcher_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (launcher_id) REFERENCES launchers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS genres (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS game_genres (
  game_id INTEGER NOT NULL,
  genre_id INTEGER NOT NULL,
  PRIMARY KEY (game_id, genre_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_tags (
  game_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (game_id, tag_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  launcher_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  FOREIGN KEY (launcher_id) REFERENCES launchers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_launcher_id ON sync_jobs(launcher_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/db/schema.sql
git commit -m "feat: add database schema with all Phase 1 tables"
```

---

### Task 4: Migration Runner (TDD)

**Files:**
- Create: `backend/src/db/migrate.js`
- Test: `backend/tests/db/migrate.test.js`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/db/migrate.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

describe('migration runner', () => {
  const testDbPath = path.join(__dirname, '..', '..', 'data', 'test-migrate.db');

  before(() => {
    // Ensure data directory exists
    const dir = path.dirname(testDbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  after(() => {
    // Clean up test database files
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('should create all tables', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name);

    assert.deepEqual(tables, [
      'game_editions', 'game_genres', 'game_tags',
      'games', 'genres', 'launchers',
      'settings', 'sync_jobs', 'tags', 'users'
    ]);

    db.close();
  });

  it('should enable WAL mode', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const mode = db.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');

    db.close();
  });

  it('should enable foreign keys', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const fk = db.pragma('foreign_keys', { simple: true });
    assert.equal(fk, 1);

    db.close();
  });

  it('should seed default admin user', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const user = db.prepare('SELECT username FROM users').get();
    assert.equal(user.username, 'admin');

    db.close();
  });

  it('should not duplicate admin user on re-run', () => {
    const { runMigrations } = require('../../src/db/migrate');

    // Run twice
    let db = runMigrations(testDbPath);
    db.close();
    db = runMigrations(testDbPath);

    const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
    assert.equal(count.c, 1);

    db.close();
  });

  it('should hash the admin password with bcrypt', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const user = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
    assert.ok(user.password_hash.startsWith('$2'), 'password should be bcrypt hashed');

    db.close();
  });

  it('should be idempotent — running multiple times does not error', () => {
    const { runMigrations } = require('../../src/db/migrate');

    assert.doesNotThrow(() => {
      const db1 = runMigrations(testDbPath);
      db1.close();
      const db2 = runMigrations(testDbPath);
      db2.close();
      const db3 = runMigrations(testDbPath);
      db3.close();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/db/migrate.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/db/migrate.js`:

```javascript
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;
const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'changeme123';

function runMigrations(dbPath) {
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Set pragmas before anything else
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Read and execute schema inside a transaction
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  db.transaction(() => {
    db.exec(schema);
  })();

  // Seed default admin user if users table is empty
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const hash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, BCRYPT_ROUNDS);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      DEFAULT_ADMIN_USER,
      hash
    );
  }

  return db;
}

module.exports = { runMigrations };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/db/migrate.test.js`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/migrate.js backend/tests/db/migrate.test.js
git commit -m "feat: add migration runner with admin seed and tests"
```

---

### Task 5: Express Server Skeleton (TDD)

**Files:**
- Create: `backend/src/server.js`
- Create: `backend/src/middleware/errorHandler.js`
- Create: `backend/src/routes/auth.js`
- Create: `backend/src/routes/setup.js`
- Create: `backend/src/routes/launchers.js`
- Create: `backend/src/routes/games.js`
- Create: `backend/src/routes/sync.js`
- Test: `backend/tests/server.test.js`

- [ ] **Step 1: Create placeholder routers**

All five routers follow the same pattern. Create each:

`backend/src/routes/auth.js`:
```javascript
const { Router } = require('express');
const router = Router();

// TODO: Implement auth routes (login, logout, me)
router.use((req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
```

`backend/src/routes/setup.js`:
```javascript
const { Router } = require('express');
const router = Router();

// TODO: Implement setup routes (first-run wizard)
router.use((req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
```

`backend/src/routes/launchers.js`:
```javascript
const { Router } = require('express');
const router = Router();

// TODO: Implement launcher CRUD routes
router.use((req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
```

`backend/src/routes/games.js`:
```javascript
const { Router } = require('express');
const router = Router();

// TODO: Implement game listing/detail routes
router.use((req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
```

`backend/src/routes/sync.js`:
```javascript
const { Router } = require('express');
const router = Router();

// TODO: Implement sync trigger/status routes
router.use((req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
```

- [ ] **Step 2: Create error handler middleware**

Create `backend/src/middleware/errorHandler.js`:

```javascript
function errorHandler(err, req, res, next) {
  console.error(err);

  const status = err.status || err.statusCode || 500;
  const message =
    process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error';

  res.status(status).json({ error: message });
}

module.exports = errorHandler;
```

- [ ] **Step 3: Write server tests**

Create `backend/tests/server.test.js`:

```javascript
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Express server', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-server.db');

  before(() => {
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt-secret';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('GET /api/health should return status ok', async () => {
    // Clear cache to pick up env vars
    delete require.cache[require.resolve('../src/server')];
    const { app } = require('../src/server');

    const res = await makeFetch(app, '/api/health');
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.version, '1.0.0');
    assert.equal(body.app, 'Gameshelf');
  });

  it('GET /api/auth should return 501', async () => {
    delete require.cache[require.resolve('../src/server')];
    const { app } = require('../src/server');

    const res = await makeFetch(app, '/api/auth');
    assert.equal(res.status, 501);
  });

  it('GET /api/games should return 501', async () => {
    delete require.cache[require.resolve('../src/server')];
    const { app } = require('../src/server');

    const res = await makeFetch(app, '/api/games');
    assert.equal(res.status, 501);
  });
});

/**
 * Minimal fetch helper that creates a temporary server,
 * makes a request, and closes it. Uses Node 20 built-in fetch.
 */
function makeFetch(app, path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${path}`;
      fetch(url, options)
        .then(resolve)
        .catch(reject)
        .finally(() => server.close());
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd backend && node --test tests/server.test.js`
Expected: FAIL — module not found

- [ ] **Step 5: Write server.js**

Create `backend/src/server.js`:

```javascript
require('dotenv').config();

// Validate required env vars before anything else
const requiredEnv = [
  { name: 'GAMESHELF_ENCRYPTION_KEY', minLength: 32 },
  { name: 'GAMESHELF_JWT_SECRET', minLength: 1 },
];

for (const { name, minLength } of requiredEnv) {
  const val = process.env[name];
  if (!val) {
    console.error(`FATAL: ${name} environment variable is required.`);
    process.exit(1);
  }
  if (val.length < minLength) {
    console.error(
      `FATAL: ${name} must be at least ${minLength} characters. Current: ${val.length}`
    );
    process.exit(1);
  }
}

const express = require('express');
const cookieParser = require('cookie-parser');
const { runMigrations } = require('./db/migrate');
const errorHandler = require('./middleware/errorHandler');

// Routes
const authRouter = require('./routes/auth');
const setupRouter = require('./routes/setup');
const launchersRouter = require('./routes/launchers');
const gamesRouter = require('./routes/games');
const syncRouter = require('./routes/sync');

// Run migrations
const dbPath = process.env.GAMESHELF_DB_PATH || './data/gameshelf.db';
const db = runMigrations(dbPath);

// Create app
const app = express();

// Middleware
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', app: 'Gameshelf' });
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api/setup', setupRouter);
app.use('/api/launchers', launchersRouter);
app.use('/api/games', gamesRouter);
app.use('/api/sync', syncRouter);

// Global error handler
app.use(errorHandler);

// Start server (only if not imported for testing)
const PORT = process.env.PORT || 3001;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Gameshelf server running on port ${PORT}`);
  });
}

module.exports = { app, db };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && node --test tests/server.test.js`
Expected: All 3 tests PASS

- [ ] **Step 7: Run all tests**

Run: `cd backend && npm test`
Expected: All tests PASS (encrypt: 6, migrate: 7, server: 3)

- [ ] **Step 8: Commit**

```bash
git add backend/src/server.js backend/src/middleware/errorHandler.js \
  backend/src/routes/*.js backend/tests/server.test.js
git commit -m "feat: add Express server skeleton with routes and tests"
```

---

### Task 6: Docker Setup

**Files:**
- Create: `Dockerfile.backend`
- Create: `Dockerfile.frontend`
- Create: `frontend/nginx.conf`
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Create Dockerfile.backend**

```dockerfile
FROM node:20-alpine AS backend

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3, bcrypt)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

# Create non-root user data directory
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

CMD ["node", "src/server.js"]
```

- [ ] **Step 2: Create frontend/nginx.conf**

Create `frontend/nginx.conf`:

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA routing — serve index.html for all non-file requests
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to backend
    location /api/ {
        proxy_pass http://backend:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- [ ] **Step 3: Create Dockerfile.frontend**

```dockerfile
# --- Dev stage ---
FROM node:20-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npx", "vite", "dev", "--host"]

# --- Build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx vite build

# --- Prod stage ---
FROM nginx:alpine AS prod
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

- [ ] **Step 4: Create docker-compose.yml**

```yaml
services:
  backend:
    build:
      context: ./backend
      dockerfile: ../Dockerfile.backend
    ports:
      - "3001:3001"
    env_file: .env
    volumes:
      - gameshelf_data:/app/data
    restart: unless-stopped

  frontend:
    build:
      context: ./frontend
      dockerfile: ../Dockerfile.frontend
      target: ${FRONTEND_TARGET:-prod}
    ports:
      - "${FRONTEND_PORT:-80}:${FRONTEND_INTERNAL_PORT:-80}"
    depends_on:
      - backend
    restart: unless-stopped

volumes:
  gameshelf_data:
```

- [ ] **Step 5: Create .env.example**

```
GAMESHELF_ENCRYPTION_KEY=change_this_to_a_random_32_plus_char_string
GAMESHELF_JWT_SECRET=change_this_too
NODE_ENV=production
PORT=3001
GAMESHELF_DB_PATH=/app/data/gameshelf.db
IGDB_CLIENT_ID=
IGDB_CLIENT_SECRET=

# Docker frontend configuration
# For development: FRONTEND_TARGET=dev FRONTEND_PORT=5173 FRONTEND_INTERNAL_PORT=5173
# For production (default): FRONTEND_TARGET=prod FRONTEND_PORT=80 FRONTEND_INTERNAL_PORT=80
FRONTEND_TARGET=prod
FRONTEND_PORT=80
FRONTEND_INTERNAL_PORT=80
```

- [ ] **Step 6: Commit**

```bash
git add Dockerfile.backend Dockerfile.frontend docker-compose.yml \
  .env.example frontend/nginx.conf
git commit -m "feat: add Docker setup with multi-stage frontend build"
```

---

### Task 7: Frontend Placeholder

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/index.html`
- Create: `frontend/vite.config.js`
- Create: `frontend/src/App.jsx`

- [ ] **Step 1: Create frontend/package.json**

```json
{
  "name": "gameshelf-frontend",
  "version": "1.0.0",
  "description": "Gameshelf frontend",
  "type": "module",
  "scripts": {
    "dev": "vite dev --host",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create frontend/index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gameshelf</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create frontend/src/main.jsx and App.jsx**

Create `frontend/src/main.jsx`:
```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

Create `frontend/src/App.jsx`:
```jsx
export default function App() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <h1>Gameshelf</h1>
    </div>
  );
}
```

- [ ] **Step 4: Create frontend/vite.config.js**

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 5: Install frontend dependencies**

Run: `cd frontend && npm install`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json \
  frontend/index.html frontend/vite.config.js \
  frontend/src/main.jsx frontend/src/App.jsx
git commit -m "feat: add minimal React/Vite frontend placeholder"
```

---

### Task 8: README and Final Verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md**

```markdown
# Gameshelf

Self-hosted game library manager. Aggregates game ownership across Steam, EA, Epic, GOG, and more into a single unified library.

## Quick Start

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env — set GAMESHELF_ENCRYPTION_KEY and GAMESHELF_JWT_SECRET

# Start with Docker
docker compose up -d

# Access
# Frontend: http://localhost
# API: http://localhost:3001/api/health
```

## Development

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend
cd frontend
npm install
npm run dev
```

## Default Credentials

- Username: `admin`
- Password: `changeme123`

## Tech Stack

- Backend: Node.js 20, Express 5, SQLite (better-sqlite3)
- Frontend: React 18, Vite, TailwindCSS
- Auth: JWT with httpOnly cookies
- Encryption: AES-256-GCM for stored credentials
```

- [ ] **Step 2: Run all backend tests one final time**

Run: `cd backend && npm test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with quick start instructions"
```
