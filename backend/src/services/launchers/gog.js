const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const BaseLauncher = require('./base');

/**
 * GOG integration using browser-based OAuth flow.
 *
 * 2FA: GOG uses Google Authenticator (6-digit TOTP).
 * The code is passed via credentials.otp_code at sync time.
 *
 * The client_id and client_secret are community-maintained values from GOG
 * Galaxy reverse-engineering projects (gogrepoc, lgogdownloader). The previous
 * password grant approach used a truncated secret; this browser-based flow
 * uses the full GOG Galaxy client credentials.
 *
 * Credentials shape: { username: string, password: string, otp_code?: string,
 *                       access_token?: string, refresh_token?: string }
 */

const GOG_CLIENT_ID = '46899977096215655';
const GOG_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const GOG_REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';
const GOG_AUTH_URL = `https://auth.gog.com/auth?client_id=${GOG_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOG_REDIRECT_URI)}&response_type=code&layout=client2`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class GOGLauncher extends BaseLauncher {
  async authenticate(credentials) {
    const { username, password, otp_code } = credentials;

    const jar = new CookieJar();
    const client = wrapper(axios.create({
      jar,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    }));

    // Step 1: GET auth page to obtain login form and CSRF token
    const authPageRes = await client.get(GOG_AUTH_URL);
    const authHtml = authPageRes.data;

    console.log('[GOG] Auth page status:', authPageRes.status, 'url:', authPageRes.request?.res?.responseUrl || '(unknown)');

    // Log all hidden form fields to detect missing fields or CAPTCHAs
    const hiddenFields = [...authHtml.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)].map(m => m[0]);
    console.log('[GOG] Hidden form fields:', hiddenFields.join(' | ') || '(none)');

    // Check for CAPTCHA
    if (authHtml.includes('recaptcha') || authHtml.includes('captcha') || authHtml.includes('g-recaptcha')) {
      console.log('[GOG] WARNING: CAPTCHA detected on login page');
    }

    const tokenMatch = authHtml.match(/name="login\[_token\]"[^>]*value="([^"]+)"/);
    if (!tokenMatch) {
      console.log('[GOG] Auth page HTML (first 500 chars):', authHtml.substring(0, 500));
      throw new Error('GOG: Could not extract login CSRF token');
    }
    const csrfToken = tokenMatch[1];
    const cookiesForLogin = await jar.getCookies('https://login.gog.com');
    console.log('[GOG] Cookies for login.gog.com:', cookiesForLogin.map(c => c.key).join(', ') || '(none)');

    // Step 2: POST credentials to login_check
    let loginRes;
    try {
      loginRes = await client.post(
        'https://login.gog.com/login_check',
        new URLSearchParams({
          'login[username]': username,
          'login[password]': password,
          'login[login]': '',
          'login[_token]': csrfToken,
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          maxRedirects: 0,
          validateStatus: (status) => status < 500,
        }
      );
    } catch (err) {
      // Axios may throw on redirects depending on config — extract from error
      if (err.response) {
        loginRes = err.response;
      } else {
        throw err;
      }
    }

    // Step 3: Check where we ended up
    const redirectUrl = loginRes.headers?.location || loginRes.request?.res?.responseUrl || '';
    console.log('[GOG] Login response status:', loginRes.status, 'redirect:', redirectUrl || '(none)');

    // Success — extract code from redirect URL
    if (redirectUrl.includes('on_login_success')) {
      const code = new URL(redirectUrl, 'https://auth.gog.com').searchParams.get('code');
      if (!code) throw new Error('GOG: Login succeeded but no OAuth code in redirect');
      return this._exchangeCode(code, credentials);
    }

    // 2FA required — check for totp or two_step in redirect
    if (redirectUrl.includes('two_step') || redirectUrl.includes('totp')) {
      if (!otp_code) {
        throw new Error('OTP_REQUIRED:Enter the code from your authenticator app');
      }

      // Step 4: GET the 2FA page to extract its CSRF token
      const twoFaPageRes = await client.get(redirectUrl);
      const twoFaHtml = twoFaPageRes.data;

      let twoFaResult;

      if (redirectUrl.includes('totp')) {
        // TOTP (6-digit authenticator code)
        const totpTokenMatch = twoFaHtml.match(/name="two_factor_totp_authentication\[_token\]"[^>]*value="([^"]+)"/);
        if (!totpTokenMatch) throw new Error('GOG: Could not extract TOTP CSRF token');

        const digits = otp_code.toString().split('');
        const fields = {};
        for (let i = 0; i < digits.length && i < 6; i++) {
          fields[`two_factor_totp_authentication[token][letter_${i + 1}]`] = digits[i];
        }
        fields['two_factor_totp_authentication[send]'] = '';
        fields['two_factor_totp_authentication[_token]'] = totpTokenMatch[1];

        try {
          twoFaResult = await client.post(redirectUrl, new URLSearchParams(fields), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
          });
        } catch (err) {
          if (err.response) twoFaResult = err.response;
          else throw err;
        }
      } else {
        // Email-based 2FA (4-digit code)
        const emailTokenMatch = twoFaHtml.match(/name="second_step_authentication\[_token\]"[^>]*value="([^"]+)"/);
        if (!emailTokenMatch) throw new Error('GOG: Could not extract email 2FA CSRF token');

        const digits = otp_code.toString().split('');
        const fields = {};
        for (let i = 0; i < digits.length && i < 4; i++) {
          fields[`second_step_authentication[token][letter_${i + 1}]`] = digits[i];
        }
        fields['second_step_authentication[send]'] = '';
        fields['second_step_authentication[_token]'] = emailTokenMatch[1];

        try {
          twoFaResult = await client.post(redirectUrl, new URLSearchParams(fields), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
          });
        } catch (err) {
          if (err.response) twoFaResult = err.response;
          else throw err;
        }
      }

      // Extract code from final redirect
      const finalUrl = twoFaResult.headers?.location || twoFaResult.request?.res?.responseUrl || '';
      if (!finalUrl.includes('on_login_success')) {
        throw new Error('GOG: 2FA submission failed — invalid code or unexpected response');
      }

      const code = new URL(finalUrl, 'https://auth.gog.com').searchParams.get('code');
      if (!code) throw new Error('GOG: 2FA succeeded but no OAuth code in redirect');
      return this._exchangeCode(code, credentials);
    }

    // If we got HTML back (login page again), credentials were wrong
    console.log('[GOG] Unexpected state — no matching redirect. Status:', loginRes.status);
    console.log('[GOG] Login response body:', typeof loginRes.data === 'string' ? loginRes.data.substring(0, 500) : JSON.stringify(loginRes.data));
    throw new Error('GOG login failed — check username and password');
  }

  async _exchangeCode(code, credentials) {
    const tokenRes = await axios.get('https://auth.gog.com/token', {
      params: {
        client_id: GOG_CLIENT_ID,
        client_secret: GOG_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: GOG_REDIRECT_URI,
      },
    });

    const { access_token, refresh_token } = tokenRes.data;

    // Strip otp_code (time-sensitive, should not be persisted) and store tokens
    const { otp_code: _, ...cleanCredentials } = credentials;
    cleanCredentials.access_token = access_token;
    cleanCredentials.refresh_token = refresh_token;

    return { session: access_token, updatedCredentials: cleanCredentials };
  }

  async refreshIfNeeded(credentials) {
    // If we have a refresh token, try using it first (no 2FA needed)
    if (credentials.refresh_token) {
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

        // Strip otp_code and update tokens
        const { otp_code: _, ...cleanCredentials } = credentials;
        cleanCredentials.access_token = access_token;
        cleanCredentials.refresh_token = refresh_token;

        return { session: access_token, updatedCredentials: cleanCredentials };
      } catch (err) {
        console.warn('[GOG] Refresh token expired, falling back to full auth:', err.message);
      }
    }

    // Fall back to full authentication (requires 2FA code)
    return this.authenticate(credentials);
  }

  async fetchOwnedGames(session) {
    // session is already unwrapped to a raw access_token string by syncEngine.js
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
