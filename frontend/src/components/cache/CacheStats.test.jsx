import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CacheStats from './CacheStats';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

describe('CacheStats', () => {
  it('shows counts from /api/cache/games', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          games: [
            { id: 1, platform: 'steam', app_id: '1', status: 'up_to_date', blocked: false },
            { id: 2, platform: 'steam', app_id: '2', status: 'pending_update', blocked: false },
          ],
        }),
      })
    );
    wrap(<CacheStats />);
    expect(await screen.findByText('Cached')).toBeInTheDocument();
    expect(screen.getByText('Update ready')).toBeInTheDocument();
    // counts derive from the 2 stubbed games (cached=1, update_ready=1).
    // findAllByText waits for the async query to resolve (tiles show '—' while loading).
    const ones = await screen.findAllByText('1');
    expect(ones.length).toBeGreaterThanOrEqual(2);
  });

  it('shows a Partial tile counting validation_failed games separately from Failed (#230)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          games: [
            { id: 1, platform: 'steam', app_id: '1', status: 'validation_failed', blocked: false },
            { id: 2, platform: 'steam', app_id: '2', status: 'failed', blocked: false },
          ],
        }),
      })
    );
    wrap(<CacheStats />);
    // A dedicated Partial tile exists (distinct from Failed).
    expect(await screen.findByText('Partial')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
