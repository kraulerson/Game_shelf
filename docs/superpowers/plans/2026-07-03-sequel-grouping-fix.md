# Sequel Grouping Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop merging sequels (Portal + Portal 2, Darksiders + Darksiders II) onto one game, both going forward (prevention) and in existing data (one-time repair), while still grouping true editions (Darksiders II + its Deathinitive Edition).

**Architecture:** A new pure module `gameIdentity.js` decides "same game?" from two slugs: same after stripping trailing edition-qualifier words, OR one is a word-boundary prefix of the other whose leftover tail does **not** start with a number/roman numeral. A numeric/roman tail = sequel = different game. The 4 existing prefix-match sites route through it (prevention). A new idempotent migration Phase 16 (`repairSequelGrouping.js`) splits already-merged sequels apart and re-homes them (repair).

**Tech Stack:** Node.js (CommonJS), better-sqlite3, `node:test` (backend). Frontend untouched — the main list + detail page already dedup by `game_id` and rank editions by `is_display_edition DESC, tier DESC, launcher priority ASC`, so correct grouping is all that's needed.

## Global Constraints

- Node CommonJS (`require`/`module.exports`), ESM not used in backend.
- `gameIdentity.js` must have **no top-level `require` of `titleMatcher.js`** (titleMatcher requires it) — avoid a circular import by importing `slugify` lazily inside functions, or by operating on already-slugified input. Callers pass slugs.
- Reuse `slugify` / `normalize` from `backend/src/services/metadata/titleMatcher.js` — do not reimplement normalization. `slugify` already strips `™®`, `(2010)`-style years, and some trailing edition phrases.
- Rule is **numeric/roman tail only** splits (approved). Word-tail subtitles (Half-Life 2: Deathmatch) stay grouped — that is the accepted trade-off, not a bug.
- TDD: write the failing test, watch it fail, implement, watch it pass.
- Backend tests: `cd backend && node --test <file>` for one file, `cd backend && node --test 'tests/**/*.test.js'` for all. Two pre-existing failures are tolerated; introduce **no new** failures.
- Framework hooks gate edits: mark the plan task `in_progress` (TaskUpdate) before editing files for that task.
- No per-task commits. One grouped commit at the end (Task 7), A/B/C structure brought to Karl at commit time. Claude pushes the branch and opens the PR; **Karl merges** (never `gh pr merge`).
- Branch: `fix/sequel-grouping` off `main` in the Game_shelf repo (`/Users/karl/Documents/Claude Projects/Game_shelf`).

---

### Task 0: Branch setup

**Files:** none (git only).

- [ ] **Step 1: Create the branch off main**

```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf"
git checkout main && git pull --ff-only
git checkout -b fix/sequel-grouping
git status
```
Expected: on `fix/sequel-grouping`, clean tree (the spec + this plan are untracked and will be added in Task 7's commit).

---

### Task 1: `gameIdentity.js` module + unit tests

**Files:**
- Create: `backend/src/services/metadata/gameIdentity.js`
- Test: `backend/tests/services/metadata/gameIdentity.test.js`

**Interfaces:**
- Produces:
  - `canonicalBaseSlug(slug: string) -> string` — slug with trailing qualifier/year tokens stripped (never strips a number/roman numeral).
  - `sameGameSlug(slugA: string, slugB: string) -> boolean` — true iff same game.
  - `isSequelToken(tok: string) -> boolean` — true for `/^[0-9]+$/` or a roman numeral i–xx.
  - `MIN_BASE = 4`, `ROMAN: Set<string>`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/services/metadata/gameIdentity.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalBaseSlug, sameGameSlug, isSequelToken } = require('../../../src/services/metadata/gameIdentity');

describe('gameIdentity.isSequelToken', () => {
  it('true for arabic and roman numerals', () => {
    for (const t of ['2', '3', '64', 'ii', 'iii', 'x']) assert.equal(isSequelToken(t), true, t);
  });
  it('false for words', () => {
    for (const t of ['deathinitive', 'edition', 'wild', 'deathmatch', '']) assert.equal(isSequelToken(t), false, t);
  });
});

describe('gameIdentity.canonicalBaseSlug', () => {
  it('strips trailing edition qualifiers, keeps sequel number', () => {
    assert.equal(canonicalBaseSlug('darksiders-ii-deathinitive-edition'), 'darksiders-ii');
    assert.equal(canonicalBaseSlug('darksiders-ii'), 'darksiders-ii');
    assert.equal(canonicalBaseSlug('darksiders'), 'darksiders');
    assert.equal(canonicalBaseSlug('portal-2'), 'portal-2');
    assert.equal(canonicalBaseSlug('endless-space-2-definitive-edition'), 'endless-space-2');
    assert.equal(canonicalBaseSlug('darksiders-warmastered-edition'), 'darksiders');
  });
  it('strips a trailing 4-digit year but not a non-year number', () => {
    assert.equal(canonicalBaseSlug('dead-space-2008'), 'dead-space');
    assert.equal(canonicalBaseSlug('doom-64'), 'doom-64');
  });
  it('never strips to empty', () => {
    assert.equal(canonicalBaseSlug('edition'), 'edition');
  });
});

describe('gameIdentity.sameGameSlug', () => {
  it('groups true editions (same base, or edition-qualified extension)', () => {
    assert.equal(sameGameSlug('darksiders-ii', 'darksiders-ii-deathinitive-edition'), true);
    assert.equal(sameGameSlug('portal-2', 'portal-2'), true);
    assert.equal(sameGameSlug('the-witcher-3', 'the-witcher-3-wild-hunt'), true); // word tail = same game
    assert.equal(sameGameSlug('dragon-age-inquisition', 'dragon-age-inquisition-game-of-the-year-edition'), true);
  });
  it('splits sequels (numeric/roman tail)', () => {
    assert.equal(sameGameSlug('portal', 'portal-2'), false);
    assert.equal(sameGameSlug('darksiders', 'darksiders-ii-deathinitive-edition'), false);
    assert.equal(sameGameSlug('half-life', 'half-life-2'), false);
    assert.equal(sameGameSlug('nioh', 'nioh-2'), false);
    assert.equal(sameGameSlug('doom', 'doom-64'), false);
    assert.equal(sameGameSlug('cat-quest', 'cat-quest-iii'), false);
  });
  it('leaves unrelated / non-prefix pairs ungrouped', () => {
    assert.equal(sameGameSlug('deus-ex-invisible-war', 'deus-ex-2-invisible-war'), false); // not a prefix pair
    assert.equal(sameGameSlug('gloomhaven', 'darksiders-ii'), false);
  });
  it('is symmetric', () => {
    assert.equal(sameGameSlug('portal-2', 'portal'), false);
    assert.equal(sameGameSlug('darksiders-ii-deathinitive-edition', 'darksiders-ii'), true);
  });
  it('rejects too-short overlaps', () => {
    assert.equal(sameGameSlug('go', 'go-2'), false); // base < MIN_BASE
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/services/metadata/gameIdentity.test.js`
Expected: FAIL — `Cannot find module '.../gameIdentity'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/metadata/gameIdentity.js`:

```js
// Distinguish game EDITIONS (same game — "Darksiders II" + "Darksiders II
// Deathinitive Edition") from SEQUELS (different games — "Portal" + "Portal 2").
// Operates on slugs (see slugify in titleMatcher). A numeric / roman-numeral tail
// after a shared word-boundary prefix marks a sequel => different game.
//
// No top-level require of titleMatcher: titleMatcher requires THIS module, so a
// top-level back-require would be a cycle. This module needs nothing from it.

const MIN_BASE = 4;

const ROMAN = new Set([
  'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
  'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx',
]);

// Edition/qualifier tokens stripped from the END of a slug to find the base game.
// slugify already removes trademark symbols, "(2010)", and some trailing edition
// phrases; this closes the gaps (deathinitive, warmastered, director's cut, ...).
const QUALIFIER = new Set([
  'edition', 'editions', 'complete', 'collection', 'pack',
  'goty', 'game', 'of', 'the', 'year',
  'deluxe', 'gold', 'ultimate', 'premium', 'special', 'enhanced',
  'definitive', 'deathinitive', 'remastered', 'remaster', 'warmastered',
  'directors', 'director', 'cut', 'final',
  'collectors', 'collector', 'legendary', 'limited', 'anniversary',
  'standard', 'base', 'digital', 'hd', 'day', 'one', 'launch', 'and',
]);

function isSequelToken(tok) {
  return /^[0-9]+$/.test(tok) || ROMAN.has(tok);
}

// A bare 4-digit release year (Dead Space 2008) — strip so the year-tagged
// duplicate collapses onto the base. Doom 64 keeps "64" (not a year).
function isYearToken(tok) {
  return /^(19[7-9]\d|20\d\d)$/.test(tok);
}

// Reduce a slug to its base-game slug by dropping trailing qualifier / year
// tokens. Stops at the first non-qualifier token from the end. Never strips a
// number or roman numeral — those are part of the base (portal-2 stays portal-2).
function canonicalBaseSlug(slug) {
  const toks = String(slug || '').split('-').filter(Boolean);
  while (toks.length > 1) {
    const last = toks[toks.length - 1];
    if (isSequelToken(last)) break;
    if (QUALIFIER.has(last) || isYearToken(last)) { toks.pop(); continue; }
    break;
  }
  return toks.join('-');
}

function wordBoundaryPrefix(shorter, longer) {
  return longer.startsWith(shorter) &&
    (longer.length === shorter.length || longer[shorter.length] === '-');
}

// True when two slugs are the SAME game: equal base, or one base is an
// edition-qualified extension of the other. A numeric/roman tail => sequel => false.
function sameGameSlug(slugA, slugB) {
  const a = canonicalBaseSlug(slugA);
  const b = canonicalBaseSlug(slugB);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < MIN_BASE) return false;
  if (!wordBoundaryPrefix(shorter, longer)) return false;
  const tail = longer.slice(shorter.length + 1);
  return !isSequelToken(tail.split('-')[0]);
}

module.exports = { canonicalBaseSlug, sameGameSlug, isSequelToken, ROMAN, MIN_BASE };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/services/metadata/gameIdentity.test.js`
Expected: PASS — all assertions green.

---

### Task 2: `titleMatcher` prefix-boost is sequel-aware

**Files:**
- Modify: `backend/src/services/metadata/titleMatcher.js` (top requires; `findBestMatch` lines 90-95)
- Test: `backend/tests/services/metadata/titleMatcher.test.js` (add cases)

**Interfaces:**
- Consumes: `isSequelToken` from `gameIdentity` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/services/metadata/titleMatcher.test.js` (inside the existing top-level, after the last `describe`; if the file has a single `describe`, add a new one):

```js
const { describe: describe2, it: it2 } = require('node:test');
const assert2 = require('node:assert/strict');
const { findBestMatch: fbm } = require('../../../src/services/metadata/titleMatcher');

describe2('findBestMatch sequel awareness', () => {
  it2('does NOT match a sequel via the prefix boost', () => {
    // Levenshtein("doom","doom-64") ~0.57; only the old prefix boost pushed it to 0.80.
    assert2.equal(fbm('Doom', [{ name: 'Doom 64' }]), null);
  });
  it2('still matches a true edition via the prefix boost', () => {
    const m = fbm('Darksiders II', [{ name: 'Darksiders II: Deathinitive Edition' }]);
    assert2.ok(m && m.name === 'Darksiders II: Deathinitive Edition');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/services/metadata/titleMatcher.test.js`
Expected: FAIL — the "does NOT match a sequel" case returns `{ name: 'Doom 64' }` (old boost), not `null`.

- [ ] **Step 3: Implement**

At the top of `backend/src/services/metadata/titleMatcher.js` (line 1, before `const EDITION_SUFFIXES`), add:

```js
const { isSequelToken } = require('./gameIdentity');
```

Replace the prefix-boost block (current lines 90-95):

```js
    // Boost prefix matches: launcher titles often lack subtitles present in IGDB
    const shorter = searchSlug.length <= resultSlug.length ? searchSlug : resultSlug;
    const longer = searchSlug.length <= resultSlug.length ? resultSlug : searchSlug;
    if (longer.startsWith(shorter) && (longer.length === shorter.length || longer[shorter.length] === '-')) {
      similarity = Math.max(similarity, 0.80);
    }
```

with:

```js
    // Boost prefix matches: launcher titles often lack subtitles present in IGDB.
    // But a numeric/roman tail (Doom -> Doom 64) is a SEQUEL, not a subtitle —
    // never boost that, or IGDB pulls the wrong game's metadata.
    const shorter = searchSlug.length <= resultSlug.length ? searchSlug : resultSlug;
    const longer = searchSlug.length <= resultSlug.length ? resultSlug : searchSlug;
    if (longer.startsWith(shorter) && (longer.length === shorter.length || longer[shorter.length] === '-')) {
      const tail = longer.slice(shorter.length + 1);
      if (!tail || !isSequelToken(tail.split('-')[0])) {
        similarity = Math.max(similarity, 0.80);
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/services/metadata/titleMatcher.test.js`
Expected: PASS — including all pre-existing titleMatcher cases (no regression).

---

### Task 3: `enrichGame` cross-launcher match is sequel-aware

**Files:**
- Modify: `backend/src/services/metadata/enrichGame.js` (top requires; cross-match block lines 150-171)
- Test: `backend/tests/services/metadata/enrichGame-sequel.test.js` (new)

**Interfaces:**
- Consumes: `sameGameSlug` from `gameIdentity` (Task 1). The cross-match's `slug` is `slugify(title)` (line 122); candidates expose `g.slug`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/services/metadata/enrichGame-sequel.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('enrichGame cross-launcher sequel guard', () => {
  const testDbPath = path.join(__dirname, '..', '..', 'data', 'test-enrich-sequel.db');
  let db, enrichGame;

  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    // No IGDB creds — enrichGame falls straight to the cross-launcher / minimal path.
    delete require.cache[require.resolve('../../../src/db/migrate')];
    db = require('../../../src/db/migrate').runMigrations(testDbPath);
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled) VALUES (1,'steam','Steam',1)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled) VALUES (2,'epic','Epic',1)").run();
    ({ enrichGame } = require('../../../src/services/metadata/enrichGame'));
  });
  after(() => {
    if (db) db.close();
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('does NOT cross-match a sequel onto its predecessor game', async () => {
    // An enriched "Portal 2" game already exists (has description).
    const g = db.prepare("INSERT INTO games (title, slug, description) VALUES ('Portal 2','portal-2','desc') RETURNING id").get();
    const ed = db.prepare("INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (1,'400','Portal') RETURNING id").get();
    await enrichGame(ed.id, db);
    const row = db.prepare('SELECT game_id FROM game_editions WHERE id = ?').get(ed.id);
    assert.ok(row.game_id, 'game_id set');
    assert.notEqual(row.game_id, g.id, 'Portal must NOT land on the Portal 2 game');
    const own = db.prepare('SELECT slug FROM games WHERE id = ?').get(row.game_id);
    assert.equal(own.slug, 'portal', 'Portal gets its own game');
  });

  it('DOES cross-match a true edition across launchers', async () => {
    const g = db.prepare("INSERT INTO games (title, slug, description) VALUES ('Torchlight II','torchlight-ii','desc') RETURNING id").get();
    const ed = db.prepare("INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (2,'tl2','Torchlight II') RETURNING id").get();
    await enrichGame(ed.id, db);
    const row = db.prepare('SELECT game_id FROM game_editions WHERE id = ?').get(ed.id);
    assert.equal(row.game_id, g.id, 'Torchlight II (Epic) joins the existing Torchlight II game');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/services/metadata/enrichGame-sequel.test.js`
Expected: FAIL — the first case: `Portal` is cross-matched onto the `Portal 2` game (`row.game_id === g.id`), so `assert.notEqual` throws.

- [ ] **Step 3: Implement**

At the top of `backend/src/services/metadata/enrichGame.js`, near the existing `require('./titleMatcher')`, add:

```js
const { sameGameSlug } = require('./gameIdentity');
```

Replace the `validCross` predicate (current lines 160-165):

```js
    const validCross = crossMatch.find(g => {
      const shorter = slug.length <= g.slug.length ? slug : g.slug;
      const longer = slug.length <= g.slug.length ? g.slug : slug;
      if (shorter.length < MIN_CROSS_SLUG) return false;
      return longer.startsWith(shorter) && (longer.length === shorter.length || longer[shorter.length] === '-');
    });
```

with:

```js
    // Same game only — sameGameSlug rejects a sequel (numeric/roman tail), so
    // "Portal" no longer cross-matches onto an existing "Portal 2" game.
    const validCross = crossMatch.find(g => sameGameSlug(slug, g.slug));
```

(The `MIN_CROSS_SLUG` constant and the candidate query above it are unchanged; `sameGameSlug`'s own `MIN_BASE=4` guard subsumes the length check.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/services/metadata/enrichGame-sequel.test.js`
Expected: PASS — both cases.

- [ ] **Step 5: Confirm no regression in existing enrichGame tests**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/services/metadata/enrichGame.test.js tests/services/metadata/enrichGame-manual-override.test.js`
Expected: PASS (same result as before this task).

---

### Task 4: Migration Phase 12b won't merge sequel game rows

**Files:**
- Modify: `backend/src/db/migrate.js` (top requires; Phase 12b condition lines 192-194)
- Test: `backend/tests/db/migrate-phase12b-sequel.test.js` (new)

**Interfaces:**
- Consumes: `sameGameSlug` from `gameIdentity` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/db/migrate-phase12b-sequel.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('migrate Phase 12b sequel guard', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-p12b-sequel.db');
  let runMigrations;

  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    ({ runMigrations } = require('../../src/db/migrate'));
  });
  after(() => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('keeps a sequel pair separate but merges a true edition pair', () => {
    let db = runMigrations(testDbPath);
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled) VALUES (1,'steam','Steam',1)").run();
    // Sequel pair (must stay separate): portal / portal-2
    const p1 = db.prepare("INSERT INTO games (title,slug,description) VALUES ('Portal','portal','d') RETURNING id").get();
    const p2 = db.prepare("INSERT INTO games (title,slug,description) VALUES ('Portal 2','portal-2','d') RETURNING id").get();
    db.prepare("INSERT INTO game_editions (game_id,launcher_id,launcher_game_id,title) VALUES (?,1,'400','Portal')").run(p1.id);
    db.prepare("INSERT INTO game_editions (game_id,launcher_id,launcher_game_id,title) VALUES (?,1,'620','Portal 2')").run(p2.id);
    // Edition pair (must merge): darksiders-ii / darksiders-ii-deathinitive-edition
    const d1 = db.prepare("INSERT INTO games (title,slug,description) VALUES ('Darksiders II','darksiders-ii','d') RETURNING id").get();
    const d2 = db.prepare("INSERT INTO games (title,slug,description) VALUES ('Darksiders II Deathinitive Edition','darksiders-ii-deathinitive-edition','d') RETURNING id").get();
    db.prepare("INSERT INTO game_editions (game_id,launcher_id,launcher_game_id,title) VALUES (?,1,'50650','Darksiders II')").run(d1.id);
    db.prepare("INSERT INTO game_editions (game_id,launcher_id,launcher_game_id,title) VALUES (?,1,'388410','Darksiders II Deathinitive Edition')").run(d2.id);
    db.close();

    // Re-run migrations: Phase 12b executes over the inserted rows.
    delete require.cache[require.resolve('../../src/db/migrate')];
    ({ runMigrations } = require('../../src/db/migrate'));
    db = runMigrations(testDbPath);

    const portalGames = db.prepare("SELECT COUNT(*) c FROM games WHERE slug IN ('portal','portal-2')").get().c;
    assert.equal(portalGames, 2, 'Portal and Portal 2 stay separate');
    const darkGames = db.prepare("SELECT COUNT(*) c FROM games WHERE slug IN ('darksiders-ii','darksiders-ii-deathinitive-edition')").get().c;
    assert.equal(darkGames, 1, 'Darksiders II + Deathinitive merged to one game');
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/db/migrate-phase12b-sequel.test.js`
Expected: FAIL — `portalGames` is 1 (old Phase 12b merged Portal into Portal 2).

- [ ] **Step 3: Implement**

At the top of `backend/src/db/migrate.js` (with the other top-level requires), add:

```js
const { sameGameSlug } = require('../services/metadata/gameIdentity');
```

In Phase 12b, replace the merge condition (current lines 192-194):

```js
        // Check if shorter.slug is a prefix of longer.slug on word boundary
        if (longer.slug.startsWith(shorter.slug) &&
            (longer.slug.length === shorter.slug.length || longer.slug[shorter.slug.length] === '-')) {
```

with:

```js
        // Merge edition variants only. sameGameSlug adds the sequel guard: a
        // numeric/roman tail (portal -> portal-2) is a different game, never merged.
        if (longer.slug.startsWith(shorter.slug) &&
            (longer.slug.length === shorter.slug.length || longer.slug[shorter.slug.length] === '-') &&
            sameGameSlug(shorter.slug, longer.slug)) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/db/migrate-phase12b-sequel.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm no regression in existing migrate tests**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/db/migrate.test.js tests/db/migrate-phase12.test.js tests/db/migrate-fixes.test.js`
Expected: PASS (unchanged).

---

### Task 5: Align the Phase 15 Epic repair predicate

**Files:**
- Modify: `backend/src/db/repairMisGroupedEditions.js` (`isPrefixRelated`, lines 8-23)
- Test: `backend/tests/db/repairMisGroupedEditions.test.js` (existing — must stay green)

**Interfaces:**
- Consumes: `sameGameSlug` from `gameIdentity` (Task 1). Keeps the `isPrefixRelated(a, b)` export/signature so the existing test and caller are unchanged.

- [ ] **Step 1: Implement (delegation)**

In `backend/src/db/repairMisGroupedEditions.js`, replace the `slugify` import line (line 8) and the `isPrefixRelated` function (lines 15-23). Change:

```js
const { slugify } = require('../services/metadata/titleMatcher');
```
to:
```js
const { slugify } = require('../services/metadata/titleMatcher');
const { sameGameSlug } = require('../services/metadata/gameIdentity');
```

Replace the `MIN_SLUG` constant and `isPrefixRelated` body (lines 13, 17-23):

```js
const MIN_SLUG = 4;

// One slug is a prefix of the other on a word boundary, and the shared prefix is
// itself meaningful (a 1-3 char overlap is not a real match).
function isPrefixRelated(a, b) {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < MIN_SLUG) return false;
  return longer.startsWith(shorter) &&
    (longer.length === shorter.length || longer[shorter.length] === '-');
}
```

with:

```js
// Two slugs belong to the same game. Delegates to the shared sequel-aware rule so
// the Epic repair also refuses to keep a sequel edition on the wrong game.
function isPrefixRelated(a, b) {
  return sameGameSlug(a, b);
}
```

(Remove the now-unused `NAMESPACE_THRESHOLD`/`MIN_SLUG` only if `MIN_SLUG` is unused elsewhere; `NAMESPACE_THRESHOLD` is still used — leave it.)

- [ ] **Step 2: Run the existing repair test to verify it stays green**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/db/repairMisGroupedEditions.test.js`
Expected: PASS — both cases (the DAI edition kept; the 6 unrelated re-homed; second run moves 0). `sameGameSlug` gives the same keep/re-home verdicts as the old raw prefix on this fixture.

---

### Task 6: `repairSequelGrouping.js` + Phase 16 wiring

**Files:**
- Create: `backend/src/db/repairSequelGrouping.js`
- Modify: `backend/src/db/migrate.js` (add Phase 16 after Phase 15, ~line 257)
- Test: `backend/tests/db/repairSequelGrouping.test.js` (new)

**Interfaces:**
- Consumes: `slugify` (titleMatcher), `canonicalBaseSlug` + `sameGameSlug` (gameIdentity).
- Produces: `repairSequelGrouping(db) -> number` (count of editions re-homed).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/db/repairSequelGrouping.test.js`:

```js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('repairSequelGrouping (Phase 16)', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-phase16.db');
  let db, repair;

  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(testDbPath);
    ({ repairSequelGrouping: repair } = require('../../src/db/repairSequelGrouping'));

    db.prepare("INSERT INTO launchers (id,name,display_name,enabled) VALUES (1,'steam','Steam',1)").run();

    // Game A: "Portal 2" wrongly holds Portal + Portal 2.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (10,'Portal 2','portal-2')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (100,10,1,'400','Portal')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (101,10,1,'620','Portal 2')").run();

    // Game B: "Darksiders II: Deathinitive Edition" holds Darksiders II + its Deathinitive
    // (keep) plus the original "Darksiders" (must re-home into the Warmastered game).
    db.prepare("INSERT INTO games (id,title,slug) VALUES (20,'Darksiders II: Deathinitive Edition','darksiders-ii-deathinitive-edition')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (200,20,1,'d0','Darksiders')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (201,20,1,'d1','Darksiders II')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (202,20,1,'d2','Darksiders II Deathinitive Edition')").run();

    // Game C: existing "Darksiders: Warmastered Edition" — the re-home target for the original.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (30,'Darksiders: Warmastered Edition','darksiders-warmastered-edition')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (300,30,1,'d3','Darksiders Warmastered Edition')").run();

    // Game D: healthy multi-edition game (must be untouched).
    db.prepare("INSERT INTO games (id,title,slug) VALUES (40,'Trine 2','trine-2')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (400,40,1,'t0','Trine 2')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (401,40,1,'t1','Trine 2: Complete Story')").run();
  });
  after(() => {
    if (db) db.close();
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('splits Portal off Portal 2 into its own game', () => {
    const moved = repair(db);
    assert.ok(moved >= 2, `moved ${moved}`);
    const portal = db.prepare('SELECT game_id FROM game_editions WHERE id=100').get();
    assert.notEqual(portal.game_id, 10, 'Portal left the Portal 2 game');
    const portalGame = db.prepare('SELECT slug FROM games WHERE id=?').get(portal.game_id);
    assert.equal(portalGame.slug, 'portal');
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=101').get().game_id, 10, 'Portal 2 stays');
  });

  it('re-homes the original Darksiders into the Warmastered game, keeps II + Deathinitive', () => {
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=200').get().game_id, 30, 'Darksiders -> Warmastered game');
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=201').get().game_id, 20, 'Darksiders II stays');
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=202').get().game_id, 20, 'Deathinitive stays');
  });

  it('leaves the healthy game untouched', () => {
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=400').get().game_id, 40);
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=401').get().game_id, 40);
  });

  it('is idempotent — a second run moves nothing', () => {
    assert.equal(repair(db), 0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/db/repairSequelGrouping.test.js`
Expected: FAIL — `Cannot find module '.../repairSequelGrouping'`.

- [ ] **Step 3: Implement the repair module**

Create `backend/src/db/repairSequelGrouping.js`:

```js
// Phase 16 repair: split sequels the old prefix matcher merged onto one game
// (Portal + Portal 2, Darksiders + Darksiders II). For each game holding editions
// of more than one base game, keep the editions that belong (sameGameSlug with the
// game's own slug) and re-home the rest — reusing an existing game whose base slug
// exactly matches (so the original Darksiders lands on the Warmastered game, not
// the Genesis spinoff), else creating a new game row. DLC children follow their
// base edition. Idempotent. Companion to Phase 15 (Epic namespace repair).
const { slugify } = require('../services/metadata/titleMatcher');
const { canonicalBaseSlug, sameGameSlug } = require('../services/metadata/gameIdentity');

function repairSequelGrouping(db) {
  const games = db.prepare(`
    SELECT g.id AS gid, g.slug AS gslug
    FROM games g JOIN game_editions ge ON ge.game_id = g.id
    WHERE ge.parent_edition_id IS NULL
    GROUP BY g.id
    HAVING COUNT(ge.id) > 1
  `).all();
  if (games.length === 0) return 0;

  const edsOf = db.prepare(
    'SELECT id, title FROM game_editions WHERE game_id = ? AND parent_edition_id IS NULL AND title IS NOT NULL');
  const childrenOf = db.prepare('SELECT id FROM game_editions WHERE parent_edition_id = ?');
  const candGames = db.prepare('SELECT id, slug FROM games WHERE slug LIKE ?');
  const insGame = db.prepare("INSERT INTO games (title, slug) VALUES (?, ?) ON CONFLICT(slug) DO NOTHING");
  const findGame = db.prepare('SELECT id FROM games WHERE slug = ?');
  const relink = db.prepare('UPDATE game_editions SET game_id = ? WHERE id = ?');
  const delEmpty = db.prepare(
    'DELETE FROM games WHERE id = ? AND NOT EXISTS (SELECT 1 FROM game_editions WHERE game_id = ?)');

  let moved = 0;
  // FK must toggle outside the transaction (SQLite forbids changing it within one).
  db.pragma('foreign_keys = OFF');
  const run = db.transaction(() => {
    for (const { gid, gslug } of games) {
      for (const ed of edsOf.all(gid)) {
        const es = slugify(ed.title);
        if (!es || sameGameSlug(es, gslug)) continue; // belongs to this game — keep
        const ebase = canonicalBaseSlug(es);
        // Reuse an existing game whose base slug EXACTLY equals this edition's base.
        let target = candGames.all(ebase + '%')
          .find(c => c.id !== gid && canonicalBaseSlug(c.slug) === ebase);
        if (!target) {
          insGame.run(ed.title, es);
          target = findGame.get(es);
        }
        if (target && target.id !== gid) {
          relink.run(target.id, ed.id);
          for (const child of childrenOf.all(ed.id)) relink.run(target.id, child.id);
          moved++;
        }
      }
      delEmpty.run(gid, gid); // drop the game if it lost all its editions
    }
  });
  run();
  db.pragma('foreign_keys = ON');
  return moved;
}

module.exports = { repairSequelGrouping };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/db/repairSequelGrouping.test.js`
Expected: PASS — all four cases.

- [ ] **Step 5: Wire Phase 16 into migrate.js**

In `backend/src/db/migrate.js`, immediately after the Phase 15 block (after line 257, before `return db;`), add:

```js
  // Phase 16: split sequels the old prefix matcher merged onto one game (Portal +
  // Portal 2, Darksiders + Darksiders II). Prevention now lives in gameIdentity
  // (enrichGame cross-match, Phase 12b, Phase 15). This heals existing data.
  // Idempotent: once split, each game's editions share one base game.
  {
    const { repairSequelGrouping } = require('./repairSequelGrouping');
    const split = repairSequelGrouping(db);
    if (split > 0) {
      console.log(`[Migration] Phase 16: split ${split} sequel editions off mis-grouped games`);
    }
  }
```

- [ ] **Step 6: Verify the migration wiring end-to-end**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test tests/db/migrate.test.js tests/db/repairSequelGrouping.test.js`
Expected: PASS — a fresh `runMigrations` on an empty DB runs Phase 16 (0 splits, no error); the repair unit test passes.

---

### Task 7: Full verification, commit, push, PR

**Files:** none new (git + verification only).

- [ ] **Step 1: Full backend suite**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/backend" && node --test 'tests/**/*.test.js' 2>&1 | tail -30`
Expected: no NEW failures beyond the 2 pre-existing (record which 2 fail on a clean `main` first if unsure). New files (gameIdentity, enrichGame-sequel, migrate-phase12b-sequel, repairSequelGrouping) all green.

- [ ] **Step 2: Frontend build (must still compile — frontend untouched)**

Run: `cd "/Users/karl/Documents/Claude Projects/Game_shelf/frontend" && npm run build 2>&1 | tail -15`
Expected: build succeeds.

- [ ] **Step 3: Bring the A/B/C commit structure to Karl, then commit**

Stage: the spec, this plan, `gameIdentity.js`, `repairSequelGrouping.js`, edits to `titleMatcher.js` / `enrichGame.js` / `migrate.js` / `repairMisGroupedEditions.js`, and all new test files.

```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf"
git add backend/src/services/metadata/gameIdentity.js backend/src/db/repairSequelGrouping.js \
  backend/src/services/metadata/titleMatcher.js backend/src/services/metadata/enrichGame.js \
  backend/src/db/migrate.js backend/src/db/repairMisGroupedEditions.js \
  backend/tests/services/metadata/gameIdentity.test.js backend/tests/services/metadata/titleMatcher.test.js \
  backend/tests/services/metadata/enrichGame-sequel.test.js backend/tests/db/migrate-phase12b-sequel.test.js \
  backend/tests/db/repairSequelGrouping.test.js \
  docs/superpowers/specs/2026-07-03-sequel-grouping-fix-design.md \
  docs/superpowers/plans/2026-07-03-sequel-grouping-fix.md
git commit -m "fix(grouping): split sequels from editions (prevention + Phase 16 repair)"
```

- [ ] **Step 4: Push and open the PR (Karl merges)**

```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf"
git push -u origin fix/sequel-grouping
gh pr create --title "fix(grouping): stop merging sequels as editions" --body "<summary>"
```
Do NOT `gh pr merge`.

---

## Deploy / go-live (after Karl merges — separate from plan execution)

1. Back up the live DB on LXC 1102: `docker exec gameshelf-backend-1 cp /app/data/gameshelf.db /app/data/gameshelf.db.bak-pre-sequel-fix`.
2. Deploy the merged `main`; on container start, migrations run Phase 16 and split the ~40 games.
3. Verify live: Portal and Portal 2 are separate; Darksiders (original) sits on the Warmastered game; Darksiders II + Deathinitive stay together; the mixed-sequel sweep count drops to ~0.
4. Trigger `POST /api/metadata/enrich-all` so the newly split games (e.g. a fresh "Portal" row) pick up cover/description (they start bare after the split).

## Self-review notes (author)

- **Spec coverage:** shared rule (Task 1) ✓; prevention at all 4 sites (Task 2 titleMatcher, Task 3 enrichGame, Task 4 Phase 12b, Task 5 Phase 15) ✓; repair Phase 16 (Task 6) ✓; display unchanged (relies on existing tier query) ✓; testing per task ✓; rollout ✓.
- **Type consistency:** `sameGameSlug`, `canonicalBaseSlug`, `isSequelToken` names identical across Tasks 1–6. `repairSequelGrouping(db) -> number` matches Phase 16 caller. `isPrefixRelated(a,b)` signature preserved in Task 5.
- **No placeholders:** every code + test step carries full code and exact commands.
