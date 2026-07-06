# Design — #225 per-game prefill-edition override

<!-- 2026-07-06 -->

**Issue:** kraulerson/lancache-orchestrator#225 — prefill only the highest-priority launcher per game.
**Repo:** Game_shelf (this is a Game_shelf-only change — no orchestrator changes).

## Context: what already works

The orchestrator's scheduled prefill covers **Epic only** (Steam is prefilled by the host
SteamPrefill cron). Game_shelf already dedups cross-launcher games (Piece 3): `crossLauncherExclusions.js::computeSteamCoveredEpicAppIds` finds every Epic edition whose `game_id`
also has a Steam edition and pushes them as `source=gameshelf` exclusions
(`syncCrossLauncherExclusions` → orchestrator `PUT /api/v1/prefill-exclusions/gameshelf/epic`).
The Epic scheduled prefill skips excluded app_ids. So a game owned on Steam **and** Epic is cached
via Steam only — its Epic edition is excluded. There are ~114 such exclusions live.

**The gap:** this is hardcoded "Steam always beats Epic." There is no way to say "actually, cache
*this* game's Epic edition instead." That per-game override is the only unbuilt part of #225.

## Decision (from brainstorming with Karl)

Add a **per-game prefill-edition override**, stored **separately from** the #224 display edition
(display = what the UI shows; prefill = what gets cached — they can differ). The override simply
**removes a Steam+Epic game's Epic edition from the exclusion set** so the Epic prefill caches it.

**Scope decisions:**
- **Toggle only appears for games owned on BOTH Steam and Epic** — the only case with a real choice.
  Epic-alone or Epic + a non-Steam launcher (e.g. Epic + GOG) always auto-prefills Epic (no Steam
  edition → never in the exclusion set → nothing to override). This falls out of the compute for
  free.
- **Epic-only reach** (Karl's choice): the override only decides whether **Epic** is prefilled. When
  set to Epic, we stop excluding the Epic edition (Epic gets cached). We do **not** touch the host
  SteamPrefill selection — Steam's cron is left alone. (So a game flipped to "prefill Epic" gets
  Epic cached; Steam may still be cached by its cron — accepted.)
- **Default = Steam** (unchanged behavior): with no override, a Steam+Epic game's Epic edition stays
  excluded, exactly as today.
- Mirror the existing #224 display-edition mechanism for consistency.

## Architecture / components

### 1. Data — `edition_tiers.is_prefill_edition`
`is_display_edition` lives on `edition_tiers` (one row per `game_edition_id`, `UNIQUE(game_edition_id)`).
Add a sibling column `is_prefill_edition INTEGER DEFAULT 0`. Update both `backend/src/db/schema.sql`
and `backend/src/db/migrate.js` (Game_shelf creates/migrates its schema in `migrate.js`; the change
must be an additive `ALTER TABLE ... ADD COLUMN is_prefill_edition INTEGER DEFAULT 0` guarded so it's
idempotent on existing DBs, plus the column in the `CREATE TABLE` for fresh DBs). At most one edition
per game carries `is_prefill_edition = 1` (the override); unset = default priority (Steam).

### 2. Compute — `computeSteamCoveredEpicAppIds`
Currently: Epic editions whose `game_id` has a Steam edition. Change: **also exclude Epic editions
the operator chose to prefill.** LEFT JOIN `edition_tiers et` on the Epic `game_editions.id` and add
`AND COALESCE(et.is_prefill_edition, 0) = 0`. So a Steam+Epic game is Steam-covered (Epic excluded)
UNLESS its Epic edition is the chosen prefill edition. No other logic changes; the sync + orchestrator
reconcile are unchanged — only which app_ids are in the pushed set changes.

### 3. API — `POST /api/games/:id/prefill-edition`
Mirror the display-edition setter (`games.js` `POST /:id/display-edition`): body `{edition_id}`,
validate the edition belongs to the game, then in one transaction clear `is_prefill_edition=0` for all
the game's editions and set `=1` on the chosen one. **Robustness:** unlike the display setter (which
UPDATEs and silently no-ops if no `edition_tiers` row exists), the prefill setter must `INSERT OR
IGNORE INTO edition_tiers (game_edition_id) VALUES (?)` for the target first so the UPDATE lands.
Optionally accept `edition_id = null` to CLEAR the override (revert to default Steam). Guard: the
target edition should be the **Epic** edition of a game that also has a **Steam** edition (400
otherwise) — the only meaningful override; keeps junk out of the data.

### 4. GET game response
The game-detail query already returns `is_display_edition` per edition. Add `is_prefill_edition`
(from `edition_tiers`) per edition, plus a computed `has_prefill_choice` boolean on the game (true iff
the game has both a Steam and an Epic edition) so the UI knows when to show the control.

### 5. UI — GameDetail "Prefill this edition"
Add a per-launcher "Prefill this edition" affordance next to (but independent of) "Set as display",
**shown only when `has_prefill_choice` is true**. It POSTs `/api/games/:id/prefill-edition`
`{edition_id}` then invalidates the game query. Reuse the existing display-edition button styling.
Copy makes the default explicit (e.g. "Cached via Steam · Prefill Epic instead").

### 6. Sync trigger
After a prefill-edition change, the exclusion set is stale until the next `syncCrossLauncherExclusions`
run (it already runs on the daily cron + on library sync). The setter should trigger a
`syncCrossLauncherExclusions` (fire-and-forget, tolerant of orchestrator-offline) so the change
actuates promptly rather than waiting for the cron — mirroring how the cross-launcher sync is already
invoked.

## Data flow

```
Operator clicks "Prefill Epic" on GameDetail (game owned Steam+Epic)
  → POST /api/games/:id/prefill-edition {edition_id: <epic edition>}
  → edition_tiers.is_prefill_edition = 1 on the Epic edition (0 on siblings)
  → syncCrossLauncherExclusions() re-computes: this Epic app_id now EXCLUDED from the set
    (computeSteamCoveredEpicAppIds skips is_prefill_edition=1)
  → PUT /api/v1/prefill-exclusions/gameshelf/epic (reconcile: drops this app_id's exclude row)
  → orchestrator Epic scheduled prefill no longer skips it → caches Epic
```

## Error handling
- Setter: 404 game-not-found; 400 edition-not-in-game / not-an-Epic-edition-of-a-Steam+Epic-game.
- `syncCrossLauncherExclusions` already tolerates orchestrator-offline (503 passthrough) — the
  prefill-edition write still succeeds; the sync retries on the next cron.
- Additive migration is idempotent (guarded ADD COLUMN) — safe to re-run.

## Testing
- **Unit (compute):** `computeSteamCoveredEpicAppIds` — a Steam+Epic game is in the exclusion set by
  default; the same game with its Epic edition `is_prefill_edition=1` is NOT in the set; an Epic-only
  and an Epic+GOG game are never in the set regardless.
- **Backend (setter):** POST sets the flag (and clears siblings), creates the `edition_tiers` row if
  missing, `null` clears it, 400 for a non-Epic / non-Steam+Epic target, 404 unknown game.
- **Frontend:** the "Prefill this edition" control renders only when `has_prefill_choice`; clicking
  POSTs the right edition_id + invalidates.
- Full backend suite: no NEW failures beyond the 2 pre-existing (setup/qr, health).

## Non-goals
- No host-SteamPrefill-selection pruning (Steam left to its cron — Karl's choice).
- No global configurable priority order (Steam>Epic is fine; GOG isn't orchestrator-prefilled).
- No orchestrator changes (the exclusion/reconcile/prefill path is unchanged).
