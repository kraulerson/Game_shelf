# F15 — Cache Badge + Cache Panel + Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **NO per-task commits.** Implement all tasks TDD-style, then Task 7 = full frontend (`vitest run`) + backend (`node --test`) sweep + a single `feat(cache)` commit (bring A/B/C structure to the user FIRST). The user pushes from a separate terminal (the in-session branch-safety hook blocks pushes), then I open the PR.

**Goal:** Show each owned game's lancache cache status in the Game_shelf UI — a colorblind-safe badge on library cards (the primary edition) and a per-edition cache panel on the game detail page with block/prefill/validate actions.

**Architecture:** A pure badge-state mapping + a react-query hook (`useCacheStatus`) that bulk-fetches `/api/cache/games` **once** and exposes a `(platform, app_id) → {id, status, blocked}` map. Correlation is `launcher.name → orchestrator platform` and `game_editions.launcher_game_id ↔ orchestrator games.app_id`. The **primary edition is already computed server-side** (the `/api/games` list query ranks by `is_display_edition DESC, tier DESC, launcher.priority ASC` and returns the winner's `launcher_name` + `launcher_game_id` on each game), so the card needs no JS selector.

**Tech Stack:** React 18, Vite, Tailwind, `@tanstack/react-query`, `lucide-react`. **New:** `vitest` + React Testing Library + `jsdom`.

**Conventions (from the existing frontend):**
- Data fetch: `fetch('/api/…', { credentials: 'same-origin' }).then(r => r.json())` inside `useQuery({ queryKey: [...], queryFn })`.
- **Mutations: plain `fetch(…, { method })` then `queryClient.invalidateQueries({ queryKey })`** — the repo uses **no** `useMutation`; mirror that.
- Badges: a Tailwind pill `<span className="inline-flex items-center rounded-full font-medium …">` (see `components/LauncherBadge.jsx`); icons from `lucide-react`.
- ESM (`import`/`export`). Run frontend tests from `frontend/`: `npm test` (= `vitest run`). Backend stays `node --test` from `backend/`.

**Key data shapes (verified):**
- `GET /api/games` → `{ games: [{ id, title, launcher_name, launcher_game_id, platforms: [{launcher_name}], … }], total }` — `launcher_name`/`launcher_game_id` are the **primary edition's**.
- `GET /api/games/:id` → `{ …game, editions: [{ id, launcher_game_id, launcher_name, launcher_display_name, priority, … }] }`.
- `GET /api/cache/games` (F14) → `{ games: [{ id, platform, app_id, status, blocked, … }], meta }`; or `503 { status: 'orchestrator_offline' }` when the orchestrator is down.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/vite.config.js` | add the `test` block (jsdom, globals, setupFiles) |
| `frontend/src/test/setup.js` | **new** — RTL/jest-dom matchers |
| `frontend/package.json` | add `vitest`/RTL devDeps + `test` script |
| `frontend/src/utils/cacheBadge.js` | **new** — pure `cacheBadgeFor()` + `launcherToPlatform()` |
| `frontend/src/hooks/useCacheStatus.js` | **new** — react-query bulk fetch → keyed map + `isOffline` |
| `frontend/src/components/cache/CacheBadge.jsx` | **new** — renders one badge state |
| `frontend/src/components/cache/CachePanel.jsx` | **new** — per-edition rows + actions (GameDetail) |
| `frontend/src/components/GameCard.jsx` | render `CacheBadge` for the primary edition |
| `frontend/src/pages/GameDetail.jsx` | render `CachePanel editions={game.editions}` |

---

## Task 1: Add vitest + React Testing Library

**Files:**
- Modify: `frontend/package.json`, `frontend/vite.config.js`
- Create: `frontend/src/test/setup.js`, `frontend/src/test/smoke.test.jsx`

- [ ] **Step 1: Install the dev deps**

Run (from `frontend/`):
```
npm install -D vitest@^2 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14 jsdom@^25
```
(If `frontend/node_modules` doesn't exist yet, run `npm install` first to materialize the existing deps.)

- [ ] **Step 2: Add the test config to `vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
});
```

- [ ] **Step 3: Create `frontend/src/test/setup.js`**

```js
import '@testing-library/jest-dom';
```

- [ ] **Step 4: Add the test script to `frontend/package.json`** (in `"scripts"`):

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: Smoke test** — `frontend/src/test/smoke.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('vitest + RTL', () => {
  it('renders', () => {
    render(<div>hello</div>);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run** — `cd frontend && npm test`. Expected: 1 passed.

---

## Task 2: Pure badge mapping + launcher→platform

**Files:**
- Create: `frontend/src/utils/cacheBadge.js`, `frontend/src/utils/cacheBadge.test.js`

Pure functions (no React/lucide import — return string descriptors so they're trivially testable):
- `launcherToPlatform(launcherName)` → `'steam'` | `'epic'` | `null` (null = untracked).
- `cacheBadgeFor({ status, blocked, tracked, offline })` → `{ icon, tone, label }` where `icon` is a lucide name string, `tone` ∈ `green|blue|amber|gray|red|slate|neutral`. Precedence: offline → not-tracked → blocked → status.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { launcherToPlatform, cacheBadgeFor } from './cacheBadge';

describe('launcherToPlatform', () => {
  it('maps steam/epic, others null', () => {
    expect(launcherToPlatform('steam')).toBe('steam');
    expect(launcherToPlatform('Steam')).toBe('steam');
    expect(launcherToPlatform('epic')).toBe('epic');
    expect(launcherToPlatform('gog')).toBe(null);
    expect(launcherToPlatform(undefined)).toBe(null);
  });
});

describe('cacheBadgeFor', () => {
  const cases = [
    [{ status: 'up_to_date', tracked: true }, 'CheckCircle', 'green', 'Cached'],
    [{ status: 'downloading', tracked: true }, 'Download', 'blue', 'Downloading'],
    [{ status: 'pending_update', tracked: true }, 'ArrowUpCircle', 'amber', 'Update ready'],
    [{ status: 'not_downloaded', tracked: true }, 'Circle', 'gray', 'Not cached'],
    [{ status: 'validation_failed', tracked: true }, 'AlertTriangle', 'red', 'Check failed'],
    [{ status: 'failed', tracked: true }, 'XCircle', 'red', 'Failed'],
    [{ status: 'unknown', tracked: true }, 'HelpCircle', 'gray', 'Unknown'],
  ];
  for (const [input, icon, tone, label] of cases) {
    it(`maps ${input.status}`, () => {
      expect(cacheBadgeFor(input)).toEqual({ icon, tone, label });
    });
  }
  it('blocked overlays any status', () => {
    expect(cacheBadgeFor({ status: 'up_to_date', blocked: true, tracked: true }))
      .toEqual({ icon: 'Ban', tone: 'slate', label: 'Blocked' });
  });
  it('untracked launcher -> neutral dash', () => {
    expect(cacheBadgeFor({ tracked: false })).toEqual({ icon: 'Minus', tone: 'neutral', label: '—' });
  });
  it('offline -> neutral cloud-off', () => {
    expect(cacheBadgeFor({ status: 'up_to_date', tracked: true, offline: true }))
      .toEqual({ icon: 'CloudOff', tone: 'neutral', label: '—' });
  });
  it('unknown status string falls back to Unknown', () => {
    expect(cacheBadgeFor({ status: 'wat', tracked: true }).label).toBe('Unknown');
  });
});
```

- [ ] **Step 2: Run to verify red** — `cd frontend && npm test src/utils/cacheBadge.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `frontend/src/utils/cacheBadge.js`**

```js
const TRACKED_LAUNCHERS = { steam: 'steam', epic: 'epic' };

export function launcherToPlatform(launcherName) {
  if (!launcherName) return null;
  return TRACKED_LAUNCHERS[String(launcherName).toLowerCase()] || null;
}

const STATUS_MAP = {
  up_to_date: { icon: 'CheckCircle', tone: 'green', label: 'Cached' },
  downloading: { icon: 'Download', tone: 'blue', label: 'Downloading' },
  pending_update: { icon: 'ArrowUpCircle', tone: 'amber', label: 'Update ready' },
  not_downloaded: { icon: 'Circle', tone: 'gray', label: 'Not cached' },
  validation_failed: { icon: 'AlertTriangle', tone: 'red', label: 'Check failed' },
  failed: { icon: 'XCircle', tone: 'red', label: 'Failed' },
  unknown: { icon: 'HelpCircle', tone: 'gray', label: 'Unknown' },
};

// Precedence: offline > not-tracked > blocked > status (blocked overlays any status).
export function cacheBadgeFor({ status, blocked, tracked, offline } = {}) {
  if (offline) return { icon: 'CloudOff', tone: 'neutral', label: '—' };
  if (!tracked) return { icon: 'Minus', tone: 'neutral', label: '—' };
  if (blocked) return { icon: 'Ban', tone: 'slate', label: 'Blocked' };
  return STATUS_MAP[status] || STATUS_MAP.unknown;
}
```

- [ ] **Step 4: Run to verify green** — `cd frontend && npm test src/utils/cacheBadge.test.js`. Expected: PASS.

---

## Task 3: `useCacheStatus` hook (bulk fetch + keyed map)

**Files:**
- Create: `frontend/src/hooks/useCacheStatus.js`, `frontend/src/hooks/useCacheStatus.test.jsx`

Bulk-fetches `/api/cache/games` once; returns `{ statusFor(platform, appId), isOffline, isLoading }`. `statusFor` returns `{ id, status, blocked }` or `undefined` when the game isn't tracked.

- [ ] **Step 1: Write the failing test**

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCacheStatus } from './useCacheStatus';

function wrapper({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => { vi.restoreAllMocks(); });

it('builds a keyed map from /api/cache/games', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ games: [{ id: 9, platform: 'steam', app_id: '730', status: 'up_to_date', blocked: false }] }),
  }));
  const { result } = renderHook(() => useCacheStatus(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.statusFor('steam', '730')).toEqual({ id: 9, status: 'up_to_date', blocked: false });
  expect(result.current.statusFor('steam', 'nope')).toBeUndefined();
  expect(result.current.isOffline).toBe(false);
});

it('flags offline on a 503 orchestrator_offline body', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false, status: 503, json: async () => ({ status: 'orchestrator_offline' }),
  }));
  const { result } = renderHook(() => useCacheStatus(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.isOffline).toBe(true);
  expect(result.current.statusFor('steam', '730')).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify red** — `cd frontend && npm test src/hooks/useCacheStatus.test.jsx`. Expected: FAIL.

- [ ] **Step 3: Implement `frontend/src/hooks/useCacheStatus.js`**

```js
import { useQuery } from '@tanstack/react-query';

async function fetchCacheGames() {
  const res = await fetch('/api/cache/games', { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 503 || body.status === 'orchestrator_offline') return { offline: true, games: [] };
    throw new Error(`cache games HTTP ${res.status}`);
  }
  return { offline: false, games: body.games || [] };
}

export function useCacheStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ['cacheStatus'],
    queryFn: fetchCacheGames,
    staleTime: 30000,
    retry: false,
  });

  const map = new Map();
  for (const g of data?.games || []) {
    map.set(`${g.platform}:${g.app_id}`, { id: g.id, status: g.status, blocked: g.blocked });
  }

  return {
    isLoading,
    isOffline: Boolean(data?.offline),
    statusFor: (platform, appId) => map.get(`${platform}:${appId}`),
  };
}
```

- [ ] **Step 4: Run to verify green** — `cd frontend && npm test src/hooks/useCacheStatus.test.jsx`. Expected: PASS.

---

## Task 4: `CacheBadge` component

**Files:**
- Create: `frontend/src/components/cache/CacheBadge.jsx`, `frontend/src/components/cache/CacheBadge.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CacheBadge from './CacheBadge';

it('renders the label text (colorblind-safe: text always present)', () => {
  render(<CacheBadge status="up_to_date" tracked />);
  expect(screen.getByText('Cached')).toBeInTheDocument();
});

it('renders Blocked when blocked overlays a status', () => {
  render(<CacheBadge status="up_to_date" blocked tracked />);
  expect(screen.getByText('Blocked')).toBeInTheDocument();
});

it('renders a neutral dash for an untracked launcher', () => {
  render(<CacheBadge tracked={false} />);
  expect(screen.getByText('—')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify red** — `cd frontend && npm test src/components/cache/CacheBadge.test.jsx`. Expected: FAIL.

- [ ] **Step 3: Implement `frontend/src/components/cache/CacheBadge.jsx`**

```jsx
import {
  CheckCircle, Download, ArrowUpCircle, Circle, AlertTriangle,
  XCircle, HelpCircle, Ban, Minus, CloudOff,
} from 'lucide-react';
import { cacheBadgeFor } from '../../utils/cacheBadge';

const ICONS = { CheckCircle, Download, ArrowUpCircle, Circle, AlertTriangle, XCircle, HelpCircle, Ban, Minus, CloudOff };

const TONE = {
  green: 'bg-green-700 text-green-100',
  blue: 'bg-blue-700 text-blue-100',
  amber: 'bg-amber-600 text-amber-50',
  red: 'bg-red-700 text-red-100',
  gray: 'bg-gray-700 text-gray-200',
  slate: 'bg-slate-600 text-slate-100',
  neutral: 'bg-gray-800 text-gray-400',
};

export default function CacheBadge({ status, blocked, tracked = true, offline = false, size = 'default' }) {
  const { icon, tone, label } = cacheBadgeFor({ status, blocked, tracked, offline });
  const Icon = ICONS[icon];
  const sizeClasses = size === 'small' ? 'text-xs px-1.5 py-0.5 gap-0.5' : 'text-sm px-2.5 py-0.5 gap-1';
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${sizeClasses} ${TONE[tone]}`}
      title={label}
    >
      <Icon size={size === 'small' ? 12 : 14} aria-hidden="true" />
      {label}
    </span>
  );
}
```

- [ ] **Step 4: Run to verify green** — `cd frontend && npm test src/components/cache/CacheBadge.test.jsx`. Expected: PASS.

---

## Task 5: Wire `CacheBadge` into the library card

**Files:**
- Modify: `frontend/src/components/GameCard.jsx`
- Create: `frontend/src/components/GameCard.cache.test.jsx`

The card reads the game's **primary edition** (`game.launcher_name` + `game.launcher_game_id`, already computed server-side) and shows its cache state via `useCacheStatus`.

- [ ] **Step 1: Write the failing test**

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import GameCard from './GameCard';

function renderCard(game) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><GameCard game={game} /></MemoryRouter></QueryClientProvider>
  );
}

beforeEach(() => { vi.restoreAllMocks(); });

it('shows the primary edition cache badge on a steam game', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ games: [{ id: 1, platform: 'steam', app_id: '730', status: 'up_to_date', blocked: false }] }),
  }));
  renderCard({ id: 1, title: 'CS', launcher_name: 'steam', launcher_game_id: '730', platforms: [{ launcher_name: 'steam' }] });
  expect(await screen.findByText('Cached')).toBeInTheDocument();
});

it('shows a neutral dash for a GOG-only (untracked) game', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [] }) }));
  renderCard({ id: 2, title: 'Witcher', launcher_name: 'gog', launcher_game_id: 'witcher', platforms: [{ launcher_name: 'gog' }] });
  expect(await screen.findByText('—')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify red** — Expected: FAIL (no badge).

- [ ] **Step 3: Implement** — in `GameCard.jsx`, add the import + hook + badge. Add near the top:

```jsx
import { useCacheStatus } from '../hooks/useCacheStatus';
import CacheBadge from './cache/CacheBadge';
import { launcherToPlatform } from '../utils/cacheBadge';
```

Inside the component body (after `const playtime = …`):

```jsx
  const { statusFor, isOffline } = useCacheStatus();
  const platform = launcherToPlatform(game.launcher_name);
  const cache = platform ? statusFor(platform, game.launcher_game_id) : undefined;
```

Render the badge as a cover overlay — add inside the card `<div>` (e.g., just after the cover image block), top-left:

```jsx
      <div className="absolute top-1.5 left-1.5 z-10">
        <CacheBadge
          status={cache?.status}
          blocked={cache?.blocked}
          tracked={Boolean(platform)}
          offline={isOffline}
          size="small"
        />
      </div>
```

- [ ] **Step 4: Run to verify green.** Then run the whole frontend suite (`cd frontend && npm test`) to confirm the existing card still renders.

---

## Task 6: `CachePanel` on GameDetail (per-edition rows + actions)

**Files:**
- Create: `frontend/src/components/cache/CachePanel.jsx`, `frontend/src/components/cache/CachePanel.test.jsx`
- Modify: `frontend/src/pages/GameDetail.jsx`

The panel lists every **tracked** edition (steam/epic) of the game as a row with its cache badge + a Block toggle + Prefill/Validate buttons. Block uses `(platform, app_id)`; prefill/validate use the orchestrator game id from the cache map. Mutations are plain `fetch` + `queryClient.invalidateQueries(['cacheStatus'])`.

- [ ] **Step 1: Write the failing test**

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CachePanel from './CachePanel';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => { vi.restoreAllMocks(); });

const editions = [
  { id: 11, launcher_name: 'steam', launcher_game_id: '730', launcher_display_name: 'Steam' },
  { id: 12, launcher_name: 'gog', launcher_game_id: 'x', launcher_display_name: 'GOG' },
];

it('renders a row per TRACKED edition with its badge (gog excluded)', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ games: [{ id: 9, platform: 'steam', app_id: '730', status: 'up_to_date', blocked: false }] }),
  }));
  wrap(<CachePanel editions={editions} />);
  expect(await screen.findByText('Cached')).toBeInTheDocument();
  expect(screen.getByText('Steam')).toBeInTheDocument();
  expect(screen.queryByText('GOG')).not.toBeInTheDocument(); // untracked excluded
});

it('Prefill posts to the orchestrator game id', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ games: [{ id: 9, platform: 'steam', app_id: '730', status: 'not_downloaded', blocked: false }] }) })
    .mockResolvedValue({ ok: true, json: async () => ({ job_id: 1 }) });
  vi.stubGlobal('fetch', fetchMock);
  wrap(<CachePanel editions={editions} />);
  await screen.findByText('Not cached');
  await userEvent.click(screen.getByRole('button', { name: /prefill/i }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/cache/games/9/prefill', expect.objectContaining({ method: 'POST' }))
  );
});
```

- [ ] **Step 2: Run to verify red.**

- [ ] **Step 3: Implement `frontend/src/components/cache/CachePanel.jsx`**

```jsx
import { useQueryClient } from '@tanstack/react-query';
import CacheBadge from './CacheBadge';
import { useCacheStatus } from '../../hooks/useCacheStatus';
import { launcherToPlatform } from '../../utils/cacheBadge';

export default function CachePanel({ editions = [] }) {
  const queryClient = useQueryClient();
  const { statusFor, isOffline } = useCacheStatus();

  const tracked = editions
    .map((e) => ({ e, platform: launcherToPlatform(e.launcher_name) }))
    .filter((x) => x.platform);

  if (tracked.length === 0) return null;

  async function mutate(path, method = 'POST') {
    await fetch(path, { method, credentials: 'same-origin' });
    queryClient.invalidateQueries({ queryKey: ['cacheStatus'] });
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">Cache</h3>
      <div className="space-y-2">
        {tracked.map(({ e, platform }) => {
          const cache = statusFor(platform, e.launcher_game_id);
          const orchId = cache?.id;
          return (
            <div key={e.id} className="flex items-center gap-3">
              <span className="w-24 text-sm text-gray-400">{e.launcher_display_name || e.launcher_name}</span>
              <CacheBadge status={cache?.status} blocked={cache?.blocked} tracked offline={isOffline} />
              <div className="ml-auto flex gap-2">
                {cache?.blocked ? (
                  <button className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                    disabled={isOffline}
                    onClick={() => mutate(`/api/cache/block-list/${platform}/${encodeURIComponent(e.launcher_game_id)}`, 'DELETE')}>
                    Unblock
                  </button>
                ) : (
                  <button className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                    disabled={isOffline}
                    onClick={() => fetch('/api/cache/block-list', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ platform, app_id: e.launcher_game_id, source: 'gameshelf' }),
                    }).then(() => queryClient.invalidateQueries({ queryKey: ['cacheStatus'] }))}>
                    Block
                  </button>
                )}
                <button className="text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50"
                  disabled={isOffline || !orchId}
                  onClick={() => mutate(`/api/cache/games/${orchId}/prefill`)}>
                  Prefill
                </button>
                <button className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                  disabled={isOffline || !orchId}
                  onClick={() => mutate(`/api/cache/games/${orchId}/validate`)}>
                  Validate
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify green.**

- [ ] **Step 5: Wire into `GameDetail.jsx`** — add the import near the other component imports:

```jsx
import CachePanel from '../components/cache/CachePanel';
```

And render it where the editions/details are shown (after the editions list block in the return). Pass `editions={game.editions}`:

```jsx
        {game.editions && <CachePanel editions={game.editions} />}
```

Run `cd frontend && npm test` — the GameDetail page still renders; new panel tests pass.

---

## Task 7: Full sweep, commit, PR

- [ ] **Step 1: Frontend suite** — `cd frontend && npm test`. Expected: all pass (cacheBadge, useCacheStatus, CacheBadge, GameCard, CachePanel, smoke).
- [ ] **Step 2: Backend unaffected** — `cd backend && node --test 'tests/**/*.test.js'`. Expected: unchanged from before F15 (the 2 pre-existing failures may remain; no NEW failures).
- [ ] **Step 3:** Present the **A/B/C commit structure**, then a single `feat(cache): F15 cache badge + panel on library & game detail` commit. Note: `package-lock.json` changes (new devDeps) are included; `node_modules` stays gitignored.
- [ ] **Step 4:** The user pushes `feat/f15-cache-badges` from a separate terminal; then I open the PR. Do NOT merge.

---

## Notes
- **No `/api/games` change needed** — the list already returns the primary edition's `launcher_name`/`launcher_game_id`, and the detail returns all `editions`.
- **Basic offline handling only** (neutral badges + disabled mutations). Full F17 graceful degradation (health/version skew, the token-grep CI, retry policy) is the next plan.
- **Out of scope:** F16 dashboard, F17.
