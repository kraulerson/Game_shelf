const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Xbox / Microsoft integration using OpenXBL API.
 *
 * Users get a free API key from https://xbl.io (requires Xbox Live account).
 * The API key is permanent and does not expire.
 *
 * Credentials shape: { api_key: string }
 */

const OPENXBL_BASE = 'https://xbl.io/api/v2';

class XboxLauncher extends BaseLauncher {
  async authenticate(credentials) {
    this.credentials = credentials;
    return null;
  }

  async refreshIfNeeded(credentials) {
    this.credentials = credentials;
    return null;
  }

  async fetchOwnedGames(session) {
    const { api_key } = this.credentials;

    const headers = {
      'X-Authorization': api_key,
      'Accept': 'application/json',
    };

    try {
      const res = await axios.get(`${OPENXBL_BASE}/player/titleHistory`, { headers });
      const titles = res.data?.titles || [];

      return titles
        .filter(t => t.titleId && t.name)
        .map(t => ({
          launcher_game_id: t.titleId.toString(),
          title: t.name,
          playtime_minutes: t.minutesPlayed || 0,
        }));
    } catch (err) {
      console.error('[Xbox] Title history fetch failed:', err.message);
      throw err;
    }
  }
}

module.exports = XboxLauncher;
