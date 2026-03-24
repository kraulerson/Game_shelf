# Phase 10: Epic Games & Xbox Launcher Implementations

## Overview

Implement two new launcher integrations:

1. **Epic Games Store** — OAuth authorization code flow with rolling token refresh
2. **Xbox / Microsoft** — OpenXBL API key-based access

Both follow existing launcher patterns (BaseLauncher subclass) and plug into the existing sync engine, enrichment pipeline, and 6-hour auto-sync cron.

## Design Decisions

- **Epic uses browser-based auth code flow** — user logs in on Epic's site (handles 2FA natively), gets a one-time code, pastes it into Gameshelf. No email/password stored.
- **Epic tokens roll forward** — refresh token (8h) is renewed each sync (6h), keeping the session alive indefinitely without re-authentication.
- **Xbox uses permanent API key** — same model as Steam. User gets a free key from xbl.io.
- **New `auth_type: 'auth_code'`** — frontend shows link + code input instead of username/password fields.

## Feature 1: Epic Games Store Integration

### Authentication

**OAuth flow:**
1. User clicks Configure → UI shows link to Epic's OAuth login page:
   `https://www.epicgames.com/id/login?redirectUrl=https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code`
2. User logs in on Epic's site (2FA handled by Epic in browser)
3. Epic shows JSON with `authorizationCode`
4. User copies code, pastes into Gameshelf input
5. Backend exchanges code for tokens via:
   `POST https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token`
   with `grant_type=authorization_code`, `code={auth_code}`, and Basic auth header using Epic's launcher client credentials: `34a02cf8f4414e29b15921876da36f9a:9209d4a5e25a457fb9b07489d313b41a`
6. Response contains: `access_token`, `refresh_token`, `expires_at`, `refresh_expires_at`, `account_id`
7. All stored encrypted in `credentials_json`

**Token refresh (in `refreshIfNeeded()`):**
- Check if `expires_at` has passed
- If expired, POST to the same token endpoint with `grant_type=refresh_token` and the stored `refresh_token`
- Response contains new `access_token` + new `refresh_token` (rolling)
- Update `credentials_json` with new tokens
- Refresh token lasts 8 hours; 6-hour sync cycle keeps it alive

**Credentials endpoint change:**
- `POST /api/launchers/epic/credentials` receives `{ auth_code }` instead of username/password
- Backend immediately exchanges the code for tokens before storing
- Returns success only if the exchange succeeds

### Game Library Retrieval

**Fetch owned games:**
- `GET https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true`
- Headers: `Authorization: Bearer {access_token}`
- Returns paginated library items with metadata
- Paginate through all pages using cursor/offset

**Fetch playtime:**
- `GET https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/{accountId}/all`
- Returns playtime per game in seconds

**Game mapping:**
- `launcher_game_id`: catalog item ID or namespace from library response
- `title`: from library metadata
- `playtime_minutes`: from playtime endpoint (seconds / 60)

### Implementation

**Replace `backend/src/services/launchers/epic.js`** stub with full implementation:
- `authenticate(credentials)`: exchange auth code for tokens
- `refreshIfNeeded(credentials)`: check expiry, refresh if needed, update stored credentials
- `fetchOwnedGames(session)`: call library + playtime endpoints, return game array

## Feature 2: Xbox / Microsoft Integration

### Authentication

**API key flow (same as Steam):**
1. User signs up at https://xbl.io and gets a free API key from their profile
2. User enters API key in Gameshelf Configure dialog
3. Key stored encrypted in `credentials_json`

### Game Library Retrieval

**Fetch title history:**
- `GET https://xbl.io/api/v2/player/titleHistory`
- Headers: `X-Authorization: {api_key}`, `Accept: application/json`
- Returns title history with games played/owned

**Game mapping:**
- `launcher_game_id`: Xbox title ID
- `title`: game name from response
- `playtime_minutes`: from title history if available

### Implementation

**Replace `backend/src/services/launchers/xbox.js`** stub with full implementation:
- `authenticate(credentials)`: store API key (no session needed)
- `refreshIfNeeded(credentials)`: no-op (API key doesn't expire)
- `fetchOwnedGames(session)`: call titleHistory endpoint, return game array

## Feature 3: Frontend Changes

### Launcher Configuration

**Modify `AVAILABLE_LAUNCHERS` in `launchers.js`:**
- Epic: `auth_type: 'auth_code'`, `implemented: true`
- Xbox: `auth_type: 'api_key'`, `implemented: true` (was already `api_key` in auth_type but `implemented: false`)

**New `auth_code` UI in Setup page and credential form:**
- When `auth_type === 'auth_code'`: show a link to the OAuth page + a text input labeled "Paste authorization code"
- Styled differently from username/password fields — instruction text explaining the flow

**Modify `POST /api/launchers/:id/credentials`:**
- For Epic (`auth_type === 'auth_code'`): receive `{ auth_code }`, exchange for tokens, store tokens
- For other launchers: existing behavior unchanged
- Remove the `implemented` guard for Epic and Xbox

### Setup Page

The existing Setup page needs to handle the `auth_code` type. When configuring Epic:
1. Show instruction text: "Log in to Epic Games and copy the authorization code"
2. Show clickable link to Epic's OAuth URL
3. Show text input for pasting the code
4. On submit, send `{ auth_code: '...' }` to the credentials endpoint

## Files Changed

### Backend
- Rewrite: `backend/src/services/launchers/epic.js` — full Epic implementation
- Rewrite: `backend/src/services/launchers/xbox.js` — full Xbox implementation
- Modify: `backend/src/routes/launchers.js` — update AVAILABLE_LAUNCHERS (implemented: true for epic/xbox), handle auth_code exchange in credentials endpoint
- Modify: `backend/src/services/syncEngine.js` — `refreshIfNeeded` must update stored credentials when tokens are refreshed (Epic needs this)

### Frontend
- Modify: `frontend/src/pages/Settings.jsx` — no changes needed (already shows Configure for implemented launchers)
- Modify: `frontend/src/pages/Setup.jsx` — handle `auth_code` type with link + code input

## Testing Considerations

- Epic auth code exchange: mock the token endpoint, verify tokens stored correctly
- Epic token refresh: mock refresh endpoint, verify new tokens saved to DB
- Epic expired refresh token: verify graceful failure (sync job marked failed, not crashed)
- Epic game retrieval: mock library endpoint, verify game array format
- Xbox API key: verify stored and used in X-Authorization header
- Xbox game retrieval: mock titleHistory endpoint, verify game array format
- Sync engine: verify refreshIfNeeded updates credentials_json for Epic
- Frontend: auth_code type shows link + code input, not username/password
- 6-hour auto-sync: verify Epic refresh cycle keeps session alive
