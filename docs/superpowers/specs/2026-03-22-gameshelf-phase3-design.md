# Gameshelf Phase 3 — Launcher Integrations & Sync Engine

**Date:** 2026-03-22
**Status:** Approved
**Scope:** Tasks 1–8 of Phase 3

## Overview

Phase 3 adds launcher service integrations (Steam, Humble Bundle, itch.io, GOG as working implementations; EA, Ubisoft, Epic, Battle.net, Xbox as stubs), a sync engine that orchestrates fetching owned games and upserting them into the database, and a cron-based scheduler for automatic syncing.

## Schema Changes

Four targeted changes to the existing Phase 1 schema:

### 1. Add unique index on `(launcher_id, launcher_game_id)`

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_editions_launcher_game
  ON game_editions(launcher_id, launcher_game_id);
```

Enables upsert during sync using `ON CONFLICT(launcher_id, launcher_game_id)`.

### 2. Make `game_id` nullable in `game_editions`

Change `game_id INTEGER NOT NULL` to `game_id INTEGER`. Allows sync to insert `game_editions` rows without a linked `games` row. Phase 4 metadata enrichment will populate `game_id` later.

### 3. Add `title` column to `game_editions`

Add `title TEXT` to `game_editions`. Synced editions exist before a `games` row does (since `game_id` is null until Phase 4 enrichment). The title from the launcher API needs somewhere to live in the interim. Phase 4 will use this title to find/create the corresponding `games` row.

### 4. Drop `UNIQUE(game_id, launcher_id)` constraint

The existing `UNIQUE(game_id, launcher_id)` constraint becomes problematic with nullable `game_id` — SQLite treats NULLs as distinct, allowing multiple null-game_id rows per launcher (which we want), but the constraint is semantically misleading. The new `UNIQUE(launcher_id, launcher_game_id)` index is the primary dedup mechanism going forward. Drop the old constraint during the table recreation migration.

**Migration approach:** A new idempotent migration step in `migrate.js` handles all changes via table recreation (SQLite requires this for NOT NULL removal and constraint changes). The migration checks whether the column is already nullable before acting.

### Summary of `game_editions` after migration

```sql
CREATE TABLE IF NOT EXISTS game_editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER,                          -- nullable (was NOT NULL)
  launcher_id INTEGER NOT NULL,
  launcher_game_id TEXT,
  title TEXT,                               -- new column
  launcher_url TEXT,
  owned INTEGER NOT NULL DEFAULT 1,
  install_state TEXT,
  playtime_minutes INTEGER DEFAULT 0,
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (launcher_id) REFERENCES launchers(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_editions_launcher_game
  ON game_editions(launcher_id, launcher_game_id);
```

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
- `refreshIfNeeded(credentials)` — for API-key launchers (Steam, itch.io), returns null (no session needed). For session-based launchers (Humble, GOG), calls `authenticate()` to get a fresh session. Session tokens are not cached between syncs — each sync run authenticates fresh. This is simpler than caching sessions and avoids stale-session bugs. The `last_sync_at` column on the `launchers` table is updated after each successful sync.

## Launcher Implementations

All files in `/backend/src/services/launchers/`. Each extends `BaseLauncher`.

### Steam (`steam.js`) — Task 1

**Auth:** Uses Steam Web API with user-provided `api_key` (from steamcommunity.com/dev/apikey) and `steamid64`. No password-based login — documented clearly in comments as fragile and against Steam ToS.

**Credential shape:** `{api_key: string, steamid64: string}`

**Required change to `AVAILABLE_LAUNCHERS`:** Update Steam's `auth_type` from `'credentials+totp'` to `'api_key'` in `/backend/src/routes/launchers.js`. Update the credential validation in `POST /:id/credentials` to accept `api_key` (and `steamid64` as an additional field) for Steam. The `otp_supported` and `qr_supported` flags should be set to `false` for Steam since we're not doing password-based login.

**Required change to Setup wizard:** The Steam card in the frontend setup wizard (Step 3) should show API Key + Steam ID fields instead of username/password. The Steam Guard warning about shared_secret is no longer needed since we use the Web API approach.

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

**fetchOwnedGames:** Single endpoint for purchased/owned games:

GET `https://api.itch.io/profile/owned-keys` with `Authorization: Bearer {api_key}` header → returns purchased games with pagination.

Note: The `/my-games` endpoint returns games the user has **uploaded/created**, not purchased. We only use `/profile/owned-keys` for the library.

**Response mapping:**
```
owned_key.game → {
  launcher_game_id: game.id.toString(),
  title: game.title,
  playtime_minutes: 0
}
```

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

**Note on client credentials:** The `client_id` and `client_secret` above are community-maintained values from GOG reverse-engineering projects (e.g., lgogdownloader). They may be revoked by GOG at any time. Documented with a TODO comment suggesting these could be made configurable via environment variables if needed.

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

#### `async syncLauncher(launcherName, db)`

The `launcherName` parameter is the string slug (e.g., `"steam"`, `"gog"`), matching the `name` column in the `launchers` table. Returns the `sync_jobs.id` for the created job.

1. Look up launcher row by `name` column
2. Create `sync_jobs` row: `status='running'`, `started_at=now()`. Capture the inserted row's `id`.
3. Decrypt `credentials_json` via `decrypt()`
4. Instantiate correct launcher class via registry map: `{steam: SteamLauncher, humble: HumbleLauncher, ...}`
5. Call `refreshIfNeeded(credentials)` → `fetchOwnedGames(session)`
6. For each returned game: upsert into `game_editions` using `ON CONFLICT(launcher_id, launcher_game_id)` — sets `owned=1`, updates `title`, `playtime_minutes`. `game_id` left null.
7. Mark any `game_editions` for this launcher NOT in the returned list as `owned=0` (soft removal — never delete rows)
8. Update `sync_jobs`: `status='success'`, `completed_at=now()`, `games_found=N` (total returned), `games_updated=M` (rows actually changed)
9. Update `launchers.last_sync_at` to now
10. On catch: `status='failed'`, `error_message`, `completed_at=now()`. Log error but don't throw — one launcher failing must not crash the full sync.
11. Return the `sync_jobs.id`

**Schema addition for sync_jobs:** Add `games_found INTEGER DEFAULT 0` and `games_updated INTEGER DEFAULT 0` columns to the `sync_jobs` table during migration.

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
| POST | `/api/sync/:launcherName` | Fire-and-forget `syncLauncher(launcherName)`. Return `{message: "Sync started for [launcher]"}`. The `:launcherName` param is the string slug (e.g., `steam`). |
| GET | `/api/sync/status` | Return latest `sync_jobs` row per launcher (subquery with MAX id per launcher_id), including `games_found` and `games_updated` counts. |

## Scheduler

In `server.js`, add `node-cron` schedule (already a dependency):

The cron schedule must be placed **inside** the existing `if (require.main === module)` block to prevent it from running during tests:

```javascript
if (require.main === module) {
  cron.schedule('0 */6 * * *', () => {
    console.log('[Gameshelf Scheduler] Starting 6-hour library sync');
    syncAll(db);
  });

  app.listen(PORT, () => {
    console.log(`Gameshelf server running on port ${PORT}`);
  });
}
```

Runs `syncAll()` every 6 hours.

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
- `backend/src/services/launchers/index.js` — barrel export with launcher registry map
- `backend/src/services/syncEngine.js`

### Modified files
- `backend/src/db/schema.sql` — recreate `game_editions` (nullable `game_id`, add `title`, drop old unique constraint, add new index); add columns to `sync_jobs`
- `backend/src/db/migrate.js` — add migration step for schema changes
- `backend/src/routes/sync.js` — replace stub with real routes
- `backend/src/routes/launchers.js` — update Steam `auth_type` to `api_key`, update credential validation to accept `steamid64`
- `backend/src/server.js` — add cron scheduler
- `frontend/src/pages/Setup.jsx` — update Steam credential card to show API Key + Steam ID fields

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
