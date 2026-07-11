# Card Badge / Display Priority: Unranked Launcher Sorts Last — Design Spec

**Date:** 2026-07-10
**Repo:** Game_shelf (backend only; no frontend change)
**Status:** Approach approved (Karl chose the robust code fix); pending spec review.

## Problem

On the main-page game cards, the status badge (and the primary launcher/edition shown)
should follow the launcher **display priority**: pick the highest-priority launcher the
game is owned on and show *its* status — the lancache cache badge for Steam/Epic, or the
manual Downloaded/Not-downloaded badge for GOG/Amazon/Humble/Itch.

The card **already** follows `launchers.priority` (via `resolveCacheLauncher` and the
display-edition ordering). The bug is in the data model's default: **an unranked launcher
has `priority = 0`, and `0` sorts *first* (highest) under `ORDER BY priority ASC`.**

Live state (verified 2026-07-10):

```
launchers.priority:  amazon=0  steam=1  epic=2  ubisoft=3  ea=4  gog=5  humble=6  xbox=7  itchio=8
```

Every launcher was explicitly ranked (1–8) except **Amazon**, which was never placed and
sits at the default `0` — so Amazon outranks Steam and Epic. For any game also owned on
Amazon, Amazon wins the badge and the display edition. Example: **Psychonauts**
(`steam, humble, amazon`, all `tier 0`, no `is_display_edition`) resolves to **amazon** →
the card shows Amazon "Downloaded" instead of Steam "Cached". **220 games** are owned on
both a manual and a lancache launcher and are affected.

`is_display_edition` is NOT involved (all such editions have it 0); the sole cause is
`priority 0` sorting first.

## Goal / Non-goals

**Goal:** an unranked launcher (`priority = 0`) is treated as **lowest** priority, so the
built-in canonical order (Steam>Epic>GOG>EA>Ubisoft>Humble>Itch>Xbox>Amazon) governs
unranked launchers. Lancache launchers then win the badge + display for any multi-launcher
game by default, Karl's explicit rankings (1–8) still apply, `is_display_edition`/`tier`
overrides still take precedence, and a future unranked launcher can't hijack the badge.

**Non-goals:** no frontend change (the card already consumes `cache_launcher_name`); no
schema change / migration (Amazon stays `0` in the DB — the code now reads `0` correctly as
"unranked → last"); no change to sync ordering (functionally order-irrelevant); no change to
`is_display_edition` / `is_prefill_edition` semantics.

## Design

### One shared SQL fragment

In `backend/src/services/cacheLauncher.js`, add and export:

```js
// A launcher's EFFECTIVE display priority. priority is user-set (1 = highest); the
// default 0 means "unranked" and must sort LAST, letting CANONICAL_ORDER_SQL (Steam>
// Epic>...>Amazon) govern unranked launchers — so lancache launchers win by default and
// a newly-added, unranked launcher can't outrank everything. Assumes the launchers table
// is aliased `l`.
const EFFECTIVE_PRIORITY_SQL = `CASE WHEN l.priority = 0 THEN 999 ELSE l.priority END`;
```

`999` is safely above any realistic user priority; ties among unranked launchers fall
through to `CANONICAL_ORDER_SQL` (which already ranks Steam=1 … Amazon=9 < 99=other).

### Apply it (replace `l.priority ASC` → `${EFFECTIVE_PRIORITY_SQL} ASC`)

| File:line | Ordering | Effect of fix |
|---|---|---|
| `cacheLauncher.js` `resolveCacheLauncher` (~:48) | the **badge** launcher | Psychonauts → steam; Amazon+Epic → epic; Amazon-only → amazon |
| `routes/games.js` display-edition (~:116 detail, ~:607/:633 list) | which edition's title/launcher shows as primary | primary launcher matches the badge (no "Cached on Steam" with an Amazon primary label) |
| `routes/games.js` `platforms` list (~:658) | owned-launcher chips, priority order | unranked launcher listed last, not first |
| `routes/games.js` `/filters` launcher list (~:57) | filter facet order | consistent ordering |

`routes/games.js` imports `EFFECTIVE_PRIORITY_SQL` from `../services/cacheLauncher`.
`routes/sync.js:30` (`ORDER BY l.priority ASC`) is **left unchanged** — it orders launchers
for a sync pass, not for display, and the order is functionally irrelevant.

The `is_display_edition DESC` and `tier DESC` keys stay ahead of the priority key in every
ORDER BY, so per-game display overrides and better-edition tiers are unaffected.

### Data flow (after)

`GET /api/games` → `resolveCacheLauncher(db, gameId)` orders by
`is_display_edition DESC, EFFECTIVE_PRIORITY ASC, CANONICAL ASC, tier DESC, id ASC` →
returns the top launcher → `cache_launcher_name` → frontend `launcherToPlatform` →
Steam/Epic cache badge, else manual Downloaded/Not-downloaded badge. Unchanged frontend.

## Error handling / edge cases

- **All launchers unranked (priority 0):** every launcher → 999, so `CANONICAL_ORDER_SQL`
  governs (Steam>Epic>…>Amazon) — the sensible default.
- **Explicit Epic-over-Steam** (`launchers.priority` epic < steam, or per-game
  `is_prefill_edition`): still honored — those keys are unchanged / earlier.
- **`is_display_edition` set on a manual edition:** still wins (it's the first ORDER BY
  key) — an intentional override is preserved.
- **Ungrouped single edition (gameId null):** `resolveCacheLauncher` returns null (unchanged);
  the frontend falls back to the edition's own launcher. Not affected.

## Testing (TDD, node:test)

Extend `backend/tests/services/cacheLauncher.test.js`:
- game owned on steam(priority 1) + amazon(priority 0) → resolves to **steam** (regression
  for the exact bug; today it returns amazon).
- amazon-only game → resolves to **amazon** (manual badge still shows for manual-only).
- `is_display_edition = 1` on the amazon edition of a steam+amazon game → resolves to
  **amazon** (override precedence intact).
- explicit rank epic(priority 1) + steam(priority 2) → resolves to **epic** (explicit
  ranking still wins).
- all-zero priorities (steam+epic+amazon all 0) → resolves to **steam** (canonical governs).

A lighter `routes/games.js` assertion (a steam+amazon fixture returns `cache_launcher_name:
'steam'`) is optional if the route test harness makes it cheap; the resolver unit tests are
the load-bearing coverage.

## Rollout

Single backend PR. Deploy: `.102` `git reset --hard origin/master && docker compose up -d
--build backend`. Live-verify: the 220 manual+lancache games now resolve to their lancache
launcher (spot-check Psychonauts → steam); Amazon-only games still show Amazon Downloaded.
Karl merges the PR.
