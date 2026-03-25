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

No `otp_supported` or `otp_instruction` needed — 2FA is handled by the user in their browser.

### Backend — GOG Launcher (`gog.js`)

Complete rewrite. Remove the browser-based OAuth flow (cookie jar, CSRF tokens, form scraping, 2FA code submission). Replace with:

**`authenticate(credentials)`** — Receives `{ auth_code }` from the Setup page. Exchanges it for tokens:
```
GET https://auth.gog.com/token?client_id=...&client_secret=...&grant_type=authorization_code&code={auth_code}&redirect_uri=...
```
Returns the token payload: `{ access_token, refresh_token }`.

**`refreshIfNeeded(credentials)`** — If `credentials.refresh_token` exists, use `grant_type=refresh_token` to get a new access token. If refresh fails (expired), throw an error telling the user to re-configure GOG in Setup. Return `{ session: access_token, updatedCredentials }` to persist the new tokens.

**`fetchOwnedGames(session)`** — Unchanged. Uses `Bearer {session}` to call `embed.gog.com/user/data/games` and `api.gog.com/products/{id}`.

**Dependencies removed:** `tough-cookie` and `axios-cookiejar-support` are no longer needed by GOG. Check if any other launcher uses them before removing from `package.json`. If not, remove them.

### Frontend — Setup Page (`Setup.jsx`)

The `auth_code` UI block currently has Epic-specific text and URL. Make it launcher-aware:

**GOG auth URL:**
```
https://auth.gog.com/auth?client_id=46899977096215655&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code&layout=galaxy
```

**GOG instructions:**
1. "Click the link below and log in to your GOG account"
2. Link text: "Open GOG Login"
3. "After logging in, copy the `code` value from the URL and paste it below"

**Epic instructions** remain as-is.

The simplest approach: use a config object keyed by launcher ID with the auth URL, link text, and instructions. Fall back to generic text for unknown launchers.

### Backend — Credentials Endpoint

No changes needed. The `auth_type === 'auth_code'` path in `POST /api/launchers/:id/credentials` already calls `launcher.authenticate({ auth_code })` and stores the returned payload. This is fully generic — GOG's `authenticate()` just needs to return the right shape.

### Settings Page

No changes needed for GOG specifically. Since GOG is now `auth_code` with `otp_supported: false`, clicking Sync fires immediately (no 2FA modal, no two-phase flow). The `awaiting_otp` logic only applies to launchers with `otp_supported: true` (currently just Humble).

### Existing GOG Credentials

Users who previously configured GOG with username/password will need to re-configure via Setup with the new auth code flow. The old credentials (username/password) won't work with the new `authenticate()` since it expects `{ auth_code }`. On the next sync, `refreshIfNeeded()` will attempt the refresh token (which won't exist in old credentials), fall back to `authenticate()`, and fail because there's no `auth_code`. The sync will fail with a clear error. User removes GOG and re-adds via Setup.

### Edge Cases

- **Auth code expired:** GOG auth codes are one-time use and expire quickly. If the code is expired, `authenticate()` will fail and the credentials endpoint returns an error. User tries again with a fresh code.
- **Refresh token expired:** `refreshIfNeeded()` catches the error, throws with a message to re-configure. User goes to Setup, gets a new auth code.
- **GOG redirect page:** After login, GOG redirects to `https://embed.gog.com/on_login_success?origin=client&code=XXX`. This page may show a blank or error page (since there's no actual client to receive it). The user needs to copy the `code` parameter from the URL bar. Instructions should be clear about this.

## Out of Scope

- Humble Bundle auth changes (separate effort)
- Auto-detection of stale credentials prompting re-setup
- Removing diagnostic logging from previous debugging (can be cleaned up separately)
