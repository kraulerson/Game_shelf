# Prefix-Aware Title Matching + Cross-Launcher Metadata Sharing

**Date:** 2026-03-24
**Status:** Approved
**Scope:** 2 files — `titleMatcher.js`, `enrichGame.js`

## Problem

Epic Games `sandboxName` titles are often shorter than IGDB's full titles (e.g., "MechWarrior 5" vs "MechWarrior 5: Mercenaries"). The `findBestMatch` function uses Levenshtein similarity with a 0.75 threshold, which rejects valid prefix matches (0.52 similarity for the MechWarrior example). This causes ~574 out of 603 Epic games to fail IGDB enrichment.

Additionally, when IGDB lookup fails, no attempt is made to reuse metadata from other launchers that may have the same game already enriched.

## Solution

### Part 1: Prefix-aware matching (`titleMatcher.js`)

In `findBestMatch`, after computing Levenshtein similarity, add a prefix check:

```js
const shorter = searchSlug.length <= resultSlug.length ? searchSlug : resultSlug;
const longer = searchSlug.length <= resultSlug.length ? resultSlug : searchSlug;
if (longer.startsWith(shorter) && (longer.length === shorter.length || longer[shorter.length] === '-')) {
  similarity = Math.max(similarity, 0.80);
}
```

The `-` boundary check prevents false matches like `mechwarrior` matching `mechwarrior-5-mercenaries` when searching for a different game. Only exact word-boundary prefixes get boosted.

Applies to **all launchers**, not just Epic.

### Part 2: Cross-launcher metadata sharing (`enrichGame.js`)

In `enrichGame`, when IGDB lookup fails, before creating a minimal `games` row:

1. Compute the edition's slug
2. Search existing `games` rows for a prefix match: `WHERE (slug LIKE :slug || '%' OR :slug LIKE slug || '%') AND description IS NOT NULL`
3. Verify the match using the same prefix logic from Part 1
4. If found: link the edition to the existing game (no new row needed)
5. If not found: create minimal row as before

Same logic in `enrichUnderEnriched` for re-enrichment passes.

### What stays the same

- 0.75 Levenshtein threshold (prefix boost brings valid matches above it)
- Enrichment pipeline structure (IGDB external ID → title search → simplified title → cross-launcher → minimal)
- SteamGridDB and Steam CDN image fallbacks
- Re-enrichment 7-day cycle
- All existing title matching for non-prefix cases

## Testing

### Regression tests (`titleMatcher.test.js`)

- "MechWarrior 5" matches "MechWarrior 5: Mercenaries" (prefix with `-` boundary) → boosted above 0.75
- "The Witcher 3" matches "The Witcher 3: Wild Hunt" → boosted
- "mechwarrior" does NOT match "mechwarrior-5-mercenaries" (not a word-boundary prefix of the search)
- Exact matches still work (similarity 1.0)
- Non-prefix similar titles still use Levenshtein (no boost)

### Integration test (`enrichGame` cross-launcher)

- When IGDB fails for an edition, and a matching game exists from another launcher, the edition links to that game
- When no matching game exists, a minimal row is created (existing behavior)

## Data Fix

After deploying, reset Epic enrichment timestamps and re-enrich:

```sql
UPDATE games SET last_enrichment_at = NULL, cover_url = NULL, description = NULL
WHERE id IN (SELECT ge.game_id FROM game_editions ge
  JOIN launchers l ON l.id = ge.launcher_id
  WHERE l.name = 'epic' AND ge.game_id IS NOT NULL AND description IS NULL);
```
