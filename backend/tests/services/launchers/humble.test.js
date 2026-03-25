const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Humble Launcher', () => {
  it('refreshIfNeeded should return session cookie without HTTP calls', async () => {
    const HumbleLauncher = require('../../../src/services/launchers/humble');
    const instance = new HumbleLauncher('humble', null);

    const result = await instance.refreshIfNeeded({ session_cookie: 'test-session-value' });
    assert.equal(result.session, '_simpleauth_sess=test-session-value');
  });

  it('refreshIfNeeded should throw when session_cookie is missing', async () => {
    const HumbleLauncher = require('../../../src/services/launchers/humble');
    const instance = new HumbleLauncher('humble', null);

    await assert.rejects(
      () => instance.refreshIfNeeded({}),
      { message: /session cookie missing/i }
    );
  });

  it('fetchOwnedGames should use cookie and return games', async () => {
    const axios = require('axios');
    const originalGet = axios.get;

    axios.get = async (url, opts) => {
      if (url.includes('/user/order')) {
        return { status: 200, data: [{ gamekey: 'key1' }] };
      }
      if (url.includes('/order/key1')) {
        return {
          data: {
            subproducts: [
              { machine_name: 'game1', human_name: 'Test Game', downloads: [{ platform: 'windows' }] },
              { machine_name: 'coupon1', human_name: 'Coupon', downloads: [] },
            ],
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    try {
      const HumbleLauncher = require('../../../src/services/launchers/humble');
      const instance = new HumbleLauncher('humble', null);
      const games = await instance.fetchOwnedGames('_simpleauth_sess=test');

      assert.equal(games.length, 1);
      assert.equal(games[0].title, 'Test Game');
      assert.equal(games[0].launcher_game_id, 'game1');
    } finally {
      axios.get = originalGet;
    }
  });

  // REGRESSION: Humble returns redirect/non-JSON when session cookie is expired.
  // fetchOwnedGames must throw a clear error, not crash on invalid data.
  it('fetchOwnedGames should throw clear error on expired session', async () => {
    const axios = require('axios');
    const originalGet = axios.get;

    axios.get = async () => ({
      status: 302,
      data: '<html>Redirecting to login</html>',
    });

    try {
      const HumbleLauncher = require('../../../src/services/launchers/humble');
      const instance = new HumbleLauncher('humble', null);

      await assert.rejects(
        () => instance.fetchOwnedGames('_simpleauth_sess=expired'),
        { message: /expired|invalid/i }
      );
    } finally {
      axios.get = originalGet;
    }
  });
});
