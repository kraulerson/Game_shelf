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
- Contextual instruction text, driven by an `otp_instruction` field on the launcher config:
  - Humble: "Enter the code emailed to you"
  - GOG: "Enter the code from your authenticator app"
- Text input for the code (accepts alphanumeric, no strict format validation — different services use different formats)
- Cancel and Sync buttons

**On submit:** Calls `POST /api/sync/:launcherName` with `Content-Type: application/json` and body `{ otp_code: "123456" }`. Modal closes, sync proceeds as normal.

**Error feedback:** Since sync is fire-and-forget, the user won't get immediate feedback if the code is wrong. They'll see "failed" on the next sync status poll (10s interval). This is an acceptable UX trade-off — the sync status area already displays error messages from failed sync jobs.

### Launcher Config Changes

In `backend/src/routes/launchers.js` AVAILABLE_LAUNCHERS:
- GOG: change `otp_supported: false` to `otp_supported: true`, add `otp_instruction: 'Enter the code from your authenticator app'`
- Humble: change `otp_supported: false` to `otp_supported: true`, add `otp_instruction: 'Enter the code emailed to you'`
- Keep `auth_type` as `credentials` for both (unchanged)

### Backend — Sync Route

**`POST /api/sync/:launcherName`** currently fires and forgets with no request body. Changes:
- Read optional `otp_code` from `req.body` (express.json() middleware is already configured globally in server.js)
- Pass it to `syncLauncher(launcherName, db, otpCode)`

### Backend — Sync Engine

**`syncLauncher(launcherName, db, otpCode)`:**
- Accepts optional `otpCode` parameter
- Adds `otpCode` to the credentials object before passing to the launcher: `credentials.otp_code = otpCode`
- Launchers that need it read `credentials.otp_code`; others ignore it
- `syncAll()` requires no changes — it calls `syncLauncher(name, db)` without a code, and 2FA launchers will fail gracefully (already handled by the per-launcher error catch)

### Backend — Humble Bundle Launcher (`humble.js`)

Rewrite `authenticate()` to handle 2FA:

1. POST to `https://www.humblebundle.com/processlogin` with form fields: `username`, `password`, `guard` (empty string on first attempt)
2. Humble returns HTTP 200 with a JSON body in all cases. Check response:
   - If `success: true` — login succeeded, extract `_simpleauth_sess` cookie
   - If `humble_guard_required: true` and `success: false` — email 2FA code needed
3. If 2FA required and `otp_code` is provided:
   - Re-POST to the same `/processlogin` endpoint with `username`, `password`, and `guard` set to the `otp_code`
   - Extract `_simpleauth_sess` cookie from success response
4. If 2FA required but no `otp_code` — throw error: "Humble Bundle requires a verification code. Sync this launcher individually with the code emailed to you."

### Backend — GOG Launcher (`gog.js`)

Rewrite `authenticate()` to use browser-based OAuth flow (current password grant doesn't support 2FA).

**Dependencies:** Requires `tough-cookie` and `axios-cookiejar-support` (or manual cookie management) for maintaining cookies across the multi-step flow. Add to backend dependencies.

**Auth flow:**
1. Create a cookie jar for the session (all requests share cookies)
2. GET the GOG auth page (`https://auth.gog.com/auth?client_id=...&response_type=code&...`) to obtain the login form
3. Extract CSRF token (`login[_token]`) from the HTML form
4. POST to `https://login.gog.com/login_check` with form fields: `login[username]`, `login[password]`, `login[_token]`
5. Check redirect URL:
   - If contains `on_login_success` — no 2FA, extract OAuth `code` from URL
   - If contains `two_step` or `totp` — 2FA required
6. If 2FA required and `otp_code` is provided:
   - GET the 2FA page, extract its CSRF token
   - POST the code as per-digit fields (`letter_1` through `letter_6` for TOTP)
   - Follow redirect to capture OAuth `code`
7. If 2FA required but no `otp_code` — throw error: "GOG requires an authenticator code. Sync this launcher individually with the code from your authenticator app."
8. Exchange OAuth `code` for tokens via `GET https://auth.gog.com/token?grant_type=authorization_code&code=...&client_id=...&client_secret=...`
9. Return `{ access_token, refresh_token }` — store both in credentials

**Fragility note:** This flow is based on reverse-engineering of GOG's web login (community projects: gogrepoc, lgogdownloader). The per-digit field names and CSRF token extraction are implementation details that GOG could change. If the flow breaks, errors will surface as sync failures.

**`refreshIfNeeded()` override:**
- Check if stored credentials contain a `refresh_token`
- If yes, attempt `grant_type=refresh_token` to get a new access token — no 2FA needed
- If refresh fails (expired/revoked), fall back to full `authenticate()` with `otp_code` from credentials
- If no refresh token stored, call `authenticate()` directly
- On success, return `{ session: access_token, updatedCredentials: { ...credentials, access_token, refresh_token } }` — syncEngine already persists updated credentials

### Data Flow

1. User clicks Sync on Humble/GOG row in Settings
2. Frontend detects `otp_supported === true` → shows 2FA modal
3. User enters code → clicks Sync in modal
4. `POST /api/sync/:launcherName` with `{ otp_code: "..." }` (Content-Type: application/json)
5. Sync route passes code to `syncLauncher(name, db, otpCode)`
6. Sync engine adds code to credentials, calls launcher's `refreshIfNeeded()`
7. Launcher authenticates with 2FA (or refresh token), fetches games
8. Normal sync flow continues (upsert, enrichment, etc.)

### Edge Cases

- **Wrong code:** Launcher auth fails, sync job marked as failed with error message — user sees "failed" status on next poll and can retry
- **Code expires while typing:** Same as wrong code — retry with fresh code
- **Humble sends email late:** User waits for email, enters code when it arrives — no timeout in the modal
- **GOG CSRF token changes:** Fetched fresh each auth attempt, so always current
- **GOG refresh token still valid:** `refreshIfNeeded()` uses refresh token silently — no 2FA prompt needed. User still sees the modal but the code won't actually be used (harmless)
- **Sync All:** 2FA launchers will fail (no code provided) — acceptable since user can sync them individually. `syncAll()` requires no changes.
- **Account without 2FA:** User enters any value in the modal, but the launcher ignores it if the API doesn't challenge. Alternatively, user could configure the launcher before 2FA is enabled, but this edge case is acceptable since both accounts currently have 2FA.

## Out of Scope

- Storing sessions/tokens for reuse across syncs (user enters code each time, though GOG refresh tokens provide partial session persistence)
- CAPTCHA handling (if either service introduces CAPTCHAs, the flow will fail — documented as a known limitation)
- Changing the Setup page 2FA flow (credentials are still saved as username/password only)
- Input validation on OTP code (different services use different formats)
- Skipping the 2FA modal for accounts that don't have 2FA enabled (always prompt for simplicity)
