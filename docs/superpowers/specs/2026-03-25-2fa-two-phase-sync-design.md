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
5. Sync engine catches this specific error → updates the sync job status to `awaiting_otp` (new status value) with the current timestamp in `completed_at` (used as the "waiting since" time)
6. Sync function returns — does not block

### Phase 2 — Submit Code

1. Frontend polls sync status (existing 10-second interval), sees `awaiting_otp` on the launcher's latest job
2. Frontend checks if the job is within the 5-minute window (comparing `completed_at` timestamp to now)
3. If within window: shows an **"Enter Code"** button on the launcher row
4. User clicks "Enter Code" → OTP modal opens with launcher-specific instruction text
5. User enters code → frontend POSTs to `POST /api/sync/:launcherName/otp` with `{ otp_code: "..." }`
6. Backend validates that an `awaiting_otp` job exists within the 5-minute window
7. Backend runs `syncLauncher(launcherName, db, otpCode)` — launcher re-authenticates with the code
8. Login completes → normal sync flow continues (upsert, enrichment, etc.)

### New Sync Job Status: `awaiting_otp`

Added to the existing status values (`pending`, `running`, `success`, `failed`):
- `awaiting_otp` — login triggered, waiting for user to provide 2FA code
- `completed_at` is set to the current timestamp when entering this state (used as the window start time)
- No schema changes needed — `status` is a TEXT column, and `completed_at` is already nullable TEXT

### New Endpoint: `POST /api/sync/:launcherName/otp`

Request body:
```json
{ "otp_code": "123456" }
```

Logic:
1. Find the latest sync job for this launcher
2. Validate it has status `awaiting_otp` and `completed_at` is within 5 minutes of now
3. If expired: return `400` with error "OTP window expired — click Sync to restart"
4. If valid: call `syncLauncher(launcherName, db, otpCode)` (fire and forget)
5. Return `{ message: "Sync resumed" }`

### Frontend Changes (Settings.jsx)

**Remove:** The pre-sync OTP modal trigger from `handleSyncClick()`. Clicking Sync always fires the sync immediately (the backend handles 2FA detection).

**Add:** "Enter Code" button logic based on sync status polling:
- When a launcher's latest sync job has status `awaiting_otp` AND is within the 5-minute window:
  - Show an **"Enter Code"** button on the launcher row (alongside or replacing Sync)
  - Clicking it opens the existing OTP modal (reuse the `otpPrompt` / `otpCode` state)
  - On submit: POSTs to `/api/sync/:launcherName/otp` instead of `/api/sync/:launcherName`
- When the 5-minute window expires:
  - "Enter Code" button disappears
  - Status shows the `awaiting_otp` state as expired/timed out
  - User clicks Sync to restart

**Survives refresh:** The "Enter Code" button is driven by sync status polling data, not component state. Refreshing the page, closing the modal, or navigating away and back all work — the button reappears as long as the `awaiting_otp` job is within the window.

### Launcher Changes

**Humble (`humble.js`):** When `humble_guard_required` is detected and no `otp_code` is provided, throw `new Error('OTP_REQUIRED:Enter the code emailed to you')`. The text after `OTP_REQUIRED:` is used as the modal instruction.

**GOG (`gog.js`):** When 2FA redirect is detected and no `otp_code` is provided, throw `new Error('OTP_REQUIRED:Enter the code from your authenticator app')`.

### Sync Engine Changes

In `syncEngine.js`, catch errors starting with `OTP_REQUIRED:`:
- Set the sync job status to `awaiting_otp`
- Set `completed_at` to the current timestamp
- Store the instruction text in `error_message` (the part after `OTP_REQUIRED:`)
- Do **not** log this as an error — it's a normal flow step

### Data Flow Summary

```
User clicks Sync
  → POST /api/sync/humble (no body)
  → syncLauncher starts, attempts login
  → Humble says "guard required", sends email
  → authenticate() throws OTP_REQUIRED
  → Sync job marked awaiting_otp
  → Frontend polls, sees awaiting_otp
  → Shows "Enter Code" button on Humble row
  → User clicks "Enter Code", enters emailed code
  → POST /api/sync/humble/otp { otp_code: "..." }
  → syncLauncher runs with code, login completes
  → Normal sync continues
```

### Edge Cases

- **User closes modal:** "Enter Code" button remains visible (driven by poll data). Click again to re-open.
- **Page refresh:** Same — button reappears from poll data within the 5-minute window.
- **5-minute timeout:** Button disappears, user clicks Sync to restart the flow.
- **Wrong code:** Sync fails normally (sync job status = `failed` with error message). User clicks Sync to restart.
- **Sync All:** 2FA launchers will hit the `OTP_REQUIRED` path and enter `awaiting_otp`. User can then provide codes individually via the "Enter Code" buttons. `syncAll` already handles per-launcher failures.
- **Non-2FA launchers:** Unaffected — `handleSyncClick` fires sync immediately, no `awaiting_otp` status ever set.

## Out of Scope

- Automatic cleanup of expired `awaiting_otp` jobs (they're harmless — next sync creates a new job)
- WebSocket/SSE for instant status updates (10-second polling is sufficient)
- Changing the GOG launcher auth implementation (browser OAuth flow from previous spec is kept)
