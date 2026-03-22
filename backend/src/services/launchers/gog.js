const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * GOG integration using unofficial OAuth2 password grant.
 *
 * TODO: GOG's API is unofficial. The client_id and client_secret below are
 * community-maintained values from GOG reverse-engineering projects (e.g.,
 * lgogdownloader). They may be revoked by GOG at any time. Consider making
 * these configurable via environment variables if they change frequently.
 *
 * TODO: GOG's auth may require re-auth flows (e.g., CAPTCHA, 2FA) that are
 * not handled here. Monitor for auth failures and document workarounds.
 *
 * Credentials shape: { username: string, password: string }
 */

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173d183b1a9';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class GOGLauncher extends BaseLauncher {
  async authenticate(credentials) {
    const { username, password } = credentials;

    const res = await axios.post('https://auth.gog.com/token', null, {
      params: {
        client_id: GOG_CLIENT_ID,
        client_secret: GOG_CLIENT_SECRET,
        grant_type: 'password',
        username,
        password,
      },
    });

    return res.data.access_token;
  }

  async fetchOwnedGames(session) {
    // Get list of owned game IDs
    const ownedRes = await axios.get('https://embed.gog.com/user/data/games', {
      headers: { Authorization: `Bearer ${session}` },
    });

    const ownedIds = ownedRes.data?.owned || [];
    const games = [];

    // Fetch product details for each owned game (rate limited: 1 req/sec)
    for (const id of ownedIds) {
      try {
        const productRes = await axios.get(`https://api.gog.com/products/${id}`, {
          params: { expand: 'description' },
        });

        games.push({
          launcher_game_id: id.toString(),
          title: productRes.data.title,
          playtime_minutes: 0,
        });
      } catch (err) {
        console.warn(`[GOG] Failed to fetch product ${id}: ${err.message}`);
      }

      // Rate limit: 1 request per second
      await sleep(1000);
    }

    return games;
  }
}

module.exports = GOGLauncher;
