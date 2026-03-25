const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('humanizeSlug', () => {
  const { humanizeSlug } = require('../../../src/services/launchers/gog');

  it('should strip trailing product ID and title-case', () => {
    assert.equal(humanizeSlug('quake_ii_quad_damage_1112936378'), 'Quake II Quad Damage');
  });

  it('should handle roman numerals correctly', () => {
    assert.equal(humanizeSlug('tomb_raider_the_last_revelation_chronicles_1085477296'), 'Tomb Raider The Last Revelation Chronicles');
    assert.equal(humanizeSlug('bioshock_remastered_1157510446'), 'Bioshock Remastered');
  });

  it('should uppercase roman numerals i through x', () => {
    assert.equal(humanizeSlug('final_fantasy_iii_123'), 'Final Fantasy III');
    assert.equal(humanizeSlug('grand_theft_auto_iv_456'), 'Grand Theft Auto IV');
    assert.equal(humanizeSlug('civilization_vi_789'), 'Civilization VI');
  });

  it('should handle slug with no trailing ID', () => {
    assert.equal(humanizeSlug('some_game'), 'Some Game');
  });
});

describe('GOG Launcher', () => {
  it('refreshIfNeeded should throw clear error when no refresh_token exists', async () => {
    // REGRESSION: Old username/password credentials have no refresh_token.
    // refreshIfNeeded must throw a clear re-configure message, not a cryptic error.
    const GOGLauncher = require('../../../src/services/launchers/gog');
    const instance = new GOGLauncher('gog', null);

    await assert.rejects(
      () => instance.refreshIfNeeded({ username: 'old', password: 'creds' }),
      { message: /reconfigured|re-add|Setup/i }
    );
  });

  // REGRESSION: GOG API returns "product_title_xxxxx" for some products.
  // fetchOwnedGames must fall back to humanizing the slug for these titles.
  it('fetchOwnedGames should humanize slug when title is a product_title key', async () => {
    const axios = require('axios');
    const originalGet = axios.get;

    axios.get = async (url) => {
      if (url.includes('/user/data/games')) {
        return { data: { owned: [1112936378] } };
      }
      if (url.includes('/products/1112936378')) {
        return {
          data: {
            title: 'product_title_1112936378',
            slug: 'quake_ii_quad_damage_1112936378',
            game_type: 'game',
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    try {
      const GOGLauncher = require('../../../src/services/launchers/gog');
      const instance = new GOGLauncher('gog', null);
      const games = await instance.fetchOwnedGames('fake-token');

      assert.equal(games.length, 1);
      assert.equal(games[0].title, 'Quake II Quad Damage');
      assert.equal(games[0].launcher_game_id, '1112936378');
    } finally {
      axios.get = originalGet;
    }
  });

  // REGRESSION: GOG "owned" list includes non-game products like wallpaper packs.
  // fetchOwnedGames must skip products where game_type !== 'game'.
  it('fetchOwnedGames should skip non-game products', async () => {
    const axios = require('axios');
    const originalGet = axios.get;

    axios.get = async (url) => {
      if (url.includes('/user/data/games')) {
        return { data: { owned: [111, 222] } };
      }
      if (url.includes('/products/111')) {
        return {
          data: { title: 'Real Game', slug: 'real_game', game_type: 'game' },
        };
      }
      if (url.includes('/products/222')) {
        return {
          data: { title: 'CDPR goodies', slug: 'cdpr_goodies', game_type: 'pack' },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    try {
      const GOGLauncher = require('../../../src/services/launchers/gog');
      const instance = new GOGLauncher('gog', null);
      const games = await instance.fetchOwnedGames('fake-token');

      assert.equal(games.length, 1, 'Should only return the real game');
      assert.equal(games[0].title, 'Real Game');
    } finally {
      axios.get = originalGet;
    }
  });

  it('refreshIfNeeded should throw clear error when refresh token is expired', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => { throw new Error('invalid_grant'); };

    try {
      const GOGLauncher = require('../../../src/services/launchers/gog');
      const instance = new GOGLauncher('gog', null);

      await assert.rejects(
        () => instance.refreshIfNeeded({ refresh_token: 'expired_token' }),
        { message: /expired|re-add|Setup/i }
      );
    } finally {
      axios.get = originalGet;
    }
  });
});
