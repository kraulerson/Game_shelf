import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PlatformAuthCards from './PlatformAuthCards';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => vi.restoreAllMocks());

describe('PlatformAuthCards', () => {
  it('shows a card per platform and a reconnect command when not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          platforms: [
            { name: 'steam', auth_status: 'expired', auth_method: 'steam_cm', last_sync_at: null },
            { name: 'epic', auth_status: 'ok', auth_method: 'epic_oauth', last_sync_at: '2026-06-18' },
          ],
        }),
      })
    );
    wrap(<PlatformAuthCards />);
    expect(await screen.findByText('steam')).toBeInTheDocument();
    expect(screen.getByText('orchestrator-cli auth steam')).toBeInTheDocument(); // reconnect cmd (expired)
    expect(screen.queryByText('orchestrator-cli auth epic')).not.toBeInTheDocument(); // ok -> no cmd
  });

  it('copy button writes the command to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          platforms: [{ name: 'steam', auth_status: 'never', auth_method: 'steam_cm', last_sync_at: null }],
        }),
      })
    );
    wrap(<PlatformAuthCards />);
    await screen.findByText('steam');
    await userEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('orchestrator-cli auth steam');
  });
});
