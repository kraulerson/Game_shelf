# Xbox Game Approval Feature

**Date:** 2026-03-24
**Status:** Approved

## Problem

The Xbox integration (via OpenXBL API) syncs all games from a user's title history, including games played through Xbox Game Pass that the user doesn't own. The API provides no way to distinguish owned vs. Game Pass games. Users need a way to curate their Xbox library to only include games they actually own.

## Solution

A dedicated approval page accessible from the Xbox launcher row on the Settings page. The page presents all synced Xbox games as an unchecked checklist. The user checks the games they own, clicks Save, and all unchecked games are hard-deleted from the database.

## Design

### Frontend — Settings Page (Xbox Row)

- Add an "Approve" button to the Xbox launcher row, shown when Xbox is configured
- Positioned alongside the existing Sync and Remove buttons
- Navigates to `/settings/xbox/approve`

### Frontend — Approval Page (`/settings/xbox/approve`)

- **Header:** "Xbox Game Approval" with a back link to Settings
- **Game list:** All Xbox game editions where `owned = 1`
- **Each row:** Checkbox (unchecked by default), cover art thumbnail (if available), game title
- **Controls:**
  - Select All / Deselect All toggle at the top
  - Save button at the bottom — disabled until at least one game is checked
- **On Save:** Sends approved edition IDs to backend, redirects to Settings with success toast
- **Empty state:** Message like "No Xbox games to review" if no editions exist

### Backend — New Endpoint

**`POST /api/launchers/xbox/approve`**

Request body:
```json
{ "approved_edition_ids": [1, 2, 5] }
```

Logic:
1. Query all Xbox game editions where `owned = 1`
2. Hard-delete any edition NOT in the `approved_edition_ids` list
3. For each deleted edition: if the parent game has no remaining editions from any launcher, hard-delete the game record too
4. Return `{ deleted_editions: <count>, deleted_games: <count> }`

### Data Flow

1. User clicks "Approve" on Xbox row → navigates to `/settings/xbox/approve`
2. Page fetches Xbox editions via existing game/edition API filtered by Xbox launcher
3. User checks games they own → clicks Save
4. `POST /api/launchers/xbox/approve` receives approved edition IDs
5. Backend deletes unapproved editions and orphaned games
6. User redirected to Settings with success toast

### Edge Cases

- **Zero games checked:** Save button is disabled, prevents accidental deletion of all games
- **Game has editions from multiple launchers:** Only the Xbox edition is deleted; the game survives with its other editions
- **User syncs Xbox again after approving:** Previously deleted games reappear via sync; user can approve again (button persists for this reason)
- **No Xbox games exist:** Empty state message shown

## Out of Scope

- Automatic ownership detection (not possible via OpenXBL API)
- Approval flow for other launchers (not needed — other launchers sync only owned games)
- Undo/restore of deleted games (user can re-sync to get them back)
