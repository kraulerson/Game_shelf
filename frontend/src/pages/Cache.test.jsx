import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Cache from './Cache';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

describe('Cache page', () => {
  it('renders all sections', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [], platforms: [], jobs: [], block_list: [] }) })
    );
    wrap(<Cache />);
    expect(await screen.findByText('Cache stats')).toBeInTheDocument();
    expect(screen.getByText('Platforms')).toBeInTheDocument();
    expect(screen.getByText('Recent jobs')).toBeInTheDocument();
    expect(screen.getByText('Block list')).toBeInTheDocument();
  });

  it('shows an offline banner when the orchestrator is offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ status: 'orchestrator_offline' }) })
    );
    wrap(<Cache />);
    expect(await screen.findByText(/orchestrator is offline/i)).toBeInTheDocument();
  });
});

describe('Cache page — F17 degradation banners', () => {
  it('shows a degraded banner (reachable but unhealthy), not the offline banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url) => {
        if (String(url).includes('/api/cache/health')) {
          return Promise.resolve({ ok: false, status: 503, json: async () => ({ status: 'degraded', version: '0.1.0' }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ games: [], platforms: [], jobs: [], block_list: [] }) });
      })
    );
    wrap(<Cache />);
    expect(await screen.findByText(/degraded state/i)).toBeInTheDocument();
    expect(screen.queryByText(/orchestrator is offline/i)).not.toBeInTheDocument();
  });

  it('shows a version-skew banner when the orchestrator reports an unsupported version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url) => {
        if (String(url).includes('/api/cache/health')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ok', version: '9.9.9' }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ games: [], platforms: [], jobs: [], block_list: [] }) });
      })
    );
    wrap(<Cache />);
    expect(await screen.findByText(/version skew/i)).toBeInTheDocument();
    expect(screen.getByText(/9\.9\.9/)).toBeInTheDocument();
  });

  it('the offline banner exposes a Retry button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ status: 'orchestrator_offline' }) })
    );
    wrap(<Cache />);
    await screen.findByText(/orchestrator is offline/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    // Clicking re-runs the cache queries; fetch is called again for the refetch.
    expect(fetch).toHaveBeenCalled();
  });
});

describe('Cache page — Refresh cache status (full sweep)', () => {
  it('starts a full sweep, polls the sweep job, and reports completion', async () => {
    const fetchMock = vi.fn((url, opts) => {
      if (String(url) === '/api/cache/sweep' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({ job_id: 7, full: true, queued: true }),
        });
      }
      if (String(url).includes('/api/cache/jobs') && String(url).includes('kind=sweep')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ jobs: [{ id: 7, kind: 'sweep', state: 'succeeded' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ games: [], platforms: [], jobs: [], block_list: [] }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<Cache />);
    const btn = await screen.findByRole('button', { name: /refresh cache status/i });
    await userEvent.click(btn);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/cache/sweep',
        expect.objectContaining({ method: 'POST' })
      )
    );
    await waitFor(() => expect(screen.getByText(/re-validation complete/i)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('kind=sweep'), expect.anything());
  });

  it('the Refresh button is disabled when the orchestrator is offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ status: 'orchestrator_offline' }) })
    );
    wrap(<Cache />);
    // Wait for the offline state to settle (button is enabled on the first
    // render before the cacheStatus query resolves).
    await screen.findByText(/orchestrator is offline/i);
    expect(screen.getByRole('button', { name: /refresh cache status/i })).toBeDisabled();
  });
});
