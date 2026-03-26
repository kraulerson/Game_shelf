const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('UbisoftLauncher', () => {
  it('refreshIfNeeded() should login and get both club and demux tickets', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let callCount = 0;
    axios.post = async (url, body, opts) => {
      callCount++;
      return {
        data: {
          ticket: `ticket_${callCount}`,
          sessionId: `sess_${callCount}`,
          rememberMeTicket: `rm_${callCount}`,
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

      // Should have both tickets
      assert.ok(result.session.ticket, 'Should have club ticket');
      assert.ok(result.updatedCredentials.username, 'Should preserve username');
      assert.ok(result.updatedCredentials.password, 'Should preserve password');
      assert.ok(result.updatedCredentials.rememberMeTicket, 'Should have club rememberMeTicket');
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should throw OTP_REQUIRED when 2FA is triggered', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        twoFactorAuthenticationTicket: '2fa_ticket_abc',
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      await assert.rejects(
        () => launcher.refreshIfNeeded({
          username: 'user@example.com',
          password: 'mypass',
        }),
        (err) => {
          assert.ok(err.message.startsWith('OTP_REQUIRED:'));
          return true;
        }
      );
    } finally {
      axios.post = originalPost;
    }
  });

  it('refreshIfNeeded() should skip login when tickets are not expired', async () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
    const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
    const launcher = new UbisoftLauncher('ubisoft', {});

    const result = await launcher.refreshIfNeeded({
      username: 'user@example.com',
      password: 'mypass',
      ticket: 'valid_club_ticket',
      sessionId: 'sess_123',
      rememberMeTicket: 'rm_club',
      expiration: new Date(Date.now() + 3600000).toISOString(),
      demuxTicket: 'valid_demux_ticket',
      demuxRememberMeTicket: 'rm_demux',
      demuxExpiration: new Date(Date.now() + 3600000).toISOString(),
    });

    assert.equal(result.session.ticket, 'valid_club_ticket');
    assert.equal(result.session.demuxTicket, 'valid_demux_ticket');
    // Credentials are always returned (to preserve all fields), but tickets should be unchanged
    assert.equal(result.updatedCredentials.ticket, 'valid_club_ticket');
    assert.equal(result.updatedCredentials.demuxTicket, 'valid_demux_ticket');
  });

  it('refreshIfNeeded() should use rememberMeTicket when expired', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async (url, body, opts) => ({
      data: {
        ticket: 'new_ticket',
        sessionId: 'new_sess',
        rememberMeTicket: 'new_rm',
        userId: 'user_123',
        expiration: '2099-01-01T00:00:00.000Z',
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});

      const result = await launcher.refreshIfNeeded({
        username: 'user@example.com',
        password: 'mypass',
        ticket: 'expired_ticket',
        sessionId: 'old_sess',
        rememberMeTicket: 'old_rm',
        expiration: new Date(Date.now() - 1000).toISOString(),
        demuxTicket: 'expired_demux',
        demuxRememberMeTicket: 'old_demux_rm',
        demuxExpiration: new Date(Date.now() - 1000).toISOString(),
      });

      assert.ok(result.updatedCredentials.ticket, 'Should have new club ticket');
      assert.ok(result.updatedCredentials.rememberMeTicket, 'Should have new rememberMeTicket');
    } finally {
      axios.post = originalPost;
    }
  });

  // REGRESSION: platform filter was dropping all games because ownedPlatformGroups.type
  // is not populated by the API. Since the uplay/graphql endpoint only returns PC games,
  // no client-side platform filter is needed.
  it('_fetchViaGraphQL() should return all games without platform filtering', async () => {
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
      const games = await launcher._fetchViaGraphQL('test_ticket', 'test_sess');

      assert.equal(games.length, 3, 'Should return all games without filtering');
      assert.equal(games[0].title, 'Watch Dogs 2');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should fall back to GraphQL when no demux ticket', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        data: {
          viewer: {
            ownedGames: {
              totalCount: 2,
              nodes: [
                { id: 'game-1', name: 'Far Cry 5' },
                { id: 'game-2', name: 'Anno 1800' },
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

      assert.equal(games.length, 2);
      assert.equal(games[0].title, 'Far Cry 5');
    } finally {
      axios.post = originalPost;
    }
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
