# Manual-Coverage: Amazon + Humble + Itch (Game_shelf) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Downloaded / Not-downloaded status + filter for Amazon, Humble, and Itch.io games (like GOG), scanning per-game folders (Amazon) and loose installer files (Humble/Itch) on the lancache host.

**Architecture:** A small manual-launcher **registry** replaces GOG hardcoding. Dir launchers (GOG/Amazon) keep the exact current matcher. File launchers (Humble/Itch) request `?include_files=true` and pass their entries through a new `normalizeFileEntry` (extension/version/platform strip + camelCase split) plus a hand-seeded **alias map** for opaque names. `routes/games.js` and `routes/cache.js` compute download-status as the **union** over the registry via one shared helper. Frontend is unchanged (already launcher-agnostic).

**Tech Stack:** Node ESM (CommonJS `require`), better-sqlite3, `node:test` + `node:assert/strict`. Backend tests: `cd backend && node --test 'tests/**/*.test.js'`; single file `node --test tests/services/<f>.test.js`. Game_shelf has NO framework hooks.

## Global Constraints

- Registry (verbatim, order = display order): `[{name:'gog',folder:'GOG',mode:'dir'},{name:'amazon',folder:'Amazon Games',mode:'dir'},{name:'humble',folder:'Humble Bundle',mode:'file'},{name:'itchio',folder:'Itch.io',mode:'file'}]`.
- Dir-mode launchers MUST keep byte-identical matching — do not route them through `normalizeFileEntry`.
- Alias seeds (verbatim, from the spec) — humble: `atomzombiesmasher-10172016.zip`→`atom-zombie-smasher`, `neoaquarium_en_setup104.zip`→`neo-aquarium-the-king-of-crustaceans`, `steelstorm-br-2.00.02818-release.exe`→`steel-storm-burning-retribution`, `hf-build-1.005.zip`→`hammerfight`; itchio: `Stellaxy.zip`→`stellaxy-classic`, `Totem 1.06.zip`→`ttem`, `VirtuaWorlds_CthulhuFrozenNightmare.zip`→`cthulhu-frozen-nightmare`, `anodyne-windowsremasterandclassic.zip`→`anodyne`, `rumble_v1.0.0_win64.zip`→`rumble-in-the-midwest`.
- Alias slug must exist in `ownedGamesForLauncher(db, launcher)`; matcher enforces this by only marking a game present when the game's own slug equals the alias slug.
- `download_status` values unchanged: `'downloaded'` | `'not_downloaded'` | `null`. No schema/migration. No frontend change.

---

### Task 1: Manual-launcher registry module

**Files:**
- Create: `backend/src/services/manualLaunchers.js`
- Test: `backend/tests/services/manualLaunchers.test.js`

**Interfaces:**
- Produces: `MANUAL_LAUNCHERS` (array of `{name, folder, mode}`), `manualLauncherByFolder(folder)` → registry entry or `undefined` (case-insensitive on folder).

- [ ] **Step 1: Write failing test**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MANUAL_LAUNCHERS, manualLauncherByFolder } = require('../../src/services/manualLaunchers');

describe('manualLaunchers registry', () => {
  it('lists gog, amazon, humble, itchio with correct modes', () => {
    assert.deepEqual(MANUAL_LAUNCHERS.map((l) => [l.name, l.folder, l.mode]), [
      ['gog', 'GOG', 'dir'],
      ['amazon', 'Amazon Games', 'dir'],
      ['humble', 'Humble Bundle', 'file'],
      ['itchio', 'Itch.io', 'file'],
    ]);
  });
  it('resolves a folder name to its entry (case-insensitive)', () => {
    assert.equal(manualLauncherByFolder('Amazon Games').name, 'amazon');
    assert.equal(manualLauncherByFolder('itch.io').name, 'itchio');
    assert.equal(manualLauncherByFolder('Nope'), undefined);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd backend && node --test tests/services/manualLaunchers.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** `backend/src/services/manualLaunchers.js`

```js
// The manual-download launchers Game_shelf checks against the lancache host, in
// display order. `folder` is the on-disk folder the orchestrator lists; `mode`
// selects dir-scan (folder-per-game: GOG, Amazon) vs file-scan (loose installers:
// Humble, Itch — needs ?include_files=true + filename normalization). (#222)
const MANUAL_LAUNCHERS = [
  { name: 'gog', folder: 'GOG', mode: 'dir' },
  { name: 'amazon', folder: 'Amazon Games', mode: 'dir' },
  { name: 'humble', folder: 'Humble Bundle', mode: 'file' },
  { name: 'itchio', folder: 'Itch.io', mode: 'file' },
];

function manualLauncherByFolder(folder) {
  const f = String(folder).toLowerCase();
  return MANUAL_LAUNCHERS.find((l) => l.folder.toLowerCase() === f);
}

module.exports = { MANUAL_LAUNCHERS, manualLauncherByFolder };
```

- [ ] **Step 4: Run to verify pass** — same command → PASS.

---

### Task 2: `normalizeFileEntry` — loose-filename → slug

**Files:**
- Modify: `backend/src/services/manualCoverage.js` (add function + export)
- Test: `backend/tests/services/manualCoverage.test.js` (append a describe block)

**Interfaces:**
- Consumes: `slugify` (already imported from `./metadata/titleMatcher`).
- Produces: `normalizeFileEntry(name: string): string` — a slug.

- [ ] **Step 1: Write failing table test** (append to `manualCoverage.test.js`)

```js
describe('manualCoverage.normalizeFileEntry (file-mode)', () => {
  const { normalizeFileEntry } = require('../../src/services/manualCoverage');
  const cases = [
    ['AndYetItMovesv1.3.0Setup.exe', 'and-yet-it-moves'],
    ['LoneSurvivor-PC.zip', 'lone-survivor'],
    ['TokiTori_2013-07-03_Windows_1372878397.zip', 'toki-tori'],
    ['voxatron_0.3.5b_setup.exe', 'voxatron'],
    ['2D TreasureHunter.zip', '2d-treasure-hunter'],
    ['Cub3D - A Perspective Shifting Puzzle RPG.zip', 'cub3d-a-perspective-shifting-puzzle-rpg'],
    ['fumiko-windows-64.zip', 'fumiko'],
    ['frisbros-window-64.zip', 'frisbros'],
    ['BladesAdrift.zip', 'blades-adrift'],
    ['Annulus 2.31.zip', 'annulus'],
    ['rumble_v1.0.0_win64.zip', 'rumble'],
    ['Totem 1.06.zip', 'totem'],
  ];
  for (const [input, expected] of cases) {
    it(`normalizes ${input} -> ${expected}`, () => {
      assert.equal(normalizeFileEntry(input), expected);
    });
  }
});
```

- [ ] **Step 2: Run to verify fail** — `node --test tests/services/manualCoverage.test.js` → FAIL (function undefined).

- [ ] **Step 3: Implement** — in `backend/src/services/manualCoverage.js`, after the `folderRawForms` definition add:

```js
// Loose-file launchers (Humble/Itch) store installer/archive FILES, not per-game
// folders: `AndYetItMovesv1.3.0Setup.exe`, `Totem 1.06.zip`. Normalize a filename
// down to a title slug by stripping extension/version/platform noise and splitting
// camelCase. Ordered — each rule fixes a real observed filename (#222).
const _EXT = /\.(exe|zip|rar|7z|msi|bin|sh|dmg|pkg|tar|gz|iso)$/i;
const _BRACKET = /[([{][^)\]}]*[)\]}]/g;
const _DATE = /\b\d{4}[-_.]\d{2}[-_.]\d{2}\b/g;
const _GLUED_VER = /([A-Za-z])(v?\d+(?:[._]\d+)+)/g; // Movesv1.3.0 -> Moves v1.3.0
const _CAMEL1 = /([a-z])([A-Z])/g; // lowercase->Upper ONLY (keeps 2D / Cub3D)
const _CAMEL2 = /([A-Z]+)([A-Z][a-z])/g; // HTTPServer -> HTTP Server
const _SEP = /[_-]+/g;
const _VER = /v?\d+(?:[._]\d+)+[a-z]?/gi; // dotted version incl trailing letter (0.3.5b)
const _VER2 = /\bv\d+\b/gi; // v2
const _LONGID = /\b\d{5,}\b/g; // build/epoch ids
const _PLATFORM =
  /\b(?:windows?|win64|win32|win|pc|osx|macos|mac|linux|x64|x86|64bit|32bit|64|32|setup|installer|install|release|build|final|full|std|en|eng|remaster|classic)\b/gi;

function normalizeFileEntry(name) {
  let s = String(name).replace(_EXT, '');
  s = s.replace(_BRACKET, ' ');
  s = s.replace(_DATE, ' ');
  s = s.replace(_GLUED_VER, '$1 $2');
  s = s.replace(_CAMEL1, '$1 $2').replace(_CAMEL2, '$1 $2');
  s = s.replace(_SEP, ' ');
  s = s.replace(_VER, ' ').replace(_VER2, ' ');
  s = s.replace(_LONGID, ' ');
  s = s.replace(_PLATFORM, ' ');
  return slugify(s);
}
```
Add `normalizeFileEntry` to `module.exports`.

- [ ] **Step 4: Run to verify pass** — same command → PASS (all 12 cases). If any case is off by a rule ordering, adjust the ordering (do NOT special-case a single filename).

- [ ] **Step 5: Commit** (Tasks 1–2 together)
```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf"
git add backend/src/services/manualLaunchers.js backend/src/services/manualCoverage.js backend/tests/services/manualLaunchers.test.js backend/tests/services/manualCoverage.test.js
git commit -m "feat(#222): manual-launcher registry + normalizeFileEntry"
```

---

### Task 3: Alias map module

**Files:**
- Create: `backend/src/services/manualDownloadAliases.js`
- Test: `backend/tests/services/manualDownloadAliases.test.js`

**Interfaces:**
- Produces: `ALIASES` — `{ [launcher]: { [exactEntryName]: gameSlug } }`; `aliasesFor(launcher)` → the per-launcher map (or `{}`).

- [ ] **Step 1: Write failing test**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ALIASES, aliasesFor } = require('../../src/services/manualDownloadAliases');

describe('manualDownloadAliases', () => {
  it('maps opaque humble/itch filenames to owned slugs', () => {
    assert.equal(ALIASES.humble['steelstorm-br-2.00.02818-release.exe'], 'steel-storm-burning-retribution');
    assert.equal(ALIASES.itchio['Totem 1.06.zip'], 'ttem');
  });
  it('aliasesFor returns {} for a launcher with no aliases', () => {
    assert.deepEqual(aliasesFor('gog'), {});
  });
});
```

- [ ] **Step 2: Run to verify fail** → FAIL (module missing).

- [ ] **Step 3: Implement** `backend/src/services/manualDownloadAliases.js`

```js
// Exact on-disk entry name -> game slug, for downloads whose filename can't be
// auto-normalized to the owned title (abbreviations, opaque builds, accent-mangled
// titles). Each slug is verified against the live owned set at match time; a slug
// that isn't owned on that launcher simply never matches. (#222)
const ALIASES = {
  humble: {
    'atomzombiesmasher-10172016.zip': 'atom-zombie-smasher',
    'neoaquarium_en_setup104.zip': 'neo-aquarium-the-king-of-crustaceans',
    'steelstorm-br-2.00.02818-release.exe': 'steel-storm-burning-retribution',
    'hf-build-1.005.zip': 'hammerfight', // HF=Hammerfight — confirm live before shipping
  },
  itchio: {
    'Stellaxy.zip': 'stellaxy-classic',
    'Totem 1.06.zip': 'ttem', // owned "Tôtem" — accent stripped to "ttem"
    'VirtuaWorlds_CthulhuFrozenNightmare.zip': 'cthulhu-frozen-nightmare',
    'anodyne-windowsremasterandclassic.zip': 'anodyne',
    'rumble_v1.0.0_win64.zip': 'rumble-in-the-midwest',
  },
};

function aliasesFor(launcher) {
  return ALIASES[launcher] || {};
}

module.exports = { ALIASES, aliasesFor };
```

- [ ] **Step 4: Run to verify pass** → PASS.

---

### Task 4: Matcher — file mode + alias precedence + simplifyTitle form

**Files:**
- Modify: `backend/src/services/manualCoverage.js` (`matchGames`, `computeManualCoverage`, `computeDownloadedIds`, `downloadedGameIds`)
- Test: `backend/tests/services/manualCoverage.test.js` (append)

**Interfaces:**
- Consumes: `normalizeFileEntry` (Task 2); `simplifyTitle` from `./metadata/titleMatcher`.
- Produces (backward-compatible — new optional opts default to dir/no-alias):
  - `matchGames(games, entries, { mode = 'dir', aliases = {} } = {})`
  - `computeDownloadedIds(games, entries, opts = {})`
  - `downloadedGameIds(db, launcherName, entries, opts = {})`
  - `computeManualCoverage(games, entries, opts = {})`

- [ ] **Step 1: Write failing tests**

```js
describe('manualCoverage file-mode + aliases + simplifyTitle', () => {
  const { computeDownloadedIds, computeManualCoverage } = require('../../src/services/manualCoverage');

  it('file-mode matches a normalized filename to an owned title', () => {
    const games = [{ id: 1, title: 'Toki Tori', slug: 'toki-tori' }];
    const ids = computeDownloadedIds(games, ['TokiTori_2013-07-03_Windows_1372878397.zip'], { mode: 'file' });
    assert.ok(ids.has(1));
  });

  it('file-mode matches a subtitle-less filename via simplifyTitle', () => {
    const games = [{ id: 2, title: "Lone Survivor: The Director's Cut", slug: 'lone-survivor-the-directors-cut' }];
    const ids = computeDownloadedIds(games, ['LoneSurvivor-PC.zip'], { mode: 'file' });
    assert.ok(ids.has(2));
  });

  it('alias covers an opaque filename (game present only if its slug === alias slug)', () => {
    const games = [
      { id: 3, title: 'Steel Storm: Burning Retribution', slug: 'steel-storm-burning-retribution' },
      { id: 4, title: 'Unrelated', slug: 'unrelated' },
    ];
    const opts = { mode: 'file', aliases: { 'steelstorm-br-2.00.02818-release.exe': 'steel-storm-burning-retribution' } };
    const ids = computeDownloadedIds(games, ['steelstorm-br-2.00.02818-release.exe'], opts);
    assert.deepEqual([...ids], [3]);
  });

  it('an alias entry that matches a game is NOT reported as extra', () => {
    const games = [{ id: 3, title: 'Steel Storm: Burning Retribution', slug: 'steel-storm-burning-retribution' }];
    const opts = { mode: 'file', aliases: { 'steelstorm-br-2.00.02818-release.exe': 'steel-storm-burning-retribution' } };
    const r = computeManualCoverage(games, ['steelstorm-br-2.00.02818-release.exe'], opts);
    assert.equal(r.present, 1);
    assert.deepEqual(r.extra_folders, []);
  });

  it('an unmatched file is reported as extra_folders (original name)', () => {
    const games = [{ id: 1, title: 'Toki Tori', slug: 'toki-tori' }];
    const r = computeManualCoverage(games, ['DitV-Windows.zip'], { mode: 'file' });
    assert.deepEqual(r.extra_folders, ['DitV-Windows.zip']);
  });
});
```

- [ ] **Step 2: Run to verify fail** → FAIL (signatures don't accept opts / no file mode).

- [ ] **Step 3: Implement** — edit `backend/src/services/manualCoverage.js`.

Change the import line to also pull `simplifyTitle`:
```js
const { slugify, simplifyTitle } = require('./metadata/titleMatcher');
```
Replace `matchGames` with an opts-aware version (dir path unchanged; file path uses `normalizeFileEntry`; alias pre-check):
```js
function entryForms(name, mode) {
  return mode === 'file' ? [normalizeFileEntry(name)] : folderSlugForms(name);
}

function matchGames(games, entries, { mode = 'dir', aliases = {} } = {}) {
  const list = (entries || []).map((name) => ({
    name,
    forms: entryForms(name, mode),
    raw: mode === 'file' ? [] : folderRawForms(name),
    aliasSlug: aliases[name] ? String(aliases[name]).toLowerCase() : null,
  }));
  const allForms = new Set(list.flatMap((f) => f.forms));
  const rawForms = new Set(list.flatMap((f) => f.raw));
  const aliasSlugs = new Set(list.map((f) => f.aliasSlug).filter(Boolean));
  const presentIds = new Set();
  const usedForms = new Set();
  const usedAliasSlugs = new Set();
  for (const g of games) {
    let matched = false;
    const gslug = g.slug ? String(g.slug).toLowerCase() : null;
    // 1. alias: an on-disk entry explicitly maps to this game's slug
    if (gslug && aliasSlugs.has(gslug)) {
      matched = true;
      usedAliasSlugs.add(gslug);
    }
    // 2. GOG raw-slug exact match (dir mode only in practice)
    if (!matched && g.gog_slug) {
      const gs = String(g.gog_slug).toLowerCase();
      if (rawForms.has(gs)) {
        matched = true;
        usedForms.add(gs);
      }
    }
    // 3. fuzzy: slug / title / edition_title / subtitle-stripped title
    if (!matched) {
      const cands = [g.slug, g.title, g.edition_title, g.title ? simplifyTitle(g.title) : null]
        .filter(Boolean)
        .map((c) => (c === g.slug ? c : slugify(c)));
      const hit = cands.find((s) => allForms.has(s));
      if (hit) {
        matched = true;
        usedForms.add(hit);
      }
    }
    if (matched) presentIds.add(g.id);
  }
  return { presentIds, usedForms, usedAliasSlugs, folders: list };
}
```
Update the pure/db wrappers to thread opts:
```js
function computeDownloadedIds(games, entries, opts = {}) {
  return matchGames(games, entries, opts).presentIds;
}

function downloadedGameIds(db, launcherName, entries, opts = {}) {
  return computeDownloadedIds(ownedGamesForLauncher(db, launcherName), entries, opts);
}
```
Update `computeManualCoverage` extra_folders to treat alias-consumed entries as used:
```js
function computeManualCoverage(games, entries, opts = {}) {
  const { presentIds, usedForms, usedAliasSlugs, folders } = matchGames(games, entries, opts);
  const missing = games
    .filter((g) => !presentIds.has(g.id))
    .map((g) => ({ id: g.id, title: g.title, slug: g.slug }));
  const extra_folders = folders
    .filter((f) => {
      const formsUsed = f.forms.some((s) => usedForms.has(s)) || f.raw.some((s) => usedForms.has(s));
      const aliasUsed = f.aliasSlug && usedAliasSlugs.has(f.aliasSlug);
      return !formsUsed && !aliasUsed;
    })
    .map((f) => f.name);
  return { total_owned: games.length, present: presentIds.size, missing, extra_folders };
}
```

- [ ] **Step 4: Run to verify pass** — `node --test tests/services/manualCoverage.test.js` → PASS **including all pre-existing dir-mode tests** (they call the 2-arg form, which now defaults `opts={}`/`mode='dir'`). If `simplifyTitle` isn't exported by `titleMatcher.js`, add it to that module's exports (it's an existing internal function).

- [ ] **Step 5: Commit**
```bash
git add backend/src/services/manualCoverage.js backend/src/services/manualDownloadAliases.js backend/tests/services/manualCoverage.test.js backend/tests/services/manualDownloadAliases.test.js
git commit -m "feat(#222): matcher file-mode + alias precedence + simplifyTitle form"
```

---

### Task 5: Snapshot include_files + registry-resolved `fetchManualCoverage` + cache route

**Files:**
- Modify: `backend/src/services/manualCoverageSnapshot.js` (`get`)
- Modify: `backend/src/services/manualCoverage.js` (`fetchManualCoverage`)
- Test: `backend/tests/services/manualCoverageSnapshot.test.js`, `backend/tests/services/manualCoverage.test.js`

**Interfaces:**
- Produces: `snapshot.get(launcher, { includeFiles = false } = {})` → `{present, entries, stale}`, appends `?include_files=true`, caches by `launcher|includeFiles`.
- `fetchManualCoverage(db, launcherFolder, {client})` resolves the registry entry by folder → uses `entry.name` for owned games, `entry.mode` + `aliasesFor(entry.name)` for matching, and requests `include_files` when `mode==='file'`.

- [ ] **Step 1: Write failing tests** — snapshot: a fake client records the requested path; assert `get('Itch.io', { includeFiles: true })` requests `/api/v1/manual-downloads/Itch.io?include_files=true` and caches separately from the no-files key. `fetchManualCoverage`: with a fake client returning file entries for `Humble Bundle`, an owned humble game whose filename normalizes to its slug is reported present. (Mirror the existing `manualCoverageSnapshot.test.js` fake-client style.)

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement**

`manualCoverageSnapshot.js` — change `get` signature + URL + cache key:
```js
async function get(launcher, { includeFiles = false } = {}) {
  const key = `${launcher}|${includeFiles ? 1 : 0}`;
  const cached = cache.get(key);
  if (cached && now() - cached.fetchedAt < ttlMs) {
    return { present: cached.present, entries: cached.entries, stale: false };
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const qs = includeFiles ? '?include_files=true' : '';
      const { status, data } = await client.callOrchestrator(
        'GET',
        `/api/v1/manual-downloads/${encodeURIComponent(launcher)}${qs}`
      );
      if (status !== 200) throw Object.assign(new Error('manual-downloads fetch failed'), { status });
      const entry = {
        present: Boolean(data.present),
        entries: Array.isArray(data.entries) ? data.entries : [],
        fetchedAt: now(),
      };
      cache.set(key, entry);
      return { present: entry.present, entries: entry.entries, stale: false };
    } catch {
      const last = cache.get(key);
      if (last) return { present: last.present, entries: last.entries, stale: true };
      return { present: false, entries: [], stale: true };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
```
Export `getManualDownloadsSnapshot: (launcher, opts) => defaultSnapshot.get(launcher, opts)`.

`manualCoverage.js` — require the registry + aliases at top:
```js
const { manualLauncherByFolder } = require('./manualLaunchers');
const { aliasesFor } = require('./manualDownloadAliases');
```
Rewrite `fetchManualCoverage`:
```js
async function fetchManualCoverage(db, launcherFolder, { client = orchestrator } = {}) {
  const reg = manualLauncherByFolder(launcherFolder);
  const name = reg ? reg.name : String(launcherFolder).toLowerCase();
  const mode = reg ? reg.mode : 'dir';
  const includeFiles = mode === 'file';
  const qs = includeFiles ? '?include_files=true' : '';
  const { status, data } = await client.callOrchestrator(
    'GET',
    `/api/v1/manual-downloads/${encodeURIComponent(launcherFolder)}${qs}`
  );
  if (status !== 200) {
    throw Object.assign(new Error('manual-downloads fetch failed'), { status, body: data });
  }
  const games = ownedGamesForLauncher(db, name);
  const report = computeManualCoverage(games, data.entries || [], { mode, aliases: aliasesFor(name) });
  return { launcher: launcherFolder, present_folder: Boolean(data.present), ...report };
}
```

- [ ] **Step 4: Run to verify pass** → PASS. `routes/cache.js` needs no change (it already calls `fetchManualCoverage(db, req.params.launcher)`; the registry lookup handles Amazon/Humble/Itch folder names).

- [ ] **Step 5: Commit**
```bash
git add backend/src/services/manualCoverageSnapshot.js backend/src/services/manualCoverage.js backend/tests/services/manualCoverageSnapshot.test.js backend/tests/services/manualCoverage.test.js
git commit -m "feat(#222): snapshot include_files + registry-resolved fetchManualCoverage"
```

---

### Task 6: `routes/games.js` — union download-status over the registry

**Files:**
- Modify: `backend/src/services/manualCoverage.js` (add `manualDownloadSets` helper + export)
- Modify: `backend/src/routes/games.js` (detail block ~92-98, list block ~509-532, per-row ~686-688)
- Test: `backend/tests/routes/games-manual-metadata.test.js` (or a new `games-manual-coverage.test.js`)

**Interfaces:**
- Produces: `async manualDownloadSets(db, getSnapshot)` → `{ downloadedIds: Set<number>, manualGameIds: Set<number> }` (union over `MANUAL_LAUNCHERS`).

- [ ] **Step 1: Write failing test** — seed a fixture DB with an amazon-owned game (folder match), a humble-owned game (file+normalizer match), an itch-owned game (alias match), and a steam-only game (no manual edition). Inject a fake snapshot returning the right entries per folder. Assert: `GET /api/games` returns `download_status: 'downloaded'` for the three manual games and `null` for the steam-only one; `GET /api/games?download_status=downloaded` returns exactly the three; `GET /api/games?download_status=not_downloaded` returns a manual-owned game with no matching entry. (Mirror the request-injection pattern already used in `games-manual-metadata.test.js`.)

- [ ] **Step 2: Run to verify fail** → FAIL (only GOG surfaced today).

- [ ] **Step 3: Implement**

Add the helper to `manualCoverage.js` (imports `MANUAL_LAUNCHERS`):
```js
// Union download-status sets over every manual launcher (#222). `getSnapshot` is
// manualCoverageSnapshot.getManualDownloadsSnapshot (folder, {includeFiles}).
async function manualDownloadSets(db, getSnapshot) {
  const downloadedIds = new Set();
  for (const { name, folder, mode } of MANUAL_LAUNCHERS) {
    const { entries } = await getSnapshot(folder, { includeFiles: mode === 'file' });
    const ids = downloadedGameIds(db, name, entries, { mode, aliases: aliasesFor(name) });
    for (const id of ids) downloadedIds.add(id);
  }
  const names = MANUAL_LAUNCHERS.map((l) => l.name);
  const manualGameIds = new Set(
    db
      .prepare(
        `SELECT DISTINCT ge.game_id AS id FROM game_editions ge
           JOIN launchers l ON l.id = ge.launcher_id
          WHERE l.name IN (${names.map(() => '?').join(',')}) AND ge.game_id IS NOT NULL`
      )
      .all(...names)
      .map((r) => r.id)
  );
  return { downloadedIds, manualGameIds };
}
```
Add `manualDownloadSets` and (already) `MANUAL_LAUNCHERS` names to exports. Require it in `games.js`:
```js
const { downloadedGameIds, manualDownloadSets } = require('../services/manualCoverage');
const { MANUAL_LAUNCHERS } = require('../services/manualLaunchers');
```
**Detail endpoint (~92-98):** replace the GOG-only block:
```js
  const { downloadedIds: dlIds, manualGameIds: mIds } = await manualDownloadSets(db, getManualDownloadsSnapshot);
  const download_status = mIds.has(Number(id))
    ? (dlIds.has(Number(id)) ? 'downloaded' : 'not_downloaded')
    : null;
```
**List endpoint (~509-514):** replace `gogFolders`/`downloadedIds`/`gogGameIds` with:
```js
  const { downloadedIds, manualGameIds } = await manualDownloadSets(db, getManualDownloadsSnapshot);
```
**Filter (~516-532):** fill the temp table from `downloadedIds` (unchanged), and generalize the `not_downloaded` predicate to any manual launcher:
```js
    if (dlStatuses.includes('not_downloaded')) {
      const names = MANUAL_LAUNCHERS.map((l) => l.name);
      parts.push(
        `(g.id IN (SELECT ge2.game_id FROM game_editions ge2 JOIN launchers l2 ON l2.id = ge2.launcher_id ` +
          `WHERE l2.name IN (${names.map(() => '?').join(',')})) AND g.id NOT IN (SELECT game_id FROM _manual_downloaded))`
      );
      outerParams.push(...names); // add to the param array this query uses for the outer WHERE
    }
```
> NOTE for the implementer: confirm the exact param array name the list query binds for `outerConditions` (read `games.js` around where `outerWhere`/params are assembled) and push `names` in the SAME order the placeholders appear. If the existing filter used no bound params (GOG was a literal), thread a params array through — do not string-concat launcher names.

**Per-row (~686-688):** replace `gogGameIds`/`downloadedIds` with `manualGameIds`/`downloadedIds`:
```js
    const download_status = manualGameIds.has(gameId)
      ? (downloadedIds.has(gameId) ? 'downloaded' : 'not_downloaded')
      : null;
```

- [ ] **Step 4: Run to verify pass** — `node --test tests/routes/games-manual-metadata.test.js` and the new coverage test → PASS. Run the whole routes suite to catch regressions.

- [ ] **Step 5: Commit**
```bash
git add backend/src/services/manualCoverage.js backend/src/routes/games.js backend/tests/routes/
git commit -m "feat(#222): surface download_status + filter across all manual launchers"
```

---

### Task 7: Full verification + PR

- [ ] **Step 1: Full backend suite** — `cd backend && node --test 'tests/**/*.test.js'` → no NEW failures (baseline: the 2 pre-existing failures noted in prior sessions).
- [ ] **Step 2: Frontend build sanity** (no frontend change, but confirm nothing imports a removed symbol) — `cd frontend && npm run build`.
- [ ] **Step 3: Push + PR**
```bash
git push -u origin feat/manual-coverage-amazon-humble-itch
gh pr create --title "feat(#222): manual-download coverage for Amazon + Humble + Itch" --body "..."
```
(Karl merges — never `gh pr merge`. Requires the orchestrator PR deployed first for Humble/Itch `include_files`; Amazon works once the orchestrator regex is live.)

## Post-deploy verification (live)
- Amazon-only owned game → "Downloaded" badge; filter `download_status=downloaded` includes Amazon games.
- `GET /api/cache/manual-coverage/Humble%20Bundle` and `.../Itch.io` → `present` counts ≈ auto+aliases; eyeball `extra_folders` and add any newly-identified alias.
- Confirm `hf-build-1.005.zip`→`hammerfight` is correct against the actual Humble bundle; drop the alias if wrong.

## Self-Review
- **Spec coverage:** registry (T1), normalizer (T2), aliases (T3), matcher file-mode+alias+simplifyTitle (T4), snapshot include_files + fetchManualCoverage + cache route (T5), games.js union detail/list/filter (T6). ✓ Frontend unchanged (spec Part F). ✓
- **Type consistency:** `matchGames(games, entries, opts)` / `computeDownloadedIds(games, entries, opts)` / `downloadedGameIds(db, name, entries, opts)` / `computeManualCoverage(games, entries, opts)` consistent across T4–T6; `getSnapshot(folder,{includeFiles})` consistent T5–T6. ✓
- **Regression:** dir-mode 2-arg calls default to `mode:'dir'`; existing manualCoverage/snapshot tests untouched and must stay green (T4/T5 step 4). ✓
- **Placeholder scan:** the only open items are the deliberately-flagged `outerParams` binding name (implementer confirms from live code) and the `hf`→hammerfight live confirmation — both are verification notes, not unspecified logic. ✓
