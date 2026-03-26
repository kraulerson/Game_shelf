# Amazon Games Launcher — Design Spec

**Date:** 2026-03-26
**Status:** Approved

## Problem

Amazon Games is missing as a launcher. Users need to import their Amazon Games library into Gameshelf.

## Approach

Local SQLite database import with a preview/approval step. Amazon Games stores a `games.db` SQLite file at `%LocalAppData%\Amazon Games\Data\games.db`. The user uploads this file, reviews the parsed game list, selects which games to import, and confirms. After import, the launcher is sync-locked to prevent accidental removal.

This combines two existing patterns:
- **Ubisoft cache import** — file upload → parse → upsert
- **Xbox approval** — preview list → select → confirm → lock

## Backend

### New Launcher Registration

Add to `AVAILABLE_LAUNCHERS` in `backend/src/routes/launchers.js`:
```javascript
{ id: 'amazon', display_name: 'Amazon Games', auth_type: 'file_import', otp_supported: false, qr_supported: false, implemented: true }
```

Add to `LAUNCHER_CLASSES` in `backend/src/services/launchers/index.js`:
```javascript
amazon: AmazonLauncher
```

### Launcher Service

**File:** `backend/src/services/launchers/amazon.js`

Single exported function:

- `parseGamesDb(buffer)` — Opens the SQLite buffer as a temporary file, reads the `entitlements` or `products` table, filters for `product_type = 'GAME'`, returns `[{ launcher_game_id, title }]`. Cleans up the temp file after reading.

The launcher class extends BaseLauncher but `fetchOwnedGames()` throws an error explaining that Amazon Games uses file import only (no API sync).

### Endpoints

Two new routes in `backend/src/routes/launchers.js`:

1. **`POST /api/launchers/amazon/preview`**
   - Accepts: multipart file upload (`games_db` field)
   - Action: Calls `parseGamesDb(buffer)`, returns the game list as JSON
   - Response: `{ games: [{ launcher_game_id, title }] }`
   - No database writes

2. **`POST /api/launchers/amazon/import`**
   - Accepts: JSON body `{ approved_games: [{ launcher_game_id, title }] }`
   - Action: Ensures `amazon` launcher row exists in DB, upserts selected games as game_editions, sets `sync_locked = 1`, triggers enrichment
   - Response: `{ imported: N }`

### Database Handling

The uploaded `games.db` is a SQLite file. Since better-sqlite3 requires a file path (not a buffer), the approach is:
- Write the uploaded buffer to a temp file
- Open it with better-sqlite3 in read-only mode
- Query the entitlements/products table
- Close and delete the temp file

The table name may be `entitlements` or `products` — the parser should check which exists and use it.

## Frontend

### Settings Page

In `Settings.jsx`, add an "Import Database" button for the Amazon launcher (similar to Ubisoft's "Import Cache" button). Clicking it navigates to `/settings/amazon/approve`.

### Amazon Approval Page

**File:** `frontend/src/pages/AmazonApproval.jsx`

Follows the XboxApproval.jsx pattern exactly:

1. **Upload step:** File picker for `games.db`, sends to `/api/launchers/amazon/preview`
2. **Review step:** Shows parsed game list with checkboxes (all selected by default), select all / deselect all buttons, game count
3. **Confirm step:** "Import Selected" button sends approved games to `/api/launchers/amazon/import`
4. **Success:** Navigate back to Settings with flash message

### Routing

Add to `App.jsx`:
```jsx
<Route path="/settings/amazon/approve" element={<AmazonApproval />} />
```

## Testing

- Unit test for `parseGamesDb()` — create a minimal SQLite db in the test, write it to a buffer, parse it
- Route test for `/api/launchers/amazon/preview` — verify it returns parsed games without DB writes
- Route test for `/api/launchers/amazon/import` — verify games are upserted and `sync_locked = 1`
- Launcher count test update — bump expected count from 9 to 10

## Scope

- New files: `backend/src/services/launchers/amazon.js`, `frontend/src/pages/AmazonApproval.jsx`
- Modified files: `backend/src/routes/launchers.js`, `backend/src/services/launchers/index.js`, `frontend/src/pages/Settings.jsx`, `frontend/src/App.jsx`
- Tests: `backend/tests/routes/launchers.test.js`, `backend/tests/services/launchers/amazon.test.js` (new)
