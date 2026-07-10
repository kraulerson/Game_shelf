# Manual-Download Coverage: Amazon + Humble + Itch.io — Design Spec

**Date:** 2026-07-10
**Issue:** #222 (extension beyond GOG)
**Repos:** `Game_shelf` (primary) + `lancache_orchestrator` (small agent/API change)
**Status:** Approved direction (Karl); pending spec review.

---

## Problem

Game_shelf surfaces a "Downloaded / Not-downloaded" badge + filter for manually-downloaded
GOG games (#222, PR #20). Karl has now hand-downloaded his **Amazon**, **Humble Bundle**, and
**Itch.io** libraries to the lancache host, but Game_shelf only checks GOG, so those games show
no download status.

The manual-coverage pipeline already exists and is mostly launcher-agnostic:

```
Game_shelf routes  →  manualCoverageSnapshot (60s TTL)
                   →  orchestrator  GET /api/v1/manual-downloads/{launcher}
                   →  agent         GET /v1/manual-downloads/{launcher}   (lists <cache>/<launcher>/)
                   →  manualCoverage matcher (slug/title diff vs owned library)
                   →  download_status per game  →  badge + filter (frontend, already generic)
```

Extending it to three more launchers is **wiring + two structural fixes**, not new architecture.

## Ground truth (live scan of the lancache host, 2026-07-10)

Folders live under the agent's cache root `<manual_downloads_cache_path>/<Launcher>/`:

Owned = library editions on that launcher linked to a game row (what the matcher diffs against);
the raw enabled-launcher edition counts are higher (Amazon 509, Humble 162) — the difference is
editions not yet matched to a game.

| Launcher folder on disk | Layout | On disk | Owned (linked) | Naive match today |
|---|---|---|---|---|
| `GOG` | dir-per-game | 262 | 256 | working (PR #20) |
| `Amazon Games` | **dir-per-game**, clean titles | 384 | 483 | **370 / 384 = 96%** with the existing matcher, zero changes |
| `Humble Bundle` | **loose installer files** (`.exe`/`.zip`), version-mangled | 18 | 130 | 9 / 18 |
| `Itch.io` | **loose archive files** (`.zip`/`.exe`) | 24 | 26 | 13 / 24 |

Two structural blockers found on disk (invisible from code review):

1. **Folder names contain spaces / dots** — `Amazon Games`, `Humble Bundle`, `Itch.io`. Both the
   control-plane and agent endpoints guard the launcher path component with
   `^[A-Za-z0-9_-]+$`, which **rejects all three** with `400 invalid launcher`. GOG works only
   because its folder is literally `GOG`.
2. **Humble/Itch entries are files, not directories** — the agent lists directories only
   (`if e.is_dir()`), so file-based launchers return `entries: []`.

## Goals / Non-goals

**Goals**
- Amazon, Humble, and Itch owned games show the same Downloaded / Not-downloaded badge + filter as GOG.
- Scan the launcher folders **as they exist today** (Amazon dirs; Humble/Itch loose files) — no
  requirement for Karl to reorganize downloads.
- Reach ~full coverage: high-confidence auto-matching + a small hand-seeded alias map for the
  opaque stragglers.
- Zero regression to the GOG and Amazon (dir) matching paths.

**Non-goals**
- No schema change / migration (matching is by title/slug against the existing owned library).
- No frontend change (badge + filter are already launcher-agnostic).
- No new lancache prefill/caching for these launchers — they are download-only.
- Not chasing 100% auto-match on inherently-opaque filenames (`hf-build-1.005.zip`); those are
  resolved by the alias map, and anything genuinely unmatched is surfaced (not hidden).

---

## Design

### Part A — Orchestrator (small, unblocks everything)

Two changes, mirrored in the agent router and the control-plane proxy.

**A1. Widen the launcher-name guard.**
`^[A-Za-z0-9_-]+$` → `^[A-Za-z0-9 ._-]+$` in **both**:
- `src/orchestrator/agent/routers/manual_downloads.py`
- `src/orchestrator/api/routers/manual_downloads.py`

Path traversal remains impossible:
- No `/` is allowed, so no multi-segment traversal.
- `.` is allowed but the existing **resolve-under-root guard** (`target.parent != root` after
  `.resolve()`) rejects `.` and `..` — `(root / "..").resolve().parent != root`. Belt-and-suspenders
  already present; this just stops rejecting legitimate `Itch.io`.

**A2. Add `include_files` (default `false`).**
- Agent router: `include_files: bool = False` query param. When `True`, `entries` also includes
  regular files (still skipping names starting with `!` or `.`). When `False` (default), behavior
  is **byte-identical to today** (dirs only) — protects GOG/Amazon.
  ```python
  entries = sorted(
      e.name for e in target.iterdir()
      if (e.is_dir() or (include_files and e.is_file()))
      and not e.name.startswith(("!", "."))
  )
  ```
- Control-plane router: accept `include_files: bool = False`, forward it to the client.
- `src/orchestrator/clients/agent_client.py::manual_downloads(launcher, include_files=False)`:
  URL-encode the launcher and pass the query:
  ```python
  from urllib.parse import quote
  path = f"/v1/manual-downloads/{quote(launcher, safe='')}"
  if include_files:
      path += "?include_files=true"
  ```
  (The raw `f"/v1/manual-downloads/{launcher}"` would send an un-encoded space; `quote()` fixes it.)

**Orchestrator is a separate PR, deployed first** (control-plane only for the regex; agent for
`include_files`). Amazon (dir mode) needs only A1; Humble/Itch need A1 + A2.

### Part B — Game_shelf: manual-launcher registry

New module `backend/src/services/manualLaunchers.js`:

```js
// The manual-download launchers Game_shelf checks against the lancache host, in
// display/priority order. `folder` is the on-disk folder name the orchestrator lists;
// `mode` selects dir-scan (folder-per-game) vs file-scan (loose installers).
const MANUAL_LAUNCHERS = [
  { name: 'gog',    folder: 'GOG',           mode: 'dir'  },
  { name: 'amazon', folder: 'Amazon Games',  mode: 'dir'  },
  { name: 'humble', folder: 'Humble Bundle', mode: 'file' },
  { name: 'itchio', folder: 'Itch.io',       mode: 'file' },
];
```

`mode` drives two things: whether to request `include_files` from the orchestrator, and whether the
matcher applies filename normalization. `dir` launchers keep the exact path they use today.

### Part C — Game_shelf: filename normalizer (file mode only)

`manualCoverage.js` gains `normalizeFileEntry(name)`, applied **only** to `mode: 'file'` launcher
entries. Dir launchers (GOG/Amazon) continue through the existing `folderSlugForms` /
`folderRawForms` path unchanged — Amazon's 96% and GOG's exact-match stay intact.

Ordered transform (each rule derived from a real unmatched case in the live scan):

1. Strip extension: `.(exe|zip|rar|7z|msi|bin|sh|dmg|pkg|tar|gz|iso)$`.
2. Drop bracketed tags: `[(...)]`, `[...]` → space (`Dark Assault (Windows)` → `Dark Assault`).
3. Strip embedded dates `YYYY[-_.]MM[-_.]DD` → space (`TokiTori_2013-07-03_...`).
4. Split a glued letter→version: `([A-Za-z])(v?\d+(?:[._]\d+)+)` → `$1 $2` (`Movesv1.3.0` → `Moves v1.3.0`).
5. camelCase split, **lowercase→Upper only** so `2D`/`3D`/`Cub3D` survive:
   `([a-z])([A-Z])` → `$1 $2`, then `([A-Z]+)([A-Z][a-z])` → `$1 $2`
   (`AndYetItMoves` → `And Yet It Moves`; `TreasureHunter` → `Treasure Hunter`).
6. Separators `[_-]+` → space.
7. Strip version tokens (allow trailing letter): `\bv?\d+(?:[._]\d+)+[a-z]?\b` and `\bv\d+\b` → space
   (`0.3.5b`, `v2`).
8. Strip long ids: `\b\d{5,}\b` → space (build/date epochs).
9. Strip platform/build words (whole-word): `windows|win64|win32|win|pc|osx|macos|mac|linux|x64|x86|64bit|32bit|64|32|setup|installer|install|release|build|final|full|std|en|eng|remaster|classic` → space.
10. `slugify()` the residual (reuses the deployed normalizer: lowercases, strips punctuation, dashes).

**Match precedence** for every launcher (extends the current two-tier matcher):
1. **Alias map** (Part D) — exact folder/file name → game slug. Highest precedence.
2. **Launcher exact slug** — GOG's `gog_slug` (unchanged; other launchers have none).
3. **Fuzzy forms** — the owned game's candidate forms (`slug`, `slugify(title)`, `slugify(edition_title)`,
   **and `slugify(simplifyTitle(title))`** so a subtitle-less file like `Lone Survivor` hits the
   owned `Lone Survivor: The Director's Cut`) vs. the entry's normalized form(s). Dir entries use
   `folderSlugForms`; file entries use `normalizeFileEntry`.

Expected coverage after tuning: Humble ~14/18 auto, Itch ~18/24 auto; the rest via aliases.

### Part D — Game_shelf: alias map for opaque stragglers

New data module `backend/src/services/manualDownloadAliases.js`:

```js
// Exact on-disk entry name -> game slug, for downloads whose filename can't be
// auto-normalized to the owned title (abbreviations, opaque build names, accented
// titles that mangle). The slug MUST exist in that launcher's owned set
// (ownedGamesForLauncher) — verified below against the live library.
module.exports = {
  humble: {
    'atomzombiesmasher-10172016.zip': 'atom-zombie-smasher',
    'neoaquarium_en_setup104.zip': 'neo-aquarium-the-king-of-crustaceans',
    'steelstorm-br-2.00.02818-release.exe': 'steel-storm-burning-retribution',
    'hf-build-1.005.zip': 'hammerfight', // HF=Hammerfight — confirm bundle contents at impl
  },
  itchio: {
    'Stellaxy.zip': 'stellaxy-classic',
    'Totem 1.06.zip': 'ttem', // owned "Tôtem" — accent stripped by slugify to "ttem"
    'VirtuaWorlds_CthulhuFrozenNightmare.zip': 'cthulhu-frozen-nightmare',
    'anodyne-windowsremasterandclassic.zip': 'anodyne',
    'rumble_v1.0.0_win64.zip': 'rumble-in-the-midwest',
  },
};
```

Seeds above are verified against the live owned sets (2026-07-10). The matcher consults
`aliases[launcher][entryName]` first. Each alias slug is membership-checked against
`ownedGamesForLauncher(db, launcher)` at implementation; any that don't resolve are dropped and
reported as extra, not force-fit. Genuinely-extra downloads with **no** owned edition
(`Welcome v2.0.2 WINDOW.zip` [Humble], `DitV-Windows.zip`, `SHARECART1000.zip`,
`Cub3D - A Perspective Shifting Puzzle RPG.zip` [Itch]) stay unmatched and surface in
`extra_folders` — correctly, not aliased to a different game.

### Part E — Game_shelf: generalize the consumers

**`manualCoverageSnapshot.js`** — `get(launcher, { includeFiles = false } = {})`; append
`?include_files=true` when set; cache-key by `${launcher}|${includeFiles ? 1 : 0}`. Backward
compatible (existing `get('GOG')` unchanged).

**`manualCoverage.js`** — `matchGames`/`computeDownloadedIds`/`downloadedGameIds`/`computeManualCoverage`
take an options bag `{ mode = 'dir', aliases = {} }` so a file-mode launcher normalizes entries and
consults aliases. `fetchManualCoverage(db, launcherFolder)` resolves the registry entry for that
folder (mode + include_files + aliases) and threads it through. Signatures stay backward-compatible
by defaulting to dir mode.

**`routes/games.js`** — replace the GOG-hardcoded blocks (`hasGog`, single `getManualDownloadsSnapshot('GOG')`,
`gogGameIds`) with a loop over `MANUAL_LAUNCHERS`:
- `downloadedIds` = **union** of `downloadedGameIds(db, name, entries, { mode, aliases })` across the registry.
- `manualGameIds` = union of `game_id`s that have an owned edition on **any** registered manual launcher.
- Per-game `download_status`: `'downloaded'` if in `downloadedIds`, else `'not_downloaded'` if in
  `manualGameIds`, else `null`. (Shape unchanged — frontend already consumes it.)
- Download-status **filter facet**: same union; the `_manual_downloaded` temp table is filled from
  the union set; the `not_downloaded` predicate targets "has an edition on any manual launcher AND
  not in `_manual_downloaded`".

**`routes/cache.js`** — the `GET /manual-coverage/:launcher` report route already takes a launcher
param; it now works for `Amazon Games`/`Humble Bundle`/`Itch.io` (URL-encoded) via `fetchManualCoverage`,
which resolves mode/aliases from the registry.

### Part F — Frontend

**No change.** `manualDownloadBadge(download_status)`, `CacheBadge`'s `badge` prop, `GameCard`'s
"non-lancache platform → manual badge" branch, and the `FilterPanel` Download-status facet are all
launcher-agnostic and consume the same `download_status` field. A game owned on multiple manual
launchers reads `downloaded` if any launcher has it (union) — the intended behavior.

---

## Data flow (after)

```
GET /api/games
  → for each { name, folder, mode } in MANUAL_LAUNCHERS:
        snapshot.get(folder, { includeFiles: mode === 'file' })
          → orchestrator GET /api/v1/manual-downloads/<folder>?include_files=<mode==='file'>
          → agent lists <cache>/<folder>/ (dirs, +files if include_files)
        downloadedGameIds(db, name, entries, { mode, aliases[name] })
  → union → download_status per game → badge + filter
```

## Error handling

- Orchestrator/agent offline: snapshot serves last-good (`stale`) or `{present:false,entries:[]}` →
  games surface `not_downloaded`/`null`, never a 500 (unchanged behavior).
- Invalid launcher (shouldn't happen — registry is fixed): 400 from the endpoint; caught by cache
  route as 503-style, and the games route treats an errored launcher as "no entries" (best-effort
  union, one bad launcher can't blank the others).
- Files vs dirs: `include_files=false` guarantees no behavior drift for GOG/Amazon.

## Testing (TDD, test-first)

**Orchestrator (pytest):**
- `manual_downloads` agent + api: `_LAUNCHER_RE` accepts `Amazon Games`, `Itch.io`, `Humble Bundle`;
  rejects `..`, `a/b`, empty.
- Traversal guard: `launcher=".."` / `"."` → 400 (resolve-under-root).
- `include_files=true` lists files; default lists dirs only (regression lock on GOG/Amazon shape).
- `agent_client.manual_downloads` URL-encodes the launcher and appends the query.

**Game_shelf (node:test / vitest):**
- `normalizeFileEntry` table test over the **exact live filenames** (18 Humble + 24 Itch) → expected
  slugs (locks the ordered rules; e.g. `AndYetItMovesv1.3.0Setup.exe` → `and-yet-it-moves`,
  `Cub3D - A Perspective Shifting Puzzle RPG.zip` → `cub3d-a-perspective-shifting-puzzle-rpg`,
  `TokiTori_2013-07-03_Windows_1372878397.zip` → `toki-tori`).
- Alias precedence: an aliased filename matches even when normalization wouldn't.
- `simplifyTitle` form: `Lone Survivor` file matches owned `Lone Survivor: The Director's Cut`.
- Dir-mode regression: Amazon folder set still yields the same matches (no normalization applied).
- Union across launchers: a game owned on humble+gog shows `downloaded` if either has it.
- `routes/games.js`: `download_status` + filter facet correct for amazon/humble/itch fixtures.

**Live verification (post-deploy):**
- `GET /api/v1/manual-downloads/Amazon%20Games` → 200 with 384 entries.
- Coverage report per launcher: Amazon present ≈ 370, Humble/Itch present ≈ auto+aliases.
- Amazon-only owned game shows "Downloaded"; download-status filter returns the expected sets.

## Rollout

1. **Orchestrator PR** (regex widen + `include_files` + agent_client encode). Deploy control-plane
   (regex) + agent (include_files) — agent RECREATE for the router change. No 2FA.
2. **Game_shelf PR** (registry + normalizer + aliases + snapshot/route generalization). Deploy .102.
3. Seed the alias map from the live `extra_folders` report, re-deploy, verify coverage.

Karl merges both PRs (never `gh pr merge`).
