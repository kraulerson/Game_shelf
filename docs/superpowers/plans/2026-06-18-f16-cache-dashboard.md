# F16 — Cache Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **NO per-task commits.** Implement all tasks TDD-style, then Task 8 = full frontend (`npm test`) + backend (`node --test`, no new failures) + a single `feat(cache)` commit (bring A/B/C structure to the user FIRST). I (Claude) push the branch, then open the PR.

**Goal:** A `/cache` dashboard page showing cache stats, per-platform auth status (with copy-pasteable reconnect commands), recent jobs, and block-list management — each section independently fetched and error-isolated so one failure (or the orchestrator being offline) never blanks the page.

**Architecture:** `pages/Cache.jsx` renders four self-contained section components, each with its own `useQuery` against an `/api/cache/*` endpoint (so a 500/offline in one isolates to that section). A page-level offline banner is driven off the shared `useCacheStatus` query. Stats reuse that same `['cacheStatus']` query (extended to expose `games` + derived `counts`) — no extra fetch.

**Tech Stack:** React 18, Vite, Tailwind, `@tanstack/react-query`, `lucide-react`. Tests: vitest + RTL (set up in F15).

**Conventions:**
- Fetch: `fetch('/api/…', { credentials: 'same-origin' }).then(r => r.json())` in `useQuery`. Mutations: plain `fetch(…, { method })` + `queryClient.invalidateQueries({ queryKey })` (no `useMutation`).
- Cards/sections: `bg-gray-800 rounded-lg p-4` on the dark theme; `lucide-react` icons.
- Routes live in `App.jsx`'s `AuthenticatedLayout` block (alongside `/settings`). Nav links in `Nav.jsx` (desktop + mobile).
- Run frontend tests: `cd frontend && npm test` (or `npm test <path>`).

**Endpoint shapes (forwarded as-is by the F14 proxy):**
- `GET /api/cache/games` → `{ games: [{ id, platform, app_id, status, blocked, title? }], meta }` (full set; or `503 {status:'orchestrator_offline'}`).
- `GET /api/cache/jobs?limit=25&sort=id:desc` → `{ jobs: [{ id, kind, state, platform, game_id, source, created_at? }], meta }`.
- `GET /api/cache/platforms` → `{ platforms: [{ name, auth_status, auth_method, last_sync_at, last_error }], meta }`.
- `GET /api/cache/block-list` → `{ block_list: [{ id, platform, app_id, reason, source, blocked_at }], meta }`; `POST {platform, app_id, reason?}`; `DELETE /:platform/:app_id`.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/utils/cacheBadge.js` | add pure `cacheCounts(games)` |
| `frontend/src/hooks/useCacheStatus.js` | also return `games` + `counts` |
| `frontend/src/components/cache/CacheStats.jsx` | **new** — counts tiles |
| `frontend/src/components/cache/PlatformAuthCards.jsx` | **new** — auth cards + copy reconnect |
| `frontend/src/components/cache/RecentJobs.jsx` | **new** — recent 25 jobs |
| `frontend/src/components/cache/BlockListManager.jsx` | **new** — list + filter + add/remove |
| `frontend/src/pages/Cache.jsx` | **new** — assembles the sections + offline banner |
| `frontend/src/App.jsx` | add the `/cache` route |
| `frontend/src/components/Nav.jsx` | add the "Cache" nav link (desktop + mobile) |

---

## Task 1: `cacheCounts` + extend `useCacheStatus`

**Files:**
- Modify: `frontend/src/utils/cacheBadge.js`, `frontend/src/utils/cacheBadge.test.js`
- Modify: `frontend/src/hooks/useCacheStatus.js`, `frontend/src/hooks/useCacheStatus.test.jsx`

- [ ] **Step 1: Write the failing tests**

`cacheBadge.test.js` (append):
```js
import { cacheCounts } from './cacheBadge';

describe('cacheCounts', () => {
  it('tallies by status + blocked + total', () => {
    const games = [
      { status: 'up_to_date', blocked: false },
      { status: 'up_to_date', blocked: true },
      { status: 'pending_update', blocked: false },
      { status: 'not_downloaded', blocked: false },
      { status: 'failed', blocked: false },
    ];
    expect(cacheCounts(games)).toEqual({
      total: 5, cached: 2, update_ready: 1, not_cached: 1, failed: 1, blocked: 1,
    });
  });
  it('empty -> zeros', () => {
    expect(cacheCounts([])).toEqual({ total: 0, cached: 0, update_ready: 0, not_cached: 0, failed: 0, blocked: 0 });
  });
});
```

`useCacheStatus.test.jsx` (append a case to the existing first test, or a new it):
```js
it('exposes games + counts', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ games: [
      { id: 1, platform: 'steam', app_id: '1', status: 'up_to_date', blocked: false },
      { id: 2, platform: 'steam', app_id: '2', status: 'failed', blocked: true },
    ] }),
  }));
  const { result } = renderHook(() => useCacheStatus(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.games).toHaveLength(2);
  expect(result.current.counts.total).toBe(2);
  expect(result.current.counts.failed).toBe(1);
  expect(result.current.counts.blocked).toBe(1);
});
```

- [ ] **Step 2: Run to verify red** — `cd frontend && npm test src/utils/cacheBadge.test.js src/hooks/useCacheStatus.test.jsx`. Expected: FAIL.

- [ ] **Step 3: Implement** — `cacheBadge.js` (append):
```js
// Tally a games list by user-facing buckets for the dashboard stats.
export function cacheCounts(games = []) {
  const c = { total: 0, cached: 0, update_ready: 0, not_cached: 0, failed: 0, blocked: 0 };
  for (const g of games) {
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

`useCacheStatus.js` — import `cacheCounts` and add to the return:
```js
import { cacheCounts } from '../utils/cacheBadge';
// ...
  const games = data?.games || [];
  // ...build map from games...
  return {
    isLoading,
    isOffline: Boolean(data?.offline),
    statusFor: (platform, appId) => map.get(`${platform}:${appId}`),
    games,
    counts: cacheCounts(games),
  };
```

- [ ] **Step 4: Run to verify green** — same command. Expected: PASS (incl. the existing F15 tests — additive).

---

## Task 2: `CacheStats` section

**Files:**
- Create: `frontend/src/components/cache/CacheStats.jsx`, `frontend/src/components/cache/CacheStats.test.jsx`

- [ ] **Step 1: Write the failing test**
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CacheStats from './CacheStats';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

it('shows counts from /api/cache/games', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ games: [
      { id: 1, platform: 'steam', app_id: '1', status: 'up_to_date', blocked: false },
      { id: 2, platform: 'steam', app_id: '2', status: 'pending_update', blocked: false },
    ] }),
  }));
  wrap(<CacheStats />);
  expect(await screen.findByText('Cached')).toBeInTheDocument();
  expect(screen.getByText('Update ready')).toBeInTheDocument();
  // counts derive from the 2 stubbed games (cached=1, update_ready=1)
  expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run to verify red.**

- [ ] **Step 3: Implement `CacheStats.jsx`**
```jsx
import { useCacheStatus } from '../../hooks/useCacheStatus';

const TILES = [
  ['Total', 'total', 'text-gray-200'],
  ['Cached', 'cached', 'text-green-400'],
  ['Update ready', 'update_ready', 'text-amber-400'],
  ['Not cached', 'not_cached', 'text-gray-400'],
  ['Failed', 'failed', 'text-red-400'],
  ['Blocked', 'blocked', 'text-slate-300'],
];

export default function CacheStats() {
  const { counts, isLoading } = useCacheStatus();
  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">Cache stats</h2>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {TILES.map(([label, key, color]) => (
          <div key={key} className="bg-gray-900 rounded-lg p-3 text-center">
            <div className={`text-2xl font-bold ${color}`}>{isLoading ? '—' : counts[key]}</div>
            <div className="text-xs text-gray-500 mt-1">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify green.**

---

## Task 3: `PlatformAuthCards` (with copy reconnect)

**Files:**
- Create: `frontend/src/components/cache/PlatformAuthCards.jsx`, `frontend/src/components/cache/PlatformAuthCards.test.jsx`

- [ ] **Step 1: Write the failing test**
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PlatformAuthCards from './PlatformAuthCards';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

it('shows a card per platform and a reconnect command when not ok', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ platforms: [
      { name: 'steam', auth_status: 'expired', auth_method: 'steam_cm', last_sync_at: null },
      { name: 'epic', auth_status: 'ok', auth_method: 'epic_oauth', last_sync_at: '2026-06-18' },
    ] }),
  }));
  wrap(<PlatformAuthCards />);
  expect(await screen.findByText('steam')).toBeInTheDocument();
  expect(screen.getByText('orchestrator-cli auth steam')).toBeInTheDocument(); // reconnect cmd (expired)
  expect(screen.queryByText('orchestrator-cli auth epic')).not.toBeInTheDocument(); // ok -> no cmd
});

it('copy button writes the command to the clipboard', async () => {
  const writeText = vi.fn().mockResolvedValue();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ platforms: [{ name: 'steam', auth_status: 'never', auth_method: 'steam_cm', last_sync_at: null }] }),
  }));
  wrap(<PlatformAuthCards />);
  await screen.findByText('steam');
  await userEvent.click(screen.getByRole('button', { name: /copy/i }));
  expect(writeText).toHaveBeenCalledWith('orchestrator-cli auth steam');
});
```

- [ ] **Step 2: Run to verify red.**

- [ ] **Step 3: Implement `PlatformAuthCards.jsx`**
```jsx
import { useQuery } from '@tanstack/react-query';
import { Copy, CheckCircle, AlertCircle } from 'lucide-react';

function statusTone(s) {
  return s === 'ok' ? 'text-green-400' : 'text-amber-400';
}

export default function PlatformAuthCards() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['cachePlatforms'],
    queryFn: () => fetch('/api/cache/platforms', { credentials: 'same-origin' }).then((r) => r.json()),
    retry: false,
  });

  if (isLoading) return <SectionShell title="Platforms"><p className="text-gray-500 text-sm">Loading…</p></SectionShell>;
  if (isError || data?.status === 'orchestrator_offline' || !data?.platforms)
    return <SectionShell title="Platforms"><p className="text-gray-500 text-sm">Platform status unavailable.</p></SectionShell>;

  return (
    <SectionShell title="Platforms">
      <div className="grid sm:grid-cols-2 gap-3">
        {data.platforms.map((p) => {
          const ok = p.auth_status === 'ok';
          const cmd = `orchestrator-cli auth ${p.name}`;
          return (
            <div key={p.name} className="bg-gray-900 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="text-white text-sm font-medium">{p.name}</span>
                <span className={`flex items-center gap-1 text-xs ${statusTone(p.auth_status)}`}>
                  {ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />} {p.auth_status}
                </span>
              </div>
              {p.last_sync_at && <div className="text-xs text-gray-500 mt-1">last sync: {p.last_sync_at}</div>}
              {!ok && (
                <div className="mt-2 flex items-center gap-2">
                  <code className="text-xs bg-gray-800 px-2 py-1 rounded text-gray-300 flex-1 truncate">{cmd}</code>
                  <button
                    className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 flex items-center gap-1"
                    onClick={() => navigator.clipboard?.writeText(cmd)}
                  >
                    <Copy size={12} /> Copy
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}

function SectionShell({ title, children }) {
  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">{title}</h2>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify green.**

---

## Task 4: `RecentJobs` section

**Files:**
- Create: `frontend/src/components/cache/RecentJobs.jsx`, `frontend/src/components/cache/RecentJobs.test.jsx`

- [ ] **Step 1: Write the failing test**
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RecentJobs from './RecentJobs';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

it('lists recent jobs and requests limit=25 sorted desc', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ jobs: [{ id: 7, kind: 'prefill', state: 'running', platform: 'steam', game_id: 3 }] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  wrap(<RecentJobs />);
  expect(await screen.findByText('prefill')).toBeInTheDocument();
  expect(screen.getByText('running')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/cache/jobs?limit=25&sort=id:desc',
    expect.objectContaining({ credentials: 'same-origin' })
  );
});

it('isolates its own error (renders a message, not a throw)', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ status: 'orchestrator_offline' }) }));
  wrap(<RecentJobs />);
  expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify red.**

- [ ] **Step 3: Implement `RecentJobs.jsx`**
```jsx
import { useQuery } from '@tanstack/react-query';

async function fetchJobs() {
  const res = await fetch('/api/cache/jobs?limit=25&sort=id:desc', { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === 'orchestrator_offline') throw new Error('jobs unavailable');
  return body.jobs || [];
}

export default function RecentJobs() {
  const { data: jobs, isLoading, isError } = useQuery({ queryKey: ['cacheJobs'], queryFn: fetchJobs, retry: false });

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">Recent jobs</h2>
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : isError ? (
        <p className="text-gray-500 text-sm">Jobs unavailable.</p>
      ) : jobs.length === 0 ? (
        <p className="text-gray-500 text-sm">No recent jobs.</p>
      ) : (
        <div className="space-y-1">
          {jobs.map((j) => (
            <div key={j.id} className="flex items-center gap-3 text-sm py-1 border-b border-gray-700/50 last:border-0">
              <span className="text-gray-300 w-28">{j.kind}</span>
              <span className="text-gray-400 w-20">{j.state}</span>
              <span className="text-gray-500 w-16">{j.platform || '—'}</span>
              <span className="text-gray-600 ml-auto text-xs">{j.game_id ? `game ${j.game_id}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify green.**

---

## Task 5: `BlockListManager` (list + filter + add/remove)

**Files:**
- Create: `frontend/src/components/cache/BlockListManager.jsx`, `frontend/src/components/cache/BlockListManager.test.jsx`

- [ ] **Step 1: Write the failing test**
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BlockListManager from './BlockListManager';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

const list = { block_list: [
  { id: 1, platform: 'steam', app_id: '730', reason: 'no', source: 'cli', blocked_at: 't' },
  { id: 2, platform: 'epic', app_id: 'fortnite', reason: null, source: 'api', blocked_at: 't' },
] };

it('lists entries and filters them client-side', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => list }));
  wrap(<BlockListManager />);
  expect(await screen.findByText('730')).toBeInTheDocument();
  expect(screen.getByText('fortnite')).toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText(/filter/i), 'fort');
  expect(screen.queryByText('730')).not.toBeInTheDocument();
  expect(screen.getByText('fortnite')).toBeInTheDocument();
});

it('remove issues a DELETE and invalidates', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => list })
    .mockResolvedValue({ ok: true, json: async () => ({ removed: 1 }) });
  vi.stubGlobal('fetch', fetchMock);
  wrap(<BlockListManager />);
  await screen.findByText('730');
  await userEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/cache/block-list/steam/730', expect.objectContaining({ method: 'DELETE' }))
  );
});
```

- [ ] **Step 2: Run to verify red.**

- [ ] **Step 3: Implement `BlockListManager.jsx`**
```jsx
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';

async function fetchBlockList() {
  const res = await fetch('/api/cache/block-list', { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === 'orchestrator_offline') throw new Error('block-list unavailable');
  return body.block_list || [];
}

export default function BlockListManager() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [platform, setPlatform] = useState('steam');
  const [appId, setAppId] = useState('');
  const { data: rows, isLoading, isError } = useQuery({ queryKey: ['cacheBlockList'], queryFn: fetchBlockList, retry: false });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['cacheBlockList'] });

  async function add(e) {
    e.preventDefault();
    if (!appId.trim()) return;
    await fetch('/api/cache/block-list', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, app_id: appId.trim(), source: 'gameshelf' }),
    });
    setAppId('');
    invalidate();
  }

  async function remove(p, a) {
    await fetch(`/api/cache/block-list/${p}/${encodeURIComponent(a)}`, { method: 'DELETE', credentials: 'same-origin' });
    invalidate();
  }

  const shown = (rows || []).filter(
    (r) => !filter || `${r.platform} ${r.app_id} ${r.reason || ''}`.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">Block list</h2>
      <form onSubmit={add} className="flex gap-2 mb-3">
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="bg-gray-900 text-sm text-white rounded px-2 py-1">
          <option value="steam">steam</option>
          <option value="epic">epic</option>
        </select>
        <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="app_id" className="bg-gray-900 text-sm text-white rounded px-2 py-1 flex-1" />
        <button type="submit" className="text-sm px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white">Block</button>
      </form>
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="bg-gray-900 text-sm text-white rounded px-2 py-1 w-full mb-2" />
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : isError ? (
        <p className="text-gray-500 text-sm">Block list unavailable.</p>
      ) : (
        <div className="max-h-72 overflow-y-auto space-y-1">
          {shown.map((r) => (
            <div key={r.id} className="flex items-center gap-3 text-sm py-1">
              <span className="text-gray-400 w-16">{r.platform}</span>
              <span className="text-gray-200 flex-1 truncate">{r.app_id}</span>
              {r.reason && <span className="text-gray-500 text-xs truncate max-w-[40%]">{r.reason}</span>}
              <button onClick={() => remove(r.platform, r.app_id)} className="text-gray-500 hover:text-red-400 flex items-center gap-1 text-xs" aria-label={`remove ${r.app_id}`}>
                <Trash2 size={12} /> Remove
              </button>
            </div>
          ))}
          {shown.length === 0 && <p className="text-gray-500 text-sm">No entries.</p>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify green.**

---

## Task 6: `Cache` page (assemble + offline banner)

**Files:**
- Create: `frontend/src/pages/Cache.jsx`, `frontend/src/pages/Cache.test.jsx`

- [ ] **Step 1: Write the failing test**
```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Cache from './Cache';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

it('renders all sections', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [], platforms: [], jobs: [], block_list: [] }) }));
  wrap(<Cache />);
  expect(await screen.findByText('Cache stats')).toBeInTheDocument();
  expect(screen.getByText('Platforms')).toBeInTheDocument();
  expect(screen.getByText('Recent jobs')).toBeInTheDocument();
  expect(screen.getByText('Block list')).toBeInTheDocument();
});

it('shows an offline banner when the orchestrator is offline', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ status: 'orchestrator_offline' }) }));
  wrap(<Cache />);
  expect(await screen.findByText(/orchestrator is offline/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify red.**

- [ ] **Step 3: Implement `Cache.jsx`**
```jsx
import { CloudOff } from 'lucide-react';
import { useCacheStatus } from '../hooks/useCacheStatus';
import CacheStats from '../components/cache/CacheStats';
import PlatformAuthCards from '../components/cache/PlatformAuthCards';
import RecentJobs from '../components/cache/RecentJobs';
import BlockListManager from '../components/cache/BlockListManager';

export default function Cache() {
  const { isOffline } = useCacheStatus();
  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-bold text-white">Lancache</h1>
      {isOffline && (
        <div className="bg-amber-900/40 border border-amber-700 rounded-lg p-3 flex items-center gap-2 text-amber-200 text-sm">
          <CloudOff size={16} /> The orchestrator is offline — cache data and actions are unavailable.
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

- [ ] **Step 4: Run to verify green.**

---

## Task 7: Route + nav link

**Files:**
- Modify: `frontend/src/App.jsx`, `frontend/src/components/Nav.jsx`

- [ ] **Step 1: Add the route** — in `App.jsx`, import and add the route inside the `AuthenticatedLayout` block, alongside `/settings`:
```jsx
import Cache from './pages/Cache';
// ...
            <Route path="/settings" element={<Settings />} />
            <Route path="/cache" element={<Cache />} />
```

- [ ] **Step 2: Add the nav link** — in `Nav.jsx`, add `HardDrive` to the lucide import, then add a Cache link in BOTH the desktop and mobile link lists (mirroring the Settings link, with `onClick={() => setMenuOpen(false)}` in the mobile one):
```jsx
import { Library, Settings, LogOut, Menu, X, Loader2, HardDrive } from 'lucide-react';
// desktop (after the Settings <Link>):
          <Link to="/cache" className={linkClass('/cache')}>
            <HardDrive size={16} /> Cache
          </Link>
// mobile (after the Settings <Link>):
          <Link to="/cache" className={linkClass('/cache')} onClick={() => setMenuOpen(false)}>
            <HardDrive size={16} /> Cache
          </Link>
```

- [ ] **Step 3: Verify the build** — `cd frontend && npm run build`. Expected: builds clean (the `/cache` route + nav link compile).

---

## Task 8: Full sweep, commit, PR

- [ ] **Step 1: Frontend suite** — `cd frontend && npm test`. Expected: all pass (F15 + the new F16 section/page tests).
- [ ] **Step 2: Build** — `cd frontend && npm run build`. Expected: clean.
- [ ] **Step 3: Backend unaffected** — `cd backend && node --test 'tests/**/*.test.js'`. Expected: same as before (the 2 pre-existing failures; no NEW ones).
- [ ] **Step 4:** Present the **A/B/C commit structure**, then a single `feat(cache): F16 cache dashboard` commit.
- [ ] **Step 5:** Push `feat/f16-cache-dashboard` (Claude pushes; the orchestrator repo is parked off `main`). Open the PR. Do NOT merge.

---

## Notes
- **Section error isolation** is per-`useQuery` (each section throws inside its own queryFn → its own `isError` state) — no React error boundaries needed.
- **Stats reuse** the shared `['cacheStatus']` query (extended), so the dashboard's stats + the library badges share one fetch.
- **`>=500` block-list** = a `max-h-72 overflow-y-auto` scroll list + client-side filter (no pagination, no virtualization — fine for a homelab admin page).
- **Out of scope:** F17 (health/version skew, retry policy, the token-grep CI, full degradation polish).
