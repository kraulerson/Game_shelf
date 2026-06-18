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
