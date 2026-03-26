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

      // Verify Basic auth header
      assert.ok(capturedHeaders.Authorization.startsWith('Basic '));
      const decoded = Buffer.from(capturedHeaders.Authorization.split(' ')[1], 'base64').toString();
      assert.equal(decoded, 'user@example.com:mypass');

      // Verify session returned
      assert.equal(result.session.ticket, 'ubi_ticket_123');
      assert.equal(result.session.sessionId, 'sess_123');

      // Verify updated credentials include ticket + rememberMeTicket
      assert.equal(result.updatedCredentials.ticket, 'ubi_ticket_123');
      assert.equal(result.updatedCredentials.rememberMeTicket, 'rm_ticket_123');
      assert.equal(result.updatedCredentials.username, 'user@example.com');
      assert.equal(result.updatedCredentials.password, 'mypass');
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
        maskedPhone: '***1234',
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

  it('refreshIfNeeded() should complete login with OTP code after 2FA', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let callCount = 0;
    axios.post = async (url, body, opts) => {
      callCount++;
      if (callCount === 1) {
        return {
          data: {
            twoFactorAuthenticationTicket: '2fa_ticket_abc',
          },
        };
      }
      assert.ok(opts.headers['Ubi-2faCode'], 'Should include 2FA code header');
      assert.ok(opts.headers.Authorization.includes('2fa_ticket_abc'));
      return {
        data: {
          ticket: 'ubi_ticket_after_2fa',
          sessionId: 'sess_456',
          rememberMeTicket: 'rm_ticket_456',
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
        otp_code: '123456',
      });

      assert.equal(result.session.ticket, 'ubi_ticket_after_2fa');
      assert.equal(result.updatedCredentials.ticket, 'ubi_ticket_after_2fa');
      assert.equal(callCount, 2, 'Should make two requests (login + 2FA)');
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
    assert.equal(result.updatedCredentials, null, 'Should not refresh when ticket is valid');
  });

  it('refreshIfNeeded() should use rememberMeTicket when ticket is expired', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          ticket: 'new_ticket',
          sessionId: 'new_sess',
          rememberMeTicket: 'new_rm',
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
        ticket: 'expired_ticket',
        sessionId: 'old_sess',
        rememberMeTicket: 'old_rm',
        expiration: new Date(Date.now() - 1000).toISOString(),
      });

      assert.ok(capturedHeaders.Authorization.startsWith('rm_v1 t='));
      assert.equal(result.session.ticket, 'new_ticket');
      assert.equal(result.updatedCredentials.rememberMeTicket, 'new_rm');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should return PC games from GraphQL response', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          data: {
            viewer: {
              ownedGames: {
                totalCount: 2,
                nodes: [
                  {
                    id: 'game-1',
                    spaceId: 'space-1',
                    name: 'Assassin\'s Creed Valhalla',
                    viewer: { meta: { id: 'm1', ownedPlatformGroups: [{ id: 'pg1', name: 'PC', type: 'PC' }] } },
                  },
                  {
                    id: 'game-2',
                    spaceId: 'space-2',
                    name: 'Far Cry 6',
                    viewer: { meta: { id: 'm2', ownedPlatformGroups: [{ id: 'pg2', name: 'PC', type: 'PC' }] } },
                  },
                ],
              },
            },
          },
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ubisoft')];
      const UbisoftLauncher = require('../../../src/services/launchers/ubisoft');
      const launcher = new UbisoftLauncher('ubisoft', {});
      const games = await launcher.fetchOwnedGames({ ticket: 'test_ticket', sessionId: 'test_sess' });

      assert.equal(games.length, 2);
      assert.equal(games[0].launcher_game_id, 'game-1');
      assert.equal(games[0].title, 'Assassin\'s Creed Valhalla');
      assert.equal(games[0].playtime_minutes, 0);

      assert.ok(capturedHeaders.Authorization.includes('test_ticket'));
      assert.equal(capturedHeaders['Ubi-SessionId'], 'test_sess');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should filter out non-PC games', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        data: {
          viewer: {
            ownedGames: {
              totalCount: 3,
              nodes: [
                {
                  id: 'pc-game',
                  name: 'Watch Dogs 2',
                  viewer: { meta: { id: 'm1', ownedPlatformGroups: [{ id: 'pg1', name: 'PC', type: 'PC' }] } },
                },
                {
                  id: 'console-game',
                  name: 'Just Dance 2024',
                  viewer: { meta: { id: 'm2', ownedPlatformGroups: [{ id: 'pg2', name: 'PS5', type: 'CONSOLE' }] } },
                },
                {
                  id: 'multi-plat',
                  name: 'Rainbow Six Siege',
                  viewer: { meta: { id: 'm3', ownedPlatformGroups: [
                    { id: 'pg3', name: 'PC', type: 'PC' },
                    { id: 'pg4', name: 'PS5', type: 'CONSOLE' },
                  ] } },
                },
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

      assert.equal(games.length, 2, 'Should include PC and multi-plat, exclude console-only');
      assert.equal(games[0].title, 'Watch Dogs 2');
      assert.equal(games[1].title, 'Rainbow Six Siege');
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
