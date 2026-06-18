import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
