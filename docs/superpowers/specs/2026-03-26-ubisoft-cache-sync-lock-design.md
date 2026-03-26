# Ubisoft Cache Import Sync Lock

**Date:** 2026-03-26
**Status:** Approved

## Problem

When Ubisoft cache files are imported, games are added to the database. A subsequent Ubisoft GraphQL sync marks any games NOT returned by the API as `owned = 0`, effectively removing cache-imported games that only exist locally.

## Solution

Set `sync_locked = 1` on the Ubisoft launcher after a successful cache import, identical to the Xbox approval workflow.

## Change

**File:** `backend/src/routes/launchers.js` — Ubisoft cache import endpoint (`POST /api/launchers/ubisoft/import-cache`)

After successful import, add:
```javascript
db.prepare('UPDATE launchers SET sync_locked = 1 WHERE id = ?').run(launcher.id);
```

## Existing Infrastructure Used

- `sync_locked` column already exists on `launchers` table
- Sync engine already skips launchers with `sync_locked = 1`
- Settings UI already shows "Locked" badge and "Unlock" button when `sync_locked = 1`

## Testing

- Regression test: verify `sync_locked = 1` after successful cache import

## Scope

One line in one file. No schema changes, no migration, no frontend changes.
