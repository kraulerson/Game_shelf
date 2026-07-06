import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GameDetail from './GameDetail';

const game = {
  id: 7,
  title: 'Dual',
  slug: 'dual',
  genres: [],
  tags: [],
  dlc: [],
  has_prefill_choice: true,
  editions: [
    { id: 100, launcher_name: 'steam', launcher_display_name: 'Steam', is_display_edition: true, is_prefill_edition: true },
    { id: 101, launcher_name: 'epic', launcher_display_name: 'Epic', is_display_edition: false, is_prefill_edition: false },
  ],
};

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/games/7']}>
        <Routes>
          <Route path="/games/:id" element={<GameDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => vi.restoreAllMocks());

describe('GameDetail — #225 Prefill this edition', () => {
  it('shows "Prefill this edition" on the non-prefill edition and POSTs on click', async () => {
    const fetchMock = vi.fn((url, opts) => {
      const u = String(url);
      if (/\/api\/games\/7\/prefill-edition$/.test(u) && opts?.method === 'POST')
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      if (/\/api\/games\/7$/.test(u)) return Promise.resolve({ ok: true, json: async () => game });
      if (u.includes('/api/tags')) return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve({ ok: true, json: async () => ({ games: [] }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    wrap();
    const btn = await screen.findByRole('button', { name: /prefill this edition/i });
    await userEvent.click(btn);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/games/7/prefill-edition',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });
});
