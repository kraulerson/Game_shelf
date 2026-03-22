# Gameshelf Phase 2 — Auth, Setup Wizard & Route Guards

**Date:** 2026-03-22
**Status:** Approved
**Scope:** Tasks 1–6 of Phase 2

## Overview

Phase 2 adds authentication (JWT via httpOnly cookies), a multi-step setup wizard for configuring game launchers, TOTP/2FA support, and frontend route guards. Building on the Phase 1 foundation (schema, encryption, Express skeleton, React/Vite placeholder).

## Task 1 — JWT Auth Middleware & Routes

### Middleware: `/backend/src/middleware/auth.js`

- Reads JWT from `req.cookies.gameshelf_session`
- Verifies with `process.env.GAMESHELF_JWT_SECRET` using `jsonwebtoken`
- On success: sets `req.user = { id, username }` from decoded token payload
- On failure: returns `401 { error: "Unauthorized" }` — no redirect, no failure details

### Routes: `/backend/src/routes/auth.js`

| Method | Path | Auth | Behavior |
|--------|------|------|----------|
| POST | `/api/auth/login` | No | Lookup user by username in `users` table via `req.app.locals.db`. bcrypt compare password. On match: sign JWT `{ id, username }` with 24h expiry, set httpOnly/Secure/SameSite=Strict cookie `gameshelf_session` (maxAge 24h, path=/). Return `{ username }`. On mismatch: 401 `{ error: "Invalid credentials" }`. |
| POST | `/api/auth/logout` | No | Clear `gameshelf_session` cookie (same flags). Return `{ ok: true }`. |
| GET | `/api/auth/me` | Yes | Return `{ username: req.user.username }`. |

### Database Access Pattern

`server.js` sets `app.locals.db = db` after `runMigrations()`. Routes access via `req.app.locals.db`.

## Task 2 — Frontend Login Page

### `/frontend/src/pages/Login.jsx`

- Dark theme, centered card layout using TailwindCSS
- "Gameshelf" app title displayed above the form
- Username + password fields, submit button
- POSTs to `/api/auth/login`
- On 401: displays "Invalid credentials" inline below form (no `alert()`)
- On success: calls `GET /api/setup/status`
  - If `{ complete: false }` → navigate to `/setup`
  - Else → navigate to `/library`

### TailwindCSS Infrastructure

- `tailwind.config.js` — content paths: `./src/**/*.{js,jsx}`
- `postcss.config.js` — standard Tailwind + autoprefixer
- `src/index.css` — Tailwind directives (`@tailwind base/components/utilities`)
- Import `index.css` in `main.jsx`

## Task 3 — Setup Wizard Backend

### Routes: `/backend/src/routes/setup.js`

All routes protected by auth middleware.

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/setup/status` | Query `launchers` for any row with `enabled=1` AND `credentials_json IS NOT NULL`. If found, return `{ complete: true }`. Else check `settings` table for `setup_complete` key. Return `{ complete: bool }`. |
| POST | `/api/setup/complete` | Upsert `settings` with `key='setup_complete', value='true'`. Return `{ ok: true }`. |
| GET | `/api/launchers/available` | Return hardcoded static array of 9 launchers (see below). |
| POST | `/api/launchers/:id/credentials` | Validate `:id` is in supported list. Accept `{ username, password, api_key, totp_secret }`. Encrypt full payload with `encrypt(JSON.stringify(payload))`. Upsert `launchers` row: set `credentials_json`, `enabled=1`. Return `{ ok: true }`. |
| GET | `/api/launchers/:id/test` | Decrypt `credentials_json`. Stub: return `{ success: true, message: "Connection test not yet implemented for [launcher]" }` with TODO comment. |
| POST | `/api/launchers/priority` | Accept `[{ id, priority }]` array. Update `priority` column per launcher in a transaction. Return `{ ok: true }`. |
| GET | `/api/setup/qr/:launcher_id` | Call `generateQRSetupData(launcherId, username)` from TOTP util. Return `{ uri: "otpauth://..." }`. |

### Stub: `/backend/src/routes/sync.js`

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/sync/all` | Return `{ status: "started" }`. TODO: real sync implementation. |

### Supported Launchers (static data)

```json
[
  {"id":"steam","display_name":"Steam","auth_type":"credentials+totp","otp_supported":true,"qr_supported":true},
  {"id":"ea","display_name":"EA App","auth_type":"credentials+totp","otp_supported":true,"qr_supported":false},
  {"id":"ubisoft","display_name":"Ubisoft Connect","auth_type":"credentials+totp","otp_supported":true,"qr_supported":false},
  {"id":"epic","display_name":"Epic Games","auth_type":"credentials+totp","otp_supported":true,"qr_supported":false},
  {"id":"humble","display_name":"Humble Bundle","auth_type":"credentials","otp_supported":false,"qr_supported":false},
  {"id":"itchio","display_name":"itch.io","auth_type":"api_key","otp_supported":false,"qr_supported":false},
  {"id":"gog","display_name":"GOG","auth_type":"credentials","otp_supported":false,"qr_supported":false},
  {"id":"battlenet","display_name":"Battle.net","auth_type":"credentials+totp","otp_supported":true,"qr_supported":false},
  {"id":"xbox","display_name":"Xbox / Microsoft","auth_type":"credentials","otp_supported":false,"qr_supported":false}
]
```

## Task 4 — TOTP Support

### `/backend/src/utils/totp.js`

| Function | Behavior |
|----------|----------|
| `generateTOTPCode(secret)` | Uses `otpauth` package. Creates TOTP instance (SHA-1, 6 digits, 30s period). Returns current 6-digit code as string. |
| `generateQRSetupData(launcherId, username)` | Builds `otpauth://totp/Gameshelf:{launcherId}:{username}` URI via `otpauth` package's URI generation. Returns URI string. |
| `generateSteamCode(sharedSecret)` | Uses `steam-totp` package. Calls `SteamTotp.generateAuthCode(sharedSecret)`. Documented: Steam uses non-standard TOTP — base64 shared secret, custom 5-char alphabet (`23456789BCDFGHJKMNPQRTVWXY`), Steam Guard Mobile Authenticator protocol. |

### New dependencies

- `otpauth` — TOTP generation and URI building
- `steam-totp` — Steam Guard code generation

## Task 5 — Setup Wizard Frontend

### `/frontend/src/pages/Setup.jsx`

Single component with `step` state variable (1–5). Shared state: `selectedLaunchers`, `credentials` (per-launcher object).

**Step 1 — Welcome:** "Welcome to Gameshelf" title, brief description, "Begin Setup" button.

**Step 2 — Select Launchers:** Checkbox grid from `GET /api/launchers/available`. Each shows display name and auth type badge. Sets `selectedLaunchers`.

**Step 3 — Configure Credentials:** Card per selected launcher:
- Username/password fields if `auth_type` includes `credentials`
- API key field if `auth_type` is `api_key`
- "Enable 2FA" toggle if `otp_supported` is true
  - If enabled: text input for "TOTP Secret" + "Or scan QR code" button
  - QR button calls `GET /api/setup/qr/:launcher_id`, renders `QRCodeSVG` from `qrcode.react`
  - Steam: warning notice about Steam Guard shared_secret
- "Test Connection" button calls `GET /api/launchers/:id/test`, shows inline result
- "Save" calls `POST /api/launchers/:id/credentials`

**Step 4 — Launcher Priority:** Drag-and-drop sortable list using `@dnd-kit/core` + `@dnd-kit/sortable`. Top item = priority 1. Saves via `POST /api/launchers/priority` on "Next".

**Step 5 — Done:** "Gameshelf is ready. Your library is syncing now." Fires `POST /api/sync/all` in background. Navigates to `/library` after 2 seconds.

### New frontend dependencies

- `react-router-dom` — routing
- `qrcode.react` — QR code rendering
- `@dnd-kit/core` — drag-and-drop core
- `@dnd-kit/sortable` — sortable list preset

## Task 6 — Route Guards

### `/frontend/src/components/RequireAuth.jsx`

- Calls `GET /api/auth/me` on mount
- On 401 → redirect to `/login`
- On success → render `<Outlet />`
- Shows nothing (or spinner) while checking

### `/frontend/src/components/RequireSetup.jsx`

- Calls `GET /api/setup/status` on mount
- If `{ complete: false }` → redirect to `/setup`
- On success → render `<Outlet />`

### Route Structure in `App.jsx`

```
/login          → Login.jsx (public)
/setup          → RequireAuth → Setup.jsx
/library        → RequireAuth → RequireSetup → Library.jsx (placeholder)
/settings       → RequireAuth → Settings.jsx (placeholder)
/               → redirect to /library
```

### Placeholder Pages

- `Library.jsx` — dark-themed page with "Library" heading
- `Settings.jsx` — dark-themed page with "Settings" heading

## Decisions & Trade-offs

| Decision | Choice | Rationale |
|----------|--------|-----------|
| DB access pattern | `app.locals.db` | Simple, no extra modules, idiomatic Express |
| Auth state management | Fetch-on-mount (no global state) | httpOnly cookies handled by browser; guards already call `/api/auth/me`; no extra deps |
| Wizard structure | Single component with step state | Shared state between steps is simpler in one file; extract later if needed |
| Cookie security | httpOnly + Secure + SameSite=Strict | Prevents XSS token theft and CSRF |
| TOTP library | `otpauth` + `steam-totp` | Standard TOTP via `otpauth`; Steam's non-standard protocol requires dedicated package |

## Files Created/Modified

### New files
- `backend/src/middleware/auth.js`
- `backend/src/utils/totp.js`
- `frontend/tailwind.config.js`
- `frontend/postcss.config.js`
- `frontend/src/index.css`
- `frontend/src/pages/Login.jsx`
- `frontend/src/pages/Setup.jsx`
- `frontend/src/pages/Library.jsx`
- `frontend/src/pages/Settings.jsx`
- `frontend/src/components/RequireAuth.jsx`
- `frontend/src/components/RequireSetup.jsx`

### Modified files
- `backend/src/server.js` — add `app.locals.db = db`
- `backend/src/routes/auth.js` — implement login/logout/me
- `backend/src/routes/setup.js` — implement setup + launcher routes
- `backend/src/routes/launchers.js` — may merge into setup.js or keep separate
- `backend/src/routes/sync.js` — stub POST /api/sync/all
- `frontend/src/main.jsx` — import index.css
- `frontend/src/App.jsx` — React Router setup with route guards
