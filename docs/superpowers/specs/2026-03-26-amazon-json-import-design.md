# Amazon Games — JSON Import + PowerShell Export

**Date:** 2026-03-26
**Status:** Approved

## Problem

Amazon Games stores entitlement data in DPAPI-encrypted SQLite blobs. The initial SQLite-based import cannot read this data. We need a PowerShell script to decrypt and export the data on Windows, then import the resulting JSON through Gameshelf.

## Approach

1. PowerShell script decrypts DPAPI blobs from `Entitlements.sqlite`, exports a JSON file
2. Replace the SQLite parser with a JSON parser in the backend
3. Update the frontend to accept `.json` files and reference the PowerShell script

## PowerShell Script

**File:** `tools/amazon-export.ps1`

- Loads `Entitlements.sqlite` from `$env:LOCALAPPDATA\Amazon Games\Data\Entitlements.sqlite` (or user-specified path)
- Requires `System.Data.SQLite` or uses `Add-Type` with SQLite interop — alternatively, reads the file using .NET SQLite classes available on modern Windows
- For each row in `game_entitlements`:
  - Decrypts `value` BLOB using `[System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')`
  - Parses the decrypted bytes as UTF-8 text (likely JSON)
  - Extracts product ID (from `key` column) and title (from decrypted data)
- Outputs `amazon-games.json` to the current directory:
  ```json
  [
    { "productId": "uuid-here", "title": "Game Name" },
    ...
  ]
  ```
- Prints a summary (e.g., "Exported 42 games to amazon-games.json")

Note: The exact structure of the decrypted blob is unknown until we run it. The script should log the first decrypted blob so the user can inspect the format. If the decrypted data is JSON with a title field, extract it. If not, fall back to using the product ID as the title and log a warning.

## Backend Changes

**File:** `backend/src/services/launchers/amazon.js`

- Remove `parseGamesDb()` (SQLite parser)
- Add `parseGamesJson(buffer)`:
  - Parses buffer as UTF-8 JSON
  - Expects array of `{ productId, title }` objects
  - Returns `[{ launcher_game_id, title }]` sorted alphabetically
  - Throws on invalid JSON or missing fields

**File:** `backend/src/routes/launchers.js`

- Update preview endpoint to call `parseGamesJson()` instead of `parseGamesDb()`
- Accept file field named `games_json` instead of `games_db`

## Frontend Changes

**File:** `frontend/src/pages/AmazonApproval.jsx`

- Change file accept filter from `.db` to `.json`
- Change form field name from `games_db` to `games_json`
- Update instructions to reference the PowerShell script and `amazon-games.json`

## Testing

- Update unit tests: test `parseGamesJson()` with valid JSON, invalid JSON, missing fields
- Update route tests: send JSON file to preview endpoint
- Import test remains the same (it sends JSON body, not files)

## Re-import Safety

The upsert query handles re-imports safely:
- New games are inserted
- Existing games get title updated, owned confirmed
- Games not in the new file are untouched (no deletions)
