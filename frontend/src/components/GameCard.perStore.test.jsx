// Per-store cache status on the library card (#31).
//
// Rules under test:
//  - the status section is a FIXED height on every card, so a row of cards never
//    goes ragged (Karl: "make the heights of the cards stay the same");
//  - a game whose stores agree (or that has one store — 1935 of 2247 games)
//    renders exactly what it renders today: the single primary CacheBadge;
//  - a game whose stores disagree gets a condensed per-store line, primary first;
//  - nothing is signalled by colour alone: every status carries a shape symbol
//    AND a text label, and the full wording is in the accessible text.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import GameCard from './GameCard';
import { STATUS_SECTION_HEIGHT_CLASS } from '../utils/perStoreStatus';

function stubCacheGames(games) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games }) }));
}

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

// BioShock Infinite: owned on Steam + Epic + GOG. Cached on Steam, blocked on
// Epic, and not downloaded on GOG. (GOG is a manual-download launcher — lancache
// never sees it, so it can carry a download status but never "Blocked".)
const BIOSHOCK = {
  id: 1,
  title: 'BioShock Infinite',
  launcher_name: 'steam',
  launcher_game_id: '8870',
  cache_launcher_name: 'steam',
  cache_launcher_game_id: '8870',
  platforms: [
    { launcher_name: 'epic', launcher_display_name: 'Epic', launcher_game_id: 'epic-bio' },
    { launcher_name: 'steam', launcher_display_name: 'Steam', launcher_game_id: '8870' },
    { launcher_name: 'gog', launcher_display_name: 'GOG', launcher_game_id: 'gog-bio', download_status: 'not_downloaded' },
  ],
};

const BIOSHOCK_CACHE = [
  { id: 9, platform: 'steam', app_id: '8870', status: 'up_to_date', blocked: false },
  { id: 10, platform: 'epic', app_id: 'epic-bio', status: 'not_downloaded', blocked: true },
];

describe('GameCard per-store status section', () => {
  it('a single-store game renders only the primary badge — no per-store line', async () => {
    stubCacheGames([{ id: 1, platform: 'steam', app_id: '730', status: 'up_to_date', blocked: false }]);
    renderCard({
      id: 1,
      title: 'CS',
      launcher_name: 'steam',
      launcher_game_id: '730',
      cache_launcher_name: 'steam',
      cache_launcher_game_id: '730',
      platforms: [{ launcher_name: 'steam', launcher_display_name: 'Steam', launcher_game_id: '730' }],
    });
    await screen.findByTitle('Steam — Cached');
    const section = screen.getByTestId('card-status');
    expect(within(section).getByText('Cached')).toBeInTheDocument();
    expect(screen.queryByTestId('per-store-line')).toBeNull();
  });

  it('a game whose stores all agree renders no per-store line', async () => {
    stubCacheGames([
      { id: 1, platform: 'steam', app_id: '400', status: 'up_to_date', blocked: false },
      { id: 2, platform: 'epic', app_id: 'e400', status: 'up_to_date', blocked: false },
    ]);
    renderCard({
      id: 2,
      title: 'Portal',
      launcher_name: 'steam',
      launcher_game_id: '400',
      cache_launcher_name: 'steam',
      cache_launcher_game_id: '400',
      platforms: [
        { launcher_name: 'steam', launcher_display_name: 'Steam', launcher_game_id: '400' },
        { launcher_name: 'epic', launcher_display_name: 'Epic', launcher_game_id: 'e400' },
      ],
    });
    await screen.findByTitle('Steam — Cached');
    const section = screen.getByTestId('card-status');
    expect(within(section).getByText('Cached')).toBeInTheDocument();
    expect(screen.queryByTestId('per-store-line')).toBeNull();
  });

  it('disagreeing stores get a per-store line, primary store first', async () => {
    stubCacheGames(BIOSHOCK_CACHE);
    renderCard(BIOSHOCK);
    await screen.findByTitle('Steam — Cached');
    const line = screen.getByTestId('per-store-line');
    expect(line.textContent.indexOf('Steam')).toBe(0);
  });

  it('every store status is in the accessible text, in full words', async () => {
    stubCacheGames(BIOSHOCK_CACHE);
    renderCard(BIOSHOCK);
    await screen.findByTitle('Steam — Cached');
    const line = screen.getByTestId('per-store-line');
    const accessible = line.getAttribute('aria-label');
    expect(accessible).toBe(line.getAttribute('title'));
    expect(accessible).toContain('Steam — Cached');
    expect(accessible).toContain('Epic — Blocked');
    expect(accessible).toContain('GOG — Not downloaded');
  });

  it('each store badge carries its own status symbol and wording — never colour alone', async () => {
    stubCacheGames(BIOSHOCK_CACHE);
    const { container } = renderCard(BIOSHOCK);
    await screen.findByTitle('Steam — Cached');
    const badges = container.querySelectorAll('[data-testid="launcher-status"]');
    expect(badges).toHaveLength(3);
    const titles = [...badges].map((b) => b.getAttribute('title'));
    expect(titles).toEqual(['Steam — Cached', 'Epic — Blocked', 'GOG — Not downloaded']);
    // A shape symbol, not just a colour, distinguishes each one.
    const symbols = [...badges].map((b) => b.querySelector('[data-testid="status-symbol"]').textContent);
    expect(new Set(symbols).size).toBe(3);
    // ...and the wording is available to a screen reader.
    for (const t of ['Cached', 'Blocked', 'Not downloaded']) {
      expect(screen.getAllByText(new RegExp(t)).length).toBeGreaterThan(0);
    }
  });

  it('four stores render an overflow indicator with the full list in the accessible text', async () => {
    stubCacheGames([
      { id: 1, platform: 'steam', app_id: 's4', status: 'up_to_date', blocked: false },
      { id: 2, platform: 'epic', app_id: 'e4', status: 'not_downloaded', blocked: true },
    ]);
    renderCard({
      id: 4,
      title: 'Four Store Game',
      launcher_name: 'steam',
      launcher_game_id: 's4',
      cache_launcher_name: 'steam',
      cache_launcher_game_id: 's4',
      platforms: [
        { launcher_name: 'steam', launcher_display_name: 'Steam', launcher_game_id: 's4' },
        { launcher_name: 'epic', launcher_display_name: 'Epic', launcher_game_id: 'e4' },
        { launcher_name: 'gog', launcher_display_name: 'GOG', launcher_game_id: 'g4', download_status: 'downloaded' },
        { launcher_name: 'amazon', launcher_display_name: 'Amazon', launcher_game_id: 'a4', download_status: 'not_downloaded' },
      ],
    });
    await screen.findByTitle('Steam — Cached');
    const line = screen.getByTestId('per-store-line');
    expect(within(line).getByTestId('per-store-overflow').textContent).toMatch(/^\+\d+$/);
    const accessible = line.getAttribute('aria-label');
    for (const t of ['Steam — Cached', 'Epic — Blocked', 'GOG — Downloaded', 'Amazon — Not downloaded']) {
      expect(accessible).toContain(t);
    }
  });

  it('the status section keeps its reserved height with no stores and no status', async () => {
    stubCacheGames([]);
    renderCard({ id: 5, title: 'Bare', platforms: [] });
    const section = await screen.findByTestId('card-status');
    expect(section.className).toContain(STATUS_SECTION_HEIGHT_CLASS);
    expect(screen.queryByTestId('per-store-line')).toBeNull();
  });

  it('the reserved height is identical for an agreeing card and a disagreeing card', async () => {
    stubCacheGames(BIOSHOCK_CACHE);
    const a = renderCard({
      id: 6,
      title: 'One Store',
      launcher_name: 'steam',
      launcher_game_id: '8870',
      cache_launcher_name: 'steam',
      cache_launcher_game_id: '8870',
      platforms: [{ launcher_name: 'steam', launcher_display_name: 'Steam', launcher_game_id: '8870' }],
    });
    const single = (await within(a.container).findByTestId('card-status')).className;
    const b = renderCard(BIOSHOCK);
    await within(b.container).findByTitle('Steam — Cached');
    const multi = within(b.container).getByTestId('card-status').className;
    expect(single).toBe(multi);
    expect(single).toContain(STATUS_SECTION_HEIGHT_CLASS);
  });

  it('the store row cannot wrap onto a second line and grow the card', async () => {
    stubCacheGames(BIOSHOCK_CACHE);
    const { container } = renderCard(BIOSHOCK);
    await screen.findByTitle('Steam — Cached');
    const row = container.querySelector('[data-testid="platform-row"]');
    expect(row.className).toContain('flex-nowrap');
    expect(row.className).not.toContain('flex-wrap');
    expect(row.className).toContain('overflow-hidden');
  });

  it('claims no disagreement while the cache query is still in flight', async () => {
    // Every tracked store reads Unknown before the fetch resolves; that must not
    // flash a per-store line saying the stores disagree.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderCard(BIOSHOCK);
    const section = await screen.findByTestId('card-status');
    expect(within(section).queryByTestId('per-store-line')).toBeNull();
  });
});
