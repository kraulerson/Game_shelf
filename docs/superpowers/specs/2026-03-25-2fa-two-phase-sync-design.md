# Two-Phase 2FA Sync for Humble Bundle and GOG

**Date:** 2026-03-25
**Status:** Approved
**Supersedes:** The pre-sync modal approach from `2026-03-24-humble-gog-2fa-design.md` for OTP code entry timing. The launcher auth rewrites (Humble guard flow, GOG browser OAuth) and backend plumbing (sync route accepting otp_code, syncEngine injection) from that spec remain valid.

## Problem

The current pre-sync modal asks for the 2FA code before the backend attempts login. This causes timing issues:
- **Humble Bundle:** The email code isn't sent until the backend POSTs to processlogin. The user has no code to enter when the modal appears.
- **GOG:** Google Authenticator codes rotate every 60 seconds. If the user enters a code and the backend doesn't submit it quickly enough, the code may have rotated by the time it reaches GOG.

## Solution

Replace the pre-sync modal with a two-phase sync flow. Phase 1 triggers the login (and the 2FA challenge). Phase 2 collects the code from the user and completes the login. The code is submitted immediately when the user enters it, eliminating timing mismatches.

Both Humble and GOG follow the same flow. The only difference is the prompt text.

## Design

### Phase 1 — Trigger Login

1. User clicks Sync on Humble/GOG row (no modal appears)
2. Backend starts sync, attempts login with saved credentials
3. Launcher's `authenticate()` hits the 2FA challenge:
   - Humble: receives `{ humble_guard_required: true }` (Humble sends the email at this point)
   - GOG: redirect URL contains `two_step` or `totp`
4. `authenticate()` throws a recognizable error with a convention like `OTP_REQUIRED:` prefix
5. Sync engine catches this specific error → updates the sync job status to `awaiting_otp` (new status value), stores the instruction text in `error_message`, and leaves `completed_at` as null
6. The 5-minute window is measured from `started_at` (already set when the job was created)
7. Sync function returns — does not block

### Phase 2 — Submit Code

1. Frontend polls sync status (existing 10-second interval), sees `awaiting_otp` on the launcher's latest job
2. Frontend checks if the job is within the 5-minute window (comparing `started_at` timestamp to now)
3. If within window: shows an **"Enter Code"** button on the launcher row
4. User clicks "Enter Code" → OTP modal opens with instruction text from `error_message`
5. User enters code → frontend POSTs to `POST /api/sync/:launcherName/otp` with `{ otp_code: "..." }`
6. Backend validates that an `awaiting_otp` job exists within the 5-minute window
7. Backend runs `syncLauncher(launcherName, db, otpCode)` — launcher authenticates with the code
8. Login completes → normal sync flow continues (upsert, enrichment, etc.)

### New Sync Job Status: `awaiting_otp`

Added to the existing status values (`pending`, `running`, `success`, `failed`):
- `awaiting_otp` — login triggered, waiting for user to provide 2FA code
- `started_at` is used for the 5-minute window calculation (already set when job is created)
- `completed_at` remains null (the job hasn't completed yet)
- `error_message` stores the instruction text for the frontend modal (e.g., "Enter the code emailed to you") — this is a pragmatic reuse of the field for non-error data in this specific status
- No schema changes needed — `status` is a TEXT column

### New Endpoint: `POST /api/sync/:launcherName/otp`

**Route ordering:** Must be registered before the `/:launcherName` catch-all in `sync.js`, following the same pattern as `/status`.

Request body:
```json
{ "otp_code": "123456" }
```

Logic:
1. Find the latest sync job for this launcher
2. Validate it has status `awaiting_otp` and `started_at` is within 5 minutes of now
3. If expired: return `400` with error "OTP window expired — click Sync to restart"
4. If valid: call `syncLauncher(launcherName, db, otpCode)` (fire and forget)
5. Return `{ message: "Sync resumed" }`

**5-minute window constant:** Define `OTP_WINDOW_MS = 5 * 60 * 1000` in the sync route and return it in the sync status response so the frontend uses the same value.

### Frontend Changes (Settings.jsx)

**Remove:** The pre-sync OTP modal trigger from `handleSyncClick()`. Clicking Sync always fires the sync immediately (the backend handles 2FA detection).

**Add:** "Enter Code" button logic based on sync status polling:
- When a launcher's latest sync job has status `awaiting_otp` AND is within the 5-minute window:
  - Show an **"Enter Code"** button on the launcher row (alongside or replacing Sync)
  - Clicking it opens the existing OTP modal (reuse the `otpPrompt` / `otpCode` state)
  - Instruction text comes from the sync job's `error_message` field
  - On submit: POSTs to `/api/sync/:launcherName/otp` instead of `/api/sync/:launcherName`
- When the 5-minute window expires:
  - "Enter Code" button disappears
  - Status shows the `awaiting_otp` state as expired/timed out
  - User clicks Sync to restart
- **Duplicate Sync prevention:** If a launcher already has an active `awaiting_otp` job within the window, clicking Sync should not start a new sync — instead, show a message or simply show the "Enter Code" button

**Survives refresh:** The "Enter Code" button is driven by sync status polling data, not component state. Refreshing the page, closing the modal, or navigating away and back all work — the button reappears as long as the `awaiting_otp` job is within the window.

### Launcher Changes

**Humble (`humble.js`):** Modify `authenticate()` to handle two distinct paths:
- **Phase 1 (no `otp_code`):** POST to processlogin with username, password, empty guard → if `humble_guard_required`, throw `OTP_REQUIRED:Enter the code emailed to you`
- **Phase 2 (has `otp_code`):** Skip the initial guard-less POST entirely. Go straight to POSTing with username, password, and `guard: otp_code`. This avoids triggering a second email which could invalidate the first code.

**GOG (`gog.js`):** Modify `authenticate()` similarly:
- **Phase 1 (no `otp_code`):** Run the full browser OAuth flow → hit the 2FA page → throw `OTP_REQUIRED:Enter the code from your authenticator app`
- **Phase 2 (has `otp_code`):** Run the full browser OAuth flow from scratch — GET auth page, POST credentials, hit 2FA page, submit code. This is a complete re-authentication. GOG's 2FA page will present a fresh challenge, and the user enters a fresh code from their authenticator. No session state needs to persist between phases because each phase does a full login.

**Note on GOG session state:** GOG uses an in-memory cookie jar (`CookieJar`) during authentication. Phase 2 creates a new launcher instance with a fresh cookie jar and performs a complete login flow. This works because GOG's 2FA is tied to the account, not the session — a fresh login attempt will present the 2FA challenge again, and the user's freshly-entered authenticator code will be valid.

### Sync Engine Changes

In `syncEngine.js`, catch errors starting with `OTP_REQUIRED:`:
- Set the sync job status to `awaiting_otp`
- Leave `completed_at` as null
- Store the instruction text in `error_message` (the part after `OTP_REQUIRED:`)
- Do **not** log this as an error — it's a normal flow step

**`syncAll` handling:** Add an explicit check for `awaiting_otp` status in `syncAll()` categorization. Jobs with this status go into an `awaitingOtp` array (or are simply excluded from `skipped` to avoid mischaracterization).

### Data Flow Summary

```
User clicks Sync
  → POST /api/sync/humble (no body)
  → syncLauncher starts, attempts login
  → Humble says "guard required", sends email
  → authenticate() throws OTP_REQUIRED
  → Sync job marked awaiting_otp
  → Frontend polls, sees awaiting_otp (within 5-min window)
  → Shows "Enter Code" button on Humble row
  → User clicks "Enter Code", enters emailed code
  → POST /api/sync/humble/otp { otp_code: "..." }
  → syncLauncher runs with code
  → Humble authenticate() skips initial POST, submits guard code directly
  → Login completes → normal sync continues
```

### Edge Cases

- **User closes modal:** "Enter Code" button remains visible (driven by poll data). Click again to re-open.
- **Page refresh:** Same — button reappears from poll data within the 5-minute window.
- **5-minute timeout:** Button disappears, user clicks Sync to restart the flow (triggers a fresh email).
- **Wrong code:** Sync fails normally (sync job status = `failed` with error message). User clicks Sync to restart.
- **Sync All:** 2FA launchers enter `awaiting_otp`. User provides codes individually via "Enter Code" buttons. `syncAll` categorizes these separately from failures/skips.
- **Non-2FA launchers:** Unaffected — Sync fires immediately, no `awaiting_otp` status ever set.
- **User clicks Sync while `awaiting_otp` is active:** Frontend prevents this — shows "Enter Code" instead of Sync during the window.
- **Polling delay:** Up to 10 seconds between clicking Sync and seeing "Enter Code" appear. Acceptable given the architecture.

## Out of Scope

- Automatic cleanup of expired `awaiting_otp` jobs (they're harmless — next sync creates a new job)
- WebSocket/SSE for instant status updates (10-second polling is sufficient)
- Persisting GOG session state between phases (full re-authentication is used instead)
- Removing the `otp_supported` flag from launcher configs (still useful for future UI hints)
