# Epic Catalog Resolution — Phase 12

**Date:** 2026-03-24
**Status:** Approved
**Scope:** Backend sync changes, catalog API integration, DLC nesting, minor frontend additions

## Problem

~185 Epic library items have the title "Live" (DLC/content packs from various live-service games) and ~40 have codename titles (e.g., "Capsicum", "CadmiumRed"). The Epic library API returns internal `sandboxName` values for these instead of published titles. Additionally, DLC items appear as separate games in the library instead of being nested under their parent.

## Solution

### Part 1: Store Epic metadata during sync

Add three nullable columns to `game_editions`:

```sql
ALTER TABLE game_editions ADD COLUMN epic_namespace TEXT;
ALTER TABLE game_editions ADD COLUMN epic_catalog_id TEXT;
ALTER TABLE game_editions ADD COLUMN sandbox_type TEXT;
```

Update `schema.sql` to include these columns in the `CREATE TABLE` definition.

**Remove namespace dedup from `fetchOwnedGames()`.** The current `seenNamespaces` filter (added in Phase 10 fix) keeps only one item per namespace, discarding DLC items. This must be removed so all items are returned for DLC nesting. Instead, DLC items are handled in Part 3 via `parent_edition_id`.

During Epic sync in `fetchOwnedGames()`, return all items with the new fields:

```js
{
  launcher_game_id: item.appName || item.catalogItemId,
  title: item.sandboxName || item.appName || id,
  playtime_minutes: playtimeMap[id] || 0,
  epic_namespace: item.namespace,
  epic_catalog_id: item.catalogItemId,
  sandbox_type: item.sandboxType,
}
```

The sync engine's `game_editions` upsert must include the three new columns, and the `ON CONFLICT DO UPDATE SET` clause must also update them (for backfill on re-sync).

### Part 2: DLC nesting by namespace

**Runs before catalog resolution** so the catalog API can resolve titles for all items in a namespace at once.

Add column:
```sql
ALTER TABLE game_editions ADD COLUMN parent_edition_id INTEGER REFERENCES game_editions(id);
```

Post-sync step `epicCatalog.nestDLC(db, launcherId)`:

1. Query all Epic editions grouped by `epic_namespace`
2. For each namespace with multiple editions, identify the **base game**: the edition where `sandbox_type = 'PUBLIC'`, or if ambiguous, the edition with the highest tier from `edition_tiers`, or the edition with the longest title
3. All other editions in that namespace → `parent_edition_id` set to the base game edition's ID
4. **Copy `game_id` from parent to children**: `UPDATE game_editions SET game_id = (SELECT game_id FROM game_editions WHERE id = parent_edition_id) WHERE parent_edition_id IS NOT NULL AND game_id IS NULL`
5. Namespaces with only one edition are left as-is (no parent)

### Part 3: Resolve titles via Epic catalog API

New module: `backend/src/services/launchers/epicCatalog.js`

Post-sync step `epicCatalog.resolveCodenames(db, credentials, launcherInstance)`:

**Token handling:** Receives the full `credentials` object and `launcherInstance` (EpicLauncher), so it can call `launcherInstance.refreshIfNeeded(credentials)` to get a fresh token if the current one nears expiry. This prevents token expiration during the ~200 API calls.

1. Collects all unique `epic_namespace` values from editions needing resolution
2. For each namespace, queries:
   ```
   GET https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/{namespace}/bulk/items?includeMainGameDetails=true&country=US&locale=en-US
   ```
3. Maps `catalogItemId` → published `title` from the response
4. Updates `game_editions.title` and linked `games.title` for matched editions

**Codename detection heuristic (structural only, no enrichment dependency):**
A title needs resolution if:
- `title === 'Live'` (exact match), OR
- Title is a single token with no spaces AND matches codename patterns: PascalCase (`CadmiumRed`), single lowercase word (`lisbon`), or `title === launcher_game_id` (meaning no human-readable name was available), OR
- Title is a hex GUID pattern

This avoids false-positiving on real single-word ALL-CAPS titles like "DEATHLOOP" or "SUPERHOT", or real proper nouns like "Celeste" or "Subnautica" (which have enrichment data, but the heuristic doesn't depend on that).

**Rate limiting:** 500ms delay between namespace API calls. Each namespace returns all items in one call.

### Part 4: API changes

**GET /api/games (list view):**
- Dedup CTE adds `AND ge.parent_edition_id IS NULL` to exclude DLC from main list
- Response adds `dlc_count` per game: `(SELECT COUNT(*) FROM game_editions WHERE game_id = r.game_id AND parent_edition_id IS NOT NULL AND owned = 1)` — counts DLC per game, not per edition

**GET /api/games/:id (detail view):**
- `editions` query adds `AND ge.parent_edition_id IS NULL` to show only base editions
- New `dlc` array: separate query for `ge.parent_edition_id IS NOT NULL AND ge.game_id = ?`, returning title, launcher badge, tier label
- DLC items sorted by title

**Queries needing `parent_edition_id IS NULL` filter:**
- Dedup data CTE (both branches: dedup and duplicates=show)
- Count CTE
- `/api/games/filters` endpoint (launcher count, genre count, tag count, year range, playtime max)
- `platformsStmt` subquery
- `enrichAll()` in enrichGame.js (`WHERE game_id IS NULL` → add `AND parent_edition_id IS NULL`)

### Part 5: Frontend changes

**GameCard (`GameCard.jsx`):**
- When `dlc_count > 0`, show small "+N DLC" text below platform tags

**GameDetail (`GameDetail.jsx`):**
- New "DLC & Content" collapsible section after "Versions & Editions"
- Lists DLC items with title and launcher badge
- Collapsed by default, expandable

### Migration

1. Add `epic_namespace`, `epic_catalog_id`, `sandbox_type` columns to `game_editions` (ALTER TABLE, nullable)
2. Add `parent_edition_id` column to `game_editions` (ALTER TABLE, nullable)
3. Update `schema.sql` with all four new columns
4. Backfill: first Epic sync after migration populates all new columns

### Sync Flow (updated)

1. Epic `fetchOwnedGames()` returns ALL items (no namespace dedup) with `epic_namespace`, `epic_catalog_id`, `sandbox_type`
2. `syncEngine` upserts editions (including new columns, ON CONFLICT updates them)
3. Post-sync: `epicCatalog.nestDLC(db, launcherId)` — group by namespace, set parent_edition_id, copy game_id to children
4. Post-sync: `epicCatalog.resolveCodenames(db, credentials, launcherInstance)` — fix titles via catalog API
5. Existing enrichment runs — but skips editions where `parent_edition_id IS NOT NULL`

### Cleanup

Remove debug logging from `epic.js` (sample item logs, auth debug logs) now that Epic integration is stable.

### Testing

**Unit tests:**
- Codename detection heuristic (PascalCase, single word, GUID, "Live")
- Codename heuristic does NOT flag "DEATHLOOP", "Celeste", "SUPERHOT"
- DLC nesting logic (identify base game vs DLC by sandbox_type)

**API tests:**
- DLC excluded from main game list
- `dlc_count` returned correctly
- Detail endpoint includes `dlc` array separate from `editions`
- Filters endpoint not inflated by DLC items

**Integration:**
- Full Epic sync → DLC nesting → catalog resolution → enrichment flow

### What stays the same

- Epic auth flow (authorization_code, token refresh)
- Library fetch endpoint (same API, just store more fields and return all items)
- Edition tier detection and display
- All non-Epic launchers unaffected
- Enrichment pipeline (IGDB, SteamGridDB, Steam CDN) — just skips DLC items
