// Library toolbar layout + status legend.
//
// jsdom cannot see layout, so these tests assert on STRUCTURE (which element
// contains which) and on the CLASSES that encode the layout requirements. What
// a real browser must still confirm is listed in the PR body.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Library from './Library';
import { STORE_SYMBOLS } from '../utils/perStoreStatus';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

function wrap(entry = '/library') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Library />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/api/games/filters')) {
      return Promise.resolve({ ok: true, json: async () => ({ genres: [], tags: [], launchers: [] }) });
    }
    if (u.includes('/api/games')) {
      return Promise.resolve({ ok: true, json: async () => ({ games: [], total: 0, page: 1 }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }));
});

// The legend's ten entries, in render order: lancache statuses, then the two
// manual-download states, then the two that are neither.
const LEGEND = [
  ['cached', 'Cached'],
  ['update_ready', 'Update ready'],
  ['partial', 'Partly cached'],
  ['not_cached', 'Not cached'],
  ['blocked', 'Blocked'],
  ['unknown', 'Unknown'],
  ['downloaded', 'Downloaded'],
  ['not_downloaded', 'Not downloaded'],
  ['offline', 'Offline'],
  ['none', 'No status'],
];

describe('Library toolbar layout', () => {
  it('renders the Filters button in the same row as the search input', async () => {
    wrap();
    const row = await screen.findByTestId('toolbar-row-primary');
    const input = screen.getByPlaceholderText(/search games/i);
    const filters = screen.getByRole('button', { name: /filters/i });
    expect(row).toContainElement(input);
    expect(row).toContainElement(filters);
    // Filters sits at the far LEFT, before the search box, so the search box has
    // the whole middle of the row to expand into.
    expect(filters.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lets the search box grow rightwards into the free space', async () => {
    wrap();
    const input = await screen.findByPlaceholderText(/search games/i);
    const wrapper = input.closest('div');
    // It fills the gap between Filters and the right-aligned controls...
    expect(wrapper.className).toMatch(/\bflex-1\b/);
    // ...but never collapses to nothing on a narrow screen.
    expect(wrapper.className).toMatch(/min-w-/);
  });

  it('right-aligns the view/sort/sync controls so search + Filters stay left', async () => {
    const row = (await wrap(), await screen.findByTestId('toolbar-row-primary'));
    expect(row.innerHTML).toMatch(/ml-auto/);
  });

  it('opens the filter panel from its new position, anchored beside the button', async () => {
    const user = userEvent.setup();
    wrap();
    const filters = await screen.findByRole('button', { name: /filters/i });
    await user.click(filters);
    const panel = await screen.findByTestId('filter-panel-anchor');
    // The absolutely-positioned panel must sit inside a positioned anchor that
    // also holds its trigger button, or it opens in the wrong place.
    expect(panel.className).toMatch(/\brelative\b/);
    expect(panel).toContainElement(filters);
    expect(within(panel).getByRole('heading', { name: /filters/i })).toBeInTheDocument();
  });
});

describe('Library status legend', () => {
  it('shows all ten symbols with their labels, glyphs taken from STORE_SYMBOLS', async () => {
    wrap();
    const legend = await screen.findByTestId('status-legend');
    expect(LEGEND).toHaveLength(Object.keys(STORE_SYMBOLS).length);
    for (const [kind, label] of LEGEND) {
      const entry = within(legend).getByTestId(`legend-${kind}`);
      expect(entry.textContent).toContain(STORE_SYMBOLS[kind]);
      expect(entry.textContent).toContain(label);
    }
  });

  it('lives in the legend row, right-aligned so chips do not shift it', async () => {
    wrap();
    const row = await screen.findByTestId('toolbar-row-legend');
    const legend = within(row).getByTestId('status-legend');
    expect(legend.className).toMatch(/ml-auto/);
  });

  it('keeps the active-filter chips and Clear all in the legend row', async () => {
    wrap('/library?cache_status=validation_failed&launcher=steam');
    const row = await screen.findByTestId('toolbar-row-legend');
    const chips = within(row).getAllByTestId('filter-chip').map(c => c.textContent);
    expect(chips).toContain('Partly cached');
    expect(chips).toContain('steam');
    expect(within(row).getByRole('button', { name: /clear all/i })).toBeInTheDocument();
  });

  it("still removes a chip's filter from the URL when its X is clicked", async () => {
    const user = userEvent.setup();
    wrap('/library?cache_status=validation_failed&launcher=steam');
    const row = await screen.findByTestId('toolbar-row-legend');
    const chip = within(row).getAllByTestId('filter-chip').find(c => c.textContent === 'steam');
    await user.click(within(chip).getByRole('button'));
    await waitFor(() => {
      expect(screen.getByTestId('location-search').textContent).not.toMatch(/launcher=steam/);
    });
    expect(screen.getByTestId('location-search').textContent).toMatch(/cache_status=validation_failed/);
  });
});

describe('Library sticky header', () => {
  it('pins the toolbar and the alphabet row to the top of the viewport', async () => {
    wrap();
    const sticky = await screen.findByTestId('library-sticky-header');
    expect(sticky.className).toMatch(/\bsticky\b/);
    expect(sticky.className).toMatch(/\btop-0\b/);
    // Opaque, or the grid shows through as it scrolls under.
    expect(sticky.className).toMatch(/bg-gray-900/);
    expect(sticky.className).toMatch(/\bz-\d+\b/);
    // No overflow clipping, or the filter panel gets cut off.
    expect(sticky.className).not.toMatch(/overflow-(hidden|auto|y-auto|x-auto)/);
  });

  it('contains both the toolbar and the alphabet row', async () => {
    wrap();
    const sticky = await screen.findByTestId('library-sticky-header');
    expect(sticky).toContainElement(screen.getByPlaceholderText(/search games/i));
    expect(sticky).toContainElement(screen.getByTestId('toolbar-row-legend'));
    expect(sticky).toContainElement(screen.getByRole('button', { name: '#' }));
    expect(sticky).toContainElement(screen.getByRole('button', { name: 'Z' }));
  });
});
