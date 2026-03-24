# Edition Display Redesign — Phase 11

**Date:** 2026-03-24
**Status:** Approved
**Scope:** Backend migration, API changes, frontend components

## Problem

When a user owns the same game on multiple platforms, the library shows duplicate entries ranked only by launcher priority. There is no awareness of edition tiers (GOTY, Deluxe, etc.), no consolidated platform view, and the detail page lacks a clear breakdown of which version exists on which platform.

## Solution

### New Table: `edition_tiers`

```sql
CREATE TABLE IF NOT EXISTS edition_tiers (
  id INTEGER PRIMARY KEY,
  game_edition_id INTEGER NOT NULL REFERENCES game_editions(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL DEFAULT 0,
  is_display_edition INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(game_edition_id)
);
CREATE INDEX IF NOT EXISTS idx_edition_tiers_lookup
  ON edition_tiers(game_edition_id, tier, is_display_edition);
```

Note: `game_id` is intentionally omitted — it's derivable via `game_editions.game_id`, avoiding denormalization. `ON DELETE CASCADE` ensures cleanup when editions are removed (e.g., launcher removal).

### Tier Values (auto-detected from title keywords)

| Tier | Editions | Group |
|------|----------|-------|
| 0 | Standard, Base, Day One, Launch, (no keyword) | Launch |
| 1 | Deluxe, Digital Deluxe | Launch |
| 2 | Gold Edition | Launch |
| 3 | Premium, Ultimate, Collector's, Legendary, Limited Edition | Launch |
| 4 | GOTY, Game of the Year | Post-launch |
| 5 | Complete Edition, Complete Collection | Post-launch |
| 6 | Enhanced, Remastered | Post-launch/Technical |
| 7 | Special Edition | Post-launch |
| 8 | Definitive | Post-launch |
| 9 | Director's Cut | Post-launch |
| 10 | Final Cut | Post-launch |

**Detection:** Scan `game_editions.title` for keywords (case-insensitive). If multiple keywords match, the first (highest-tier) match wins due to ordered evaluation. Default to 0 when no keyword matches.

**Remakes** are treated as separate games (different slug) since they are fundamentally different products.

**Manual override:** `is_display_edition = 1` on any edition overrides auto-detection. Only one edition per game should have this flag. Manual overrides are never modified by auto-detection.

### Display Edition Selection Logic

Priority order:
1. `is_display_edition = 1` (manual override)
2. Highest `tier` value
3. Lowest launcher `priority` (tiebreaker for same tier, e.g., Witcher 3 GOTY on both Steam and GOG)

### API Changes

**Deployment note:** Frontend and backend are deployed atomically via Docker, so breaking changes to response shape are safe as long as both are updated together.

#### GET /api/games (list view)

Dedup CTE ranking changes from:
```sql
ORDER BY l.priority ASC
```
To:
```sql
ORDER BY COALESCE(et.is_display_edition, 0) DESC, COALESCE(et.tier, 0) DESC, l.priority ASC
```

The CTE joins `edition_tiers` via `LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id`.

Response adds per-game:
- `display_edition_title` — title of the winning edition (if different from game title)
- `display_tier` — tier value of the winning edition
- `platforms` — array of `{ launcher_name, launcher_display_name }` for all owned editions

The `also_on` field is replaced by `platforms`. The `platforms` query follows the same pattern as the current `also_on` query (per-game subquery after the main fetch) but returns only launcher identity, not playtime. Per-platform playtime remains available on the detail page.

**`is_primary` field:** Replaced by `is_display_edition` on the detail endpoint. The concept changes from "lowest launcher priority" to "highest tier with override". The field name changes to avoid confusion. Frontend references to `is_primary` are updated to use the new field.

#### GET /api/games/:id (detail view)

The `editions` array expands to include:
- `edition_title` — the edition-specific title from `game_editions.title`
- `tier` — numeric tier value
- `tier_label` — human-readable tier name (e.g., "GOTY", "Deluxe", "Standard")
- `is_display_edition` — boolean, whether this is the display edition (manual or auto)

The `is_primary` field is removed in favor of `is_display_edition`.

#### POST /api/games/:id/display-edition

New endpoint to set manual override:
```json
{ "edition_id": 42 }
```
Sets `is_display_edition = 1` for the given edition and clears it on all other editions for the same game.

**Validation:**
- 404 if game does not exist
- 400 if `edition_id` does not belong to this game
- Returns 200 with `{ ok: true }`

### Frontend Changes

#### GameCard (`GameCard.jsx`)
- Remove primary launcher badge + "+N more" dropdown (remove `showAlsoOn` state)
- Add small platform tags at bottom of card (all platforms the game is owned on)
- If display edition title differs from game title, show edition name in smaller text below title

#### GameRow (`GameRow.jsx`)
- Same change: replace single badge + "+N more" with inline platform tags (remove `showAlsoOn` state)

#### GameDetail (`GameDetail.jsx`)
- "Owned On" section renamed to "Versions & Editions"
- Each edition row shows: platform badge, edition title, tier label chip, playtime
- Display edition is visually highlighted (border or star icon)
- Each non-display edition row has a "Set as display" button (calls POST endpoint)
- Edition rows grouped by: display edition first, then by tier descending
- Replace `is_primary` references with `is_display_edition`

#### LauncherBadge (`LauncherBadge.jsx`)
- Add a `size` prop (`"default" | "small"`)
- Small variant: `text-xs px-1.5 py-0.5` (for platform tags on GameCard)
- Default variant: unchanged (`text-sm px-2.5 py-0.5`)

### Migration & Sync

#### Migration (in `migrate.js`)
1. Create `edition_tiers` table (idempotent via `CREATE TABLE IF NOT EXISTS`)
2. Run initial population: scan all existing `game_editions.title` for tier keywords, insert rows into `edition_tiers` where not already present

#### Ongoing (in `syncEngine.js`, after `upsertAll(games)` and before "Mark missing games")
After each sync upserts game_editions:
1. For any edition without an `edition_tiers` row, compute tier from title and insert
2. Never modify rows where `is_display_edition = 1`
3. Applies to all editions (linked and unlinked)

### Tier Detection Function

New utility module `backend/src/utils/editionTier.js`:

```js
function detectEditionTier(title) {
  const lower = title.toLowerCase();
  if (/\bfinal cut\b/.test(lower)) return 10;
  if (/\bdirector[\u2019']?s cut\b/.test(lower)) return 9;
  if (/\bdefinitive\b/.test(lower)) return 8;
  if (/\bspecial edition\b/.test(lower)) return 7;
  if (/\benhanced\b|\bremastered\b/.test(lower)) return 6;
  if (/\bcomplete\s+(edition|collection|pack)\b/.test(lower)) return 5;
  if (/\bgoty\b|\bgame of the year\b/.test(lower)) return 4;
  if (/\bultimate\b|\bpremium\b|\bcollector[\u2019']?s\b|\blegendary\b|\blimited edition\b/.test(lower)) return 3;
  if (/\bgold edition\b/.test(lower)) return 2;
  if (/\bdeluxe\b/.test(lower)) return 1;
  return 0;
}

const TIER_LABELS = [
  'Standard', 'Deluxe', 'Gold', 'Premium', 'GOTY',
  'Complete', 'Enhanced', 'Special', 'Definitive',
  "Director's Cut", 'Final Cut'
];

function getTierLabel(tier) {
  return TIER_LABELS[tier] || 'Standard';
}
```

Key improvements from review:
- Unicode apostrophes handled (`\u2019` for Director's/Collector's)
- `complete` requires "Edition/Collection/Pack" to avoid false positives ("Complete Chess")
- `gold` requires "Edition" to avoid false positives ("Gold Rush")
- Patterns ordered highest-first so first match wins

### Testing

#### Unit tests (`editionTier.test.js`)
- `detectEditionTier` returns correct tier for each keyword
- `detectEditionTier` returns 0 for plain titles
- `detectEditionTier` picks highest tier when multiple keywords present
- `detectEditionTier` handles Unicode apostrophes
- `detectEditionTier` does not false-positive on "Gold Rush", "Complete Chess"

#### API tests
- Dedup query returns the highest-tier edition as the display game
- Manual override (`is_display_edition`) takes precedence over tier
- `platforms` array includes all owned launchers
- POST display-edition sets flag correctly and clears others
- POST display-edition returns 400 for invalid edition_id

#### Frontend verification
- GameCard shows platform tags instead of single badge
- GameDetail shows "Versions & Editions" with tier labels
- "Set as display" button works

### What stays the same

- `game_editions` table structure (no changes)
- `games` table structure (no changes)
- Enrichment pipeline (IGDB, SteamGridDB, Steam CDN)
- 6-hour sync cron
- Filter panel (genre, tag, launcher, year, playtime filters)
- Search functionality
- Alphabetical A-Z nav
