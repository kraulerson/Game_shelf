const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Steam integration using the Steam Web API.
 *
 * This uses the official Steam Web API with a user-provided API key and SteamID64.
 * We do NOT use password-based Steam login — it is fragile, requires handling
 * Steam Guard, and violates Steam's Terms of Service.
 *
 * Credentials shape: { api_key: string, steamid64: string }
 * - api_key: from https://steamcommunity.com/dev/apikey
 * - steamid64: the user's 64-bit Steam ID (e.g., 76561198012345678)
 */
class SteamLauncher extends BaseLauncher {
  async authenticate(credentials) {
    // Steam Web API uses api_key in query params — no session needed
    this.credentials = credentials;
    return null;
  }

  async refreshIfNeeded(credentials) {
    // No session to refresh — API key based
    this.credentials = credentials;
    return null;
  }

  async fetchOwnedGames(session) {
    const { api_key, steamid64 } = this.credentials;

    const res = await axios.get('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/', {
      params: {
        key: api_key,
        steamid: steamid64,
        include_appinfo: 1,
        include_played_free_games: 1,
        format: 'json',
      },
    });

    const games = res.data?.response?.games || [];

    return games.map(game => ({
      launcher_game_id: game.appid.toString(),
      title: game.name,
      playtime_minutes: game.playtime_forever || 0,
    }));
  }
}

module.exports = SteamLauncher;
