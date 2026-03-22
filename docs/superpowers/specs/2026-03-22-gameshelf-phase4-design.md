# Gameshelf Phase 4 — Metadata Enrichment

**Date:** 2026-03-22
**Status:** Approved
**Scope:** Tasks 1–6 of Phase 4

## Overview

Phase 4 adds metadata enrichment using IGDB (via Twitch OAuth) as the primary source. After sync imports game_editions with null game_id, the enrichment pipeline searches IGDB for metadata (title, description, cover art, genres, developer/publisher, release year), downloads and caches images locally, creates/updates games rows, and links game_editions. A RAWG.io fallback is structurally planned but not implemented in this phase.

## IGDB Client

### `/backend/src/services/metadata/igdbClient.js`

**Authentication:** Twitch OAuth client credentials flow.
- POST `https://id.twitch.tv/oauth2/token` with `client_id`, `client_secret`, `grant_type=client_credentials`
- Cache access token in memory with expiry check. Re-auth when expired.
- Read credentials from `process.env.IGDB_CLIENT_ID` and `process.env.IGDB_CLIENT_SECRET`
- If env vars are missing, log a warning and return null from all methods (don't crash)

**`async search(title)`**
- POST `https://api.igdb.com/v4/games`
- Headers: `Client-ID: {client_id}`, `Authorization: Bearer {token}`
- Body: `search "{title}"; fields id,name,summary,cover.url,artworks.url,genres.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,first_release_date; limit 5;`
- Returns array of up to 5 results

**`async getById(igdbId)`**
- Same endpoint, body: `where id = {igdbId}; fields ...; limit 1;`
- Returns single result or null

**Rate limiting:** On 429 response, wait 500ms and retry once. On second failure, log error and return null.

## Title Matching

### `/backend/src/services/metadata/titleMatcher.js`

**`normalize(title)`** — lowercase, strip symbols except alphanumeric and spaces, collapse whitespace, strip common suffixes:
- `™`, `®`, `- Complete Edition`, `GOTY`, `Game of the Year`, `Deluxe Edition`, `Gold Edition`, `Ultimate Edition`

**`slugify(title)`** — `normalize()` then replace spaces with hyphens

**`findBestMatch(searchTitle, igdbResults)`**
- Compare `slugify(searchTitle)` against `slugify(result.name)` for each result
- Use Levenshtein similarity: `1 - (distance / max(len1, len2))`
- Return the result with highest similarity above 0.8 threshold
- If no result exceeds 0.8, return null

**Levenshtein distance:** Implemented inline (~20 lines), no external library.

## Image Cache

### `/backend/src/services/metadata/imageCache.js`

**`async cacheImage(url, gameId, type)`**
- Type: `'cover'|'hero'|'icon'`
- Download image with axios, save to `/app/data/images/{gameId}/{type}.{ext}`
- Extension derived from URL or Content-Type header, defaulting to `.jpg`
- Create directories with `mkdirSync({recursive: true})`
- Return local relative path: `/data/images/{gameId}/{type}.{ext}`

**`getLocalPath(gameId, type)`**
- Check if file exists on disk (glob for `{type}.*` to handle any extension)
- Return path or null

**IGDB image URL transformation:**
- IGDB returns URLs like `//images.igdb.com/igdb/image/upload/t_thumb/{hash}.jpg`
- Replace `t_thumb` with `t_cover_big` for covers, `t_screenshot_big` for artworks/heroes
- Prepend `https:` if URL starts with `//`

### Static serving

Add `express.static` in `server.js` after the health check, before API routes:
```javascript
const dataDir = path.resolve(path.dirname(process.env.GAMESHELF_DB_PATH || './data/gameshelf.db'));
app.use('/data/images', express.static(path.join(dataDir, 'images')));
```

Uses `path.resolve()` to normalize relative paths. Images accessible at `http://host:3001/data/images/{gameId}/cover.jpg`.

Mount metadata routes:
```javascript
const metadataRouter = require('./routes/metadata');
app.use('/api/metadata', metadataRouter);
```

## Enrichment Orchestrator

### `/backend/src/services/metadata/enrichGame.js`

**`async enrichGame(gameEditionId, db)`**

1. Load `game_editions` row by ID, get title and launcher_id
2. Normalize title, call `igdbClient.search(normalizedTitle)`
3. Call `findBestMatch()`:
   - If null: log `[Gameshelf Metadata] No IGDB match for: {title}`, create minimal `games` row (title + slugified title only), link `game_edition.game_id`. Return.
   - TODO placeholder: note where RAWG.io fallback would slot in
4. If match found: extract title, summary, release year from `first_release_date` (Unix timestamp → year). Extract developer from `involved_companies` where `.developer === true`, publisher where `.publisher === true`. Extract cover URL from `cover.url`, hero URL from first `artworks.url`. Extract genre names from `genres`.
5. Upsert into `games` table using `ON CONFLICT(slug) DO UPDATE` — update all metadata fields (`description`, `release_year`, `developer`, `publisher`) + `updated_at`
6. Download cover and hero images via `cacheImage()` — only call when URL exists (cover/artwork can be null in IGDB). Update `cover_url` and `hero_url` with local paths. Use cover as icon (IGDB has no distinct icon field). Copy cover file as icon.
7. Clear stale genre/tag associations: `DELETE FROM game_genres WHERE game_id = ?` and `DELETE FROM game_tags WHERE game_id = ?` before re-inserting. Then upsert genres into `genres` table (`INSERT OR IGNORE`), insert into `game_genres` junction. Mirror genres as tags into `tags`/`game_tags`. This ensures re-enrichment produces clean results.
8. Link `game_edition.game_id` to the `games` row. Note: each edition is enriched independently via its own `gameEditionId`. Multiple editions of the same game will converge to the same `games` row via the slug-based upsert.

**`async enrichAll(db)`**

- Find all `game_editions` where `game_id IS NULL`
- Call `enrichGame()` for each with 500ms delay between calls
- Returns `{ enriched: number, failed: number, skipped: number }`

## Metadata Routes

### `/backend/src/routes/metadata.js`

All routes auth-protected.

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/metadata/enrich/:gameEditionId` | Call `enrichGame()` synchronously, return enrichment result |
| POST | `/api/metadata/enrich-all` | Fire-and-forget `enrichAll()`, return `{message: "Gameshelf enrichment started"}` |
| GET | `/api/metadata/status` | Return `{unenriched: N, total: M}` — count of games with null `cover_url` vs total games |

## Sync Engine Update

In `syncEngine.js` `syncLauncher()`, after the success path (after updating sync_jobs to success and launcher last_sync_at), add fire-and-forget enrichment:

```javascript
console.log(`[Gameshelf Metadata] Starting enrichment pass after sync for ${launcherName}`);
enrichAll(db).catch(err => console.error('[Metadata] enrichAll error:', err.message));
```

Do not await — don't block sync job status.

## Files Created/Modified

### New files
- `backend/src/services/metadata/igdbClient.js`
- `backend/src/services/metadata/titleMatcher.js`
- `backend/src/services/metadata/imageCache.js`
- `backend/src/services/metadata/enrichGame.js`
- `backend/src/routes/metadata.js`

### Modified files
- `backend/src/services/syncEngine.js` — add enrichAll() call after sync
- `backend/src/server.js` — add static image serving + mount metadata routes

## Decisions & Trade-offs

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Metadata source | IGDB primary, RAWG placeholder | IGDB has best game coverage; RAWG deferred to avoid scope creep |
| Image storage | Local filesystem cache | External URLs go stale; local cache is reliable |
| Image serving | express.static | Simple, no auth needed for game images |
| Title matching | Levenshtein inline | No external dependency for a 20-line algorithm |
| Similarity threshold | 0.8 | Balances false positives vs missing matches |
| No-match behavior | Create minimal games row | game_edition always gets a game_id, even without rich metadata |
| Icon source | Reuse cover image | IGDB has no distinct icon field |
| Enrichment timing | Fire-and-forget after sync | Don't block sync completion |
| IGDB token caching | In-memory with expiry | Simple, no persistence needed (re-auths on restart) |
