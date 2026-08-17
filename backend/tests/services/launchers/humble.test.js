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

  // REGRESSION: Humble subproducts include soundtracks, artbooks, etc.
  // fetchOwnedGames must filter these out based on title patterns.
  it('fetchOwnedGames should filter out soundtracks and non-game items', async () => {
    const axios = require('axios');
    const originalGet = axios.get;

    axios.get = async (url) => {
      if (url.includes('/user/order')) {
        return { status: 200, data: [{ gamekey: 'key1' }] };
      }
      if (url.includes('/order/key1')) {
        return {
          data: {
            subproducts: [
              { machine_name: 'game1', human_name: 'Cool Game', downloads: [{ platform: 'windows' }] },
              { machine_name: 'ost1', human_name: 'Cool Game Soundtrack', downloads: [{ platform: 'audio' }] },
              { machine_name: 'ost2', human_name: 'Cool Game OST', downloads: [{ platform: 'audio' }] },
              { machine_name: 'ost3', human_name: 'Cool Game Original Score', downloads: [{ platform: 'audio' }] },
              { machine_name: 'art1', human_name: 'Cool Game Artbook', downloads: [{ platform: 'ebook' }] },
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

      assert.equal(games.length, 1, 'Should only return the actual game');
      assert.equal(games[0].title, 'Cool Game');
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

describe('HumbleLauncher order-fetch integrity', () => {
  it('throws when any order fetch fails instead of silently omitting its games', async () => {
    // The per-order catch warned and continued, so a failed order's games were
    // simply absent from the result. syncEngine then marks every edition that
    // was not returned as owned=0 (its only guard is a fully-empty result), and
    // still records status='success'. Any omission is therefore silent data
    // loss, so a known-incomplete list must never be returned as authoritative.
    const axios = require('axios');
    const originalGet = axios.get;

    axios.get = async (url) => {
      if (url.includes('/user/order')) {
        return { status: 200, data: [{ gamekey: 'ok1' }, { gamekey: 'bad2' }] };
      }
      if (url.includes('/order/ok1')) {
        return {
          status: 200,
          data: { subproducts: [{ machine_name: 'g1', human_name: 'Game One', downloads: [{}] }] },
        };
      }
      throw new Error('500 Internal Server Error');
    };

    try {
      const HumbleLauncher = require('../../../src/services/launchers/humble');
      const launcher = new HumbleLauncher('humble', {});
      launcher.credentials = { session_cookie: 'c' };

      await assert.rejects(
        () => launcher.fetchOwnedGames({ session_cookie: 'c' }),
        /partial|incomplete|order/i,
        'an incomplete order set must be an error, not a shorter list'
      );
    } finally {
      axios.get = originalGet;
    }
  });

  it('returns all games when every order fetch succeeds', async () => {
    const axios = require('axios');
    const originalGet = axios.get;

    axios.get = async (url) => {
      if (url.includes('/user/order')) {
        return { status: 200, data: [{ gamekey: 'a' }, { gamekey: 'b' }] };
      }
      const which = url.includes('/order/a') ? 'a' : 'b';
      return {
        status: 200,
        data: {
          subproducts: [
            { machine_name: `game_${which}`, human_name: `Game ${which}`, downloads: [{}] },
          ],
        },
      };
    };

    try {
      const HumbleLauncher = require('../../../src/services/launchers/humble');
      const launcher = new HumbleLauncher('humble', {});
      launcher.credentials = { session_cookie: 'c' };
      const games = await launcher.fetchOwnedGames({ session_cookie: 'c' });
      assert.equal(games.length, 2);
      assert.deepEqual(games.map(g => g.launcher_game_id).sort(), ['game_a', 'game_b']);
    } finally {
      axios.get = originalGet;
    }
  });
});
