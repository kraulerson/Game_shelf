# Humble Bundle Session Cookie Auth — Design Spec

**Date:** 2026-03-25
**Status:** Approved

## Problem

Humble Bundle's `processlogin` endpoint now returns a 403 with a Cloudflare CAPTCHA page, blocking automated username/password login entirely. The two-phase OTP flow cannot work because Phase 1 (the initial login POST) never reaches Humble's servers.

## Solution

Replace username/password auth with session cookie auth. The user logs into humblebundle.com in their own browser (handling CAPTCHA/2FA themselves), copies the `_simpleauth_sess` cookie from DevTools, and pastes it into Gameshelf. This is the same approach Playnite uses under the hood.

## Changes

### Launcher Config (`launchers.js`)

Change Humble entry:
- `auth_type`: `'credentials'` → `'session_cookie'`
- Remove `otp_supported` (already false)
- Add `cookie_name: '_simpleauth_sess'` for display in setup instructions

### Credentials Endpoint (`POST /api/launchers/:id/credentials`)

Add `session_cookie` auth type validation: require `session_cookie` field. Store as `{ session_cookie }`.

### Setup Wizard (`Setup.jsx`)

For `auth_type: 'session_cookie'`, render:
- Instructions text explaining how to copy the cookie from DevTools
- Single text/textarea field for the cookie value
- No username/password fields

### Humble Launcher (`humble.js`)

Rewrite to remove all login logic:

- `refreshIfNeeded(credentials)` — return `{ session: '_simpleauth_sess=' + credentials.session_cookie }` directly. No HTTP call needed.
- Remove `authenticate()` and `_extractSession()` entirely.
- `fetchOwnedGames(session)` — unchanged. Already uses the cookie string in the `Cookie` header.
- Add session validation: if the API returns a redirect to login page or non-JSON response, throw "Humble session expired. Remove and re-add Humble in Settings with a fresh cookie."

### What Gets Removed

- `authenticate()` method
- `_extractSession()` helper
- Phase 1/2 OTP guard logic
- All `processlogin` HTTP calls
- Username/password credential handling for Humble

## Testing

- Unit test: `refreshIfNeeded` returns session cookie without HTTP calls
- Unit test: `fetchOwnedGames` uses cookie and returns games
- Unit test: expired cookie (API redirect/non-JSON) throws clear error message
- Regression test: verify session_cookie auth type is accepted by credentials endpoint
