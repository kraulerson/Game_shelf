# Card Badge / Display Priority: Unranked Launcher Sorts Last — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an unranked launcher (`launchers.priority = 0`) sort LAST instead of first, so the card badge + primary launcher follow display priority (lancache launchers win by default; Amazon no longer hijacks the badge), then reprice Amazon to sit right after GOG.

**Architecture:** One shared SQL fragment `EFFECTIVE_PRIORITY_SQL` in `cacheLauncher.js` maps `priority = 0` → `999`, applied to every `ORDER BY l.priority ASC` that drives display/badge (the resolver + the games routes). Backend-only; the frontend already consumes `cache_launcher_name`. The Amazon-after-GOG reprice is a deploy-time settings `UPDATE` (priorities are user data, not seeded in code).

**Tech Stack:** Node, better-sqlite3, `node:test`. Tests: `cd backend && node --test 'tests/**/*.test.js'`; single file `node --test tests/services/cacheLauncher.test.js`.

## Global Constraints

- `EFFECTIVE_PRIORITY_SQL` verbatim: `` `CASE WHEN l.priority = 0 THEN 999 ELSE l.priority END` `` (assumes the `launchers` table is aliased `l`).
- Keep `is_display_edition DESC` and `tier DESC` ordering keys ahead of / unchanged relative to the priority key in every ORDER BY.
- Do NOT modify `backend/src/routes/sync.js:30` (sync order, not display).
- No schema change, no migration, no frontend change.
- Session framework hooks gate this repo's edits/commits: a Superpowers skill must be active before a source edit (test-file edits are exempt); a fresh `mark-evaluated` marker is needed before each `git commit` (run it lone from the orchestrator repo root, no shell-special chars in the reason).

---

### Task 1: `EFFECTIVE_PRIORITY_SQL` + resolver (the badge)

**Files:**
- Modify: `backend/src/services/cacheLauncher.js`
- Test: `backend/tests/services/cacheLauncher.test.js`

**Interfaces:**
- Produces: `EFFECTIVE_PRIORITY_SQL` (string, exported) and an updated `resolveCacheLauncher(db, gameId)` whose priority ordering treats `0` as last.

- [ ] **Step 1: Write the failing test** — append a fixture + test to `cacheLauncher.test.js`. In the `before()` block, after the existing `insEd.run(4001, ...)` line, add game 500:

```js
    // 500 Ranked-vs-unranked: EA (priority 5, explicit) + GOG (priority 0, the
    // default 'unranked'). The unranked launcher must sort LAST even though 0 < 5
    // numerically — the prod bug where Amazon sat at the default 0 and outranked
    // Steam. EA must win.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (500,'Ranked','ranked')").run();
    insEd.run(5000, 500, 4, 'ea-ranked', 'Ranked'); // ea, priority 5
    insEd.run(5001, 500, 3, 'gog-ranked', 'Ranked'); // gog, priority 0
```
And add the test (after the existing `it('honours explicit user priority …')`):

```js
  it('sorts an unranked launcher (priority 0) LAST, after an explicitly-ranked one', () => {
    // GOG is priority 0 (unranked); EA is priority 5. Pre-fix, 0 sorted first and
    // GOG won. Post-fix, 0 => 999 so EA wins. (The prod Amazon=0-beats-Steam bug.)
    const r = resolveCacheLauncher(db, 500);
    assert.equal(r.launcher_name, 'ea');
    assert.equal(r.launcher_game_id, 'ea-ranked');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/services/cacheLauncher.test.js`
Expected: the new test FAILS (`resolveCacheLauncher(db,500)` returns `gog`, not `ea`); all existing tests pass.

- [ ] **Step 3: Implement** — edit `backend/src/services/cacheLauncher.js`. After the `CANONICAL_ORDER_SQL` const, add:

```js
// A launcher's EFFECTIVE display priority. priority is user-set (1 = highest); the
// default 0 means "unranked" and must sort LAST — otherwise a never-ranked launcher
// (0) outranks every explicitly-ranked one and hijacks the badge/display. When 0 is
// pushed last, CANONICAL_ORDER_SQL (Steam>Epic>...>Amazon) governs unranked launchers,
// so lancache launchers win by default. Assumes the launchers table is aliased `l`.
const EFFECTIVE_PRIORITY_SQL = `CASE WHEN l.priority = 0 THEN 999 ELSE l.priority END`;
```
In `resolveCacheLauncher`, change the ORDER BY line `l.priority ASC,` to:
```js
                ${EFFECTIVE_PRIORITY_SQL} ASC,
```
(The query is already a template literal, so the interpolation works.) Export the new const:
```js
module.exports = { resolveCacheLauncher, CANONICAL_ORDER_SQL, EFFECTIVE_PRIORITY_SQL };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/services/cacheLauncher.test.js`
Expected: PASS (all — the 5 existing + the new one). Existing cases stay green: 100/200 (steam/epic/gog all 0 → both 999 → canonical Steam wins), 400 (ea 5 vs amazon 1, both non-zero → amazon), 300 (is_display override).

- [ ] **Step 5: Commit** (mark-evaluated first — see Global Constraints)

```bash
git add backend/src/services/cacheLauncher.js backend/tests/services/cacheLauncher.test.js
git commit -m "fix: unranked launcher (priority 0) sorts last in cache-launcher resolution"
```

---

### Task 2: Apply `EFFECTIVE_PRIORITY_SQL` to the games-route orderings

**Files:**
- Modify: `backend/src/routes/games.js` (the launcher-priority ORDER BYs)

**Interfaces:**
- Consumes: `EFFECTIVE_PRIORITY_SQL` from `../services/cacheLauncher` (Task 1).

- [ ] **Step 1: Add the import** near the other service requires at the top of `backend/src/routes/games.js`:

```js
const { EFFECTIVE_PRIORITY_SQL } = require('../services/cacheLauncher');
```

- [ ] **Step 2: Replace each `l.priority ASC`** in `games.js`. First locate them (they should be at ~:57, :116, :607, :633, :658 — confirm with grep, they can shift):

Run: `cd backend && grep -n "l.priority ASC" src/routes/games.js`

For EACH match that is inside a **template literal** (backtick) query, replace `l.priority ASC` with `${EFFECTIVE_PRIORITY_SQL} ASC`. The four display/badge orderings and the platforms list and the filters list all qualify:
- `/filters` launcher list (`GROUP BY l.name ORDER BY l.priority ASC`).
- detail edition ordering (`ORDER BY COALESCE(et.is_display_edition,0) DESC, COALESCE(et.tier,0) DESC, l.priority ASC`).
- the two list-query edition orderings (same shape as detail).
- the `platforms` list (`... ORDER BY l.priority ASC`).

**If any of these is a single-quoted string (not a backtick template),** convert that one query to a template literal first, then interpolate — do NOT string-concatenate the constant into a `'...'` literal. (Verify each hit's quoting before editing.)

Do NOT touch `backend/src/routes/sync.js`.

- [ ] **Step 3: Verify no `l.priority ASC` remains in games.js**

Run: `cd backend && grep -n "l.priority ASC" src/routes/games.js`
Expected: no matches (all replaced with `${EFFECTIVE_PRIORITY_SQL} ASC`).

- [ ] **Step 4: Regression — run the games route + services suites**

Run: `cd backend && node --test tests/routes/games-manual-metadata.test.js tests/services/cacheLauncher.test.js tests/services/manualCoverage.test.js`
Expected: PASS (no new failures). These orderings only change tiebreak position for unranked launchers, which the fixtures don't exercise adversely.

> NOTE: a dedicated route assertion (a steam+amazon fixture returning `cache_launcher_name:'steam'`) is redundant with Task 1's resolver unit test (the route calls `resolveCacheLauncher`) and the route harness boots the whole app; skip it. The display-edition/platforms ordering is validated live in Task 4.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/games.js
git commit -m "fix: games routes order launchers by effective priority (unranked last)"
```

---

### Task 3: Full suite + PR

- [ ] **Step 1: Full backend suite**

Run: `cd backend && node --test 'tests/**/*.test.js'`
Expected: no NEW failures. Known baseline (unrelated to this change): `GET /api/setup/qr/:launcher_id` + `GET /api/health` fail deterministically on master; `never leaks ORCH_TOKEN` is a full-suite-only flake (passes isolated). Confirm the failing set is exactly those.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin fix/card-badge-priority-unranked-last
gh pr create --title "fix: card badge follows display priority (unranked launcher sorts last)" --body "..."
```
PR body: explain the Amazon=0-default bug (unranked outranks Steam/Epic on 220 games), the `EFFECTIVE_PRIORITY_SQL` (0→last) fix applied to the resolver + games-route orderings, that `is_display_edition`/`tier`/explicit ranks are unchanged, and that the Amazon-after-GOG reprice is a deploy-time settings `UPDATE` (user data, not code). Karl merges (never `gh pr merge`).

---

### Task 4: Deploy + reprice Amazon after GOG + live verify (post-merge, no code)

- [ ] **Step 1: Deploy backend** on `.102`:
```
cd /opt/gameshelf && git fetch origin && git reset --hard origin/master && docker compose up -d --build backend
```

- [ ] **Step 2: Reprice Amazon after GOG** (one-time settings UPDATE; priorities are user data). Current: `steam1 epic2 ubisoft3 ea4 gog5 humble6 xbox7 itchio8 amazon0`. Target: insert Amazon at 6, shift the three below down — `amazon=6, humble=7, xbox=8, itchio=9` (steam/epic/ubisoft/ea/gog unchanged). Apply via the backend container:
```
docker exec gameshelf-backend-1 node -e "const db=require('better-sqlite3')('/app/data/gameshelf.db'); const u=db.prepare('UPDATE launchers SET priority=? WHERE name=?'); const tx=db.transaction(()=>{u.run(6,'amazon');u.run(7,'humble');u.run(8,'xbox');u.run(9,'itchio');}); tx(); console.log(db.prepare('SELECT name,priority FROM launchers ORDER BY priority').all());"
```
Expected printed order: steam1, epic2, ubisoft3, ea4, gog5, amazon6, humble7, xbox8, itchio9.

- [ ] **Step 3: Live-verify** (via the backend container, using `resolveCacheLauncher` over the live DB):
  - Psychonauts (steam+humble+amazon) now resolves to **steam** (was amazon).
  - An Amazon-only game still resolves to **amazon** (manual badge intact).
  - Spot-check a game owned on Amazon + Humble now resolves to **amazon** (6 < 7).
  Re-run the manual+lancache probe from the design work and confirm none of the 220 resolve to a manual launcher when a lancache launcher is owned.

## Self-Review
- **Spec coverage:** code fix `EFFECTIVE_PRIORITY_SQL` (Task 1 resolver + Task 2 routes); reprice Amazon-after-GOG (Task 4); no frontend/schema/migration; sync.js untouched. ✓
- **Placeholder scan:** the only "confirm line numbers with grep" note is a deliberate guard (line numbers shift), not an unspecified step; the exact replacement string is given. ✓
- **Type consistency:** `EFFECTIVE_PRIORITY_SQL` name + export identical across Task 1 (define/export) and Task 2 (import/use). ✓
