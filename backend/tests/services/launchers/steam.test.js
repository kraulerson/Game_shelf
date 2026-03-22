const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('SteamLauncher', () => {
  it('authenticate() should return null (API key based, no session)', async () => {
    const SteamLauncher = require('../../../src/services/launchers/steam');
    const launcher = new SteamLauncher('steam', {});
    const session = await launcher.authenticate({ api_key: 'test', steamid64: '123' });
    assert.equal(session, null);
  });

  it('refreshIfNeeded() should return null (no session needed)', async () => {
    const SteamLauncher = require('../../../src/services/launchers/steam');
    const launcher = new SteamLauncher('steam', {});
    const session = await launcher.refreshIfNeeded({ api_key: 'test', steamid64: '123' });
    assert.equal(session, null);
  });

  it('fetchOwnedGames() should map Steam API response correctly', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => ({
      data: {
        response: {
          games: [
            { appid: 440, name: 'Team Fortress 2', playtime_forever: 1200 },
            { appid: 570, name: 'Dota 2', playtime_forever: 500 },
          ]
        }
      }
    });

    try {
      const SteamLauncher = require('../../../src/services/launchers/steam');
      const launcher = new SteamLauncher('steam', {});
      launcher.credentials = { api_key: 'testkey', steamid64: '76561198012345678' };
      const games = await launcher.fetchOwnedGames(null);

      assert.equal(games.length, 2);
      assert.equal(games[0].launcher_game_id, '440');
      assert.equal(games[0].title, 'Team Fortress 2');
      assert.equal(games[0].playtime_minutes, 1200);
      assert.equal(games[1].launcher_game_id, '570');
    } finally {
      axios.get = originalGet;
    }
  });

  it('fetchOwnedGames() should return empty array when no games', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => ({ data: { response: {} } });

    try {
      const SteamLauncher = require('../../../src/services/launchers/steam');
      const launcher = new SteamLauncher('steam', {});
      launcher.credentials = { api_key: 'testkey', steamid64: '123' };
      const games = await launcher.fetchOwnedGames(null);
      assert.equal(games.length, 0);
    } finally {
      axios.get = originalGet;
    }
  });
});
