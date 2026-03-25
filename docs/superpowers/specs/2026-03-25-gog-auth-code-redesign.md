# GOG Auth Code Redesign

**Date:** 2026-03-25
**Status:** Approved
**Supersedes:** The browser-based OAuth login flow in GOG's `authenticate()` from `2026-03-24-humble-gog-2fa-design.md`. The two-phase 2FA sync flow from `2026-03-25-2fa-two-phase-sync-design.md` remains valid for Humble but no longer applies to GOG.

## Problem

GOG's web login page has reCAPTCHA, which cannot be solved programmatically. The browser-based OAuth flow (scraping login forms, posting credentials, handling redirects) fails because GOG rejects automated login attempts. This was confirmed via diagnostic logging: login POST returns 302 back to the login page.

## Solution

Switch GOG from `auth_type: 'credentials'` to `auth_type: 'auth_code'`, matching Epic's existing pattern. The user logs in via their own browser (handling CAPTCHA and 2FA themselves), copies the authorization code from the redirect URL, and pastes it into GameShelf. The app exchanges the code for tokens and stores the refresh token for future syncs.

## Design

### Launcher Config

In `backend/src/routes/launchers.js` AVAILABLE_LAUNCHERS, change GOG from:
```javascript
{ id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: true, ... }
```
To:
```javascript
{ id: 'gog', display_name: 'GOG', auth_type: 'auth_code', otp_supported: false, qr_supported: false, implemented: true }
```

### Backend — GOG Launcher (`gog.js`)

Complete rewrite. Remove the browser-based OAuth flow (cookie jar, CSRF tokens, form scraping, 2FA code submission). Replace with:

**`authenticate(credentials)`** — Receives `{ auth_code }` from the Setup page. Exchanges it for tokens via `GET https://auth.gog.com/token?grant_type=authorization_code&code={auth_code}&...`. Returns a **flat credentials object** `{ access_token, refresh_token }` — matching Epic's pattern. This is important: the credentials endpoint stores this return value directly as the encrypted credentials blob.

**`refreshIfNeeded(credentials)`** — If `credentials.refresh_token` exists, use `grant_type=refresh_token` to get a new access token. On success, return `{ session: access_token, updatedCredentials: { access_token, refresh_token } }` (the wrapped shape expected by syncEngine). On failure, throw a clear error: `'GOG refresh token expired. Please remove GOG and re-add it in Setup.'` — do NOT fall back to `authenticate()` (there's no `auth_code` in stored credentials). If no `refresh_token` exists (old credentials format), throw immediately with the same re-configure message.

**`fetchOwnedGames(session)`** — Unchanged. Uses `Bearer {session}` to call `embed.gog.com/user/data/games` and `api.gog.com/products/{id}`.

**Note on `redirect_uri`:** The `redirect_uri` passed during token exchange must match exactly what was used in the authorization URL: `https://embed.gog.com/on_login_success?origin=client` (without the `&code=XXX` part).

**Dependencies removed:** `tough-cookie` and `axios-cookiejar-support` are confirmed GOG-only (no other launcher uses them). Remove both from `package.json`.

### Frontend — Setup Page (`Setup.jsx`)

The `auth_code` UI block currently has Epic-specific text and URL. Make it launcher-aware with a config object:

**GOG auth URL:**
```
https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=client2
```

**GOG instructions:**
1. "Click the link below and log in to your GOG account"
2. Link text: "Open GOG Login"
3. "After logging in, you will be redirected to a page that may appear blank. Copy the `code` value from your browser's address bar and paste it below"

**Epic instructions** remain as-is.

### Backend — Credentials Endpoint

No changes needed. The `auth_type === 'auth_code'` path in `POST /api/launchers/:id/credentials` already calls `launcher.authenticate({ auth_code })` and stores the returned payload. GOG's `authenticate()` returns the flat `{ access_token, refresh_token }` shape, which is stored correctly.

### Settings Page

No changes needed. GOG is now `auth_code` with `otp_supported: false` — clicking Sync fires immediately. The `awaiting_otp` two-phase flow only applies to Humble.

### Existing GOG Credentials

Users who previously configured GOG with username/password will need to re-configure via Setup. On the next sync, `refreshIfNeeded()` will detect no `refresh_token` in the old credentials and throw a clear message: "GOG refresh token expired. Please remove GOG and re-add it in Setup."

### Edge Cases

- **Auth code expired:** GOG auth codes are one-time use and expire quickly. If expired, `authenticate()` fails and the credentials endpoint returns an error. User retries with a fresh code.
- **Refresh token expired:** `refreshIfNeeded()` catches the error, throws with a re-configure message. User goes to Setup with a new auth code.
- **GOG redirect page appears blank:** After login, GOG redirects to `embed.gog.com/on_login_success?code=XXX`. The page may look blank — the user needs to copy the `code` from the URL bar. Instructions are explicit about this.
- **Old credentials format:** `refreshIfNeeded()` detects missing `refresh_token` and throws immediately with a re-configure message.

## Out of Scope

- Humble Bundle auth changes (separate effort)
- Auto-detection of stale credentials prompting re-setup
- Removing diagnostic logging from previous debugging (can be cleaned up separately)
