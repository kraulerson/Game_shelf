const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * GOG integration using OAuth authorization code flow.
 *
 * Auth flow: User logs in at GOG's website in their browser (handling CAPTCHA
 * and 2FA themselves), gets redirected to a page with a code in the URL,
 * pastes it into GameShelf. We exchange it for access + refresh tokens.
 *
 * Credentials shape (after initial auth):
 * { access_token, refresh_token }
 */

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const ROMAN_NUMERALS = new Set(['i','ii','iii','iv','v','vi','vii','viii','ix','x']);

function humanizeSlug(slug) {
  // Strip trailing _\d+ (product ID suffix)
  const stripped = slug.replace(/_\d+$/, '');
  return stripped
    .split('_')
    .map(w => ROMAN_NUMERALS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

class GOGLauncher extends BaseLauncher {
  /**
   * Exchange a one-time authorization code for tokens.
   * Called once from the credentials endpoint during initial setup.
   * Returns flat credentials object (stored directly as encrypted credentials).
   */
  async authenticate(credentials) {
    const { auth_code } = credentials;

    const tokenRes = await axios.get('https://auth.gog.com/token', {
      params: {
        client_id: GOG_CLIENT_ID,
        client_secret: GOG_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: auth_code,
        redirect_uri: GOG_REDIRECT_URI,
      },
    });

    return {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
    };
  }

  /**
   * Refresh the access token using the stored refresh token.
   * Does NOT fall back to authenticate() — there's no auth_code in stored credentials.
   * Returns { session, updatedCredentials } for syncEngine to persist.
   */
  async refreshIfNeeded(credentials) {
    if (!credentials.refresh_token) {
      throw new Error('GOG credentials need to be reconfigured. Please remove GOG and re-add it in Setup.');
    }

    try {
      const tokenRes = await axios.get('https://auth.gog.com/token', {
        params: {
          client_id: GOG_CLIENT_ID,
          client_secret: GOG_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: credentials.refresh_token,
        },
      });

      const { access_token, refresh_token } = tokenRes.data;

      return {
        session: access_token,
        updatedCredentials: { access_token, refresh_token },
      };
    } catch (err) {
      throw new Error('GOG refresh token expired. Please remove GOG and re-add it in Setup.');
    }
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

        let title = productRes.data.title;
        if (/^product_title_\d+$/.test(title) && productRes.data.slug) {
          title = humanizeSlug(productRes.data.slug);
        }

        games.push({
          launcher_game_id: id.toString(),
          title,
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
module.exports.humanizeSlug = humanizeSlug;
