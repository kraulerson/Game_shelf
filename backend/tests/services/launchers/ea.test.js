const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('EALauncher', () => {
  // REGRESSION: JUNO_PC_CLIENT requires pc_sign and doesn't work in browsers.
  // ORIGIN_JS_SDK only supports response_type=token (implicit flow), not code exchange.
  // authenticate() stores the access_token directly — no server-side token exchange.
  it('authenticate() should store access token directly from implicit flow', async () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ea')];
    const EALauncher = require('../../../src/services/launchers/ea');
    const launcher = new EALauncher('ea', {});
    const result = await launcher.authenticate({ auth_code: 'my_access_token_123' });

    assert.equal(result.access_token, 'my_access_token_123');
    assert.ok(result.expires_at, 'Should have expires_at timestamp');
    assert.equal(result.refresh_token, undefined, 'No refresh token in implicit flow');
  });

  it('refreshIfNeeded() should skip refresh when token is not expired', async () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ea')];
    const EALauncher = require('../../../src/services/launchers/ea');
    const launcher = new EALauncher('ea', {});

    const result = await launcher.refreshIfNeeded({
      access_token: 'valid_token',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    assert.equal(result.session, 'valid_token');
    assert.equal(result.updatedCredentials, null);
  });

  it('refreshIfNeeded() should throw when token is expired', async () => {
    delete require.cache[require.resolve('../../../src/services/launchers/ea')];
    const EALauncher = require('../../../src/services/launchers/ea');
    const launcher = new EALauncher('ea', {});

    await assert.rejects(
      () => launcher.refreshIfNeeded({
        access_token: 'expired_token',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
      { message: /expired.*re-authenticate/i }
    );
  });

  it('fetchOwnedGames() should return games from GraphQL response', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    let capturedHeaders = null;
    axios.post = async (url, body, opts) => {
      capturedHeaders = opts?.headers;
      return {
        data: {
          data: {
            me: {
              ownedGameProducts: {
                items: [
                  {
                    id: 'OFB-EAST:109552153',
                    product: {
                      id: 'prod123',
                      name: 'Battlefield 1',
                      gameSlug: 'battlefield-1',
                      baseItem: { title: 'Battlefield 1', gameType: 'BASE_GAME' },
                    },
                  },
                  {
                    id: 'OFB-EAST:109552154',
                    product: {
                      id: 'prod456',
                      name: 'Mass Effect Legendary Edition',
                      gameSlug: 'mass-effect-le',
                      baseItem: { title: 'Mass Effect Legendary Edition', gameType: 'BASE_GAME' },
                    },
                  },
                ],
              },
            },
          },
        },
      };
    };

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});
      const games = await launcher.fetchOwnedGames('test_bearer_token');

      assert.equal(games.length, 2);
      assert.equal(games[0].launcher_game_id, 'OFB-EAST:109552153');
      assert.equal(games[0].title, 'Battlefield 1');
      assert.equal(games[0].playtime_minutes, 0);
      assert.equal(games[1].title, 'Mass Effect Legendary Edition');

      assert.equal(capturedHeaders.Authorization, 'Bearer test_bearer_token');
      assert.equal(capturedHeaders['x-client-id'], 'EAX-JUNO-CLIENT');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should filter out non-base-game items', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: {
        data: {
          me: {
            ownedGameProducts: {
              items: [
                {
                  id: 'game1',
                  product: {
                    id: 'p1', name: 'FIFA 24',
                    baseItem: { title: 'FIFA 24', gameType: 'BASE_GAME' },
                  },
                },
                {
                  id: 'dlc1',
                  product: {
                    id: 'p2', name: 'FIFA 24 Ultimate Team Pack',
                    baseItem: { title: 'FIFA 24 Ultimate Team Pack', gameType: 'EXPANSION' },
                  },
                },
                {
                  id: 'trial1',
                  product: {
                    id: 'p3', name: 'FIFA 24 Trial',
                    baseItem: { title: 'FIFA 24 Trial', gameType: 'TRIAL' },
                  },
                },
              ],
            },
          },
        },
      },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});
      const games = await launcher.fetchOwnedGames('test_token');

      assert.equal(games.length, 1, 'Should only return BASE_GAME items');
      assert.equal(games[0].title, 'FIFA 24');
    } finally {
      axios.post = originalPost;
    }
  });

  it('fetchOwnedGames() should handle empty library', async () => {
    const axios = require('axios');
    const originalPost = axios.post;

    axios.post = async () => ({
      data: { data: { me: { ownedGameProducts: { items: [] } } } },
    });

    try {
      delete require.cache[require.resolve('../../../src/services/launchers/ea')];
      const EALauncher = require('../../../src/services/launchers/ea');
      const launcher = new EALauncher('ea', {});
      const games = await launcher.fetchOwnedGames('test_token');

      assert.equal(games.length, 0);
    } finally {
      axios.post = originalPost;
    }
  });
});
