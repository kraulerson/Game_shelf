# Manual Title Protection, Slug Collision Fix, and Manual Sync Lock

**Date:** 2026-03-26
**Status:** Approved

## Problems

1. **Re-enrich overwrites manually edited titles** — `manual_description` and `manual_cover` flags exist, but no `manual_title` flag. After editing a title and re-enriching, the title reverts.
2. **PATCH slug collision** — After re-enrich reverts the title but keeps the old slug, editing the title again generates a slug that already exists, causing a 500 error (UNIQUE constraint).
3. **No manual lock for launchers** — After unlocking Ubisoft, there's no way to re-lock it without importing cache again.

## Fix 1: manual_title Flag

### Migration
- Add `manual_title INTEGER DEFAULT 0` column to `games` table (same pattern as Phase 13 migration for `manual_description`/`manual_cover`)

### PATCH Endpoint (`backend/src/routes/games.js`)
- When user edits title, set `manual_title = 1` alongside the title and slug update

### Enrichment (`backend/src/services/metadata/enrichGame.js`)
- In the upsert query (line ~193): `title = CASE WHEN games.manual_title = 1 THEN games.title ELSE excluded.title END`
- Also protect slug: `slug = CASE WHEN games.manual_title = 1 THEN games.slug ELSE excluded.slug END`

### Re-enrich Reset (`backend/src/routes/metadata.js`)
- When resetting fields before re-enrichment, don't clear title if `manual_title = 1`

### Manual Override Reset (`backend/src/routes/games.js`)
- Add "title" as a valid field in `DELETE /api/games/:id/manual-override` so users can clear `manual_title` and let enrichment take over

## Fix 2: Slug Collision in PATCH

### PATCH Endpoint (`backend/src/routes/games.js`)
- After generating the slug from the new title, check if it already exists on a different game
- If collision, append `-2`, `-3`, etc. until unique
- This prevents the 500 UNIQUE constraint error

## Fix 3: Manual Sync Lock

### Backend
- Add `POST /api/launchers/:id/lock-sync` endpoint in `backend/src/routes/launchers.js` — sets `sync_locked = 1` (mirror of the existing unlock endpoint)

### Frontend (`frontend/src/pages/Settings.jsx`)
- Show a "Lock" button when the launcher is configured and `!l.sync_locked`
- Placed next to the existing Sync button in the controls area

## Testing

- Migration test: `manual_title` column exists
- PATCH test: sets `manual_title = 1`
- PATCH test: slug collision handled (no 500)
- Enrichment test: respects `manual_title = 1`
- Lock endpoint test: sets `sync_locked = 1`
- Unlock after manual lock test: clears it
