import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import FilterPanel from './FilterPanel';

beforeEach(() => vi.restoreAllMocks());

function Probe() {
  const [params] = useSearchParams();
  return <div data-testid="ds">{params.get('download_status') || ''}</div>;
}

function wrap() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ genres: [], tags: [], years: [], launchers: [] }) }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FilterPanel open onClose={() => {}} />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('FilterPanel download-status facet (#222)', () => {
  it('renders a Download status facet with Downloaded / Not downloaded', () => {
    wrap();
    expect(screen.getByText('Download status')).toBeInTheDocument();
    expect(screen.getByText('Downloaded')).toBeInTheDocument();
    expect(screen.getByText('Not downloaded')).toBeInTheDocument();
  });

  it('clicking Downloaded writes ?download_status=downloaded', async () => {
    wrap();
    await userEvent.click(screen.getByText('Downloaded'));
    expect(screen.getByTestId('ds').textContent).toBe('downloaded');
  });
});
