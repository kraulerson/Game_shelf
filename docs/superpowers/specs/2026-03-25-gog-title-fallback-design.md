# GOG Title Fallback — Design Spec

**Date:** 2026-03-25
**Status:** Approved

## Problem

The GOG API (`api.gog.com/products/{id}`) returns `product_title_xxxxx` (an unresolved i18n key) as the title for some products. The `slug` field contains the actual game name in underscore format (e.g., `quake_ii_quad_damage_1112936378`).

## Solution

Add a fallback in `GOGLauncher.fetchOwnedGames()`: when the title matches `/^product_title_\d+$/`, derive the title from the slug by stripping the trailing product ID, replacing underscores with spaces, and title-casing words with smart roman numeral handling.

## Implementation

**File:** `backend/src/services/launchers/gog.js`

Add a `humanizeSlug(slug)` helper function:
1. Strip trailing `_\d+` (the product ID suffix)
2. Replace underscores with spaces
3. Title-case each word
4. Uppercase roman numerals (ii→II, iii→III, iv→IV, vi→VI, etc.)

In `fetchOwnedGames()`, after reading `productRes.data.title`, check if it matches the i18n key pattern. If so, use `humanizeSlug(productRes.data.slug)` instead.

## Re-sync Behavior

Existing bad titles will be fixed on next GOG sync because the sync engine's upsert updates the title on conflict (`syncEngine.js:57`).

## Testing

- Unit tests for `humanizeSlug()` with various slug formats
- Regression test: mock GOG API to return `product_title_xxx` title with a valid slug, verify humanized title is used
