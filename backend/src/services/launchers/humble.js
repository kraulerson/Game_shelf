const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Humble Bundle integration using unofficial session-based web API.
 *
 * 2FA: Humble emails a verification code ("Humble Guard") on new logins.
 * The code is passed via credentials.otp_code at sync time.
 *
 * Credentials shape: { username: string, password: string, otp_code?: string }
 */
class HumbleLauncher extends BaseLauncher {
  async authenticate(credentials) {
    const { username, password, otp_code } = credentials;

    // Phase 2: if we already have a code, submit it directly
    // (skip the guard-less POST to avoid triggering a second email)
    if (otp_code) {
      const guardRes = await axios.post(
        'https://www.humblebundle.com/processlogin',
        new URLSearchParams({ username, password, guard: otp_code }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          maxRedirects: 0,
          validateStatus: (status) => status < 500,
        }
      );

      const guardData = guardRes.data;
      if (!guardData || !guardData.success) {
        const errMsg = guardData?.errors ? JSON.stringify(guardData.errors) : 'Invalid verification code';
        throw new Error(`Humble Bundle 2FA failed: ${errMsg}`);
      }

      return this._extractSession(guardRes);
    }

    // Phase 1: attempt login without guard — triggers email if 2FA enabled
    const res = await axios.post(
      'https://www.humblebundle.com/processlogin',
      new URLSearchParams({ username, password, guard: '' }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 0,
        validateStatus: (status) => status < 500,
      }
    );

    const data = res.data;
    console.log(`[Humble] Login response: status=${res.status}, success=${data?.success}, guard_required=${data?.humble_guard_required}, keys=${data ? Object.keys(data).join(',') : 'null'}`);

    // 2FA required — Humble has sent the email, signal the sync engine
    if (data && data.humble_guard_required && !data.success) {
      throw new Error('OTP_REQUIRED:Enter the code emailed to you');
    }

    // No 2FA needed — check for direct success
    if (data && data.success) {
      return this._extractSession(res);
    }

    // Login failed for other reasons
    const errMsg = data?.errors ? JSON.stringify(data.errors) : (typeof data === 'string' ? data.substring(0, 200) : 'Login failed');
    console.error(`[Humble] Login failed. Full response data:`, JSON.stringify(data).substring(0, 500));
    throw new Error(`Humble Bundle login failed: ${errMsg}`);
  }

  _extractSession(res) {
    const cookies = res.headers['set-cookie'] || [];
    const sessionCookie = cookies.find(c => c.includes('_simpleauth_sess'));

    if (!sessionCookie) {
      throw new Error('Humble Bundle login succeeded but no session cookie received');
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
