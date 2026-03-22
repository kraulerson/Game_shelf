const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Humble Bundle integration using unofficial session-based web API.
 *
 * TODO: Humble's API is unofficial and undocumented. This integration may break
 * if Humble Bundle changes their API or login flow. Monitor for 401/403 errors
 * and update accordingly.
 *
 * Credentials shape: { username: string, password: string }
 */
class HumbleLauncher extends BaseLauncher {
  async authenticate(credentials) {
    const { username, password } = credentials;

    const res = await axios.post(
      'https://www.humblebundle.com/processlogin',
      new URLSearchParams({ username, password }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 0,
        validateStatus: (status) => status < 400 || status === 302,
      }
    );

    const cookies = res.headers['set-cookie'] || [];
    const sessionCookie = cookies.find(c => c.includes('_simpleauth_sess'));

    if (!sessionCookie) {
      throw new Error('Humble Bundle login failed: no session cookie received');
    }

    return sessionCookie.split(';')[0]; // "_simpleauth_sess=value"
  }

  async fetchOwnedGames(session) {
    const headers = { Cookie: session };

    // Get all order keys
    const ordersRes = await axios.get(
      'https://www.humblebundle.com/api/v1/user/order?ajax=true',
      { headers }
    );

    const gamekeys = ordersRes.data || [];
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
