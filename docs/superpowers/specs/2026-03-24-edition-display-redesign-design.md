# Edition Display Redesign — Phase 11

**Date:** 2026-03-24
**Status:** Approved
**Scope:** Backend migration, API changes, frontend components

## Problem

When a user owns the same game on multiple platforms, the library shows duplicate entries ranked only by launcher priority. There is no awareness of edition tiers (GOTY, Deluxe, etc.), no consolidated platform view, and the detail page lacks a clear breakdown of which version exists on which platform.

## Solution

### New Table: `edition_tiers`

```sql
CREATE TABLE edition_tiers (
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id),
  game_edition_id INTEGER NOT NULL REFERENCES game_editions(id),
  tier INTEGER NOT NULL DEFAULT 0,
  is_display_edition INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(game_edition_id)
);
```

### Tier Values (auto-detected from title keywords)

| Tier | Editions | Group |
|------|----------|-------|
| 0 | Standard, Base, Day One, Launch, (no keyword) | Launch |
| 1 | Deluxe, Digital Deluxe | Launch |
| 2 | Gold | Launch |
| 3 | Premium, Ultimate, Collector's, Legendary, Limited | Launch |
| 4 | GOTY, Game of the Year | Post-launch |
| 5 | Complete | Post-launch |
| 6 | Enhanced, Remastered | Post-launch/Technical |
| 7 | Special | Post-launch |
| 8 | Definitive | Post-launch |
| 9 | Director's Cut | Post-launch |
| 10 | Final Cut | Post-launch |

**Detection:** Scan `game_editions.title` for keywords (case-insensitive). If multiple keywords match, use the highest tier. Default to 0 when no keyword matches.

**Remakes** are treated as separate games (different slug) since they are fundamentally different products.

**Manual override:** `is_display_edition = 1` on any edition overrides auto-detection. Only one edition per game should have this flag. Manual overrides are never modified by auto-detection.

### Display Edition Selection Logic

Priority order:
1. `is_display_edition = 1` (manual override)
2. Highest `tier` value
3. Lowest launcher `priority` (tiebreaker)

### API Changes

#### GET /api/games (list view)

Dedup CTE ranking changes from:
```sql
ORDER BY l.priority ASC
```
To:
```sql
ORDER BY COALESCE(et.is_display_edition, 0) DESC, COALESCE(et.tier, 0) DESC, l.priority ASC
```

Response adds per-game:
- `display_edition_title` — title of the winning edition (if different from game title)
- `display_tier` — tier value of the winning edition
- `platforms` — array of `{ launcher_name, launcher_display_name }` for all owned editions

The existing `also_on` field is replaced by `platforms` for a cleaner contract.

#### GET /api/games/:id (detail view)

The `editions` array expands to include:
- `edition_title` — the edition-specific title from `game_editions.title`
- `tier` — numeric tier value
- `tier_label` — human-readable tier name (e.g., "GOTY", "Deluxe", "Standard")
- `is_display_edition` — boolean, whether this is the manually selected display edition

#### POST /api/games/:id/display-edition

New endpoint to set manual override:
```json
{ "edition_id": 42 }
```
Sets `is_display_edition = 1` for the given edition and clears it on all other editions for the same game.

### Frontend Changes

#### GameCard (`GameCard.jsx`)
- Remove primary launcher badge + "+N more" dropdown
- Add small platform tags at bottom of card (all platforms the game is owned on)
- If display edition title differs from game title, show edition name in smaller text below title

#### GameRow (`GameRow.jsx`)
- Same change: replace single badge + "+N more" with inline platform tags

#### GameDetail (`GameDetail.jsx`)
- "Owned On" section renamed to "Versions & Editions"
- Each edition row shows: platform badge, edition title, tier label chip, playtime
- Display edition is visually highlighted (border or star icon)
- Each non-display edition row has a "Set as display" button (calls POST endpoint)
- Edition rows grouped by: display edition first, then by tier descending

#### LauncherBadge (`LauncherBadge.jsx`)
- Add a `small` variant for use as platform tags on GameCard (smaller font, tighter padding)

### Migration & Sync

#### Migration
1. Create `edition_tiers` table
2. Run initial population: scan all existing `game_editions.title` for tier keywords, insert rows into `edition_tiers`

#### Ongoing (post-sync)
After each sync upserts game_editions:
1. For any edition without an `edition_tiers` row, compute tier from title and insert
2. Never modify rows where `is_display_edition = 1`

### Tier Detection Function

Reuse keyword patterns from `titleMatcher.js` EDITION_SUFFIXES, expanded into a scoring function:

```js
function detectEditionTier(title) {
  const lower = title.toLowerCase();
  if (/\bfinal cut\b/.test(lower)) return 10;
  if (/\bdirector'?s cut\b/.test(lower)) return 9;
  if (/\bdefinitive\b/.test(lower)) return 8;
  if (/\bspecial edition\b/.test(lower)) return 7;
  if (/\benhanced\b|\bremastered\b/.test(lower)) return 6;
  if (/\bcomplete\b/.test(lower)) return 5;
  if (/\bgoty\b|\bgame of the year\b/.test(lower)) return 4;
  if (/\bultimate\b|\bpremium\b|\bcollector'?s\b|\blegendary\b|\blimited edition\b/.test(lower)) return 3;
  if (/\bgold\b/.test(lower)) return 2;
  if (/\bdeluxe\b|\bdigital deluxe\b/.test(lower)) return 1;
  return 0;
}
```

Ordered from highest to lowest so the first match wins (a title containing both "Complete" and "Deluxe" gets tier 5, not 1).

### Testing

#### Unit tests
- `detectEditionTier` returns correct tier for each keyword
- `detectEditionTier` returns 0 for plain titles
- `detectEditionTier` picks highest tier when multiple keywords present

#### API tests
- Dedup query returns the highest-tier edition as the display game
- Manual override (`is_display_edition`) takes precedence over tier
- `platforms` array includes all owned launchers
- POST display-edition sets flag correctly and clears others

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
