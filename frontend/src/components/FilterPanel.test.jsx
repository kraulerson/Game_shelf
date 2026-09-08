import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import FilterPanel from './FilterPanel';

function Harness() {
  const [params] = useSearchParams();
  return (
    <>
      <FilterPanel open onClose={() => {}} />
      <div data-testid="cs">{params.get('cache_status') || ''}</div>
    </>
  );
}
function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/library']}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ genres: [], tags: [], launchers: [] }) }));
});

describe('FilterPanel cache status', () => {
  it('toggling "Not cached" sets cache_status=not_downloaded', async () => {
    wrap();
    await userEvent.click(await screen.findByLabelText('Not cached'));
    expect(screen.getByTestId('cs').textContent).toBe('not_downloaded');
  });

  it('selecting two statuses comma-joins them', async () => {
    wrap();
    await userEvent.click(await screen.findByLabelText('Cached'));
    await userEvent.click(screen.getByLabelText('Blocked'));
    expect(screen.getByTestId('cs').textContent).toBe('up_to_date,blocked');
  });

  it('toggling "Partly cached" sets cache_status=validation_failed', async () => {
    wrap();
    await userEvent.click(await screen.findByLabelText('Partly cached'));
    expect(screen.getByTestId('cs').textContent).toBe('validation_failed');
  });

  it('no longer offers the retired "Failed" and "Downloading" options', async () => {
    // The orchestrator never writes these into games.status any more (cache
    // validation integrity, 2026-09-07) — they were job outcomes, not cache truth.
    wrap();
    await screen.findByLabelText('Cached');
    expect(screen.queryByLabelText('Failed')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Downloading')).not.toBeInTheDocument();
  });

  it('toggling "Blocked" sets cache_status=blocked', async () => {
    wrap();
    await userEvent.click(await screen.findByLabelText('Blocked'));
    expect(screen.getByTestId('cs').textContent).toBe('blocked');
  });
});
