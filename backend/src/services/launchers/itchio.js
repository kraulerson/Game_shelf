const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * itch.io integration using the official API.
 *
 * Uses an API key from https://itch.io/user/settings/api-keys
 * Only fetches purchased/owned games via /profile/owned-keys.
 * The /my-games endpoint returns games the user has UPLOADED, not purchased.
 *
 * Credentials shape: { api_key: string }
 */
class ItchioLauncher extends BaseLauncher {
  async authenticate(credentials) {
    // API key based — no session needed
    this.credentials = credentials;
    return null;
  }

  async refreshIfNeeded(credentials) {
    this.credentials = credentials;
    return null;
  }

  async fetchOwnedGames(session) {
    const { api_key } = this.credentials;
    const games = [];
    const seen = new Set();
    let page = 1;
    const MAX_PAGES = 100; // Safety cap to prevent infinite loops

    // Paginate through owned keys
    while (page <= MAX_PAGES) {
      const res = await axios.get('https://api.itch.io/profile/owned-keys', {
        headers: { Authorization: `Bearer ${api_key}` },
        params: { page },
      });

      const ownedKeys = res.data?.owned_keys || [];
      if (ownedKeys.length === 0) break;

      for (const key of ownedKeys) {
        const game = key.game;
        if (game && !seen.has(game.id)) {
          seen.add(game.id);
          games.push({
            launcher_game_id: game.id.toString(),
            title: game.title,
            playtime_minutes: 0,
          });
        }
      }

      page++;
    }

    return games;
  }
}

module.exports = ItchioLauncher;
