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
