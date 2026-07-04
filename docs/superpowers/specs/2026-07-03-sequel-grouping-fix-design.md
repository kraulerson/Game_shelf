# Sequel Grouping Fix — Design

**Date:** 2026-07-03
**Repo:** Game_shelf
**Status:** Approved (approach: numeric-tail split, full repair)

## Problem

Distinct games in a series are being collapsed onto one `game_id`, so a sequel shows up on its predecessor's page and only one of them appears on the main list. Confirmed live:

- **Game 4871 "Portal 2"** contains `ed5 "Portal"` + `ed10 "Portal 2"` (two separate games).
- **Game 9786 "Darksiders II: Deathinitive Edition"** correctly holds *Darksiders II* + its *Deathinitive Edition*, but also swallowed `ed180 "Darksiders"` (the first game).

A sweep of the live DB (2207 games / 2932 editions) finds **~40 games** with a genuine sequel wrongly merged: Half-Life/HL2, BioShock/BioShock 2, Dead Space, Just Cause, Magicka, Prototype, Torchlight, Trine, Mafia, Nioh/Nioh 2, Doom/Doom 64, Life is Strange, Helldivers, Titan Quest, Blasphemous, Cat Quest, Path of Exile, and more.

### Root cause

A single numeric-suffix-blind predicate, copy-pasted into 4 sites:

```js
longer.startsWith(shorter) && (longer.length === shorter.length || longer[shorter.length] === '-')
```

It treats `portal` as a valid prefix of `portal-2` because the next character is a word boundary (`-`). It cannot tell an **edition** (`darksiders-2` → `darksiders-2-deathinitive-edition`, tail = edition words) from a **sequel** (`darksiders` → `darksiders-2`, tail = a number).

The 4 sites:

| Site | File:line | Role |
|---|---|---|
| Cross-launcher match | `backend/src/services/metadata/enrichGame.js:150-171` | **primary** — assigns a new edition to an existing game by slug prefix |
| Phase 12b prefix-merge | `backend/src/db/migrate.js:184-213` | merges two `games` rows when one slug prefixes the other |
| Phase 15 repair predicate | `backend/src/db/repairMisGroupedEditions.js:17-23` | `isPrefixRelated` used to decide "belongs here" |
| IGDB match boost | `backend/src/services/metadata/titleMatcher.js:93` | boosts IGDB similarity for prefix titles |

The existing intended model **is** documented in `docs/superpowers/specs/2026-03-24-edition-display-redesign-design.md` (Phase 11) + the `edition_tiers` table (tier 0–10: Standard…Deluxe…GOTY…Definitive…Director's Cut, `detectEditionTier` in `backend/src/utils/editionTier.js`). Best-edition display already works (`games.js` list dedup + detail page rank by `is_display_edition DESC, tier DESC, launcher priority ASC`). It only needs correct grouping beneath it.

## Goal

Two-part fix, aligned to the documented model:

1. **Prevention (permanent):** replace the blind prefix predicate at all 4 sites with a shared "same game?" rule that recognizes a numeric/roman-numeral tail as a **sequel = different game**. Every future sync/enrich obeys it.
2. **Repair (one-time, idempotent):** a migration (Phase 16) that splits already-merged sequels apart and re-homes them, then recomputes display tiers for affected games.

**Non-goal:** re-architecting edition tiers or display selection — those work. This is grouping only.

## The rule

A new shared module `backend/src/services/metadata/gameIdentity.js` exports:

### `canonicalBaseSlug(title) -> string`

`slugify(title)`, then strip **trailing** edition-qualifier tokens (stop at the first non-qualifier token from the end). This reduces an edition title to the base game it belongs to.

- Qualifier tokens (stripped when trailing): `edition`, `editions`, `goty`, `definitive`, `deathinitive`, `warmastered`, `remastered`, `remaster`, `enhanced`, `complete`, `collection`, `pack`, `deluxe`, `gold`, `ultimate`, `premium`, `collectors`, `collector`, `legendary`, `limited`, `special`, `anniversary`, `directors`, `cut`, `final`, `standard`, `base`, `launch`, `hd`, `digital`, and grammar fillers when adjacent to those: `the`, `of`, `year`, `game`, `day`, `one`, `and`.
- Also strip a single trailing 4-digit year token in `1970`–`2099` (so `dead-space-2008` → `dead-space`, merging the year-tagged duplicate with the base — while `doom-64` keeps `64`, not a year).
- **Do NOT** strip `remake` (per the doc, remakes are separate games).
- Numbers and roman numerals are **never** stripped: they are part of the base (`portal-2` stays `portal-2`; `darksiders-ii` stays `darksiders-ii`).

Examples:
- `"Darksiders II Deathinitive Edition"` → `darksiders-ii`
- `"Darksiders II"` → `darksiders-ii`
- `"Darksiders"` → `darksiders`
- `"Portal 2"` → `portal-2`
- `"ENDLESS Space™ 2 - Definitive Edition"` → `endless-space-2`
- `"Dead Space (2008)"` → `dead-space`

### `sameGame(titleA, titleB) -> boolean`

```
sa = canonicalBaseSlug(A); sb = canonicalBaseSlug(B)
if sa === sb: return true
[shorter, longer] = order by length
if shorter.length < 4: return false                       // MIN_BASE
if not wordBoundaryPrefix(shorter, longer): return false   // longer starts with shorter + '-'
tail = longer.slice(shorter.length + 1)
if isSequelToken(tail.split('-')[0]): return false         // numeric/roman first tail token => different games
return true
```

- `isSequelToken(tok)` = `/^[0-9]+$/.test(tok)` OR `tok` ∈ roman set `{i,ii,iii,iv,v,vi,vii,viii,ix,x,xi,xii,xiii,xiv,xv,xvi,xvii,xviii,xix,xx}`.
- `wordBoundaryPrefix(shorter, longer)` = `longer.startsWith(shorter) && (longer.length === shorter.length || longer[shorter.length] === '-')`.

**Behavior:** same-game when the tail is edition/subtitle words; different-game when the tail starts with a number/roman numeral.

Why numeric-only (approved): unambiguous. Splits every sequel; leaves genuine same-games alone. Worked examples against the live data:

| Pair | Bases | Verdict | Correct? |
|---|---|---|---|
| Portal / Portal 2 | `portal` / `portal-2` | different (tail `2`) | ✅ split |
| Darksiders / Darksiders II Deathinitive | `darksiders` / `darksiders-ii` | different (tail `ii`) | ✅ split |
| Darksiders II / Darksiders II Deathinitive | `darksiders-ii` / `darksiders-ii` | same | ✅ keep |
| Nioh: Complete / Nioh 2: Complete | `nioh` / `nioh-2` | different (tail `2`) | ✅ split |
| Doom / Doom 64 | `doom` / `doom-64` | different (tail `64`) | ✅ split |
| Deus Ex: Invisible War / Deus Ex 2: Invisible War | `deus-ex-invisible-war` / `deus-ex-2-invisible-war` | not a prefix pair | ✅ keep (same game, IGDB-grouped) |
| The Witcher 3 / The Witcher 3: Wild Hunt | `the-witcher-3` / `the-witcher-3-wild-hunt` | same (tail `wild`, non-numeric) | ✅ keep |

## Prevention — wiring the 4 sites

Each site's ad-hoc predicate is replaced by a call into `gameIdentity`:

1. **`enrichGame.js` cross-launcher match** — replace the `validCross` predicate with `sameGame(title, g.title)`. Keep the existing `description IS NOT NULL` candidate query and `ORDER BY length(g.slug) DESC LIMIT 5`; only the acceptance test changes. A rejected sequel then falls through to "create minimal game" (its own row) — the intended outcome.
2. **`migrate.js` Phase 12b `mergePrefix`** — replace the inline slug-prefix test with `sameGame(shorter.title, longer.title)` (using titles, not slugs, so the qualifier vocabulary applies). Only merge when `sameGame` is true.
3. **`repairMisGroupedEditions.js` `isPrefixRelated`** — reimplement as `sameGame` (keep the export name/signature so the Phase 15 test and caller are unaffected, or re-point them). This aligns the Epic-namespace repair with the same rule.
4. **`titleMatcher.js:93` boost** — guard the 0.80 prefix-boost with `!isSequelToken(tail)` so IGDB matching doesn't pull a sequel's metadata onto the wrong game. Lowest-risk, but included for consistency.

## Repair — migration Phase 16

New `backend/src/db/repairSequelGrouping.js`, invoked as Phase 16 in `migrate.js` after Phase 15.

Algorithm (idempotent):

```
for each game g with >1 owned base-edition (parent_edition_id IS NULL):
  primary = canonicalBaseSlug(g.title)          // the base the game row represents
  for each edition e under g:
    be = canonicalBaseSlug(e.title)
    if sameGame-consistent with primary: keep   // be === primary, or prefix pair w/ non-numeric tail
    else if it is a SEQUEL of primary (prefix pair, numeric tail) OR unrelated:
      target = existing game whose canonicalBaseSlug(title) === be   // reuse (e.g. Darksiders -> Warmastered game)
      if none: create games row (title=e.title, slug=slugify(e.title))  // ON CONFLICT(slug) reuse
      move e (and its parent_edition_id children) to target.game_id
      re-run detectEditionTier for the moved editions; recompute is_display_edition per affected game
  recompute is_display_edition for g (its edition set shrank)
return count moved
```

Guards:
- Only split when the leftover is a **numeric/roman sequel** relative to the game's base, or the edition base is entirely unrelated (no prefix relationship) — mirroring `sameGame`. Never split a genuine edition (`darksiders-ii` stays with `darksiders-ii`).
- Do **not** touch games whose editions all share one base (the healthy majority).
- FK toggling and transaction handling copy the Phase 15 pattern (`pragma foreign_keys=OFF` outside the txn, re-`ON` after).
- Idempotent: a second run moves 0 (once split, each game's editions share one base).

### Display recompute

After re-homing, each new/affected game needs `edition_tiers` rows + one `is_display_edition=1`. Reuse the existing tier-assignment path (the same routine Phase 11 used to populate `edition_tiers`); ensure moved editions get a tier row and each affected game has exactly one display edition (highest tier, launcher-priority tiebreak).

## Testing (TDD)

- **`gameIdentity` unit tests** — the full matrix above plus: qualifier stripping, year stripping, roman numerals, `MIN_BASE` guard (3-char overlap rejected), trademark/punctuation normalization (`ENDLESS Space™ 2` == `Endless Space 2`), and `sameGame` symmetry.
- **`repairSequelGrouping` tests** — seed a Portal/Portal 2 game and a Darksiders II + Deathinitive + original-Darksiders + existing Warmastered game; assert: Portal splits to its own game, Darksiders re-homes into the Warmastered game, Darksiders II + Deathinitive stay together; second run moves 0 (idempotent); a healthy multi-edition game is untouched.
- **Prevention regression tests** — `enrichGame` cross-match rejects a sequel and creates its own game; accepts a true edition. `migrate` Phase 12b merges an edition pair but not a sequel pair. Existing Phase 15 test still passes.
- **Full suite** — `cd backend && node --test 'tests/**/*.test.js'` (no NEW failures beyond the 2 pre-existing) + `cd frontend && npm test` + `npm run build` (frontend untouched, but verify green).

## Rollout

1. Branch `fix/sequel-grouping` off `main` in Game_shelf.
2. TDD via subagent-driven-development, one commit per the A/B/C structure I bring at commit time.
3. Back up the live DB (`gameshelf.db.bak-pre-sequel-fix`), deploy, run migrations (Phase 16 fires), verify Portal/Darksiders split live + the ~40 count drops to ~0.
4. I push the branch and open the PR; Karl merges.

## Scope / risk

- ~40 games re-grouped; new game rows created for split-off originals; DLC children follow their base edition.
- Known minor edges (accepted): word-subtitle spinoffs (Half-Life 2: Deathmatch) stay grouped; a year-tagged duplicate that isn't caught by year-strip stays separate. Neither is a numeric sequel, so neither is in the reported class.
- Frontend unchanged — display already keys off `game_id` + tiers.
