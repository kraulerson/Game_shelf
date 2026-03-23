# Phase 6: Launcher Credential Removal, Smart Re-enrichment & Scheduled Enrichment

## Overview

Three related features to improve launcher management and metadata reliability:

1. **Remove launcher credentials** — allow users to disconnect a launcher and hide its games
2. **Smart re-enrichment** — retry metadata fetching for games that failed or were incomplete
3. **Scheduled enrichment** — daily automatic enrichment pass for under-enriched games

## Feature 1: Remove Launcher Credentials

### Backend

**New endpoint:** `DELETE /api/launchers/:id/credentials`

Uses `:id` to match existing route convention in `launchers.js` (`:id` refers to the launcher `name` string, e.g. "steam", not numeric ID).

- Validates launcher exists in `LAUNCHER_MAP`; returns 400 if unknown
- Looks up the launcher row by `name` to get its numeric `id`
- Sets `credentials_json = NULL`, `enabled = 0`, `last_sync_at = NULL` on the launcher row
- Sets `owned = 0` on all `game_editions WHERE launcher_id = <numeric id>` (soft-remove)
- Returns `{ removed: true, launcher: <display_name>, gamesAffected: <count> }`
- Requires `authMiddleware`

Clearing `last_sync_at` ensures the UI shows "Never synced" rather than a stale date when credentials are re-added.

No cascade deletes. Launcher row, game_editions, games, sync_jobs all remain. Games disappear from library view because queries filter on `owned = 1`.

When credentials are re-added and synced, `syncEngine.js` upserts editions back to `owned = 1`. Previously enriched games keep their metadata. Under-enriched games get picked up by the smart re-enrich logic.

### Frontend

**LaunchersTab changes (Settings.jsx):**

- Add `configured: true/false` field to `GET /api/launchers/available` response. This requires querying the `launchers` table for rows where `credentials_json IS NOT NULL`, building a Set of configured names, and merging into the static `AVAILABLE_LAUNCHERS` array.
- For configured launchers: show a "Remove" button (red/destructive styling) next to "Sync"
- Clicking "Remove" shows a confirmation dialog: "Remove [launcher] credentials? Your games will be hidden until you re-add credentials."
- On confirm: `DELETE /api/launchers/:id/credentials`
- Invalidate queries to refresh UI — launcher returns to "not configured" state

## Feature 2: Smart Re-enrichment

### Backend

**New column:** Add `last_enrichment_at` (TEXT, nullable) to the `games` table via migration. Updated when enrichment runs for a game (whether successful or not). Used to prevent infinite retries.

**New function:** `enrichUnderEnriched(db)` in `enrichGame.js`

This is a standalone function with its own IGDB search + update logic — it does NOT call `enrichGame()`, which is designed for initial enrichment of unlinked editions.

1. Query `games` rows where metadata is incomplete AND has at least one owned edition AND hasn't been retried recently:
   ```sql
   SELECT DISTINCT g.id, g.title, g.slug
   FROM games g
   JOIN game_editions ge ON ge.game_id = g.id AND ge.owned = 1
   WHERE (g.cover_url IS NULL OR g.description IS NULL)
     AND (g.last_enrichment_at IS NULL
          OR g.last_enrichment_at < datetime('now', '-7 days'))
   ```
2. For each game: search IGDB using `g.title`, find best match via `titleMatcher`
3. Update the existing `games` row in place (description, cover_url, hero_url, icon_url, developer, publisher, release_year, genres, tags) and set `last_enrichment_at = datetime('now')` in the same UPDATE/transaction (prevents partial state if one write succeeds but the other fails)
4. `last_enrichment_at` is set regardless of match success (prevents daily retries of games IGDB will never match)
5. 500ms delay between calls (same as existing `enrichAll`)

**Modified `enrichAll(db)`:**

After processing editions with `game_id IS NULL` (current behavior), call `enrichUnderEnriched(db)` to retry previously failed enrichments. `enrichUnderEnriched` returns `{ enriched, failed, skipped }`; `enrichAll` sums both sets of counts before returning.

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

## Database Migration

New migration to add `last_enrichment_at` column:

```sql
ALTER TABLE games ADD COLUMN last_enrichment_at TEXT;
```

## Files Changed

### Backend
- `backend/src/routes/launchers.js` — new DELETE endpoint, add `configured` field to available response
- `backend/src/services/metadata/enrichGame.js` — new `enrichUnderEnriched()`, modify `enrichAll()` to call it
- `backend/src/server.js` — new daily cron job
- `backend/src/db/migrate.js` — new inline migration for `last_enrichment_at` column (follows existing pattern)

### Frontend
- `frontend/src/pages/Settings.jsx` — remove button, confirmation dialog, updated launcher status display

## Testing Considerations

- DELETE endpoint: verify credentials cleared, editions soft-removed, games preserved, `last_sync_at` cleared
- Launcher validation: unknown launcher name returns 400
- Re-add credentials + sync: verify editions restored, metadata intact
- `enrichUnderEnriched`: verify it targets only under-enriched games with owned editions, skips fully enriched, respects 7-day cooldown
- Retry cap: verify `last_enrichment_at` prevents daily re-attempts of unmatchable games
- Scheduled cron: verify it runs and calls enrichAll
- Frontend: remove button appears only for configured launchers, confirmation works, UI refreshes
