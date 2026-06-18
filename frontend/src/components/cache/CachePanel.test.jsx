import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CachePanel from './CachePanel';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

const editions = [
  { id: 11, launcher_name: 'steam', launcher_game_id: '730', launcher_display_name: 'Steam' },
  { id: 12, launcher_name: 'gog', launcher_game_id: 'x', launcher_display_name: 'GOG' },
];

describe('CachePanel', () => {
  it('renders a row per TRACKED edition with its badge (gog excluded)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          games: [{ id: 9, platform: 'steam', app_id: '730', status: 'up_to_date', blocked: false }],
        }),
      })
    );
    wrap(<CachePanel editions={editions} />);
    expect(await screen.findByText('Cached')).toBeInTheDocument();
    expect(screen.getByText('Steam')).toBeInTheDocument();
    expect(screen.queryByText('GOG')).not.toBeInTheDocument(); // untracked excluded
  });

  it('Prefill posts to the orchestrator game id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          games: [{ id: 9, platform: 'steam', app_id: '730', status: 'not_downloaded', blocked: false }],
        }),
      })
      .mockResolvedValue({ ok: true, json: async () => ({ job_id: 1 }) });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<CachePanel editions={editions} />);
    await screen.findByText('Not cached');
    await userEvent.click(screen.getByRole('button', { name: /prefill/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/cache/games/9/prefill',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });
});
