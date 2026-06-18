import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BlockListManager from './BlockListManager';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

const list = {
  block_list: [
    { id: 1, platform: 'steam', app_id: '730', reason: 'no', source: 'cli', blocked_at: 't' },
    { id: 2, platform: 'epic', app_id: 'fortnite', reason: null, source: 'api', blocked_at: 't' },
  ],
};

describe('BlockListManager', () => {
  it('lists entries and filters them client-side', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => list }));
    wrap(<BlockListManager />);
    expect(await screen.findByText('730')).toBeInTheDocument();
    expect(screen.getByText('fortnite')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/filter/i), 'fort');
    expect(screen.queryByText('730')).not.toBeInTheDocument();
    expect(screen.getByText('fortnite')).toBeInTheDocument();
  });

  it('remove issues a DELETE and invalidates', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => list })
      .mockResolvedValue({ ok: true, json: async () => ({ removed: 1 }) });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<BlockListManager />);
    await screen.findByText('730');
    await userEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/cache/block-list/steam/730',
        expect.objectContaining({ method: 'DELETE' })
      )
    );
  });
});
