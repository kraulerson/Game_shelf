# Gameshelf Phase 1 — Foundation Design Spec

## Overview

Gameshelf is a self-hosted game library web application that aggregates game ownership across multiple launchers (Steam, EA, Ubisoft, Epic, etc.) into a single unified library. It runs inside Docker on a Proxmox home server, accessed via local network or Cloudflare Tunnel.

Phase 1 establishes the foundation: database schema, migration runner, encryption utility, Docker configuration, and Express server skeleton.

## Stack (Locked)

- Backend: Node.js 20 + Express 5
- Frontend: React 18 + Vite + TailwindCSS
- Database: SQLite via better-sqlite3
- Auth: JWT with httpOnly cookies
- Scheduler: node-cron
- Container: Docker + docker-compose v2

## Task 1: Database Schema

File: `/backend/src/db/schema.sql`

### Tables

**users** — App authentication (single-user now, multi-user later)
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `username TEXT NOT NULL UNIQUE`
- `password_hash TEXT NOT NULL` (bcrypt)
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

**launchers** — Game launcher/storefront configurations
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `name TEXT NOT NULL UNIQUE` — enum-like: steam, ea, ubisoft, epic, humble, itchio, gog, battlenet, origin, xbox
- `display_name TEXT NOT NULL`
- `enabled INTEGER NOT NULL DEFAULT 0` — boolean
- `priority INTEGER NOT NULL DEFAULT 0` — lower = higher preference for dedup
- `credentials_json TEXT` — AES-256-GCM encrypted JSON blob (base64 of `{iv, tag, data}`)
- `last_sync_at TEXT`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

**games** — Deduplicated game records
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `title TEXT NOT NULL`
- `slug TEXT NOT NULL UNIQUE` — aggressive normalization for cross-launcher matching
- `cover_url TEXT`
- `hero_url TEXT`
- `icon_url TEXT`
- `description TEXT`
- `release_year INTEGER`
- `developer TEXT`
- `publisher TEXT`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

**game_editions** — One row per launcher-ownership record
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `game_id INTEGER NOT NULL` (FK → games.id, CASCADE delete)
- `launcher_id INTEGER NOT NULL` (FK → launchers.id, CASCADE delete)
- `launcher_game_id TEXT` — external ID from the launcher
- `launcher_url TEXT`
- `owned INTEGER NOT NULL DEFAULT 1` — boolean
- `install_state TEXT` — free-form, each launcher service determines values
- `playtime_minutes INTEGER DEFAULT 0`
- `last_played_at TEXT`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- UNIQUE constraint on `(game_id, launcher_id)` — one edition per launcher per game

**genres** — `id INTEGER PRIMARY KEY AUTOINCREMENT`, `name TEXT NOT NULL UNIQUE`

**tags** — `id INTEGER PRIMARY KEY AUTOINCREMENT`, `name TEXT NOT NULL UNIQUE`

**game_genres** — Junction: `game_id INTEGER NOT NULL` (FK), `genre_id INTEGER NOT NULL` (FK), `PRIMARY KEY (game_id, genre_id)`

**game_tags** — Junction: `game_id INTEGER NOT NULL` (FK), `tag_id INTEGER NOT NULL` (FK), `PRIMARY KEY (game_id, tag_id)`

**sync_jobs** — Sync operation tracking
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `launcher_id INTEGER NOT NULL` (FK → launchers.id, CASCADE delete)
- `status TEXT NOT NULL DEFAULT 'pending'` — pending, running, success, failed
- `started_at TEXT`
- `completed_at TEXT`
- `error_message TEXT`

**settings** — Key-value app settings
- `key TEXT PRIMARY KEY`
- `value TEXT`

### Indexes
- `games.slug` — UNIQUE (via column constraint)
- `game_editions(game_id, launcher_id)` — UNIQUE pair
- `sync_jobs(launcher_id)` — for lookup by launcher

### Pragmas
- `journal_mode=WAL`
- `foreign_keys=ON`

## Task 2: Migration Runner

File: `/backend/src/db/migrate.js`

- Reads and executes `schema.sql` inside a transaction
- All `CREATE TABLE` uses `IF NOT EXISTS` for idempotency — safe on every startup
- Sets `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON` before schema execution
- After schema: checks if `users` table is empty, inserts default admin (`admin` / `changeme123`, bcrypt cost 12)
- DB path from `process.env.GAMESHELF_DB_PATH`, default `./data/gameshelf.db`
- Exports `runMigrations(dbPath)` — called from `server.js` before routes

No versioned migration system yet — single `schema.sql` with `IF NOT EXISTS`. Migration versioning deferred to when schema changes begin.

## Task 3: Encryption Utility

File: `/backend/src/utils/encrypt.js`

- AES-256-GCM with random 12-byte IV per call
- `encrypt(plaintext)` → base64 JSON string: `{"iv":"...","tag":"...","data":"..."}`
- `decrypt(ciphertext)` → plaintext string
- Key derived from `process.env.GAMESHELF_ENCRYPTION_KEY` via SHA-256 at module load (must be 32+ characters)
- Throws hard error at module load if key is missing or too short
- Uses Node.js built-in `crypto` — no external dependencies

## Task 4: Docker Setup

### docker-compose.yml
- Two services: `backend` (port 3001), `frontend` (port 5173 dev / 80 prod)
- Named volume `gameshelf_data` → `/app/data` in backend
- Frontend depends on backend
- Env vars via `env_file: .env`

### Dockerfile.backend
- Node 20 Alpine, non-root `node` user
- Copy `package*.json` → install → copy source
- Health check: `wget --spider http://localhost:3001/api/health`
- Runs as `node`, exposes 3001

### Dockerfile.frontend (multi-stage)
- Build arg `MODE=production` (switchable to `development`)
- Dev: Node 20 Alpine, `vite dev --host`
- Prod: Stage 1 builds with Vite, Stage 2 copies to Nginx Alpine with `nginx.conf` for SPA routing + `/api` proxy to backend

### .env.example
```
GAMESHELF_ENCRYPTION_KEY=change_this_to_a_random_32_plus_char_string
GAMESHELF_JWT_SECRET=change_this_too
NODE_ENV=production
PORT=3001
GAMESHELF_DB_PATH=/app/data/gameshelf.db
IGDB_CLIENT_ID=
IGDB_CLIENT_SECRET=
```

## Task 5: Express Server Skeleton

File: `/backend/src/server.js`

### Startup sequence
1. Validate env vars (`GAMESHELF_ENCRYPTION_KEY` 32+ chars, `GAMESHELF_JWT_SECRET` present) — `process.exit(1)` with clear message on failure
2. Run migrations
3. Register middleware (`express.json()`, `cookie-parser`)
4. Mount routers
5. Start listening

### Routes
- `GET /api/health` → `{status:"ok", version:"1.0.0", app:"Gameshelf"}`
- Placeholder routers: `/api/auth`, `/api/setup`, `/api/launchers`, `/api/games`, `/api/sync`

### Error handling
- Global error handler: logs full error to console
- Returns `{error: message}` in development, `{error: "Internal server error"}` in production
- Never exposes stack traces in production

### package.json dependencies
- `express@5`, `better-sqlite3`, `bcrypt`, `jsonwebtoken`, `cookie-parser`, `node-cron`, `dotenv`
- Scripts: `start` (`node src/server.js`), `dev` (`node --watch src/server.js`)

## Slug Normalization (Service Layer — Not In Schema)

Aggressive normalization for cross-launcher game matching:
- Lowercase
- Strip common articles: "the", "a", "an"
- Strip edition suffixes: "GOTY", "Definitive Edition", "Complete Edition", etc.
- Replace non-alphanumeric with hyphens
- Collapse multiple hyphens
- Trim leading/trailing hyphens

Example: `"The Witcher 3: Wild Hunt - GOTY"` → `"witcher-3-wild-hunt"`

Normalization logic lives in the service layer, not the database.

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| install_state type | Free-form TEXT | Each launcher defines its own states |
| Frontend Dockerfile | Multi-stage (dev + prod) | Single file supports both modes via build arg |
| Slug normalization | Aggressive (strip articles/editions) | Better dedup across launchers |
| Migration strategy | Single schema.sql, IF NOT EXISTS | Sufficient for greenfield; versioning added later |
| Timestamps | ISO 8601 TEXT | SQLite convention, human-readable |
| Default admin password | changeme123, bcrypt cost 12 | Spec requirement; forced change can be added later |
