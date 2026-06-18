# F17 — Orchestrator ↔ Game_shelf Graceful Degradation + Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Game_shelf cache integration fail gracefully against an offline, degraded, or version-skewed orchestrator, with no retry storms and a CI-enforceable guarantee that the orchestrator bearer token never reaches the frontend bundle.

**Architecture:** Frontend-only changes in the Game_shelf repo (the F14 backend proxy already injects `ORCH_TOKEN` server-side and maps offline→503/`orchestrator_offline`, degraded→503-with-body passthrough). A new `useCacheHealth` hook does ONE health check per page load (no polling) and surfaces three independent banners on the Cache dashboard — **offline** (unreachable), **degraded** (reachable but unhealthy), and **version skew** (advisory). The badge/count utilities are hardened to tolerate schema skew (missing `blocked`, unknown `status`, malformed `games`). A vitest src-scan test plus an npm `check:no-token` dist-grep script enforce the token-never-in-frontend invariant (Game_shelf has no `.github/workflows`).

**Tech Stack:** React 18 + Vite 6 + Tailwind + @tanstack/react-query v5 + lucide-react, ESM. vitest 2 + @testing-library/react. Node ESM scripts.

---

## Context the engineer needs (read before starting)

- **Branch:** `feat/f17-degradation` (already checked out; F14/F15/F16 merged to master).
- **Repo:** `/Users/karl/Documents/Claude Projects/Game_shelf` (NOT lancache_orchestrator). Game_shelf has **no** Solo Orchestrator framework hooks/gates.
- **The orchestrator `/api/v1/health` response** (forwarded verbatim by the Game_shelf backend's `GET /api/cache/health`):
  - Healthy: HTTP **200** + `{ status:'ok', version:'0.1.0', uptime_sec, scheduler_running, lancache_reachable, cache_volume_mounted, validator_healthy, git_sha }` (git_sha is 8 hex chars).
  - Degraded (e.g. DB pool unhealthy): HTTP **503** + the SAME body shape but `status:'degraded'`. **This is reachable, not offline.**
  - Unreachable: the Game_shelf backend's `forward()`/`callOrchestrator()` catches the transport error and returns HTTP **503** + `{ status:'orchestrator_offline' }` (no `version`).
- **`fetch()` does not throw on 503** — it only throws on a true network failure (which won't happen here because the request goes to the Game_shelf backend, always reachable). So the health hook distinguishes states by **body**, not by `res.ok`:
  - `body.status === 'orchestrator_offline'` → offline.
  - otherwise (has `version`) → reachable; `body.status === 'degraded'` → degraded, else healthy.
- **No retry storms:** all cache queries already use `retry:false`; global default `staleTime:30000`; no cache query sets `refetchInterval`. The new health query adds `staleTime:Infinity` (one check per page load). Do NOT add `refetchInterval` anywhere.
- **Skew is advisory / fail-open:** if `version` is absent or unparseable, show NO warning.
- **Existing files** (already merged, mirror their style):
  - `frontend/src/hooks/useCacheStatus.js` (+ `useCacheStatus.test.jsx`)
  - `frontend/src/utils/cacheBadge.js` (+ `cacheBadge.test.js`)
  - `frontend/src/pages/Cache.jsx` (+ `Cache.test.jsx`)
  - `frontend/package.json` scripts: `test` = `vitest run`, `build` = `vite build`.
- **Conventions:** data fetch via `useQuery` (`fetch(url,{credentials:'same-origin'})`); mutations/refresh via `queryClient.invalidateQueries` (no `useMutation`); cards `bg-gray-800 rounded-lg p-4`; tests `vitest`+RTL with a `QueryClientProvider` wrapper using `retry:false`.
- **Run tests:** `cd frontend && npm test <path>` (single file) or `npm test` (all). Shell cwd resets between Bash calls — `cd` at the start of each command.
- If `enforce-context7` blocks a Write/Edit (it shouldn't in this repo, but if it does): `resolve-library-id` with the EXACT package name + `query-docs`. `react`, `@tanstack/react-query`, `lucide-react`, `react-router-dom` are already researched this session.

## File Structure

- **Create** `frontend/src/utils/orchVersion.js` — `SUPPORTED_ORCH_VERSIONS` constant + pure `isVersionSkewed(version)`.
- **Create** `frontend/src/utils/orchVersion.test.js` — skew unit tests.
- **Create** `frontend/src/hooks/useCacheHealth.js` — one-shot health query → `{ isLoading, health, version, isOffline, isDegraded, isSkewed }`.
- **Create** `frontend/src/hooks/useCacheHealth.test.jsx` — healthy / degraded / offline / network-throw / skew.
- **Create** `frontend/src/no-orch-token.test.js` — scans `frontend/src` (excluding test files + itself) for `ORCH_TOKEN`; fails if present.
- **Create** `frontend/scripts/check-no-token.mjs` — greps `frontend/dist` (post-build) for `ORCH_TOKEN` and, if `ORCH_TOKEN` is set in env, its literal value; exits 1 if found.
- **Modify** `frontend/src/utils/cacheBadge.js` — harden `cacheCounts` against malformed entries (skip non-objects).
- **Modify** `frontend/src/utils/cacheBadge.test.js` — append tolerant-merge regression tests.
- **Modify** `frontend/src/hooks/useCacheStatus.js` — tolerate a malformed/missing `games` array (`Array.isArray` guards).
- **Modify** `frontend/src/hooks/useCacheStatus.test.jsx` — append malformed-array regression test.
- **Modify** `frontend/src/pages/Cache.jsx` — add degraded + skew banners (from `useCacheHealth`) and a Retry button on the offline banner.
- **Modify** `frontend/src/pages/Cache.test.jsx` — append degraded / skew / retry tests.
- **Modify** `frontend/package.json` — add `"check:no-token"` script.

---

### Task 1: Version-skew utility

**Files:**
- Create: `frontend/src/utils/orchVersion.js`
- Test: `frontend/src/utils/orchVersion.test.js`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/utils/orchVersion.test.js
import { describe, it, expect } from 'vitest';
import { isVersionSkewed, SUPPORTED_ORCH_VERSIONS } from './orchVersion';

describe('isVersionSkewed', () => {
  it('a supported version is not skewed', () => {
    expect(isVersionSkewed(SUPPORTED_ORCH_VERSIONS[0])).toBe(false);
  });

  it('an unsupported version is skewed', () => {
    expect(isVersionSkewed('9.9.9')).toBe(true);
  });

  it('fails open when the version is absent (null/undefined/empty)', () => {
    expect(isVersionSkewed(null)).toBe(false);
    expect(isVersionSkewed(undefined)).toBe(false);
    expect(isVersionSkewed('')).toBe(false);
  });

  it('a non-string version fails open (advisory only, never crashes)', () => {
    expect(isVersionSkewed(123)).toBe(false);
    expect(isVersionSkewed({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test src/utils/orchVersion.test.js`
Expected: FAIL — `Failed to resolve import './orchVersion'`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/utils/orchVersion.js
// Versions of the lancache orchestrator this build of Game_shelf has been
// verified against. Skew detection is ADVISORY and fail-open: an unknown or
// missing version never raises a warning (we'd rather stay quiet than cry wolf).
export const SUPPORTED_ORCH_VERSIONS = ['0.1.0'];

export function isVersionSkewed(version) {
  if (typeof version !== 'string' || version === '') return false; // fail open
  return !SUPPORTED_ORCH_VERSIONS.includes(version);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test src/utils/orchVersion.test.js`
Expected: PASS (4 tests).

---

### Task 2: `useCacheHealth` hook (one check per page load)

**Files:**
- Create: `frontend/src/hooks/useCacheHealth.js`
- Test: `frontend/src/hooks/useCacheHealth.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/hooks/useCacheHealth.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCacheHealth } from './useCacheHealth';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
beforeEach(() => vi.restoreAllMocks());

function stubFetch(value, { reject = false } = {}) {
  vi.stubGlobal('fetch', reject ? vi.fn().mockRejectedValue(new Error('network')) : vi.fn().mockResolvedValue(value));
}

async function renderUntilLoaded() {
  const r = renderHook(() => useCacheHealth(), { wrapper: makeWrapper() });
  await waitFor(() => expect(r.result.current.isLoading).toBe(false));
  return r;
}

describe('useCacheHealth', () => {
  it('healthy orchestrator (200) -> not offline, not degraded, version present', async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({ status: 'ok', version: '0.1.0', git_sha: 'abcd1234' }) });
    const { result } = await renderUntilLoaded();
    expect(result.current.isOffline).toBe(false);
    expect(result.current.isDegraded).toBe(false);
    expect(result.current.isSkewed).toBe(false);
    expect(result.current.version).toBe('0.1.0');
  });

  it('degraded orchestrator (503-with-body) -> reachable + degraded, NOT offline', async () => {
    stubFetch({ ok: false, status: 503, json: async () => ({ status: 'degraded', version: '0.1.0', git_sha: 'abcd1234' }) });
    const { result } = await renderUntilLoaded();
    expect(result.current.isOffline).toBe(false);
    expect(result.current.isDegraded).toBe(true);
    expect(result.current.version).toBe('0.1.0');
  });

  it('unreachable orchestrator (503 orchestrator_offline) -> offline, no health', async () => {
    stubFetch({ ok: false, status: 503, json: async () => ({ status: 'orchestrator_offline' }) });
    const { result } = await renderUntilLoaded();
    expect(result.current.isOffline).toBe(true);
    expect(result.current.isDegraded).toBe(false);
    expect(result.current.health).toBeNull();
  });

  it('network throw -> offline (fail safe)', async () => {
    stubFetch(null, { reject: true });
    const { result } = await renderUntilLoaded();
    expect(result.current.isOffline).toBe(true);
  });

  it('reachable but unsupported version -> skewed', async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({ status: 'ok', version: '9.9.9' }) });
    const { result } = await renderUntilLoaded();
    expect(result.current.isOffline).toBe(false);
    expect(result.current.isSkewed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test src/hooks/useCacheHealth.test.jsx`
Expected: FAIL — `Failed to resolve import './useCacheHealth'`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/hooks/useCacheHealth.js
import { useQuery } from '@tanstack/react-query';
import { isVersionSkewed } from '../utils/orchVersion';

// ONE health probe per page load. staleTime:Infinity + retry:false + no
// refetchInterval => no polling, no retry storms. The operator re-checks via
// the Retry button on the dashboard (which invalidates this query).
//
// /api/cache/health forwards the orchestrator's /api/v1/health verbatim:
//   200            -> { status:'ok',       version, git_sha, ... }   (healthy)
//   503 + body     -> { status:'degraded', version, git_sha, ... }   (reachable, unhealthy)
//   503 offline    -> { status:'orchestrator_offline' }              (unreachable)
// fetch() only throws on a real transport failure (-> treat as offline).
async function fetchCacheHealth() {
  let res;
  try {
    res = await fetch('/api/cache/health', { credentials: 'same-origin' });
  } catch {
    return { offline: true, health: null };
  }
  const body = await res.json().catch(() => ({}));
  if (body.status === 'orchestrator_offline') return { offline: true, health: null };
  return { offline: false, health: body };
}

export function useCacheHealth() {
  const { data, isLoading } = useQuery({
    queryKey: ['cacheHealth'],
    queryFn: fetchCacheHealth,
    staleTime: Infinity,
    retry: false,
  });

  const health = data?.health || null;
  const version = health?.version || null;
  const isOffline = Boolean(data?.offline);
  const isDegraded = !isOffline && health?.status === 'degraded';
  const isSkewed = !isOffline && isVersionSkewed(version);

  return { isLoading, health, version, isOffline, isDegraded, isSkewed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test src/hooks/useCacheHealth.test.jsx`
Expected: PASS (5 tests).

---

### Task 3: Tolerant field merging (schema-skew hardening)

The badge already falls through to `Unknown` for an unknown `status` and treats missing `blocked` as falsy — this task adds **regression tests that lock that in** and hardens `cacheCounts` + `useCacheStatus` against malformed data (null entries, non-array `games`).

**Files:**
- Modify: `frontend/src/utils/cacheBadge.js`
- Modify: `frontend/src/utils/cacheBadge.test.js`
- Modify: `frontend/src/hooks/useCacheStatus.js`
- Modify: `frontend/src/hooks/useCacheStatus.test.jsx`

- [ ] **Step 1: Write the failing tests (badge + counts)**

Append to `frontend/src/utils/cacheBadge.test.js` (keep existing imports/tests; add the imports referenced below if not already present — `cacheBadgeFor` and `cacheCounts` are exported from `./cacheBadge`):

```js
describe('cacheBadgeFor — schema-skew tolerance (F17)', () => {
  it('a tracked game missing the `blocked` field renders its status, not Blocked', () => {
    expect(cacheBadgeFor({ status: 'up_to_date', tracked: true }).label).toBe('Cached');
  });

  it('an unknown status value falls through to Unknown (never throws)', () => {
    expect(cacheBadgeFor({ status: 'teleporting', tracked: true }).label).toBe('Unknown');
  });

  it('a missing status falls through to Unknown', () => {
    expect(cacheBadgeFor({ tracked: true }).label).toBe('Unknown');
  });
});

describe('cacheCounts — malformed-entry tolerance (F17)', () => {
  it('skips null/non-object entries without crashing', () => {
    const c = cacheCounts([null, undefined, 42, { status: 'up_to_date' }]);
    expect(c.total).toBe(1);
    expect(c.cached).toBe(1);
  });

  it('a game missing `blocked` does not count as blocked', () => {
    const c = cacheCounts([{ status: 'up_to_date' }]);
    expect(c.blocked).toBe(0);
  });

  it('an unknown status is counted only toward total', () => {
    const c = cacheCounts([{ status: 'teleporting' }]);
    expect(c.total).toBe(1);
    expect(c.cached).toBe(0);
    expect(c.update_ready).toBe(0);
    expect(c.not_cached).toBe(0);
    expect(c.failed).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify the malformed-entry test fails**

Run: `cd frontend && npm test src/utils/cacheBadge.test.js`
Expected: the `skips null/non-object entries` test FAILS with `TypeError: Cannot read properties of null (reading 'blocked')` (the badge/missing-field tests already pass — that behavior pre-exists). This proves the new `cacheCounts` guard is needed.

- [ ] **Step 3: Harden `cacheCounts`**

In `frontend/src/utils/cacheBadge.js`, change the loop in `cacheCounts` to skip non-objects:

```js
export function cacheCounts(games = []) {
  const list = Array.isArray(games) ? games : [];
  const c = { total: 0, cached: 0, update_ready: 0, not_cached: 0, failed: 0, blocked: 0 };
  for (const g of list) {
    if (!g || typeof g !== 'object') continue; // tolerate malformed rows
    c.total += 1;
    if (g.blocked) c.blocked += 1;
    if (g.status === 'up_to_date') c.cached += 1;
    else if (g.status === 'pending_update') c.update_ready += 1;
    else if (g.status === 'not_downloaded') c.not_cached += 1;
    else if (g.status === 'failed' || g.status === 'validation_failed') c.failed += 1;
  }
  return c;
}
```

- [ ] **Step 4: Run to verify the badge/counts tests pass**

Run: `cd frontend && npm test src/utils/cacheBadge.test.js`
Expected: PASS (existing + 6 new).

- [ ] **Step 5: Write the failing test (useCacheStatus tolerates a non-array `games`)**

Append to `frontend/src/hooks/useCacheStatus.test.jsx` (mirror the wrapper/stub pattern already in that file):

```js
describe('useCacheStatus — malformed payload tolerance (F17)', () => {
  it('a non-array `games` payload yields empty results, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: null }) })
    );
    const { result } = renderHook(() => useCacheStatus(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.games).toEqual([]);
    expect(result.current.counts.total).toBe(0);
    expect(result.current.statusFor('steam', '123')).toBeUndefined();
  });
});
```

> NOTE: if `useCacheStatus.test.jsx` does not already import `renderHook`/`waitFor` or define `makeWrapper`, add them at the top to match this file's existing helpers (it uses `@testing-library/react` + a `QueryClientProvider` wrapper). Reuse the existing wrapper if one is defined under a different name.

- [ ] **Step 6: Run to verify it fails**

Run: `cd frontend && npm test src/hooks/useCacheStatus.test.jsx`
Expected: FAIL — `TypeError: games is not iterable` (the `for (const g of games)` loop over `null`).

- [ ] **Step 7: Harden `useCacheStatus`**

In `frontend/src/hooks/useCacheStatus.js`:

1. In `fetchCacheGames`, the success return becomes array-safe:

```js
  return { offline: false, games: Array.isArray(body.games) ? body.games : [] };
```

2. In the hook body, guard the local `games`:

```js
  const games = Array.isArray(data?.games) ? data.games : [];
```

(Leave the rest — the `map` build, `cacheCounts(games)`, and the returned shape — unchanged.)

- [ ] **Step 8: Run to verify it passes**

Run: `cd frontend && npm test src/hooks/useCacheStatus.test.jsx`
Expected: PASS (existing F15/F16 tests + the new one).

---

### Task 4: Dashboard banners — degraded + skew + Retry

**Files:**
- Modify: `frontend/src/pages/Cache.jsx`
- Modify: `frontend/src/pages/Cache.test.jsx`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/pages/Cache.test.jsx` (the file already stubs a global `fetch` and has a `wrap()` helper + `beforeEach(vi.restoreAllMocks)`):

```js
import userEvent from '@testing-library/user-event';

describe('Cache page — F17 degradation banners', () => {
  it('shows a degraded banner (reachable but unhealthy), not the offline banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url) => {
        if (String(url).includes('/api/cache/health')) {
          return Promise.resolve({ ok: false, status: 503, json: async () => ({ status: 'degraded', version: '0.1.0' }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ games: [], platforms: [], jobs: [], block_list: [] }) });
      })
    );
    wrap(<Cache />);
    expect(await screen.findByText(/degraded state/i)).toBeInTheDocument();
    expect(screen.queryByText(/orchestrator is offline/i)).not.toBeInTheDocument();
  });

  it('shows a version-skew banner when the orchestrator reports an unsupported version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url) => {
        if (String(url).includes('/api/cache/health')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ok', version: '9.9.9' }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ games: [], platforms: [], jobs: [], block_list: [] }) });
      })
    );
    wrap(<Cache />);
    expect(await screen.findByText(/version skew/i)).toBeInTheDocument();
    expect(screen.getByText(/9\.9\.9/)).toBeInTheDocument();
  });

  it('the offline banner exposes a Retry button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ status: 'orchestrator_offline' }) })
    );
    wrap(<Cache />);
    await screen.findByText(/orchestrator is offline/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    // Clicking re-runs the cache queries; fetch is called again for the refetch.
    expect(fetch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd frontend && npm test src/pages/Cache.test.jsx`
Expected: the 3 new tests FAIL (no degraded/skew text, no Retry button); the 2 existing tests still PASS.

- [ ] **Step 3: Implement the banners + Retry**

Replace `frontend/src/pages/Cache.jsx` with:

```jsx
import { CloudOff, AlertTriangle, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCacheStatus } from '../hooks/useCacheStatus';
import { useCacheHealth } from '../hooks/useCacheHealth';
import { SUPPORTED_ORCH_VERSIONS } from '../utils/orchVersion';
import CacheStats from '../components/cache/CacheStats';
import PlatformAuthCards from '../components/cache/PlatformAuthCards';
import RecentJobs from '../components/cache/RecentJobs';
import BlockListManager from '../components/cache/BlockListManager';

export default function Cache() {
  const queryClient = useQueryClient();
  const { isOffline } = useCacheStatus();
  const { isDegraded, isSkewed, version } = useCacheHealth();

  // Re-run every cache query on demand (one place to refresh the whole page).
  const retry = () =>
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('cache') });

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-bold text-white">Lancache</h1>

      {isOffline && (
        <div className="bg-amber-900/40 border border-amber-700 rounded-lg p-3 flex items-center gap-2 text-amber-200 text-sm">
          <CloudOff size={16} />
          <span className="flex-1">The orchestrator is offline — cache data and actions are unavailable.</span>
          <button
            onClick={retry}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-800 hover:bg-amber-700 text-amber-100"
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      )}

      {!isOffline && isDegraded && (
        <div className="bg-orange-900/40 border border-orange-700 rounded-lg p-3 flex items-center gap-2 text-orange-200 text-sm">
          <AlertTriangle size={16} />
          <span className="flex-1">
            The orchestrator is reachable but reports a degraded state — some cache operations may be unreliable.
          </span>
          <button
            onClick={retry}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-orange-800 hover:bg-orange-700 text-orange-100"
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      )}

      {!isOffline && isSkewed && (
        <div className="bg-yellow-900/40 border border-yellow-700 rounded-lg p-3 flex items-start gap-2 text-yellow-200 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Version skew — the orchestrator reports v{version}, which this build of Game_shelf has not been
            verified against (supported: {SUPPORTED_ORCH_VERSIONS.join(', ')}). Cache features may behave unexpectedly.
          </span>
        </div>
      )}

      <CacheStats />
      <PlatformAuthCards />
      <RecentJobs />
      <BlockListManager />
    </div>
  );
}
```

- [ ] **Step 4: Run to verify all Cache tests pass**

Run: `cd frontend && npm test src/pages/Cache.test.jsx`
Expected: PASS (2 existing + 3 new).

---

### Task 5: Token-never-in-frontend (the F17 security invariant)

Game_shelf has **no** `.github/workflows`, so this ships as (a) a vitest src-scan test that runs in `npm test`, and (b) an npm `check:no-token` script that greps the built `dist` after `vite build`. Both look for the identifier `ORCH_TOKEN` (covers a literal `ORCH_TOKEN`/`VITE_ORCH_TOKEN` leak — Vite only inlines `VITE_`-prefixed env, so a bare `ORCH_TOKEN` can only appear via a hardcode/mistake). The dist script additionally greps for the literal token value when `ORCH_TOKEN` is present in the environment.

**Files:**
- Create: `frontend/src/no-orch-token.test.js`
- Create: `frontend/scripts/check-no-token.mjs`
- Modify: `frontend/package.json`

- [ ] **Step 1: Write the failing test (src scan)**

```js
// frontend/src/no-orch-token.test.js
// F17 security invariant: the orchestrator bearer token must NEVER live in the
// frontend. It belongs only in the Game_shelf backend env + Authorization header
// (F14). This scans the frontend source tree for the `ORCH_TOKEN` identifier.
// Excludes test files (and itself) so the literal here doesn't self-trip.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url)); // frontend/src
const FORBIDDEN = 'ORCH_TOKEN';
const SKIP_FILE = /\.test\.[jt]sx?$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(jsx?|tsx?|mjs)$/.test(entry) && !SKIP_FILE.test(entry)) out.push(p);
  }
  return out;
}

describe('frontend never references the orchestrator token', () => {
  it(`no source file under src/ contains "${FORBIDDEN}"`, () => {
    const offenders = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes(FORBIDDEN));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it passes (the codebase is already clean)**

Run: `cd frontend && npm test src/no-orch-token.test.js`
Expected: PASS — there are no `ORCH_TOKEN` references in `src/` today. (This guard test PASSES on a clean tree by design; it exists to FAIL if someone later leaks the token.)

- [ ] **Step 3: Prove the guard actually catches a leak (temporary red)**

Temporarily create `frontend/src/__leak_probe.js` containing the single line `export const x = 'ORCH_TOKEN';`, then:

Run: `cd frontend && npm test src/no-orch-token.test.js`
Expected: FAIL — `offenders` includes `__leak_probe.js`. This confirms the scanner detects a real leak.

Then DELETE the probe:

Run: `rm "frontend/src/__leak_probe.js"`
Re-run: `cd frontend && npm test src/no-orch-token.test.js` → PASS.

- [ ] **Step 4: Write the dist-grep script**

```js
// frontend/scripts/check-no-token.mjs
// Post-build guard: fail if the built bundle (frontend/dist) contains the
// orchestrator token identifier or its literal value. Run AFTER `vite build`.
//   node scripts/check-no-token.mjs
// If ORCH_TOKEN is set in the environment, its literal value is also checked.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const needles = ['ORCH_TOKEN'];
if (process.env.ORCH_TOKEN && process.env.ORCH_TOKEN.length >= 8) {
  needles.push(process.env.ORCH_TOKEN);
}

if (!existsSync(DIST)) {
  console.error(`check-no-token: ${DIST}/ not found — run \`vite build\` first.`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(DIST)) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary/unreadable asset — skip
  }
  for (const needle of needles) {
    if (text.includes(needle)) offenders.push(`${file} contains "${needle === process.env.ORCH_TOKEN ? '<ORCH_TOKEN value>' : needle}"`);
  }
}

if (offenders.length) {
  console.error('check-no-token: FAIL — orchestrator token leaked into the frontend bundle:');
  for (const o of offenders) console.error(`  - ${o}`);
  process.exit(1);
}
console.log('check-no-token: OK — no orchestrator token in the built bundle.');
```

- [ ] **Step 5: Wire the npm script**

In `frontend/package.json`, add to `"scripts"` (alongside `build`):

```json
    "check:no-token": "node scripts/check-no-token.mjs"
```

- [ ] **Step 6: Verify the dist script end-to-end**

Run: `cd frontend && npm run build && npm run check:no-token`
Expected: build succeeds, then `check-no-token: OK — no orchestrator token in the built bundle.` (exit 0).

---

### Task 6: Full verification + commit + push + PR

No per-task commits were made. This task runs the complete suite, then a SINGLE commit, push, and PR.

- [ ] **Step 1: Full frontend test suite**

Run: `cd frontend && npm test 2>&1 | tee /Users/karl/f17-frontend.log`
Expected: all suites PASS (existing F14/F15/F16 + the new orchVersion / useCacheHealth / cacheBadge / useCacheStatus / Cache / no-orch-token tests). Read the log to confirm 0 failures.

- [ ] **Step 2: Build + token dist-grep**

Run: `cd frontend && npm run build && npm run check:no-token`
Expected: build OK, `check-no-token: OK`.

- [ ] **Step 3: Backend tests (no NEW failures)**

Run: `cd backend && node --test 'tests/**/*.test.js' 2>&1 | tee /Users/karl/f17-backend.log`
Expected: same result as master — only the 2 known pre-existing failures (server.test version string; setup/qr). No NEW failures. (F17 is frontend-only; this is a regression check.)

- [ ] **Step 4: Present commit structure options, THEN commit**

Bring A/B/C commit-structure options to the user and WAIT for an explicit pick before committing (do not interpret any hook relay as approval). Recommended default (single feat commit):

```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf"
git add frontend/src/utils/orchVersion.js frontend/src/utils/orchVersion.test.js \
        frontend/src/hooks/useCacheHealth.js frontend/src/hooks/useCacheHealth.test.jsx \
        frontend/src/no-orch-token.test.js frontend/scripts/check-no-token.mjs \
        frontend/src/utils/cacheBadge.js frontend/src/utils/cacheBadge.test.js \
        frontend/src/hooks/useCacheStatus.js frontend/src/hooks/useCacheStatus.test.jsx \
        frontend/src/pages/Cache.jsx frontend/src/pages/Cache.test.jsx \
        frontend/package.json \
        docs/superpowers/plans/2026-06-18-f17-degradation.md
git commit -m "feat(cache): F17 graceful degradation + token-never-in-frontend guard

- useCacheHealth: one health probe per page load (staleTime:Infinity, retry:false,
  no polling); distinguishes offline (unreachable) vs degraded (503-with-body)
- Cache dashboard: degraded + version-skew banners; Retry button on the offline banner
- orchVersion: advisory, fail-open skew detection vs SUPPORTED_ORCH_VERSIONS
- tolerant field merging: cacheCounts/useCacheStatus tolerate malformed/missing games;
  badge regression tests for unknown status + missing blocked
- security invariant: vitest src-scan + check:no-token dist-grep ensure ORCH_TOKEN
  never reaches the frontend bundle

Completes the F14–F17 cache integration (F1–F17 MVP).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Push (Claude pushes; user merges)**

The orchestrator repo is parked off `main` (branch `chore/gameshelf-cross-repo`) so the branch-safety hook allows the cross-repo push. Push in a SEPARATE command from any checkout:

```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf" && git push -u origin feat/f17-degradation
```

- [ ] **Step 6: Open the PR (do NOT merge — user merges on GitHub)**

```bash
cd "/Users/karl/Documents/Claude Projects/Game_shelf" && gh pr create \
  --title "F17 — graceful degradation + token-never-in-frontend" \
  --body "$(cat <<'EOF'
## F17 — Orchestrator ↔ Game_shelf Graceful Degradation + Security

Final feature of the F14–F17 cache integration (completes the F1–F17 MVP).

### What
- **Version-skew detection** — new `useCacheHealth` hook does ONE `/api/cache/health` probe per page load (no polling), surfaces a banner when the orchestrator reports a version outside `SUPPORTED_ORCH_VERSIONS` (advisory, fail-open).
- **Degraded vs offline** — the hook distinguishes a reachable-but-degraded orchestrator (503-with-body) from an unreachable one (`orchestrator_offline`); the dashboard shows a distinct banner for each.
- **No retry storms** — all cache queries are `retry:false` + sane `staleTime` + no `refetchInterval`; a manual **Retry** button on the offline/degraded banners re-runs the cache queries on demand.
- **Tolerant field merging** — `cacheCounts`/`useCacheStatus` tolerate malformed/missing `games`; badge regression tests lock in unknown-status → `Unknown` and missing-`blocked` → not blocked.
- **Token never in the frontend** — a vitest src-scan test (runs in `npm test`) plus an npm `check:no-token` dist-grep guarantee `ORCH_TOKEN` only ever lives in the backend env + Authorization header.

### Test
- Frontend: full `npm test` green (new orchVersion / useCacheHealth / tolerant-merge / banner / token-scan suites + existing F14–F16).
- `npm run build && npm run check:no-token` → OK.
- Backend: `node --test` — no new failures.

> Live verification against the real orchestrator still needs the orchestrator LAN-bind (tracked separately).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Report**

Tell the user the PR is open and F17 completes the **F1–F17 MVP** (next gate: Phase 2→3). Note that live verification still needs the orchestrator LAN-bind + firewall (standing follow-up) and the live F8 driver UAT (needs Steam 2FA).

---

## Self-Review

- **Spec coverage (§7 graceful degradation + security):** version-skew detection (Task 1+2+4) ✅; no-retry-storms — confirmed existing config + new health query `staleTime:Infinity` + Retry button (Task 2+4) ✅; tolerant field merging (Task 3) ✅; token-never-in-frontend, CI-equivalent given no `.github/workflows` (Task 5) ✅; degraded-vs-offline distinction (Task 2+4) ✅.
- **Placeholder scan:** none — every code/test step has complete content.
- **Type/name consistency:** `useCacheHealth` returns `{ isLoading, health, version, isOffline, isDegraded, isSkewed }` (defined Task 2, consumed Task 4); `isVersionSkewed`/`SUPPORTED_ORCH_VERSIONS` (Task 1, used Task 2 + Task 4); `cacheCounts`/`useCacheStatus` guards (Task 3) match existing exports. Retry uses `queryClient.invalidateQueries({ predicate })` matching v5 API.
- **Fail-open guarantee:** skew is advisory — absent/unparseable version → no banner (Task 1 tests). Offline supersedes degraded/skew (`!isOffline &&` guards). Health probe failure → treated as offline, never throws to the UI.
