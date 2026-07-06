# Design — GOG (manual-download) coverage visibility

<!-- 2026-07-06 -->

**Issue:** kraulerson/lancache-orchestrator#222 (the surfacing half). **Repo:** Game_shelf only — no orchestrator/agent changes.

## Problem (adversarially-confirmed diagnosis)

Downloaded GOG games never show as downloaded on the Game_shelf main page (card badge) or on individual game pages. The **data pipeline works** — the agent lists all ~264 GOG folders, and `manualCoverage.js` already matches ~222 of 314 owned GOG games — but nothing in the UI consumes it:

- `frontend/src/utils/cacheBadge.js` `TRACKED_LAUNCHERS = {steam, epic}` → `launcherToPlatform('gog')` returns null → every GOG card renders the neutral `—` badge.
- `components/cache/CachePanel.jsx` drops non-tracked editions (`tracked.length===0 → return null`) → a GOG-only game's detail Cache panel renders nothing.
- The `#222` coverage endpoint (`GET /api/cache/manual-coverage/:launcher`) has **no React consumer** — it was built and never wired in.
- The main-page cache-status filter is a lancache-only (steam/epic) snapshot; there is no GOG value to filter on.

Secondary accuracy gap: the owned GOG identifier (`game_editions.launcher_game_id`) is a numeric product id (matches 0 folders); matching relies on a fuzzy title-slug (~222/264), so ~15% of downloaded games mis-show as "not downloaded".

## Decisions

1. **Do NOT make GOG a lancache platform.** Keep `launcherToPlatform` steam/epic-only. Adding `gog` to `TRACKED_LAUNCHERS` would make CachePanel render Prefill/Validate/Purge/Block buttons that POST with `orchId=undefined` (verifier-caught regression). GOG gets a **separate manual-download status path**.
2. **Mirror the existing in-memory snapshot pattern, not a persisted flag.** Game_shelf's steam/epic status is not DB-persisted — `cacheSnapshot.js` is an in-memory 60s-TTL snapshot joined via a query-time temp-table. Manual coverage follows the same shape: an in-memory snapshot of each manual launcher's folder list, matched to owned games at query time and joined as a temp-table.
3. **Exact matching via a persisted `game_editions.gog_slug`.** The GOG sync (`services/launchers/gog.js`) already fetches `productRes.data.slug` — GOG's real product slug, which is exactly what gogrepoc.py names folders after — but discards it. Persist it (migration + guarded ALTER) and match folder→game on it exactly; keep the existing fuzzy title-slug matcher as fallback. Backfilling existing rows needs one GOG library re-sync (documented).
4. **Generic across manual launchers, wired for GOG.** GOG has data now; Humble/Itch/Amazon get the same treatment automatically once you download games there.

## Architecture / components

### Backend
- **Migration** (`db/schema.sql` + `db/migrate.js`): `game_editions.gog_slug TEXT` (guarded ALTER, idempotent).
- **`services/launchers/gog.js`**: capture `productRes.data.slug` → `gog_slug` on the synced edition.
- **`services/manualCoverage.js`**: exact-match on `gog_slug` first, fuzzy title-slug fallback second. Export `downloadedGameIds(db, launcherName, folderNames) → Set<game_id>` (shared matcher, reused by the transient report and the snapshot join).
- **`services/manualCoverageSnapshot.js`** (new, mirrors `cacheSnapshot.js`): in-memory 60s-TTL cache of `{launcher → {present, entries:[folderNames]}}` from the orchestrator; serves last-good on error; coalesces concurrent refreshes.
- **`routes/games.js`**: at list time, get the manual folder list from the snapshot → `downloadedGameIds()` → build a temp-table of downloaded GOG game ids → LEFT JOIN so each game gets `download_status` ∈ {`downloaded`, `not_downloaded`, `null` (not a manual-launcher game)}. Add a `download_status` query-param filter (a NEW facet, parallel to `cache_status` — never reuse `cache_status`, which collides with the `unknown` value GOG editions already get). Surface `download_status` in the game-list and game-detail responses.

### Frontend
- **`utils/cacheBadge.js`**: add `manualDownloadBadge(downloadStatus)` → `downloaded` = green "Downloaded" / `not_downloaded` = gray "Not downloaded" / else `null`. `launcherToPlatform` unchanged.
- **`components/GameCard.jsx`**: if the game is a manual-launcher game (has `download_status` and no lancache platform badge), render the manual-download badge instead of the neutral `—`.
- **`components/cache/CachePanel.jsx`**: for a GOG (manual) edition, render a read-only Downloaded/Not-downloaded row — **no** Prefill/Validate/Purge/Block buttons (they don't apply to a hand-downloaded game).
- **`components/FilterPanel.jsx`**: add a "Download status" facet (Downloaded / Not downloaded) that sets `?download_status=`.

## Data flow
```
GameCard/FilterPanel → GET /api/games(?download_status=) → games.js
  → manualCoverageSnapshot.get() → orchestrator GET /api/v1/manual-downloads/GOG (folder list, cached 60s)
  → downloadedGameIds(db, 'gog', folders) [exact gog_slug, else fuzzy] → temp-table of game_ids
  → LEFT JOIN → each game gets download_status → filter/badge
```

## Scope notes / non-goals
- **Multi-launcher games** (e.g. Steam+GOG): the single card badge follows the canonical lancache launcher (Steam), so GOG download state shows on the **game-detail** page, not the card. Acceptable — the game IS cached on Steam. GOG-only games (the common case) show the download badge on the card.
- **Backfill**: exact matching only kicks in for editions synced after this ships; a one-time GOG re-sync backfills `gog_slug` for existing games. The fuzzy fallback keeps pre-backfill coverage at today's ~222/264.
- No orchestrator/agent/deployment changes (the chain is already healthy — live-verified 257 folders).
- No write-back of a persisted per-game downloaded flag (the in-memory snapshot is the source of truth, matching steam/epic).

## Testing
- `manualCoverage`: exact `gog_slug` match; fuzzy fallback still works; `downloadedGameIds` returns the right game-id set; suffix (`_game`/`_base`) handling preserved.
- `manualCoverageSnapshot`: TTL cache, last-good on error, coalesced refresh (mirror `cacheSnapshot` tests).
- `games.js`: `download_status` surfaced per game; `?download_status=downloaded` filters correctly; steam/epic `cache_status` unaffected (no regression).
- `gog.js` sync: `gog_slug` persisted from `productRes.data.slug`.
- Frontend: `manualDownloadBadge` mapping; GameCard renders it for a GOG game; CachePanel renders the GOG row with no lancache buttons; FilterPanel facet.
