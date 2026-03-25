# Xbox Sync Lock — Design Spec

**Date:** 2026-03-25
**Status:** Approved

## Problem

When the user approves Xbox games (selecting only owned titles), rejected games are hard-deleted from the database. On the next sync, the Xbox API returns ALL games again and the sync engine re-inserts them with `owned = 1`, undoing the approval.

## Solution

Add a `sync_locked` flag to the `launchers` table. After approval, the launcher is automatically locked. The sync engine and sync endpoints refuse to sync locked launchers. The user must explicitly unlock before syncing again.

## Schema Change

Add column to `launchers` table:

```sql
ALTER TABLE launchers ADD COLUMN sync_locked INTEGER NOT NULL DEFAULT 0;
```

Applied as a migration in `backend/src/db/migrations/`.

## Backend Changes

### 1. Approve Endpoint (`POST /api/launchers/:id/approve`)

After deleting rejected editions, set `sync_locked = 1` on the launcher row. This automatically locks the launcher post-approval.

### 2. Sync Guard — Route Level (`POST /api/sync/:launcherName`)

Before calling `syncLauncher()`, check `sync_locked`. If locked, return HTTP 409:

```json
{ "error": "Xbox is locked. Unlock it in Settings before syncing." }
```

### 3. Sync Guard — `syncAll()` in `syncEngine.js`

Skip locked launchers. Add a `locked` array to the return value so callers know which launchers were skipped.

### 4. Available Endpoint (`GET /api/launchers/available`)

Include `sync_locked` in the response object so the frontend can reflect lock state.

### 5. New Unlock Endpoint (`POST /api/launchers/:id/unlock-sync`)

Sets `sync_locked = 0` on the launcher. Returns `{ success: true }`.

## Frontend Changes

### Settings / LaunchersTab

When a launcher has `sync_locked = true`:

- Replace the Sync button with a locked indicator (Lock icon + "Locked" text)
- Show an "Unlock" button that calls `POST /api/launchers/:id/unlock-sync`
- Keep the "Approve" button visible for re-approval after unlock + sync

### XboxApproval Page

No changes needed — it already works correctly on its own.

## What Doesn't Change

- Sync engine upsert logic (still sets `owned = 1`)
- Hard-delete approval logic (still deletes rejected editions)
- `game_editions` schema (no new columns)

## Testing

- Regression test: approve Xbox games, verify `sync_locked = 1`, attempt sync, verify it's blocked with 409
- Unlock test: unlock launcher, verify sync proceeds normally
- syncAll test: verify locked launchers are skipped and reported
