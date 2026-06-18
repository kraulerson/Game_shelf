import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import GameCard from './GameCard';

function renderCard(game) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GameCard game={game} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('GameCard cache badge', () => {
  it('shows the primary edition cache badge on a steam game', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          games: [{ id: 1, platform: 'steam', app_id: '730', status: 'up_to_date', blocked: false }],
        }),
      })
    );
    renderCard({
      id: 1,
      title: 'CS',
      launcher_name: 'steam',
      launcher_game_id: '730',
      platforms: [{ launcher_name: 'steam' }],
    });
    expect(await screen.findByText('Cached')).toBeInTheDocument();
  });

  it('shows a neutral dash for a GOG-only (untracked) game', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [] }) }));
    renderCard({
      id: 2,
      title: 'Witcher',
      launcher_name: 'gog',
      launcher_game_id: 'witcher',
      platforms: [{ launcher_name: 'gog' }],
    });
    expect(await screen.findByText('—')).toBeInTheDocument();
  });
});
