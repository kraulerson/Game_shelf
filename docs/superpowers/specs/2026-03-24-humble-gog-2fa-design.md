# Humble Bundle & GOG 2FA Support

**Date:** 2026-03-24
**Status:** Approved

## Problem

Humble Bundle and GOG both require 2FA during login. Humble emails a verification code; GOG uses Google Authenticator (TOTP). The current launcher implementations send only username/password and fail when 2FA is required.

## Solution

Add a pre-sync 2FA prompt. When the user clicks Sync on a launcher with `otp_supported: true`, a modal asks for the 2FA code before starting the sync. The code is passed through to the launcher's authentication flow. No session storage — the user enters the code each time they sync.

## Design

### Frontend — 2FA Sync Modal (Settings Page)

**Trigger:** When clicking Sync on a configured launcher with `otp_supported === true`, show a modal instead of firing the sync immediately.

**Modal contents:**
- Launcher name in the header
- Contextual instruction text:
  - Humble: "Enter the code emailed to you"
  - GOG: "Enter the code from your authenticator app"
- Text input for the code
- Cancel and Sync buttons

**On submit:** Calls `POST /api/sync/:launcherName` with `{ otp_code: "123456" }` in the request body. Modal closes, sync proceeds as normal.

### Launcher Config Changes

In `backend/src/routes/launchers.js` AVAILABLE_LAUNCHERS:
- GOG: change `otp_supported: false` to `otp_supported: true`
- Humble: change `otp_supported: false` to `otp_supported: true`
- Keep `auth_type` as `credentials` for both (unchanged)

### Backend — Sync Route

**`POST /api/sync/:launcherName`** currently fires and forgets with no request body. Changes:
- Read optional `otp_code` from `req.body`
- Pass it to `syncLauncher(launcherName, db, otpCode)`

### Backend — Sync Engine

**`syncLauncher(launcherName, db, otpCode)`:**
- Accepts optional `otpCode` parameter
- Adds `otpCode` to the credentials object before passing to the launcher: `credentials.otp_code = otpCode`
- Launchers that need it read `credentials.otp_code`; others ignore it

### Backend — Humble Bundle Launcher (`humble.js`)

Rewrite `authenticate()` to handle 2FA:

1. POST to `https://www.humblebundle.com/processlogin` with `username`, `password`, and empty `guard` field
2. Check response JSON:
   - If `success: true` — login succeeded, extract `_simpleauth_sess` cookie
   - If `humble_guard_required: true` — 2FA is needed
3. If 2FA required and `otp_code` is provided:
   - Re-POST to the same `/processlogin` endpoint with `username`, `password`, and `guard` set to the `otp_code`
   - Extract `_simpleauth_sess` cookie from success response
4. If 2FA required but no `otp_code` — throw error: "2FA code required"

### Backend — GOG Launcher (`gog.js`)

Rewrite `authenticate()` to use browser-based OAuth flow (current password grant doesn't support 2FA):

1. GET the GOG auth page to obtain the login form and CSRF token (`login[_token]`)
2. POST to `https://login.gog.com/login_check` with `login[username]`, `login[password]`, `login[_token]`
3. Check redirect URL:
   - If contains `on_login_success` — no 2FA, extract OAuth `code` from URL
   - If contains `two_step` or `totp` — 2FA required
4. If 2FA required and `otp_code` is provided:
   - Extract CSRF token from the 2FA form page
   - POST the code as per-digit fields (`letter_1` through `letter_6` for TOTP)
   - Follow redirect to get OAuth `code`
5. Exchange OAuth `code` for access token via `GET https://auth.gog.com/token?grant_type=authorization_code&code=...`
6. Return access token

**Note:** GOG uses the Galaxy client credentials (client_id `46899977096215655`, client_secret from community reverse-engineering). The `refreshIfNeeded()` method should be updated to use refresh_token grant when possible, falling back to full re-auth with 2FA when the refresh token expires.

### Data Flow

1. User clicks Sync on Humble/GOG row in Settings
2. Frontend detects `otp_supported === true` → shows 2FA modal
3. User enters code → clicks Sync in modal
4. `POST /api/sync/:launcherName` with `{ otp_code: "..." }`
5. Sync route passes code to `syncLauncher(name, db, otpCode)`
6. Sync engine adds code to credentials, calls launcher
7. Launcher authenticates with 2FA, fetches games
8. Normal sync flow continues (upsert, enrichment, etc.)

### Edge Cases

- **Wrong code:** Launcher auth fails, sync job marked as failed with error message, user can retry
- **Code expires while typing:** Same as wrong code — retry with fresh code
- **Humble sends email late:** User waits for email, enters code when it arrives — no timeout in the modal
- **GOG CSRF token changes:** Fetched fresh each auth attempt, so always current
- **Sync All:** For `syncAll()`, launchers requiring 2FA will fail (no code provided) — this is acceptable since the user can sync them individually. The `syncAll` function already handles per-launcher failures gracefully.

## Out of Scope

- Storing sessions/tokens for reuse across syncs (user enters code each time)
- CAPTCHA handling (if either service introduces CAPTCHAs, manual browser login would be needed)
- Changing the Setup page 2FA flow (credentials are still saved as username/password only)
