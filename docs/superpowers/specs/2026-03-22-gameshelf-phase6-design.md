# Phase 6: Launcher Credential Removal, Smart Re-enrichment & Scheduled Enrichment

## Overview

Three related features to improve launcher management and metadata reliability:

1. **Remove launcher credentials** — allow users to disconnect a launcher and hide its games
2. **Smart re-enrichment** — retry metadata fetching for games that failed or were incomplete
3. **Scheduled enrichment** — daily automatic enrichment pass for under-enriched games

## Feature 1: Remove Launcher Credentials

### Backend

**New endpoint:** `DELETE /api/launchers/:name/credentials`

- Finds the launcher by `name`
- Sets `credentials_json = NULL`, `enabled = 0` on the launcher row
- Sets `owned = 0` on all `game_editions` for that launcher (soft-remove)
- Returns `{ removed: true, gamesAffected: <count> }`
- Requires `authMiddleware`

No cascade deletes. Launcher row, game_editions, games, sync_jobs all remain. Games disappear from library view because queries filter on `owned = 1`.

When credentials are re-added and synced, `syncEngine.js` upserts editions back to `owned = 1`. Previously enriched games keep their metadata. Under-enriched games get picked up by the smart re-enrich logic.

### Frontend

**LaunchersTab changes (Settings.jsx):**

- Add `configured: true/false` field to `GET /api/launchers/available` response (checks `credentials_json IS NOT NULL`)
- For configured launchers: show a "Remove" button (red/destructive styling) next to "Sync"
- Clicking "Remove" shows a confirmation dialog: "Remove [launcher] credentials? Your games will be hidden until you re-add credentials."
- On confirm: `DELETE /api/launchers/:name/credentials`
- Invalidate queries to refresh UI — launcher returns to "not configured" state

## Feature 2: Smart Re-enrichment

### Backend

**New function:** `enrichUnderEnriched(db)` in `enrichGame.js`

1. Query `games` rows where `cover_url IS NULL OR description IS NULL`
2. For each, find a linked `game_edition` to get the search title
3. Re-run enrichment: IGDB search, title match, image cache, genre/tag upsert
4. Update the existing `games` row in place
5. 500ms delay between calls (same as existing `enrichAll`)

**Modified `enrichAll(db)`:**

After processing editions with `game_id IS NULL` (current behavior), call `enrichUnderEnriched(db)` to retry previously failed enrichments.

**No route changes needed.** `POST /api/metadata/enrich-all` already calls `enrichAll`. `GET /api/metadata/status` already counts `cover_url IS NULL` as unenriched, which accurately reflects under-enriched games.

## Feature 3: Scheduled Enrichment

### Backend

**New cron job in `server.js`:**

- Schedule: `0 3 * * *` (daily at 3 AM)
- Calls `enrichAll(db)` (which now includes smart re-enrich)
- Logs: `[Gameshelf Metadata] Scheduled daily enrichment started/completed`
- Offset from existing 6-hour sync cron to avoid overlap

**Existing post-sync enrichment** (syncEngine.js line 99-100) unchanged — already calls `enrichAll` after each launcher sync, which now includes smart re-enrich.

No UI for the schedule. MetadataTab already shows unenriched count.

## Files Changed

### Backend
- `backend/src/routes/launchers.js` — new DELETE endpoint, add `configured` field to available response
- `backend/src/services/metadata/enrichGame.js` — new `enrichUnderEnriched()`, modify `enrichAll()` to call it
- `backend/src/server.js` — new daily cron job

### Frontend
- `frontend/src/pages/Settings.jsx` — remove button, confirmation dialog, updated launcher status display

## Testing Considerations

- DELETE endpoint: verify credentials cleared, editions soft-removed, games preserved
- Re-add credentials + sync: verify editions restored, metadata intact
- `enrichUnderEnriched`: verify it targets only under-enriched games, skips fully enriched ones
- Scheduled cron: verify it runs and calls enrichAll
- Frontend: remove button appears only for configured launchers, confirmation works, UI refreshes
