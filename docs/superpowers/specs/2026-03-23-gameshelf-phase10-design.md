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
- **Epic client credentials stored as constants** — the well-known launcher client ID/secret from the EpicResearch project are stored as module constants in `epic.js` (same pattern as GOG's client credentials in `gog.js`).

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
   with `grant_type=authorization_code`, `code={auth_code}`, and Basic auth header using Epic's launcher client credentials (stored as constants in `epic.js`, same pattern as `gog.js`)
6. Response contains: `access_token`, `refresh_token`, `expires_at`, `refresh_expires_at`, `account_id`
7. All tokens + `account_id` stored encrypted in `credentials_json` (not the auth code — the auth code is single-use and discarded)

### Token Refresh

**`refreshIfNeeded(credentials)` — does NOT call `authenticate()`:**

Unlike the base class default, Epic's `refreshIfNeeded()` is a completely separate code path from `authenticate()`:
- `authenticate(credentials)` is only called once from the credentials endpoint with `{ auth_code }`. It exchanges the code for tokens and returns them. Never called again after initial setup.
- `refreshIfNeeded(credentials)` checks `expires_at`, and if expired, calls the token endpoint with `grant_type=refresh_token`. Returns `{ session: { access_token, account_id }, updatedCredentials }`.

**Session return shape:** `refreshIfNeeded()` returns `{ session, updatedCredentials }`:
- `session`: `{ access_token, account_id }` — passed to `fetchOwnedGames()`
- `updatedCredentials`: new credentials object with refreshed tokens (if token was refreshed), or `null` (if no refresh needed)

### SyncEngine Credential Persistence

**Modify `syncEngine.js`** to persist updated credentials after refresh:

```
const session = await instance.refreshIfNeeded(credentials);
// If refreshIfNeeded returns { session, updatedCredentials }, persist the update
if (session && session.updatedCredentials) {
  const encrypted = encrypt(JSON.stringify(session.updatedCredentials));
  db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(encrypted, launcherName);
  session = session.session; // unwrap the actual session
}
```

For backward compatibility with existing launchers that return a bare session (null, string, or object without `updatedCredentials`), the sync engine checks for the presence of `updatedCredentials` before attempting persistence.

### Expired Refresh Token Recovery

If the server is down for >8 hours, the refresh token expires and the session is dead. When `refreshIfNeeded()` fails:
- The error is caught by the sync engine's existing try/catch
- The sync job is marked `failed` with an error message: "Epic authentication expired. Please re-authenticate."
- The user can click "Configure" on Epic in Settings to go through the OAuth flow again and get new tokens

### Game Library Retrieval

**`fetchOwnedGames(session)` receives `{ access_token, account_id }`:**

**Fetch owned games:**
- `GET https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true`
- Headers: `Authorization: Bearer {access_token}`
- Returns paginated library items — paginate through all pages using cursor
- Add 500ms delay between pages to avoid rate limiting

**Fetch playtime:**
- `GET https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/{accountId}/all`
- Uses `account_id` from the session object
- Returns playtime per game in seconds

**Game mapping:**
- `launcher_game_id`: catalog item ID or namespace from library response
- `title`: from library metadata
- `playtime_minutes`: from playtime endpoint (seconds / 60, rounded)

### Implementation

**Replace `backend/src/services/launchers/epic.js`** stub with full implementation:
- Module constants: `EPIC_CLIENT_ID`, `EPIC_CLIENT_SECRET`, `EPIC_TOKEN_URL`, `EPIC_LIBRARY_URL`
- `authenticate({ auth_code })`: exchange auth code for tokens, return credentials object with all tokens + account_id. Called once from credentials endpoint.
- `refreshIfNeeded(credentials)`: check `expires_at`, refresh if needed, return `{ session: { access_token, account_id }, updatedCredentials }` or `{ session: { access_token, account_id }, updatedCredentials: null }`.
- `fetchOwnedGames(session)`: call library + playtime endpoints using `session.access_token` and `session.account_id`, return game array.

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
- Paginate if the API supports it (follow continuation tokens if present)

**Game mapping:**
- `launcher_game_id`: Xbox title ID
- `title`: game name from response
- `playtime_minutes`: from title history if available (0 if not provided)

### Implementation

**Replace `backend/src/services/launchers/xbox.js`** stub with full implementation:
- `authenticate(credentials)`: store API key, return null (no session needed, same as Steam)
- `refreshIfNeeded(credentials)`: store credentials, return null (API key doesn't expire, same as Steam)
- `fetchOwnedGames(session)`: call titleHistory endpoint using `this.credentials.api_key`, return game array

## Feature 3: Frontend & Credential Endpoint Changes

### Launcher Configuration

**Modify `AVAILABLE_LAUNCHERS` in `launchers.js`:**
- Epic: change `auth_type` from `'credentials+totp'` to `'auth_code'`, set `implemented: true`
- Xbox: change `auth_type` from `'credentials'` to `'api_key'`, set `implemented: true`

**Add `auth_code` validation branch in credentials endpoint:**

The current `POST /api/launchers/:id/credentials` validates based on `auth_type`. Add a third branch:

```
if (auth_type === 'api_key') → require api_key (existing)
else if (auth_type === 'auth_code') → require auth_code, exchange for tokens, store tokens
else → require username/password (existing)
```

For the `auth_code` branch:
1. Validate `auth_code` is present in request body
2. Instantiate the launcher class
3. Call `authenticate({ auth_code })` to exchange for tokens
4. Encrypt the returned token credentials and store in DB
5. Return success or error if exchange fails

**Make the credentials endpoint async** — it must `await` the token exchange for `auth_code` type. Currently the handler is synchronous; add `async` to the handler function.

### Setup Page

**Modify `frontend/src/pages/Setup.jsx`:**
- When `auth_type === 'auth_code'`: show instruction text, clickable link to OAuth URL, and text input for pasting the code
- Filter unimplemented launchers from the Setup page grid (show only `implemented: true`)
- On submit for auth_code type, send `{ auth_code: '...' }` to the credentials endpoint

## Files Changed

### Backend
- Rewrite: `backend/src/services/launchers/epic.js` — full Epic implementation with OAuth token exchange and refresh
- Rewrite: `backend/src/services/launchers/xbox.js` — full Xbox implementation with OpenXBL API
- Modify: `backend/src/routes/launchers.js` — update AVAILABLE_LAUNCHERS, add auth_code validation branch, make credentials handler async
- Modify: `backend/src/services/syncEngine.js` — persist updated credentials when refreshIfNeeded returns updatedCredentials

### Frontend
- Modify: `frontend/src/pages/Setup.jsx` — handle `auth_code` type with link + code input, filter unimplemented launchers

## Testing Considerations

- Epic auth code exchange: mock the token endpoint, verify tokens stored correctly
- Epic token refresh: mock refresh endpoint, verify new tokens saved to DB via syncEngine
- Epic expired refresh token: verify graceful failure (sync job marked failed, not crashed)
- Epic game retrieval: mock library endpoint, verify game array format
- Epic account_id: verify it's stored in credentials and accessible during fetchOwnedGames
- SyncEngine credential persistence: verify updatedCredentials written back to DB for Epic, and NOT for Steam/Xbox (null case)
- Xbox API key: verify stored and used in X-Authorization header
- Xbox game retrieval: mock titleHistory endpoint, verify game array format
- Credentials endpoint: auth_code type exchanges and stores tokens, api_key type stores key, credentials type stores user/pass
- Frontend: auth_code type shows link + code input, api_key shows key input, credentials shows user/pass
- Setup page: unimplemented launchers not shown
- 6-hour auto-sync: verify Epic refresh cycle keeps session alive
