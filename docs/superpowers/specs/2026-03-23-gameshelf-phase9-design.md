# Phase 9: IGDB Hardening, SteamGridDB Image Fallback & Coming Soon Launchers

## Overview

Three changes to improve metadata reliability and user experience:

1. **Harden IGDB client** — exponential backoff, OAuth error handling, 401 re-auth, safer inter-request delay
2. **SteamGridDB image fallback** — when IGDB returns no cover/hero art, try SteamGridDB
3. **Mark unimplemented launchers** — show "Coming Soon" for stub launchers instead of a Configure button

## Feature 1: Harden IGDB Client

### Backend

**Modify `backend/src/services/metadata/igdbClient.js`:**

**Exponential backoff on 429 (rate limit):**
- Retry up to 3 times on 429 status
- Delays: 1s, 2s, 4s (exponential)
- If `Retry-After` header is present, use that value instead
- If all retries fail, return `null` (same as current behavior, but with better recovery)

**Catch OAuth token refresh errors:**
- Wrap the `axios.post` to `https://id.twitch.tv/oauth2/token` in try/catch
- If token refresh fails, log the error and return `null` instead of letting the exception crash the process
- Clear cached token on failure so next call attempts a fresh auth

**Handle 401 (expired/invalid token) mid-batch:**
- If an IGDB API request returns 401, clear the cached token
- Re-authenticate once and retry the request
- If retry also fails, return `null`

**Increase inter-request delay:**
- Change enrichment delay from 500ms to 1250ms in both `enrichAll` Phase 1 loop and `enrichUnderEnriched` loop
- This gives ~0.8 requests/second, well within IGDB's 4 req/sec limit and avoids burst sensitivity

## Feature 2: SteamGridDB Image Fallback

### Backend

**New dependency:** `npm install steamgriddb` (official Node.js client `node-steamgriddb`)

**New file `backend/src/services/metadata/steamgriddbClient.js`:**

- Reads `STEAMGRIDDB_API_KEY` from `process.env`
- If not set, all functions return `null` (disabled, same pattern as IGDB credentials check)
- `searchGame(title)` — uses the client's `searchGame()` method, returns array of results
- `getImages(sgdbGameId)` — calls `getGridsById()` for cover art and `getHeroesById()` for hero art. Returns `{ coverUrl, heroUrl }` with the top-scored result URL from each, or `null` if none found.

**Modify `enrichGame.js` and `enrichUnderEnriched()`:**

In the image download section of both functions, after checking IGDB cover/artwork URLs:

```
if (!coverUrl && !artworkUrl) {
  // IGDB had no images — try SteamGridDB fallback
  search SteamGridDB by title → find best match → get images
  if found, use those URLs for cacheImage() calls
}
```

The SteamGridDB search uses `titleMatcher.findBestMatch()` for name matching, same as IGDB. Images are cached through the existing `cacheImage()` function (the URLs are direct image links, not IGDB-format URLs, so `transformIgdbUrl` is skipped — `cacheImage` needs a small change to handle non-IGDB URLs that don't need transformation).

**Modify `backend/src/services/metadata/imageCache.js`:**

`cacheImage()` currently always calls `transformIgdbUrl()` which replaces `/t_thumb/` with `/t_cover_big/`. For SteamGridDB URLs (which are already full-size direct links), this transformation is a no-op (no `/t_thumb/` to replace), so it should work as-is. No change needed.

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

### Frontend

**Modify `frontend/src/pages/Settings.jsx` LaunchersTab:**

- For launchers where `!l.implemented`: show "Coming Soon" text label instead of Configure/Sync/Remove buttons
- Apply reduced opacity (`opacity-50`) to the launcher row
- The credential save endpoint still works if someone calls it directly, but the UI won't offer it

## Files Changed

### Backend
- Modify: `backend/src/services/metadata/igdbClient.js` — exponential backoff, OAuth error handling, 401 re-auth
- Create: `backend/src/services/metadata/steamgriddbClient.js` — SteamGridDB search and image fetching
- Modify: `backend/src/services/metadata/enrichGame.js` — SteamGridDB fallback in image section, increase delay to 1250ms
- Modify: `backend/src/routes/launchers.js` — add `implemented` field to AVAILABLE_LAUNCHERS
- Modify: `.env.example` — add STEAMGRIDDB_API_KEY

### Frontend
- Modify: `frontend/src/pages/Settings.jsx` — Coming Soon label for unimplemented launchers

### Dependencies
- Add: `steamgriddb` npm package to backend

## Testing Considerations

- IGDB 429 retry: mock axios to return 429, verify exponential backoff and eventual null return
- IGDB OAuth error: mock axios.post to throw, verify null return (not crash)
- IGDB 401 re-auth: mock 401 response, verify token is cleared and request retried
- SteamGridDB disabled: no API key set, verify functions return null without errors
- SteamGridDB fallback: when IGDB returns no images, verify SteamGridDB is called
- SteamGridDB image caching: verify downloaded images are cached through existing cacheImage()
- Launcher `implemented` field: verify GET /api/launchers/available returns the field
- Frontend: verify Coming Soon label appears for unimplemented launchers, Configure button hidden
