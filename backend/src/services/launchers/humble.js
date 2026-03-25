const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Humble Bundle integration using session cookie auth.
 *
 * The user logs into humblebundle.com in their browser, copies the
 * _simpleauth_sess cookie from DevTools, and pastes it into Gameshelf.
 * No automated login — avoids Cloudflare CAPTCHA and email 2FA entirely.
 *
 * Credentials shape: { session_cookie: string }
 */
class HumbleLauncher extends BaseLauncher {
  async refreshIfNeeded(credentials) {
    if (!credentials.session_cookie) {
      throw new Error('Humble session cookie missing. Remove and re-add Humble in Settings with a fresh cookie.');
    }

    return {
      session: `_simpleauth_sess=${credentials.session_cookie}`,
    };
  }

  async fetchOwnedGames(session) {
    const headers = { Cookie: session };

    // Get all order keys — detect expired session
    let ordersRes;
    try {
      ordersRes = await axios.get(
        'https://www.humblebundle.com/api/v1/user/order?ajax=true',
        { headers, maxRedirects: 0, validateStatus: (s) => s < 500 }
      );
    } catch (err) {
      throw new Error('Humble session expired or invalid. Remove and re-add Humble in Settings with a fresh cookie.');
    }

    // Humble redirects to login page (302) or returns non-array when session is invalid
    if (ordersRes.status === 302 || ordersRes.status === 401 || !Array.isArray(ordersRes.data)) {
      throw new Error('Humble session expired or invalid. Remove and re-add Humble in Settings with a fresh cookie.');
    }

    const gamekeys = ordersRes.data;
    const games = [];
    const seen = new Set();

    // Fetch each order's details
    for (const item of gamekeys) {
      const key = item.gamekey || item;
      try {
        const orderRes = await axios.get(
          `https://www.humblebundle.com/api/v1/order/${key}?ajax=true`,
          { headers }
        );

        const subproducts = orderRes.data?.subproducts || [];
        for (const sub of subproducts) {
          // Only include items with downloads (actual games, not coupons/etc)
          if (sub.downloads && sub.downloads.length > 0 && !seen.has(sub.machine_name)) {
            seen.add(sub.machine_name);
            games.push({
              launcher_game_id: sub.machine_name,
              title: sub.human_name,
              playtime_minutes: 0,
            });
          }
        }
      } catch (err) {
        console.warn(`[Humble] Failed to fetch order ${key}: ${err.message}`);
      }
    }

    return games;
  }
}

module.exports = HumbleLauncher;
