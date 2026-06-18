# Cache-Status Filter + Relocated Card Badge — Design

**Date:** 2026-06-18
**Status:** Approved (design)
**Repo:** Game_shelf (Express + better-sqlite3 backend, React + Vite + Tailwind frontend; no framework hooks). Deployed on LXC1102 @ `10.100.23.102` via docker-compose.
**Branch:** `feat/cache-status-filter`

---

## 1. Goal

Let the operator (a) see each game's prefill/cache status on its library card, positioned under the game info, and (b) filter the library by cache status — e.g. "all Epic games that are not cached" — with correct pagination and counts.

## 2. Background / constraints

- Library filtering is **server-side**: `Library.jsx` drives URL params and fetches `GET /api/games?<params>`; the Express backend builds SQL (better-sqlite3) with `WHERE` + `LIMIT/OFFSET` and returns a paginated page + total. Existing filter keys include `launcher` (comma-separated launcher names), `genre`, `tag`, `search`, `sort`, pagination.
- **Cache/prefill status lives in the orchestrator, not Game_shelf's DB.** The F15 `useCacheStatus` hook bulk-fetches `/api/cache/games` (the F14 proxy) and correlates by `platform:app_id` for badge display. The Game_shelf DB has the correlation key at the edition level: `game_editions.launcher_game_id` (= orchestrator `app_id`) and `launchers.name` (= orchestrator `platform`, e.g. `steam`/`epic`).
- The backend already has the orchestrator client: `backend/src/services/orchestrator.js` exports `fetchAllGames()` (paged, merged) and `callOrchestrator()`, with the bearer injected server-side (F14).

## 3. Decisions (locked in brainstorming)

- **Filter is multi-select by status** (not a binary prefilled/not). Six buckets:
  | UI label | orchestrator status |
  |---|---|
  | Cached | `up_to_date` |
  | Update ready | `pending_update` |
  | Not cached | `not_downloaded` |
  | Failed | `failed` **or** `validation_failed` |
  | Downloading | `downloading` |
  | Unknown | `unknown` **or** no orchestrator record for the (platform, app_id) |
- **Card badge: keep the existing `CacheBadge`, relocate it** from the top-left cover-art overlay to the **bottom-left of the card, under the game info**. Same component, same labels.
- **Compose at the edition level:** a game matches the cache-status filter if it has an edition where *(launcher ∈ selected launchers, if a launcher filter is active)* **and** *(that edition's status ∈ selected statuses)*. So `launcher=epic` + `cache_status=not_downloaded` = games whose **Epic** edition is not cached.
- `blocked` is **out of scope** for this status filter (separate concept; future).

## 4. Card badge relocation (frontend)

`frontend/src/components/GameCard.jsx`:
- Remove the `absolute top-1.5 left-1.5 z-10` wrapper around `<CacheBadge>`.
- Render `<CacheBadge size="small" … />` at the **end of the info block** (`<div className="p-2">…`), after the DLC/playtime row, left-aligned (e.g. a `mt-1` row). The badge keeps reading `useCacheStatus().statusFor(platform, launcher_game_id)` exactly as today; only its DOM position changes.
- No change to `CacheBadge.jsx`, `cacheBadge.js`, or `useCacheStatus.js`.

## 5. The filter (frontend)

`frontend/src/components/FilterPanel.jsx`:
- Add a **"Cache status"** section: six checkboxes (the labels in §3), toggling a `cache_status` URL param the same way `launcher` is toggled (`toggleFilter('cache_status', <statusKey>)`, comma-separated, resets `page=1`).
- Status keys in the URL are the orchestrator values: `up_to_date,pending_update,not_downloaded,failed,downloading,unknown`. (UI maps label↔key; `failed` selected includes `validation_failed` server-side.)
- The six options are a **fixed list** (not fetched from `/api/games/filters`).

`frontend/src/pages/Library.jsx`:
- Add `cache_status` to `filterKeys` (so it counts toward the active-filter badge and is cleared by "clear all").
- Add an active-filter chip for selected cache statuses (mirroring the existing `launcher`/`genre` chips), removable.
- If the games response carries `cache_filter_unavailable: true`, render a small inline note ("Cache status unavailable — status filter ignored") near the filter bar.

## 6. Backend: snapshot cache + per-request temp-table filter

`backend/src/routes/games.js` (list handler) + a new small module `backend/src/services/cacheSnapshot.js`.

### 6.1 Snapshot cache (`cacheSnapshot.js`)
- `getCacheStatusSnapshot()` → returns `{ map: Map<"platform:app_id", status>, stale: boolean }`.
- Backed by a module-level in-memory cache with a **TTL of 60 s**. On a miss/expiry it calls `fetchAllGames()` and rebuilds the map from `games[].{platform, app_id, status}`.
- On orchestrator error (offline/timeout — `fetchAllGames` throws): return the **last good snapshot** if one exists (even if expired) with `stale: true`; if none ever fetched, return `{ map: null, stale: true }`.
- Pure-ish + injectable (accept the orchestrator client / a clock) so it's unit-testable without a live orchestrator.

### 6.2 List query integration
In the `GET /api/games` list handler, **only when `cache_status` is present**:
1. `const snap = await getCacheStatusSnapshot()`.
2. If `snap.map` is null (orchestrator never reachable): **skip** the cache filter, set `cache_filter_unavailable: true` on the response, run the query as if no `cache_status` was given.
3. Otherwise build a **per-request SQLite temp table** and bulk-insert the snapshot:
   ```sql
   CREATE TEMP TABLE _cache_status(platform TEXT, app_id TEXT, status TEXT,
                                   PRIMARY KEY(platform, app_id));
   ```
   Insert one row per snapshot entry. Games with **no** orchestrator record are handled by a `LEFT JOIN` whose `NULL` status is coalesced to `'unknown'`, so the "Unknown" bucket matches both `status='unknown'` and missing records.
4. Add the filter as an `EXISTS` correlated subquery over owned editions, composed with the existing launcher filter:
   ```sql
   AND EXISTS (
     SELECT 1 FROM game_editions ge2
     JOIN launchers l2 ON l2.id = ge2.launcher_id
     LEFT JOIN _cache_status cs
            ON cs.platform = l2.name AND cs.app_id = ge2.launcher_game_id
     WHERE ge2.game_id = g.id AND ge2.owned = 1 AND ge2.parent_edition_id IS NULL
       AND ( :launcherFilterInactive OR l2.name IN (<selected launchers>) )
       AND COALESCE(cs.status, 'unknown') IN (<expanded selected statuses>)
   )
   ```
   where `<expanded selected statuses>` maps `failed` → (`failed`,`validation_failed`). The temp table + EXISTS keep `LIMIT/OFFSET` pagination and the `COUNT(*)` total correct in SQL.
5. Drop the temp table (or rely on connection scope) after the request.
- **Failure mode `failed` mapping** is applied when expanding the status IN-list.
- The `cache_status` param feeds both the page query and the count query identically so pagination math stays consistent.

### 6.3 Filters endpoint
No change to `/api/games/filters` (the six statuses are a fixed frontend list).

## 7. Bundled infra fix — `frontend/nginx.conf`

Add cache-control so future redeploys never strand a cached `index.html` (the stale-index breakage just hit):
- `location = /index.html { add_header Cache-Control "no-cache"; }` (revalidate every load; assets are content-hashed so the new HTML always points at fresh hashes).
- `location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }`.
- Keep the existing SPA `try_files` and `/api/` + `/data/images/` proxies unchanged.

## 8. Error handling / edge cases

- Orchestrator offline + `cache_status` active → filter skipped, `cache_filter_unavailable: true`, UI note. The rest of the library works normally (graceful degradation).
- A game with multiple editions matches if **any** owned primary edition matches (EXISTS semantics).
- Empty `cache_status` (param absent) → no temp table, no overhead, identical to today.
- Snapshot staleness ≤ 60 s is acceptable (orchestrator prefill runs every few hours).

## 9. Testing

**Backend (`node --test`):**
- `cacheSnapshot`: builds map from a stubbed client; serves cached within TTL (one fetch); refetches after TTL; on client error returns last-good with `stale:true`; returns `{map:null}` when never fetched.
- list filter: `cache_status=up_to_date` returns only games with a cached edition; `failed` includes `validation_failed`; `unknown` includes games with no orchestrator record (LEFT JOIN coalesce); `launcher=epic` + `cache_status=not_downloaded` matches on the **Epic** edition specifically (edition-level compose); pagination + total correct under the filter; orchestrator-offline → filter skipped + `cache_filter_unavailable:true`.

**Frontend (vitest + RTL):**
- `FilterPanel`: the Cache-status checkboxes toggle the `cache_status` param (comma-separated) and reset `page=1`.
- `Library`: `cache_status` counts toward the active-filter badge; chip renders + removes; `cache_filter_unavailable` shows the note.
- `GameCard`: the `CacheBadge` renders in the info block (not the art overlay) and still reflects `statusFor`.

## 10. Files touched

- `frontend/src/components/GameCard.jsx` — relocate badge.
- `frontend/src/components/FilterPanel.jsx` — cache-status section.
- `frontend/src/pages/Library.jsx` — filterKeys, chip, unavailable note.
- `frontend/nginx.conf` — cache-control headers.
- `backend/src/services/cacheSnapshot.js` — new snapshot cache.
- `backend/src/routes/games.js` — temp-table EXISTS filter in the list handler + `cache_filter_unavailable` flag.
- Tests alongside each (`*.test.js` / `*.test.jsx`).

## 11. Scope boundary (YAGNI)

No persisted cache-status table in Game_shelf's DB (60 s snapshot suffices); no `blocked` in the status filter; badge labels unchanged; `/api/games/filters` unchanged; no new orchestrator endpoints.
