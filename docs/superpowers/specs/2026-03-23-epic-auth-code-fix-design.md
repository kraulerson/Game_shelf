# Epic Games Auth Fix: Revert to Authorization Code Flow

**Date:** 2026-03-23
**Status:** Approved
**Scope:** Bug fix — 2 files, 3 changes

## Problem

Epic Games authentication fails with `"exchangeCode is invalid"` when attempting to exchange a code obtained from `/id/api/exchange/generate`. The debug iteration commits (`d2794a1` → `dce6410` → `01a1146` → `20a5de4`) changed the working auth flow to use `exchange_code` grant type and a different login URL, which broke initial authentication.

## Root Cause

The original implementation (commit `9668f04`) used the correct authorization code flow. Subsequent debug commits changed:
1. The login URL from `/id/api/redirect?clientId=...&responseType=code` to `/id/api/exchange/generate`
2. The grant type from `authorization_code` to `exchange_code`
3. The parameter name from `code` to `exchange_code`

The `/id/api/exchange/generate` endpoint produces exchange codes tied to the web session client, which cannot be redeemed by `launcherAppClient2`.

## Solution

Revert the auth flow to match the original working implementation (and Legendary/Heroic reference clients):

### 1. Frontend — `Setup.jsx` (line 284)

Restore the Legendary-style login URL with embedded client ID:

**Before:**
```
https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fexchange%2Fgenerate
```

**After:**
```
https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect%3FclientId%3D34a02cf8f4414e29b15921876da36f9a%26responseType%3Dcode
```

### 2. Frontend — `Setup.jsx` (line 292)

Fix the instruction text to match the JSON field name shown by the redirect page:

**Before:** `Copy the "code" value`
**After:** `Copy the "authorizationCode" value`

### 3. Backend — `epic.js` (lines 35-38)

Revert the grant type and parameter name:

**Before:**
```js
grant_type: 'exchange_code',
exchange_code: auth_code,
```

**After:**
```js
grant_type: 'authorization_code',
code: auth_code,
```

### What stays the same

- Client credentials (`launcherAppClient2`: `34a02cf8f4414e29b15921876da36f9a`)
- Client secret (corrected in `d2794a1`, kept: `daafbccc737745039dffe53d94fc76cf`)
- `token_type: 'eg1'` in token requests (intentional, matches Legendary)
- Auth header format (Basic auth with base64-encoded credentials)
- Refresh token flow (`grant_type: refresh_token`)
- All downstream game/playtime fetching
- Debug logging (kept for this attempt; remove once auth is confirmed working)

## UX Impact

Identical user flow. The JSON page shows `"authorizationCode"` instead of `"code"` — instruction text updated to match.

## Regression Test

A unit test in `backend/tests/services/launchers/epic.test.js` that mocks `axios.post` and verifies `authenticate()` sends the correct parameters:

- `grant_type` is `'authorization_code'` (not `'exchange_code'`)
- Parameter name is `code` (not `exchange_code`)
- Authorization header uses Basic auth with the correct client credentials

This test must **fail** against the current code (which sends `exchange_code`) and **pass** after the fix. Uses `node:test` and `node:assert/strict` consistent with existing test patterns (see `steam.test.js`).

## Manual Testing

1. Rebuild the Docker container
2. Remove existing Epic credentials if any
3. Click the login link — verify JSON page shows `authorizationCode` field
4. Copy the value, paste, save — verify no 401/invalid code error
5. Sync and verify games are returned
6. Wait for token expiry (or manually backdate `expires_at`) and re-sync to verify refresh works

## If This Fails

Debug logging is still in place. Check container logs for the `[Epic] Token response:` line to see what Epic returns. The next fallback would be the two-step exchange approach (Approach B).

## Alternatives Considered

- **Two-step exchange:** Authenticate with web client first, then generate launcher exchange code. Rejected — more complex, more fragile.
- **Device auth:** Persistent device token. Rejected — still needs initial auth to work first; can be added later as an enhancement.
