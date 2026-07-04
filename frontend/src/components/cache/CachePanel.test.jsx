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

  it('renders "Partial · N%" for a validation_failed edition with chunk counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          games: [
            {
              id: 9,
              platform: 'steam',
              app_id: '730',
              status: 'validation_failed',
              blocked: false,
              chunks_cached: 90,
              chunks_total: 100,
            },
          ],
        }),
      })
    );
    wrap(<CachePanel editions={editions} />);
    expect(await screen.findByText('Partial · 90%')).toBeInTheDocument();
  });

  it('Validate shows "Validating…", polls the job, then settles', async () => {
    let resolvePost;
    const postPromise = new Promise((r) => {
      resolvePost = r;
    });
    const games = {
      games: [
        {
          id: 9,
          platform: 'steam',
          app_id: '730',
          status: 'validation_failed',
          blocked: false,
          chunks_cached: 50,
          chunks_total: 100,
        },
      ],
    };
    const fetchMock = vi.fn((url, opts) => {
      if (/\/api\/cache\/games\/\d+\/validate$/.test(url) && opts?.method === 'POST') {
        return postPromise.then(() => ({ ok: true, json: async () => ({ job_id: 6 }) }));
      }
      if (typeof url === 'string' && url.startsWith('/api/cache/jobs')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ jobs: [{ id: 6, kind: 'validate', state: 'succeeded' }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => games });
    });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<CachePanel editions={editions} />);
    await screen.findByText('Partial · 50%');

    await userEvent.click(screen.getByRole('button', { name: /^validate$/i }));
    // busy state visible while the validate POST is in flight
    expect(await screen.findByText('Validating…')).toBeInTheDocument();

    resolvePost();
    // POST resolves -> poll sees the job succeeded -> button settles back
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^validate$/i })).toBeInTheDocument()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cache/games/9/validate',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/cache/jobs?game_id=9&kind=validate'),
      expect.anything()
    );
  });

  it('Complete Re-download is shown only for validation_failed (partial) games', async () => {
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
    await screen.findByText('Cached');
    expect(screen.queryByRole('button', { name: /^complete re-download$/i })).not.toBeInTheDocument();
  });

  it('Complete Re-download shows "Re-downloading…", posts force=true, polls the prefill job, then settles', async () => {
    let resolvePost;
    const postPromise = new Promise((r) => {
      resolvePost = r;
    });
    const games = {
      games: [
        {
          id: 9,
          platform: 'steam',
          app_id: '730',
          status: 'validation_failed',
          blocked: false,
          chunks_cached: 50,
          chunks_total: 100,
        },
      ],
    };
    const fetchMock = vi.fn((url, opts) => {
      if (/\/api\/cache\/games\/\d+\/prefill\?force=true$/.test(url) && opts?.method === 'POST') {
        return postPromise.then(() => ({ ok: true, json: async () => ({ job_id: 7 }) }));
      }
      if (typeof url === 'string' && url.startsWith('/api/cache/jobs')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ jobs: [{ id: 7, kind: 'prefill', state: 'succeeded' }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => games });
    });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<CachePanel editions={editions} />);
    await screen.findByText('Partial · 50%');

    await userEvent.click(screen.getByRole('button', { name: /^complete re-download$/i }));
    expect(await screen.findByText('Re-downloading…')).toBeInTheDocument();

    resolvePost();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^complete re-download$/i })).toBeInTheDocument()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cache/games/9/prefill?force=true',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/cache/jobs?game_id=9&kind=prefill'),
      expect.anything()
    );
  });

  it('stops polling /api/cache/jobs after the panel unmounts (#230 poll-loop leak)', async () => {
    const games = {
      games: [
        {
          id: 9,
          platform: 'steam',
          app_id: '730',
          status: 'validation_failed',
          blocked: false,
          chunks_cached: 50,
          chunks_total: 100,
        },
      ],
    };
    const fetchMock = vi.fn((url, opts) => {
      if (/\/api\/cache\/games\/\d+\/validate$/.test(url) && opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ job_id: 6 }) });
      }
      if (typeof url === 'string' && url.startsWith('/api/cache/jobs')) {
        // Never terminal -> the loop would poll forever without an unmount guard.
        return Promise.resolve({
          ok: true,
          json: async () => ({ jobs: [{ id: 6, kind: 'validate', state: 'running' }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => games });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = wrap(<CachePanel editions={editions} />);
    await screen.findByText('Partial · 50%');
    await userEvent.click(screen.getByRole('button', { name: /^validate$/i }));
    await screen.findByText('Validating…');

    const jobsCalls = () =>
      fetchMock.mock.calls.filter(
        ([u]) => typeof u === 'string' && u.startsWith('/api/cache/jobs')
      ).length;
    await waitFor(() => expect(jobsCalls()).toBeGreaterThanOrEqual(1));

    unmount();
    const before = jobsCalls();
    // Wait well past two poll intervals (1500ms each). A guarded loop makes at
    // most one more (in-flight) request; an unguarded loop keeps firing.
    await new Promise((r) => setTimeout(r, 1500 * 2 + 300));
    expect(jobsCalls() - before).toBeLessThanOrEqual(1);
  }, 10000);

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
