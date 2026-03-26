# Manual Metadata Editing — Design Spec

**Date:** 2026-03-25
**Version:** 1.12.3 (current)
**Scope:** Allow users to manually set description and cover image for games, with protection against auto-enrichment overwriting manual edits.

## Motivation

Four itch.io games (2d treasure hunter, earth clicker, fjords, welcome) have no IGDB metadata. The user needs a way to manually provide descriptions and cover images for games that automated enrichment can't fill.

## Approach

Override flag columns on the `games` table. When a user manually edits a field, a boolean flag is set. Enrichment checks these flags and skips protected fields. The user can reset flags to allow auto-enrichment to take over again.

## Database Migration

Add two boolean columns to `games`:

```sql
ALTER TABLE games ADD COLUMN manual_description INTEGER DEFAULT 0;
ALTER TABLE games ADD COLUMN manual_cover INTEGER DEFAULT 0;
```

Both default to `0` (false). Set to `1` when the user manually edits that field. The existing `description` and `cover_url` columns continue to hold the actual values — no new content columns needed.

## API Changes

### Extend PATCH `/api/games/:id`

Currently accepts `{ title }`. Extend to also accept:

- `description` (string) — updates `description` and sets `manual_description = 1`

Title editing continues to work as before (no override flag for title — it already has its own behavior).

### New: POST `/api/games/:id/cover`

- Accepts `multipart/form-data` with a single image file
- Validates: image type (JPEG, PNG, WebP), max size ~5MB
- Saves to `/data/images/{gameId}/cover.{ext}` (same path convention as enrichment uses)
- Updates `games.cover_url` and sets `manual_cover = 1`
- Returns the new `cover_url` path

### New: DELETE `/api/games/:id/manual-override`

- Accepts `{ field: "description" | "cover" }` in the request body
- Sets the corresponding `manual_*` flag back to `0`
- Does not clear the content — just unlocks it for the next enrichment run to overwrite
- This is the "reset to auto" escape hatch

## Enrichment Protection

In `enrichGame.js`, before updating a game's metadata:

- Read `manual_description` and `manual_cover` flags for the game
- If `manual_description = 1`, skip writing to `description`
- If `manual_cover = 1`, skip writing to `cover_url` (and `icon_url`, since icon is derived from cover)
- Build the UPDATE statement dynamically, only including non-protected fields

Same logic in `enrichUnderEnriched()` — the existing `COALESCE` pattern gets an additional guard: don't attempt to fill a manually-overridden field.

Both the daily cron and the manual "re-enrich" button respect these flags. To reset, the user clears the flag via "reset to auto", then re-enriches.

## Frontend — GameDetail.jsx

### Description Editing

- Pencil/edit icon next to the description section (same pattern as existing title editing)
- Clicking turns the description into a plain textarea
- Save/cancel buttons — save calls PATCH `/api/games/:id` with `{ description }`
- When `manual_description = 1`, show a "Manually edited" indicator with a "Reset to auto" action (calls DELETE `/api/games/:id/manual-override`)

### Cover Image Editing

- Small camera/upload icon overlay on the cover image (visible on hover, or always shown for games with no cover)
- Clicking opens a file picker dialog
- On file selection, uploads via POST `/api/games/:id/cover`
- Loading spinner during upload, then refreshes the image
- When `manual_cover = 1`, show "Manually edited" indicator with "Reset to auto"

### Empty State

For games with no metadata at all (the 4 itch.io games):

- Empty description area shows an "Add description" placeholder/button
- Missing cover shows a placeholder with an upload prompt

No new pages or modals — everything inline on GameDetail, consistent with existing title editing.

## Testing

### Backend Unit Tests

- PATCH `/api/games/:id` with `description` — updates and sets `manual_description = 1`
- POST `/api/games/:id/cover` — file upload saves to disk, updates `cover_url`, sets `manual_cover = 1`
- DELETE `/api/games/:id/manual-override` — flag reset for each field
- Reject invalid image types and oversized files
- Enrichment skips manually-overridden fields
- Enrichment still updates non-protected fields normally
- `enrichUnderEnriched` respects override flags

### Regression Test

Manually set a description, run enrichment, verify the manual description survives. This is the core protection guarantee.
