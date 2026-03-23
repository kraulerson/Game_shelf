# Phase 8: UI Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configure button for unconfigured launchers, alphabetical A-Z navigation bar, and search clear button.

**Architecture:** One backend change (add `starts_with` query param to games endpoint) plus three frontend changes (configure button in Settings, letter bar and search clear in Library).

**Tech Stack:** Express.js, better-sqlite3, React

**Spec:** `docs/superpowers/specs/2026-03-22-gameshelf-phase8-design.md`

---

### Task 1: Backend — add `starts_with` query param to games endpoint

**Files:**
- Modify: `backend/src/routes/games.js:141-146` (destructure) and `:205-208` (search clauses)

- [ ] **Step 1: Add `starts_with` to destructuring and build filter clauses**

In `backend/src/routes/games.js`, update the destructuring at line 141-146 to include `starts_with`:

Replace:
```js
  const {
    search, genre, tag, launcher, sort = 'title_asc',
    page = '1', limit = '50', duplicates,
    release_year_min, release_year_max, playtime_min, playtime_max,
    owned = 'true',
  } = req.query;
```
With:
```js
  const {
    search, genre, tag, launcher, sort = 'title_asc',
    page = '1', limit = '50', duplicates, starts_with,
    release_year_min, release_year_max, playtime_min, playtime_max,
    owned = 'true',
  } = req.query;
```

Then, after the `searchParams` line (after line 208), add the `starts_with` filter clauses:

```js
  // starts_with clause — dual expressions like search (column refs differ per mode)
  let startsWithDup = '';
  let startsWithDedup = '';
  const startsWithParams = [];
  if (starts_with) {
    if (starts_with === '#') {
      startsWithDup = "AND COALESCE(g.title, ge.title) NOT GLOB '[A-Za-z]*'";
      startsWithDedup = "AND COALESCE(g.title, r.edition_title) NOT GLOB '[A-Za-z]*'";
    } else {
      startsWithDup = 'AND COALESCE(g.title, ge.title) LIKE ? COLLATE NOCASE';
      startsWithDedup = 'AND COALESCE(g.title, r.edition_title) LIKE ? COLLATE NOCASE';
      startsWithParams.push(`${starts_with}%`);
    }
  }
```

Then inject these into the queries. In the **duplicated mode** query (line 235), replace:
```js
      WHERE 1=1 ${innerWhere} ${outerWhere} ${searchWhereDup}
```
With:
```js
      WHERE 1=1 ${innerWhere} ${outerWhere} ${searchWhereDup} ${startsWithDup}
```

Do the same for the duplicated count query (line 244).

In the **deduplicated mode** query (line 269), replace:
```js
      WHERE r.rn = 1 ${outerWhere} ${searchWhereDedup}
```
With:
```js
      WHERE r.rn = 1 ${outerWhere} ${searchWhereDedup} ${startsWithDedup}
```

Do the same for the deduplicated count query (line 289).

Update the param arrays. Replace:
```js
    countParams = [...innerParams, ...outerParams, ...searchParams];
    allParams = [...innerParams, ...outerParams, ...searchParams, limitNum, offset];
```
With (in both branches):
```js
    countParams = [...innerParams, ...outerParams, ...searchParams, ...startsWithParams];
    allParams = [...innerParams, ...outerParams, ...searchParams, ...startsWithParams, limitNum, offset];
```

- [ ] **Step 2: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/games.js
git commit -m "feat: add starts_with query param to games endpoint for alphabetical navigation"
```

---

### Task 2: Frontend — Configure button for unconfigured launchers

**Files:**
- Modify: `frontend/src/pages/Settings.jsx:7-74` (LaunchersTab)

- [ ] **Step 1: Add navigate hook and configure button**

In `frontend/src/pages/Settings.jsx`, inside the `LaunchersTab` function, add `useNavigate` after the existing hooks (after line 9):

```js
  const navigate = useNavigate();
```

Then replace the conditional button rendering (lines 59-74):

Replace:
```jsx
            {l.configured && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => syncLauncher(l.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                >
                  <RefreshCw size={14} /> Sync
                </button>
                <button
                  onClick={() => setConfirmRemove(l.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-red-900/50 hover:bg-red-800/50 text-red-400 text-sm rounded transition-colors"
                >
                  Remove
                </button>
              </div>
            )}
```
With:
```jsx
            {l.configured ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => syncLauncher(l.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                >
                  <RefreshCw size={14} /> Sync
                </button>
                <button
                  onClick={() => setConfirmRemove(l.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-red-900/50 hover:bg-red-800/50 text-red-400 text-sm rounded transition-colors"
                >
                  Remove
                </button>
              </div>
            ) : (
              <button
                onClick={() => navigate('/setup')}
                className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
              >
                Configure
              </button>
            )}
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat: add Configure button for unconfigured launchers"
```

---

### Task 3: Frontend — Alphabetical nav bar and search clear button

**Files:**
- Modify: `frontend/src/pages/Library.jsx:80,89-165` (filterKeys, header area)

- [ ] **Step 1: Add `starts_with` to filterKeys**

In `frontend/src/pages/Library.jsx`, replace line 80:
```js
  const filterKeys = ['genre', 'tag', 'launcher', 'release_year_min', 'release_year_max', 'playtime_min', 'playtime_max', 'owned', 'duplicates'];
```
With:
```js
  const filterKeys = ['genre', 'tag', 'launcher', 'release_year_min', 'release_year_max', 'playtime_min', 'playtime_max', 'owned', 'duplicates', 'starts_with'];
```

- [ ] **Step 2: Add the search clear button**

Replace the search input container (lines 93-102):
```jsx
          <div className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search games..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
```
With:
```jsx
          <div className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search games..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className={`w-full pl-9 ${searchInput ? 'pr-8' : 'pr-3'} py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500`}
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
              >
                <X size={14} />
              </button>
            )}
          </div>
```

- [ ] **Step 3: Add alphabetical navigation bar**

Add the letter bar after the closing `</div>` of the filter/controls area (after line 165, before `<div className="p-4">`). Insert between the header `</div>` and the content `<div className="p-4">`:

```jsx
      {/* Alphabetical navigation */}
      <div className="border-b border-gray-800 px-4 py-2">
        <div className="flex flex-wrap gap-1">
          {['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => {
            const active = searchParams.get('starts_with') === letter;
            return (
              <button
                key={letter}
                onClick={() => {
                  const p = new URLSearchParams(searchParams);
                  if (active) {
                    p.delete('starts_with');
                  } else {
                    p.set('starts_with', letter);
                  }
                  p.set('page', '1');
                  setSearchParams(p);
                }}
                className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`}
              >
                {letter}
              </button>
            );
          })}
        </div>
      </div>
```

- [ ] **Step 4: Verify frontend builds**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Library.jsx
git commit -m "feat: add alphabetical nav bar and search clear button to Library"
```

---

### Task 4: Version bump and deploy

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && node --test tests/**/*.test.js`
Expected: All PASS

- [ ] **Step 2: Build frontend**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

- [ ] **Step 3: Version bump**

Update version in `backend/package.json` and `frontend/package.json` from `1.2.0` to `1.3.0`.

- [ ] **Step 4: Commit and push**

```bash
git add backend/package.json frontend/package.json
git commit -m "chore: bump version to 1.3.0 for Phase 8"
git push origin master
```
