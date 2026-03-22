# Gameshelf Phase 3 — Launcher Integrations & Sync Engine

**Date:** 2026-03-22
**Status:** Approved
**Scope:** Tasks 1–8 of Phase 3

## Overview

Phase 3 adds launcher service integrations (Steam, Humble Bundle, itch.io, GOG as working implementations; EA, Ubisoft, Epic, Battle.net, Xbox as stubs), a sync engine that orchestrates fetching owned games and upserting them into the database, and a cron-based scheduler for automatic syncing.

## Schema Changes

Two targeted changes to the existing Phase 1 schema:

### 1. Add unique index on `(launcher_id, launcher_game_id)`

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_editions_launcher_game
  ON game_editions(launcher_id, launcher_game_id);
```

Enables upsert during sync using `ON CONFLICT(launcher_id, launcher_game_id)`.

### 2. Make `game_id` nullable in `game_editions`

Change `game_id INTEGER NOT NULL` to `game_id INTEGER`. Allows sync to insert `game_editions` rows without a linked `games` row. Phase 4 metadata enrichment will populate `game_id` later.

The existing `UNIQUE(game_id, launcher_id)` constraint remains valid for when `game_id` is populated.

**Migration approach:** A new idempotent migration step in `migrate.js` handles both changes. SQLite requires table recreation to change NOT NULL constraints, so the migration checks whether the column is already nullable before acting.

## Base Class

### `/backend/src/services/launchers/base.js`

```
class BaseLauncher {
  constructor(launcherId, db)
  async authenticate(credentials) → session token string | null
  async fetchOwnedGames(session) → [{launcher_game_id, title, playtime_minutes}]
  async refreshIfNeeded(credentials) → session token string | null
}
```

- `constructor(launcherId, db)` — stores launcher name string and db reference
- `authenticate(credentials)` — throws `Error('Not implemented')` if subclass doesn't override. Returns session token/cookie string, or null for API-key-based launchers.
- `fetchOwnedGames(session)` — throws `Error('Not implemented')`. Returns array of `{launcher_game_id: string, title: string, playtime_minutes: number}`.
- `refreshIfNeeded(credentials)` — checks `launchers.last_sync_at` in DB. If stored session exists and was used within the last hour, reuses it. Otherwise calls `authenticate()`. For API-key launchers, this is a passthrough (no session needed).

## Launcher Implementations

All files in `/backend/src/services/launchers/`. Each extends `BaseLauncher`.

### Steam (`steam.js`) — Task 1

**Auth:** Uses Steam Web API with user-provided `api_key` (from steamcommunity.com/dev/apikey) and `steamid64`. No password-based login — documented clearly in comments as fragile and against Steam ToS.

**Credential shape:** `{api_key: string, steamid64: string}`

**fetchOwnedGames:** Single GET request:
```
GET https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/
  ?key={api_key}&steamid={steamid64}&include_appinfo=1&include_played_free_games=1
```

**Response mapping:**
```
response.games[] → {
  launcher_game_id: appid.toString(),
  title: name,
  playtime_minutes: playtime_forever
}
```

**Rate limiting:** 200ms delay between requests if paginating (Steam typically returns full library in one call).

### Humble Bundle (`humble.js`) — Task 2

**Auth:** Session-based web API. POST to `https://www.humblebundle.com/processlogin` with username/password form data. Captures `_simpleauth_sess` cookie from response.

**Credential shape:** `{username: string, password: string}`

**fetchOwnedGames:**
1. GET `https://www.humblebundle.com/api/v1/user/order?ajax=true` with session cookie → returns `{gamekeys: [string, ...]}`
2. Batch GET `https://www.humblebundle.com/api/v1/order/{key}?ajax=true` for each order
3. Extract `subproducts` from each order. Each subproduct with a `downloads` array is a game.

**Response mapping:**
```
subproduct → {
  launcher_game_id: machine_name,
  title: human_name,
  playtime_minutes: 0
}
```

**Note:** Humble's API is unofficial and may break. Documented with TODO comment.

### itch.io (`itchio.js`) — Task 3

**Auth:** Official API using user-provided API key from `https://itch.io/user/settings/api-keys`. No login needed.

**Credential shape:** `{api_key: string}`

**fetchOwnedGames:** Two endpoints:
1. GET `https://itch.io/api/1/{api_key}/my-games` → `{games: [{id, title, ...}]}`
2. GET `https://api.itch.io/profile/owned-keys` with `Authorization: Bearer {api_key}` header → purchased games

**Response mapping:**
```
game → {
  launcher_game_id: id.toString(),
  title: title,
  playtime_minutes: 0
}
```

Deduplicates games appearing in both endpoints by `launcher_game_id`.

### GOG (`gog.js`) — Task 4

**Auth:** OAuth2 password grant (unofficial):
```
POST https://auth.gog.com/token
  client_id=46899977096215655
  client_secret=9d85c43b1482497dbbce61f6e4aa173d183b1a9
  grant_type=password
  username={username}
  password={password}
```
Returns `{access_token, refresh_token}`.

**Credential shape:** `{username: string, password: string}`

**fetchOwnedGames:**
1. GET `https://embed.gog.com/user/data/games` with `Authorization: Bearer {token}` → `{owned: [int, ...]}`
2. Batch GET `https://api.gog.com/products/{id}?expand=description` for each ID

**Response mapping:**
```
product → {
  launcher_game_id: id.toString(),
  title: title,
  playtime_minutes: 0
}
```

**Rate limiting:** 1 request per second for product detail fetches. Uses a sleep utility.

**Note:** GOG's unofficial auth may require re-auth flows. Documented with TODO comment.

### EA App (`ea.js`) — Task 5 (Stub)

Returns `[]` with `console.warn('EA App integration not yet implemented')`.

TODO: Implement using Playwright-based headless browser login and scrape game list from `https://www.ea.com/games/library`.

**Expected credential shape:** `{username: string, password: string, totp_secret?: string}`

### Ubisoft Connect (`ubisoft.js`) — Task 5 (Stub)

Returns `[]` with `console.warn('Ubisoft Connect integration not yet implemented')`.

TODO: Implement using `https://github.com/Hachi1/ubisoft-api-node` as reference.

**Expected credential shape:** `{email: string, password: string, totp_secret?: string}`

### Epic Games (`epic.js`) — Task 5 (Stub)

Returns `[]` with `console.warn('Epic Games integration not yet implemented')`.

TODO: Implement using `https://github.com/MixV2/EpicResearch` as reference.

**Expected credential shape:** `{email: string, password: string, totp_secret?: string}`

### Battle.net (`battlenet.js`) — Task 6 (Stub)

Returns `[]` with `console.warn('Battle.net integration not yet implemented')`.

TODO: Blizzard has no public game library API. Suggest Playwright automation as the path forward.

**Expected credential shape:** `{username: string, password: string, totp_secret?: string}`

### Xbox / Microsoft (`xbox.js`) — Task 6 (Stub)

Returns `[]` with `console.warn('Xbox integration not yet implemented')`.

TODO: Xbox uses Microsoft OAuth. Reference `https://xbl.io` as a community API option.

**Expected credential shape:** `{username: string, password: string}`

## Sync Engine

### `/backend/src/services/syncEngine.js`

#### `async syncLauncher(launcherId, db)`

1. Look up launcher row by `name` column (e.g., `"steam"`)
2. Create `sync_jobs` row: `status='running'`, `started_at=now()`
3. Decrypt `credentials_json` via `decrypt()`
4. Instantiate correct launcher class via registry map: `{steam: SteamLauncher, humble: HumbleLauncher, ...}`
5. Call `refreshIfNeeded(credentials)` → `fetchOwnedGames(session)`
6. For each returned game: upsert into `game_editions` using `ON CONFLICT(launcher_id, launcher_game_id)` — sets `owned=1`, updates `title`, `playtime_minutes`. `game_id` left null.
7. Mark any `game_editions` for this launcher NOT in the returned list as `owned=0` (soft removal — never delete rows)
8. Update `sync_jobs`: `status='success'`, `completed_at=now()`
9. On catch: `status='failed'`, `error_message`, `completed_at=now()`. Log error but don't throw — one launcher failing must not crash the full sync.

#### `async syncAll(db)`

- Query all launchers where `enabled=1` AND `credentials_json IS NOT NULL`
- Call `syncLauncher()` for each in **series** (not parallel — avoids rate limit stacking)
- Returns `{succeeded: [names], failed: [names], skipped: [names]}` where skipped = stubs that returned 0 games with no error

## Sync Routes

### `/backend/src/routes/sync.js` (replaces existing stub)

All routes protected by auth middleware.

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/sync/all` | Fire-and-forget `syncAll()` (do not await). Return `{message: "Gameshelf sync started"}`. |
| POST | `/api/sync/:launcherId` | Fire-and-forget `syncLauncher()` for one launcher. Return `{message: "Sync started for [launcher]"}`. |
| GET | `/api/sync/status` | Return latest `sync_jobs` row per launcher (query with GROUP BY + MAX id). |

## Scheduler

In `server.js`, add `node-cron` schedule (already a dependency):

```javascript
cron.schedule('0 */6 * * *', () => {
  console.log('[Gameshelf Scheduler] Starting 6-hour library sync');
  syncAll(db);
});
```

Runs `syncAll()` every 6 hours. Only starts when server runs as main module (not during tests).

## New Dependencies

- `axios` — HTTP client for all launcher API calls

## Files Created/Modified

### New files
- `backend/src/services/launchers/base.js`
- `backend/src/services/launchers/steam.js`
- `backend/src/services/launchers/humble.js`
- `backend/src/services/launchers/itchio.js`
- `backend/src/services/launchers/gog.js`
- `backend/src/services/launchers/ea.js`
- `backend/src/services/launchers/ubisoft.js`
- `backend/src/services/launchers/epic.js`
- `backend/src/services/launchers/battlenet.js`
- `backend/src/services/launchers/xbox.js`
- `backend/src/services/syncEngine.js`

### Modified files
- `backend/src/db/schema.sql` — add unique index on `(launcher_id, launcher_game_id)`
- `backend/src/db/migrate.js` — add migration step for nullable `game_id` + new index
- `backend/src/routes/sync.js` — replace stub with real routes
- `backend/src/server.js` — add cron scheduler

## Decisions & Trade-offs

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Schema: game_id nullable | Yes | Sync creates game_editions before games row exists; Phase 4 enrichment fills it |
| Schema: unique index | `(launcher_id, launcher_game_id)` | Enables proper upsert, prevents duplicates during re-sync |
| HTTP client | `axios` | Approved dependency, better cookie/redirect handling than built-in fetch |
| Sync order | Series, not parallel | Avoids rate limit stacking across launchers |
| Failed launcher handling | Log and continue | One broken launcher must not prevent others from syncing |
| Missing games after sync | Set `owned=0` | Soft removal — never delete game_editions rows |
| Stub launchers | Return `[]` + console.warn | Non-crashing, clearly communicates unimplemented status |
