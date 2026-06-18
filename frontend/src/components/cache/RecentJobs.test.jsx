import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RecentJobs from './RecentJobs';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

describe('RecentJobs', () => {
  it('lists recent jobs and requests limit=25 sorted desc', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobs: [{ id: 7, kind: 'prefill', state: 'running', platform: 'steam', game_id: 3 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<RecentJobs />);
    expect(await screen.findByText('prefill')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cache/jobs?limit=25&sort=id:desc',
      expect.objectContaining({ credentials: 'same-origin' })
    );
  });

  it('isolates its own error (renders a message, not a throw)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ status: 'orchestrator_offline' }) })
    );
    wrap(<RecentJobs />);
    expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
  });
});
