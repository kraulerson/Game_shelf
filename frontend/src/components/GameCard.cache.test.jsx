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

  it('reads cache_launcher_* (the priority launcher), not the display launcher (#223)', async () => {
    // The card is displayed as its Epic edition, but the game is cached on the
    // higher-priority Steam launcher. cache_launcher_* points the badge at Steam,
    // so it must read "Cached" — the multi-launcher bug this fixes.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          games: [{ id: 3, platform: 'steam', app_id: '400', status: 'up_to_date', blocked: false }],
        }),
      })
    );
    renderCard({
      id: 3,
      title: 'Portal',
      launcher_name: 'epic',
      launcher_game_id: 'epic-portal',
      cache_launcher_name: 'steam',
      cache_launcher_game_id: '400',
      platforms: [{ launcher_name: 'steam' }, { launcher_name: 'epic' }],
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

  it('shows "Downloaded" for a downloaded GOG game (#222)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [] }) }));
    renderCard({
      id: 4,
      title: 'GOG Game',
      launcher_name: 'gog',
      launcher_game_id: 'g4',
      download_status: 'downloaded',
      platforms: [{ launcher_name: 'gog' }],
    });
    expect(await screen.findByText('Downloaded')).toBeInTheDocument();
  });

  it('shows "Not downloaded" for an owned-but-missing GOG game (#222)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [] }) }));
    renderCard({
      id: 5,
      title: 'GOG Game 2',
      launcher_name: 'gog',
      launcher_game_id: 'g5',
      download_status: 'not_downloaded',
      platforms: [{ launcher_name: 'gog' }],
    });
    expect(await screen.findByText('Not downloaded')).toBeInTheDocument();
  });

  it('renders the cache badge in the info block, not as an absolute art overlay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          games: [{ id: 1, platform: 'steam', app_id: '730', status: 'up_to_date', blocked: false }],
        }),
      })
    );
    const { container } = renderCard({
      id: 1,
      title: 'CS',
      launcher_name: 'steam',
      launcher_game_id: '730',
      platforms: [{ launcher_name: 'steam' }],
    });
    // Badge still renders (just relocated)
    expect(await screen.findByText('Cached')).toBeInTheDocument();
    // ...but no longer inside the absolute top-left art overlay
    expect(container.querySelector('.absolute.top-1\\.5.left-1\\.5')).toBeNull();
  });
});
