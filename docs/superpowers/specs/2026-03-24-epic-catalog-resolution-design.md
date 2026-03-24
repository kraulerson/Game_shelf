# Epic Catalog Resolution — Phase 12

**Date:** 2026-03-24
**Status:** Approved
**Scope:** Backend sync changes, catalog API integration, DLC nesting, minor frontend additions

## Problem

~185 Epic library items have the title "Live" (DLC/content packs from various live-service games) and ~40 have codename titles (e.g., "Capsicum", "CadmiumRed"). The Epic library API returns internal `sandboxName` values for these instead of published titles. Additionally, DLC items appear as separate games in the library instead of being nested under their parent.

## Solution

### Part 1: Store Epic metadata during sync

Add two nullable columns to `game_editions`:

```sql
ALTER TABLE game_editions ADD COLUMN epic_namespace TEXT;
ALTER TABLE game_editions ADD COLUMN epic_catalog_id TEXT;
```

During Epic sync in `fetchOwnedGames()`, populate these from the library API response fields `namespace` and `catalogItemId`. These fields are already returned by the API but currently discarded.

The `game_editions` mapping changes from:
```js
{ launcher_game_id: id, title: item.sandboxName || item.appName || id, playtime_minutes: ... }
```
To:
```js
{ launcher_game_id: id, title: item.sandboxName || item.appName || id, playtime_minutes: ...,
  epic_namespace: item.namespace, epic_catalog_id: item.catalogItemId }
```

The sync engine's upsert statement for `game_editions` must be updated to include the two new columns.

### Part 2: Resolve titles via Epic catalog API

New module: `backend/src/services/launchers/epicCatalog.js`

After Epic sync completes and editions are upserted, a post-sync step:

1. Collects all unique `epic_namespace` values from editions with codename-looking titles or title "Live"
2. For each namespace, queries:
   ```
   GET https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/{namespace}/bulk/items?includeMainGameDetails=true&country=US&locale=en-US
   ```
   Using the same Bearer token from the Epic sync session.
3. Maps `catalogItemId` → published `title` from the response
4. Updates `game_editions.title` for matched editions

**Codename detection heuristic:** A title is likely a codename if it's a single token (no spaces, no colons, no digits-only) AND has no IGDB match (description IS NULL on the linked game). This avoids touching real single-word titles like "Celeste" or "DEATHLOOP" that have successful enrichment.

**Rate limiting:** Batch namespaces and add 500ms delay between API calls. Each namespace returns all items in one call, so ~200 unique namespaces means ~200 API calls over ~100 seconds.

### Part 3: DLC nesting by namespace

After catalog resolution, group editions by `epic_namespace`:

1. For each namespace with multiple editions, identify the **base game**: the edition where `sandboxType = 'PUBLIC'` or (if ambiguous) the edition with the highest tier from `edition_tiers`
2. All other editions in the same namespace are DLC/content
3. DLC editions get a new column: `parent_edition_id INTEGER REFERENCES game_editions(id)`
4. DLC editions link to the same `game_id` as the base game edition

```sql
ALTER TABLE game_editions ADD COLUMN parent_edition_id INTEGER REFERENCES game_editions(id);
```

Editions with `parent_edition_id IS NOT NULL` are DLC and excluded from the main library dedup CTE (add `AND ge.parent_edition_id IS NULL` to the WHERE clause).

### Part 4: API changes

**GET /api/games (list view):**
- Dedup CTE adds `AND ge.parent_edition_id IS NULL` to exclude DLC from main list
- Response adds `dlc_count` per game (count of child editions)

**GET /api/games/:id (detail view):**
- Response adds `dlc` array: child editions with their titles, launcher info, and tier labels
- DLC items sorted by title

### Part 5: Frontend changes

**GameCard (`GameCard.jsx`):**
- When `dlc_count > 0`, show small "+N DLC" text below platform tags

**GameDetail (`GameDetail.jsx`):**
- New "DLC & Content" collapsible section after "Versions & Editions"
- Lists DLC items with title and launcher badge
- Collapsed by default, expandable

### Migration

1. Add `epic_namespace`, `epic_catalog_id` columns to `game_editions` (ALTER TABLE, nullable)
2. Add `parent_edition_id` column to `game_editions` (ALTER TABLE, nullable)
3. Backfill: re-sync Epic to populate namespace/catalogId for existing editions (or run a one-time population from a fresh library fetch)

### Sync Flow (updated)

1. Epic `fetchOwnedGames()` returns items with `epic_namespace` and `epic_catalog_id`
2. `syncEngine` upserts editions (now including new columns)
3. Post-sync: `epicCatalog.resolveCodenames(db, session)` resolves titles
4. Post-sync: `epicCatalog.nestDLC(db)` groups DLC under parent editions
5. Existing enrichment runs (IGDB, SteamGridDB, etc.)

### Testing

**Unit tests:**
- Codename detection heuristic (single-word, no IGDB match)
- Catalog API response parsing
- DLC nesting logic (identify base game vs DLC by sandboxType)

**API tests:**
- DLC excluded from main game list
- `dlc_count` returned correctly
- Detail endpoint includes `dlc` array

**Integration:**
- Full Epic sync → catalog resolution → DLC nesting flow

### What stays the same

- Epic auth flow (authorization_code, token refresh)
- Library fetch (same API, just store more fields)
- Edition tier detection and display
- All non-Epic launchers unaffected
- Enrichment pipeline (IGDB, SteamGridDB, Steam CDN)
