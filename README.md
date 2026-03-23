# Gameshelf

Self-hosted game library manager. Aggregates game ownership across multiple launchers (Steam, GOG, Humble Bundle, itch.io, and more) into a single unified library with cover art, metadata, and deduplication.

## Prerequisites

- Docker and Docker Compose v2
- A Twitch developer account for IGDB metadata (optional but recommended)

## Quick Start

```bash
# 1. Clone and configure
cp .env.example .env
```

Edit `.env` and set these required values:
- `GAMESHELF_ENCRYPTION_KEY` — random string, 32+ characters
- `GAMESHELF_JWT_SECRET` — random string, any length

Optional but recommended:
- `IGDB_CLIENT_ID` — from dev.twitch.tv (for game metadata and cover art)
- `IGDB_CLIENT_SECRET` — from dev.twitch.tv

```bash
# 2. Start Gameshelf
docker compose up -d

# 3. Access
# Open http://localhost in your browser
```

**Default login:** admin / changeme123 — **CHANGE THIS IMMEDIATELY** via Settings > Account.

## Launcher Setup

After first login, the setup wizard guides you through connecting your game launchers.

### Steam
- Get an API key from https://steamcommunity.com/dev/apikey
- Enter your API key and 64-bit Steam ID (find at steamid.io)
- No password needed — uses the official Steam Web API

### itch.io
- Generate an API key at https://itch.io/user/settings/api-keys
- Enter the key in the setup wizard

### GOG
- Enter your GOG account email and password
- Uses unofficial OAuth2 — may require re-auth if GOG changes their API

### Humble Bundle
- Enter your Humble Bundle account email and password
- Uses unofficial session-based API

## Network Access

### Local Network
Gameshelf runs on port 80 by default. Access from other devices on your network at `http://<your-ip>`.

### Cloudflare Tunnel
For remote access without port forwarding:
1. Install cloudflared on your server
2. Point a tunnel to `http://localhost:80`
3. Access Gameshelf from anywhere via your tunnel domain

## IGDB Metadata Setup

For cover art, descriptions, and genre data:
1. Create a Twitch developer application at https://dev.twitch.tv/console
2. Copy the Client ID and generate a Client Secret
3. Add `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` to your `.env` file
4. Restart: `docker compose restart`
5. Games will be enriched automatically on next sync

## Development

```bash
# Backend
cd backend && npm install && npm run dev

# Frontend (separate terminal)
cd frontend && npm install && npm run dev
```

Backend runs on port 3001, frontend on port 5173 with API proxy.

Run tests: `cd backend && npm test`

## Tech Stack

- **Backend:** Node.js 20, Express 5, SQLite (better-sqlite3)
- **Frontend:** React 18, Vite, TailwindCSS, React Query
- **Auth:** JWT with httpOnly cookies, bcrypt password hashing
- **Encryption:** AES-256-GCM for stored launcher credentials
- **Metadata:** IGDB API via Twitch OAuth
- **Scheduler:** node-cron (syncs every 6 hours)
- **Container:** Docker with Nginx reverse proxy

## Known Limitations

The following launcher integrations are stubs (planned for future implementation):
- EA App — requires Playwright-based browser automation
- Ubisoft Connect — requires unofficial API integration
- Epic Games — requires OAuth2 with launcher credentials
- Battle.net — no public game library API
- Xbox / Microsoft — requires Microsoft OAuth
