import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCacheStatus } from './useCacheStatus';

function wrapper({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useCacheStatus', () => {
  it('builds a keyed map from /api/cache/games', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          games: [{ id: 9, platform: 'steam', app_id: '730', status: 'up_to_date', blocked: false }],
        }),
      })
    );
    const { result } = renderHook(() => useCacheStatus(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.statusFor('steam', '730')).toEqual({ id: 9, status: 'up_to_date', blocked: false });
    expect(result.current.statusFor('steam', 'nope')).toBeUndefined();
    expect(result.current.isOffline).toBe(false);
  });

  it('flags offline on a 503 orchestrator_offline body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ status: 'orchestrator_offline' }),
      })
    );
    const { result } = renderHook(() => useCacheStatus(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isOffline).toBe(true);
    expect(result.current.statusFor('steam', '730')).toBeUndefined();
  });
});

describe('useCacheStatus — malformed payload tolerance (F17)', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('a non-array `games` payload yields empty results, not a crash', async () => {
    // A truthy non-array (object) is the real hazard: `body.games || []` lets it
    // through, then `for (const g of games)` throws "is not iterable".
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: { unexpected: 'shape' } }) })
    );
    const { result } = renderHook(() => useCacheStatus(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.games).toEqual([]);
    expect(result.current.counts.total).toBe(0);
    expect(result.current.statusFor('steam', '123')).toBeUndefined();
  });
});

describe('useCacheStatus counts', () => {
  beforeEach(() => vi.restoreAllMocks());
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
});
