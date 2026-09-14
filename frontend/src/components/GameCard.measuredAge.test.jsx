import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import GameCard from './GameCard';
import { STATUS_SECTION_HEIGHT_CLASS } from '../utils/perStoreStatus';

// #309 / UAT 15 scenario 1. Karl: "Shows cached. No time on when the measurement
// was done." The age must reach the card, and it must not cost card height —
// his standing requirement from #31 is that every card stays the same height.

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

function stubGames(games) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games }) }));
}

const STEAM_CS = {
  id: 1,
  title: 'CS',
  launcher_name: 'steam',
  launcher_game_id: '730',
  platforms: [{ launcher_name: 'steam' }],
};

// Deliberately NOT vi.useFakeTimers(): react-query's async resolution runs on
// timers, so freezing the clock deadlocks findBy* queries (all three tests time
// out at 5s). Build the timestamp relative to the real clock instead — the
// assertion stays deterministic because the age buckets are coarse.
function utcMinusDays(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('GameCard measured age', () => {
  it('shows how long ago the cache status was measured', async () => {
    stubGames([
      {
        id: 1,
        platform: 'steam',
        app_id: '730',
        status: 'up_to_date',
        blocked: false,
        status_measured_at: utcMinusDays(2),
      },
    ]);
    renderCard(STEAM_CS);

    expect(await screen.findByText('Cached')).toBeInTheDocument();
    expect(screen.getByTestId('cache-measured-age')).toHaveTextContent('2d ago');
  });

  it('shows no age for a game the orchestrator has never measured', async () => {
    stubGames([
      {
        id: 1,
        platform: 'steam',
        app_id: '730',
        status: 'unknown',
        blocked: false,
        status_measured_at: null,
      },
    ]);
    renderCard(STEAM_CS);

    expect(await screen.findByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByTestId('cache-measured-age')).toBeNull();
  });

  it('does not change the reserved height of the status section', async () => {
    // Karl's hard constraint from #31: cards must stay the same height whether or
    // not they have anything extra to show. The age lives inside the SAME fixed
    // h-5 section, so a card with an age and one without stay pixel-identical.
    stubGames([
      {
        id: 1,
        platform: 'steam',
        app_id: '730',
        status: 'up_to_date',
        blocked: false,
        status_measured_at: utcMinusDays(2),
      },
    ]);
    renderCard(STEAM_CS);

    await screen.findByText('Cached');
    const section = screen.getByTestId('card-status');
    expect(section.className).toContain(STATUS_SECTION_HEIGHT_CLASS);
    expect(section.className).toContain('overflow-hidden');
  });
});
