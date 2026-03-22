# Gameshelf Phase 5 — Library UI, Settings & Production Docker

**Date:** 2026-03-22
**Status:** Approved
**Scope:** Tasks 1–9 of Phase 5

## Overview

Phase 5 completes the Gameshelf application with a full library UI (game grid/list with filter chips + dropdown panel, game detail page), settings page, navigation, and production Docker build. This is the final phase — after completion, `docker compose up -d` starts the full application.

## Games API

### `/backend/src/routes/games.js` (replaces 501 stub)

All routes auth-protected.

#### `GET /api/games`

Returns deduplicated game list with filtering and pagination.

**Query params:**
| Param | Type | Description |
|-------|------|-------------|
| `search` | string | Title search via SQLite `LIKE '%term%'` |
| `genre` | string | Comma-separated genre names |
| `tag` | string | Comma-separated tag names |
| `launcher` | string | Comma-separated launcher name slugs |
| `sort` | string | `title_asc|title_desc|release_asc|release_desc|playtime_desc` (default: `title_asc`) |
| `page` | int | Page number (default: 1) |
| `limit` | int | Results per page (default: 50) |
| `duplicates` | string | If `'show'`, return all editions including lower-priority duplicates |
| `release_year_min` | int | Minimum release year |
| `release_year_max` | int | Maximum release year |
| `playtime_min` | int | Minimum playtime in minutes |
| `playtime_max` | int | Maximum playtime in minutes |
| `owned` | string | `'true'` (default) or `'all'` — if `'all'`, include `owned=0` editions (games removed from library after re-sync) |

**Deduplication logic (default):**
1. Join `game_editions` (where `owned=1` by default) → `launchers` (for priority) → `games` (for metadata)
2. For each game grouped by `games.id`: return only the edition from the launcher with the lowest `priority` number (highest preference). Unlinked editions (null `game_id`) are each treated as distinct entries — no grouping across launchers.
3. Include `also_on` array per game: all launchers the game is owned on

**Response shape:**
```json
{
  "games": [{
    "id": 1,
    "title": "Half-Life 2",
    "slug": "half-life-2",
    "cover_url": "/data/images/1/cover.jpg",
    "icon_url": "/data/images/1/icon.jpg",
    "description": "...",
    "release_year": 2004,
    "developer": "Valve",
    "publisher": "Valve",
    "genres": ["Action", "FPS"],
    "tags": ["Action", "FPS"],
    "playtime_minutes": 1200,
    "launcher_name": "steam",
    "launcher_display_name": "Steam",
    "launcher_game_id": "220",
    "also_on": [
      {"launcher_name": "steam", "launcher_display_name": "Steam", "playtime_minutes": 1200, "launcher_game_id": "220"},
      {"launcher_name": "gog", "launcher_display_name": "GOG", "playtime_minutes": 0, "launcher_game_id": "1207658691"}
    ]
  }],
  "total": 142,
  "page": 1,
  "limit": 50
}
```

#### `GET /api/games/:id`

Full game detail including all editions, genres, tags, and image URLs.

**Response shape:**
```json
{
  "id": 1,
  "title": "Half-Life 2",
  "slug": "half-life-2",
  "cover_url": "/data/images/1/cover.jpg",
  "hero_url": "/data/images/1/hero.jpg",
  "icon_url": "/data/images/1/icon.jpg",
  "description": "Full description text...",
  "release_year": 2004,
  "developer": "Valve",
  "publisher": "Valve",
  "genres": ["Action", "FPS"],
  "tags": ["Action", "FPS"],
  "editions": [
    {
      "id": 42,
      "launcher_name": "steam",
      "launcher_display_name": "Steam",
      "launcher_game_id": "220",
      "launcher_url": "https://store.steampowered.com/app/220",
      "playtime_minutes": 1200,
      "owned": 1,
      "is_primary": true
    },
    {
      "id": 87,
      "launcher_name": "gog",
      "launcher_display_name": "GOG",
      "launcher_game_id": "1207658691",
      "launcher_url": null,
      "playtime_minutes": 0,
      "owned": 1,
      "is_primary": false
    }
  ]
}
```

The `is_primary` field is computed by comparing each edition's launcher priority — the edition with the lowest launcher `priority` number is primary.

#### `GET /api/games/filters`

Returns filter options with counts and range bounds for populating the filter UI.

```json
{
  "genres": [{"name": "Action", "count": 42}, ...],
  "tags": [{"name": "Action", "count": 42}, ...],
  "launchers": [{"name": "steam", "display_name": "Steam", "count": 120}, ...],
  "release_year_min": 1993,
  "release_year_max": 2026,
  "playtime_max_minutes": 48000
}
```

Counts reflect currently owned games.

## Library Page

### `/frontend/src/pages/Library.jsx`

Full-width layout with filter chips + dropdown panel (no persistent sidebar).

**Header bar:**
- "Gameshelf" wordmark (left)
- Search input (debounced 300ms via `useCallback`)
- View toggle: grid/list icons
- Sort dropdown: title A-Z, title Z-A, release newest, release oldest, playtime
- "Sync Now" button: calls `POST /api/sync/all`, then polls `GET /api/sync/status` every 3 seconds until all launchers show `status !== 'running'`. Shows spinner while any launcher is running. Stops polling on completion.

**Filter chips row** (below header):
- "Filters (N)" button opens the `FilterPanel` dropdown
- Active filters shown as removable chips (click X to remove)
- "Clear all" link when any filters active

**Content area:**
- Grid of `GameCard` or rows of `GameRow` depending on view toggle
- Pagination at bottom
- Empty state: "No games found" with suggestion to sync or adjust filters

**Data fetching:** `@tanstack/react-query` with `useQuery`. Cache key includes all filter/sort/page state. Refetch on filter change.

**Sync status:** Small badge in header showing last sync time, pulled from `GET /api/sync/status`.

## Filter Panel

### `/frontend/src/components/FilterPanel.jsx`

Dropdown panel triggered by "Filters (N)" button. Closes on outside click or "Apply".

**Sections:**
- **Launchers** — checkboxes for each enabled launcher with game count badge
- **Genres** — checkboxes, top 20, "Show more" expander
- **Tags** — same pattern as genres
- **Release Year** — min/max number inputs (range from dataset)
- **Playtime** — min/max inputs in hours
- **Ownership** — toggle: "Owned only" (default) / "Show all" — passes `owned=all` query param to include `owned=0` editions (games removed from library after a re-sync marked them as no longer owned)
- **Duplicates** — toggle: "Hide duplicates" (default) / "Show all copies"

**Filter state:** All stored in URL query string via `useSearchParams` from react-router-dom. Filters persist on page reload and are bookmarkable.

Active filter count shown on the "Filters" button badge.

## Game Components

### `/frontend/src/components/GameCard.jsx` (grid view)

- Cover image from `cover_url`. Fallback: gray `bg-gray-700` placeholder with game initials (first letters of first two words)
- Title: `line-clamp-2` truncation
- Launcher badges: row of `LauncherBadge` pills. Primary launcher (from dedup) is prominent (`bg-blue-600`), secondary launchers are muted (`bg-gray-700 opacity-60`)
- "Also on X platforms" indicator when `also_on.length > 1` — click opens absolute-positioned popover with full list. No external tooltip library.
- Playtime chip: shown only if `playtime_minutes > 0`, formatted as "X hrs"
- Hover state: `scale-105` transform + overlay with partial description preview
- Click navigates to `/library/game/:id`

### `/frontend/src/components/GameRow.jsx` (list view)

- Compact row: icon (small cover), title, genres (2-3 chips), launcher badges, playtime, release year
- Same "Also on" popover behavior as GameCard
- Click navigates to `/library/game/:id`

### `/frontend/src/utils/launcherIcons.js`

Maps each of the 9 launcher IDs to an emoji stub:
```
steam: "🎮", ea: "🎮", ubisoft: "🎮", epic: "🎮", humble: "📦",
itchio: "🕹️", gog: "🎮", battlenet: "⚔️", xbox: "🎮"
```

Comment: "Replace emoji stubs with actual SVG icons — each launcher's press kit provides official assets."

**`LauncherBadge` component** (in same file or separate): Small pill with icon + `display_name`. Accepts `compact` prop that shows only the icon for tight spaces.

## Game Detail Page

### `/frontend/src/pages/GameDetail.jsx` — at `/library/game/:id`

- **Hero banner**: `hero_url` image, fallback: cover image stretched + CSS `blur(20px)` + darkened overlay
- **Cover art**: overlapping hero, positioned bottom-left with negative margin
- **Info section**: title (h1), developer, publisher, release year
- **Genre and tag chips**: row of small pills
- **Description**: collapsible at 4 lines (`line-clamp-4`) with "Read more" toggle
- **"Owned On" section**: card per game_edition
  - Each card: launcher name + badge, playtime ("X hours played" or "Never played")
  - Non-primary editions: dimmed (`opacity-50`) with label "Secondary copy — [Primary Launcher] is preferred"
- **Back button**: `useNavigate(-1)` preserving filter state

Data fetched via `GET /api/games/:id` with `@tanstack/react-query`.

## Navigation

### `/frontend/src/components/Nav.jsx` — Top navigation bar

- Left: Gameshelf wordmark
- Right: Library link, Settings link, sync indicator, logout button
- Sync indicator: spinner if sync active, green dot if last sync <1h and successful, yellow dot if >24h
- Mobile: hamburger menu for links
- Logout calls `POST /api/auth/logout` then navigates to `/login`

### Route updates in `App.jsx`

```
/login           → Login (public)
/setup           → RequireAuth → Setup
/library         → RequireAuth → RequireSetup → Library
/library/game/:id → RequireAuth → RequireSetup → GameDetail
/settings        → RequireAuth → Settings (NOT behind RequireSetup — user may need Settings to configure launchers before setup is marked complete)
/                → redirect to /library
```

`QueryClientProvider` from `@tanstack/react-query` wraps the app in `main.jsx` (above `BrowserRouter` in `App.jsx`). Only `main.jsx` is modified for this — `App.jsx` does not create the provider.

## Settings Page

### `/frontend/src/pages/Settings.jsx` — Tabbed layout

**Launchers tab:**
- List of all launchers from `GET /api/launchers/available`
- Per launcher: enable/disable toggle, "Edit credentials" button (opens credential card from Setup wizard as a modal), "Sync now" button (`POST /api/sync/:launcherName`), last synced timestamp, status badge (success/failed/running)

**Metadata tab:**
- Count of unenriched games (from `GET /api/metadata/status`)
- "Re-enrich all" button (`POST /api/metadata/enrich-all`)
- Instructions for obtaining IGDB API keys

**Account tab:**
- Change password form (current password + new password + confirm new password)

### `POST /api/auth/change-password` (added to `/backend/src/routes/auth.js`)

Auth-protected. Request body: `{ currentPassword, newPassword }`.
1. Verify `currentPassword` against the user's stored `password_hash` via bcrypt
2. Validate `newPassword` is at least 8 characters
3. Hash `newPassword` with bcrypt (same rounds as admin seed: 12)
4. Update `users.password_hash` for `req.user.id`
5. Clear the `gameshelf_session` cookie (force re-login with new password)
6. Return `{ ok: true }` on success, `401 { error: "Current password is incorrect" }` on mismatch, `400 { error: "New password must be at least 8 characters" }` on validation failure

## New Frontend Dependencies

- `@tanstack/react-query` — data fetching and caching
- `lucide-react` — icons (search, grid, list, settings, sync, logout, chevron, x, etc.)
- `fuse.js` — client-side fuzzy search for instant filter-as-you-type on genre/tag lists in FilterPanel

## Production Docker Build (Task 9)

### `Dockerfile.frontend` update
- Build stage: `npm run build` produces `dist/`
- Prod stage: Nginx Alpine serves `dist/` + custom `nginx.conf`

### `nginx.conf` update
- SPA routing: `try_files $uri $uri/ /index.html`
- `/api/` proxy to `backend:3001`
- `/data/images/` proxy to `backend:3001` (images served by Express static)
- Cache static assets: `Cache-Control: max-age=604800` (7 days) for `/data/images/`
- Gzip: enabled for `text/html application/javascript text/css application/json`

### `docker-compose.yml` update
- `restart: unless-stopped` on both services
- Backend: `NODE_ENV=production`
- Volume: `gameshelf_data` remains

### `README.md` update
- Prerequisites (Docker, Docker Compose v2)
- First-run: copy `.env.example` → `.env`, set encryption key + JWT secret + IGDB credentials
- `docker compose up -d` start command
- Default login: admin / changeme123 — change immediately
- Local network access and Cloudflare Tunnel instructions
- Steam API key setup, itch.io API key, GOG credentials notes
- Known limitations: EA, Ubisoft, Epic, Battle.net, Xbox are stubs

## Files Created/Modified

### New files
- `frontend/src/components/Nav.jsx`
- `frontend/src/components/FilterPanel.jsx`
- `frontend/src/components/GameCard.jsx`
- `frontend/src/components/GameRow.jsx`
- `frontend/src/components/LauncherBadge.jsx`
- `frontend/src/utils/launcherIcons.js`
- `frontend/src/pages/GameDetail.jsx`

### Modified files
- `backend/src/routes/games.js` — replace 501 stub with full games API
- `backend/src/routes/auth.js` — add POST /api/auth/change-password
- `frontend/src/pages/Library.jsx` — replace placeholder with full library
- `frontend/src/pages/Settings.jsx` — replace placeholder with tabbed settings
- `frontend/src/App.jsx` — add GameDetail route, Nav component, restructure route guards
- `frontend/src/main.jsx` — wrap with QueryClientProvider from @tanstack/react-query
- `frontend/nginx.conf` — update for production SPA + caching
- `Dockerfile.frontend` — ensure prod build works
- `docker-compose.yml` — add restart policy
- `README.md` — full setup documentation

## Decisions & Trade-offs

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Filter UI | Chips + dropdown panel (not sidebar) | More grid space, cleaner mobile, user preference |
| Navigation | Top bar (not sidebar) | Consistent with dropdown filter pattern; sidebar nav would conflict |
| Data fetching | @tanstack/react-query | Caching, refetch on filter change, loading states built-in |
| Icons | lucide-react | Lightweight, tree-shakeable, no component library dependency |
| Client search | fuse.js | Instant fuzzy filtering in filter panel genre/tag lists |
| Launcher icons | Emoji stubs | Placeholder until real SVG icons from press kits |
| Image fallback | Gray + initials / blurred cover | Graceful degradation when images missing |
| Deduplication | SQL-level via launcher priority | Efficient, single query, consistent with launcher priority model |
| Filter persistence | URL query string | Bookmarkable, shareable, survives page reload |
| Docker | Nginx + Express | Standard SPA + API pattern, image caching at proxy level |
