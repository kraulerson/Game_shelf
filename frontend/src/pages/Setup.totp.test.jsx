import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Setup from './Setup';

/**
 * The Setup form never reads a stored secret back — that endpoint was removed on
 * purpose. But it still has to render the truth about whether one exists, or an
 * account with 2FA configured shows an unticked "Enable 2FA" box, and the user is
 * looking at a screen that contradicts what the server holds.
 */

const AVAILABLE = (totpConfigured) => [
  {
    id: 'ubisoft',
    display_name: 'Ubisoft Connect',
    auth_type: 'credentials+totp',
    otp_supported: true,
    qr_supported: false,
    implemented: true,
    configured: true,
    priority: 1,
    sync_locked: false,
    totp_configured: totpConfigured,
  },
];

function stubFetch(totpConfigured, onPost) {
  const fetchMock = vi.fn().mockImplementation((url, options) => {
    if (String(url).includes('/api/launchers/available')) {
      return Promise.resolve({ ok: true, json: async () => AVAILABLE(totpConfigured) });
    }
    if (options?.method === 'POST') {
      onPost?.(JSON.parse(options.body));
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Walk the wizard to the credentials step with Ubisoft selected. */
async function reachCredentialsStep(user) {
  await user.click(await screen.findByRole('button', { name: /begin setup/i }));
  await user.click(await screen.findByRole('button', { name: /ubisoft connect/i }));
  await user.click(screen.getByRole('button', { name: /^next$/i }));
}

beforeEach(() => vi.restoreAllMocks());

describe('Setup — the 2FA checkbox reflects what is stored', () => {
  it('starts ticked when the server reports a TOTP secret on file', async () => {
    stubFetch(true);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Setup />
      </MemoryRouter>
    );

    await reachCredentialsStep(user);

    expect(await screen.findByRole('checkbox', { name: /enable 2fa/i })).toBeChecked();
  });

  it('starts unticked when no secret is stored', async () => {
    stubFetch(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Setup />
      </MemoryRouter>
    );

    await reachCredentialsStep(user);

    expect(await screen.findByRole('checkbox', { name: /enable 2fa/i })).not.toBeChecked();
  });

  it('turns an untick into an explicit removal, and nothing else', async () => {
    // The whole chain: the box starts from what is stored, so unticking it is a real
    // decision by someone who could see the true state — and it travels as a verb,
    // because the server no longer reads any value as destructive.
    const posted = [];
    stubFetch(true, (body) => posted.push(body));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Setup />
      </MemoryRouter>
    );

    await reachCredentialsStep(user);
    await user.click(await screen.findByRole('checkbox', { name: /enable 2fa/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(posted).toHaveLength(1);
    expect(posted[0].remove_totp_secret).toBe(true);
    expect('totp_secret' in posted[0]).toBe(false);
  });
});
