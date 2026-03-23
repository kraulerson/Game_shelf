# Phase 9: IGDB Hardening, SteamGridDB Image Fallback & Coming Soon Launchers

## Overview

Three changes to improve metadata reliability and user experience:

1. **Harden IGDB client** — exponential backoff, OAuth error handling, 401 re-auth
2. **SteamGridDB image fallback** — when IGDB returns no cover/hero art, try SteamGridDB
3. **Mark unimplemented launchers** — show "Coming Soon" for stub launchers instead of a Configure button

## Feature 1: Harden IGDB Client

### Backend

**Modify `backend/src/services/metadata/igdbClient.js`:**

**Exponential backoff on 429 (rate limit):**
- Retry up to 3 times on 429 status
- Delays: 1s, 2s, 4s (exponential)
- If `Retry-After` header is present in the response, use that value instead
- If all retries fail, return `null` (same as current behavior, but with better recovery)
- Log each retry attempt with attempt number and delay for observability

**Catch OAuth token refresh errors:**
- Wrap the `axios.post` to `https://id.twitch.tv/oauth2/token` in try/catch
- If token refresh fails, log the error and return `null` instead of letting the exception crash the process
- Clear cached token on failure so next call attempts a fresh auth

**Handle 401 (expired/invalid token) mid-batch:**
- If an IGDB API request returns 401, clear the cached token
- Re-authenticate once and retry the request
- If retry also fails, return `null`

**Keep existing 500ms inter-request delay.** The stalling at 102 games is caused by the unhandled OAuth exception, not rate limiting. IGDB allows 4 req/sec; 500ms = 2 req/sec is within limits. The error handling fixes are the real solution.

## Feature 2: SteamGridDB Image Fallback

### Backend

**New dependency:** `npm install steamgriddb` (official Node.js client `node-steamgriddb`)

**New file `backend/src/services/metadata/steamgriddbClient.js`:**

- Reads `STEAMGRIDDB_API_KEY` from `process.env`
- If not set, all functions return `null` (disabled, same pattern as IGDB credentials check)
- `searchGame(title)` — uses the client's `searchGame()` method, returns array of result objects (each has `.id` and `.name`)
- `getImages(sgdbGameId)` — calls `getGridsById()` for cover art and `getHeroesById()` for hero art separately (individual try/catch for each so one failure doesn't block the other). Returns `{ coverUrl, heroUrl }` with the top-scored result URL from each, or `null` per field if not found.

**Modify `enrichGame.js` — both `enrichGame()` and `enrichUnderEnriched()`:**

In the image download section of both functions, after checking IGDB cover/artwork URLs:

```
if (!coverUrl || !artworkUrl) {
  // Try SteamGridDB fallback for missing images
  const sgdbResults = await steamgriddbClient.searchGame(title);
  const sgdbMatch = sgdbResults ? findBestMatch(title, sgdbResults) : null;
  // findBestMatch returns the matched result object; use sgdbMatch.id for image lookup
  if (sgdbMatch) {
    const sgdbImages = await steamgriddbClient.getImages(sgdbMatch.id);
    if (!coverUrl && sgdbImages?.coverUrl) coverUrl = sgdbImages.coverUrl;
    if (!artworkUrl && sgdbImages?.heroUrl) artworkUrl = sgdbImages.heroUrl;
  }
}
```

Cover and hero image downloads should be in **separate try/catch blocks** so a failure on one doesn't prevent the other from being cached. This applies to both `enrichGame()` and `enrichUnderEnriched()`.

SteamGridDB URLs are direct image links (not IGDB-format). The existing `transformIgdbUrl()` in `cacheImage()` is a no-op for these URLs (no `/t_thumb/` to replace), so `cacheImage()` works as-is.

**SteamGridDB rate limits:** Free tier allows ~50 requests/15 seconds. Each game without IGDB images triggers up to 3 SteamGridDB calls (search + grids + heroes). Add a 500ms delay between SteamGridDB fallback calls to stay well within limits.

**Add to `.env.example`:**
```
STEAMGRIDDB_API_KEY=
```

## Feature 3: Mark Unimplemented Launchers as "Coming Soon"

### Backend

**Modify `backend/src/routes/launchers.js`:**

Add `implemented: true` or `implemented: false` to each entry in `AVAILABLE_LAUNCHERS`:

- `implemented: true`: steam, humble, itchio, gog
- `implemented: false`: epic, ea, ubisoft, battlenet, xbox

This field is returned in the `GET /api/launchers/available` response.

**Guard credentials endpoint:** `POST /:id/credentials` should reject credentials for unimplemented launchers with a 400 error: "This launcher is not yet implemented." Prevents users from storing credentials for non-functional launchers via direct API calls.

### Frontend

**Modify `frontend/src/pages/Settings.jsx` LaunchersTab:**

- For launchers where `!l.implemented`: show a "Coming Soon" badge instead of Configure/Sync/Remove buttons
- Apply reduced opacity (`opacity-50`) to the entire launcher row
- The subtitle text shows "Coming Soon" instead of "Not configured"

## Files Changed

### Backend
- Modify: `backend/src/services/metadata/igdbClient.js` — exponential backoff, OAuth error handling, 401 re-auth
- Create: `backend/src/services/metadata/steamgriddbClient.js` — SteamGridDB search and image fetching
- Modify: `backend/src/services/metadata/enrichGame.js` — SteamGridDB fallback in image section, separate cover/hero try/catch
- Modify: `backend/src/routes/launchers.js` — add `implemented` field, guard credentials endpoint
- Modify: `.env.example` — add STEAMGRIDDB_API_KEY

### Frontend
- Modify: `frontend/src/pages/Settings.jsx` — Coming Soon label for unimplemented launchers

### Dependencies
- Add: `steamgriddb` npm package to backend

## Testing Considerations

- IGDB 429 retry: mock axios to return 429, verify exponential backoff with logged retry attempts and eventual null return
- IGDB OAuth error: mock axios.post to throw, verify null return (not crash)
- IGDB 401 re-auth: mock 401 response, verify token is cleared and request retried
- SteamGridDB disabled: no API key set, verify functions return null without errors
- SteamGridDB fallback: when IGDB returns no images, verify SteamGridDB is called
- SteamGridDB image caching: verify downloaded images are cached through existing cacheImage()
- SteamGridDB rate handling: verify 500ms delay between SteamGridDB API calls
- Launcher `implemented` field: verify GET /api/launchers/available returns the field
- Launcher credentials guard: POST credentials for unimplemented launcher returns 400
- Frontend: verify Coming Soon badge appears for unimplemented launchers, Configure button hidden
- Separate image try/catch: cover download failure does not prevent hero download
