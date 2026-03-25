# Xbox Sync Lock — Design Spec

**Date:** 2026-03-25
**Status:** Approved

## Problem

When the user approves Xbox games (selecting only owned titles), rejected games are hard-deleted from the database. On the next sync, the Xbox API returns ALL games again and the sync engine re-inserts them with `owned = 1`, undoing the approval.

## Solution

Add a `sync_locked` flag to the `launchers` table. After approval, the launcher is automatically locked. The sync engine refuses to sync locked launchers. The user must explicitly unlock before syncing again.

## Schema Change

Add column to `launchers` table:

```sql
ALTER TABLE launchers ADD COLUMN sync_locked INTEGER NOT NULL DEFAULT 0;
```

Applied inline in `backend/src/db/migrate.js` following the existing column-existence-check pattern (e.g., the `games_found` migration).

## Backend Changes

### 1. Approve Endpoint (`POST /api/launchers/:id/approve`)

Set `sync_locked = 1` on the launcher row after processing — including the early-return path where all games are approved (no deletions). The user has explicitly reviewed the list, so the lock should engage regardless.

### 2. Sync Guard — Engine Level (`syncLauncher()` in `syncEngine.js`)

Add the lock check inside `syncLauncher()` itself, before authentication/fetch. This is the single source of truth for the guard, protecting both the HTTP endpoint and the cron-scheduled `syncAll()` path. Throw an error like `"Launcher is sync-locked"` so the sync job is recorded as failed with a clear message.

### 3. Sync Guard — Route Level (`POST /api/sync/:launcherName`)

Also check `sync_locked` at the route level before firing `syncLauncher()`. Return HTTP 409:

```json
{ "error": "Xbox is locked. Unlock it in Settings before syncing." }
```

This provides a clean user-facing error without creating a failed sync job.

### 4. Sync Guard — `syncAll()` in `syncEngine.js`

Skip locked launchers. Add a `locked` array to the return value (separate from `skipped`, which means "synced but found nothing").

### 5. Available Endpoint (`GET /api/launchers/available`)

Add `sync_locked` to the DB query in the `/available` handler (currently selects only `name`, `credentials_json`, `priority`). Merge it into the response object alongside `configured` and `priority`.

### 6. New Unlock Endpoint (`POST /api/launchers/:id/unlock-sync`)

Sets `sync_locked = 0` on the launcher. Validates launcher ID against `LAUNCHER_MAP` and the DB row, returning 400/404 on invalid input. Returns `{ success: true }` on success. Idempotent — unlocking an already-unlocked launcher is a no-op success.

### 7. Credential Deletion (`DELETE /api/launchers/:id/credentials`)

Reset `sync_locked = 0` when credentials are removed. This prevents a stale lock persisting if the user removes and re-adds credentials.

## Frontend Changes

### Settings / LaunchersTab

When a launcher has `sync_locked = true`:

- Replace the Sync button with a locked indicator (Lock icon + "Locked" text)
- Show an "Unlock" button that calls `POST /api/launchers/:id/unlock-sync`
- Keep the "Approve" button visible (works independently of lock state)

### XboxApproval Page

Update the confirmation dialog text from "re-sync to recover" to "unlock and re-sync to recover" to reflect the new workflow.

## What Doesn't Change

- Sync engine upsert logic (still sets `owned = 1`)
- Hard-delete approval logic (still deletes rejected editions)
- `game_editions` schema (no new columns)

## Testing

- Regression test: approve Xbox games, verify `sync_locked = 1`, attempt sync via route, verify 409 response
- Engine guard test: call `syncLauncher()` directly on a locked launcher, verify it throws/fails
- Unlock test: unlock launcher, verify sync proceeds normally
- syncAll test: verify locked launchers are skipped and listed in `locked` array
- Credential deletion test: lock a launcher, delete credentials, verify `sync_locked` is reset to 0
- Approve-all test: approve all games (no deletions), verify lock is still set
