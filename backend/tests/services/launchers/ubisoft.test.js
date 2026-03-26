const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('UbisoftLauncher', () => {
  it('refreshIfNeeded() should login with Basic Auth when no ticket exists', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          ticket: 'ubi_ticket_123',
          sessionId: 'sess_123',
          rememberMeTicket: 'rm_ticket_123',
          userId: 'user_123',
          expiration: '2099-01-01T00:00:00.000Z',
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      const result = await launcher.refreshIfNeeded({
        username: 'user@example.com',
        password: 'mypass',
      });

      assert.ok(capturedHeaders.Authorization.startsWith('Basic '));
      assert.equal(result.session.ticket, 'ubi_ticket_123');
      assert.equal(result.updatedCredentials.rememberMeTicket, 'rm_ticket_123');
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should throw OTP_REQUIRED when 2FA is triggered', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: { twoFactorAuthenticationTicket: '2fa_ticket_abc' },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      await assert.rejects(
        () => launcher.refreshIfNeeded({ username: 'user@example.com', password: 'mypass' }),
        (err) => { assert.ok(err.message.startsWith('OTP_REQUIRED:')); return true; }
      );
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should skip login when ticket is not expired', async () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
    const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
    const launcher = new UbisoftLauncher('ubisoft', {});

    const result = await launcher.refreshIfNeeded({
      username: 'user@example.com',
      password: 'mypass',
      ticket: 'valid_ticket',
      sessionId: 'sess_123',
      rememberMeTicket: 'rm_ticket',
      expiration: new Date(Date.now() + 3600000).toISOString(),
    });

    assert.equal(result.session.ticket, 'valid_ticket');
    assert.equal(result.updatedCredentials, null);
  });

  it('refreshIfNeeded() should use rememberMeTicket when expired', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        ticket: 'new_ticket', sessionId: 'new_sess',
        rememberMeTicket: 'new_rm', userId: 'user_123',
        expiration: '2099-01-01T00:00:00.000Z',
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      const result = await launcher.refreshIfNeeded({
        username: 'user@example.com', password: 'mypass',
        ticket: 'expired', sessionId: 'old', rememberMeTicket: 'old_rm',
        expiration: new Date(Date.now() - 1000).toISOString(),
      });

      assert.equal(result.session.ticket, 'new_ticket');
      assert.equal(result.updatedCredentials.rememberMeTicket, 'new_rm');
    } finally {
      axios.post = originalPost;
    }
  });

  // REGRESSION: platform filter was dropping all games because ownedPlatformGroups.type
  // is not populated by the API. No client-side platform filter needed.
  it('fetchOwnedGames() should return all games without platform filtering', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        data: {
          viewer: {
            ownedGames: {
              totalCount: 3,
              nodes: [
                { id: 'game-1', name: 'Watch Dogs 2' },
                { id: 'game-2', name: 'Just Dance 2024' },
                { id: 'game-3', name: 'Rainbow Six Siege' },
              ],
            },
          },
        },
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});
      const games = await launcher.fetchOwnedGames({ ticket: 'test', sessionId: 'test' });

      assert.equal(games.length, 3);
      assert.equal(games[0].title, 'Watch Dogs 2');
    } finally {
      axios.post = originalPost;
    }
  });

  it('parseLocalCacheFiles() should extract owned base games', () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
    const { parseLocalCacheFiles } = require('../../../src/services/launchers/ubisoft');
    const fs = require('fs');
    const path = require('path');

    const configPath = path.join(__dirname, '..', '..', '..', '..', 'configurations');
    const ownerPath = path.join(__dirname, '..', '..', '..', '..', '2739cb57-6123-4d53-920b-5c6aad5dcdc1');

    // Skip if files don't exist (CI environment)
    if (!fs.existsSync(configPath) || !fs.existsSync(ownerPath)) {
      console.log('Skipping cache file test — files not present');
      return;
    }

    const games = parseLocalCacheFiles(fs.readFileSync(configPath), fs.readFileSync(ownerPath));
    assert.ok(games.length > 16, 'Should find more games than GraphQL (got ' + games.length + ')');
    assert.ok(games.some(g => g.title.includes('Assassin')), 'Should include Assassin\'s Creed');
  });

  it('fetchOwnedGames() should handle empty library', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: { data: { viewer: { ownedGames: { totalCount: 0, nodes: [] } } } },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});
      const games = await launcher.fetchOwnedGames({ ticket: 'test', sessionId: 'test' });
      assert.equal(games.length, 0);
    } finally {
      axios.post = originalPost;
    }
  });
});
