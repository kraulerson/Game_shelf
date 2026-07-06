const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('GOG sync captures gog_slug', () => {
  afterEach(() => mock.reset());

  it('fetchOwnedGames returns the GOG product slug as gog_slug', async () => {
    const axios = require('axios');
    mock.method(axios, 'get', async (url) => {
      if (url.includes('/user/data/games')) return { data: { owned: [42] } };
      if (url.includes('/products/42')) {
        return { data: { game_type: 'game', title: "Baldur's Gate II: EE", slug: 'baldurs_gate_2_enhanced_edition' } };
      }
      throw new Error('unexpected url ' + url);
    });
    delete require.cache[require.resolve('../../src/services/launchers/gog')];
    const GOGLauncher = require('../../src/services/launchers/gog');
    const inst = new GOGLauncher();
    const games = await inst.fetchOwnedGames('tok');
    assert.equal(games.length, 1);
    assert.equal(games[0].gog_slug, 'baldurs_gate_2_enhanced_edition');
  });
});
