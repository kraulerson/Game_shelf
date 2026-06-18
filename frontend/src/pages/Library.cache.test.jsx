import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Library from './Library';

function wrap(entry) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Library />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/api/games')) {
      return Promise.resolve({ ok: true, json: async () => ({ games: [], total: 0, page: 1, cache_filter_unavailable: u.includes('cache_status') }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ genres: [], tags: [], launchers: [] }) });
  }));
});

describe('Library cache-status integration', () => {
  it('shows the unavailable note when the response flags it', async () => {
    wrap('/library?cache_status=up_to_date');
    expect(await screen.findByText(/cache status unavailable/i)).toBeInTheDocument();
  });

  it('does not show the note on a normal response', async () => {
    wrap('/library');
    await screen.findByPlaceholderText(/search games/i);
    expect(screen.queryByText(/cache status unavailable/i)).not.toBeInTheDocument();
  });
});
