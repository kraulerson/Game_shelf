const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Epic Games Store integration using OAuth authorization code flow.
 *
 * Auth flow: User logs in at Epic's website, gets a one-time auth code,
 * pastes it into Gameshelf. We exchange it for access + refresh tokens.
 * Tokens are refreshed automatically on each sync cycle (rolling 8h window).
 *
 * Credentials shape (after initial auth):
 * { access_token, refresh_token, expires_at, refresh_expires_at, account_id }
 */

const EPIC_CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const EPIC_CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';
const EPIC_TOKEN_URL = 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token';
const EPIC_LIBRARY_URL = 'https://library-service.live.use1a.on.epicgames.com/library/api/public/items';
const EPIC_PLAYTIME_URL = 'https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account';

const EPIC_AUTH_HEADER = 'Basic ' + Buffer.from(`${EPIC_CLIENT_ID}:${EPIC_CLIENT_SECRET}`).toString('base64');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class EpicLauncher extends BaseLauncher {
  /**
   * Exchange a one-time authorization code for tokens.
   * Called once from the credentials endpoint during initial setup.
   */
  async authenticate(credentials) {
    const { auth_code } = credentials;

    const res = await axios.post(EPIC_TOKEN_URL, new URLSearchParams({
      grant_type: 'authorization_code',
      code: auth_code,
      token_type: 'eg1',
    }).toString(), {
      headers: {
        'Authorization': EPIC_AUTH_HEADER,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const data = res.data;
    console.log('[Epic] Token response:', JSON.stringify({
      token_type: data.token_type,
      expires_at: data.expires_at,
      account_id: data.account_id,
      scope: data.scope,
      app: data.app,
      client_id: data.client_id,
    }));
    return {
      access_token: data.access_token,
      token_type: data.token_type || 'eg1',
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      refresh_expires_at: data.refresh_expires_at,
      account_id: data.account_id,
    };
  }

  /**
   * Check token expiry and refresh if needed.
   * Does NOT call authenticate() — uses refresh_token grant instead.
   * Returns { session, updatedCredentials } for syncEngine to persist.
   */
  async refreshIfNeeded(credentials) {
    const { access_token, token_type, refresh_token, expires_at, account_id } = credentials;

    const session = { access_token, token_type: token_type || 'eg1', account_id };

    // Check if access token is still valid (with 60s buffer)
    const expiresAt = new Date(expires_at).getTime();
    if (Date.now() < expiresAt - 60000) {
      return { session, updatedCredentials: null };
    }

    // Access token expired — refresh it
    console.log('[Epic] Access token expired, refreshing...');
    try {
      const res = await axios.post(EPIC_TOKEN_URL, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
        token_type: 'eg1',
      }).toString(), {
        headers: {
          'Authorization': EPIC_AUTH_HEADER,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const data = res.data;
      const updatedCredentials = {
        access_token: data.access_token,
        token_type: data.token_type || 'eg1',
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        refresh_expires_at: data.refresh_expires_at,
        account_id: data.account_id,
      };

      console.log('[Epic] Token refreshed successfully');
      return {
        session: { access_token: data.access_token, token_type: data.token_type || 'eg1', account_id: data.account_id },
        updatedCredentials,
      };
    } catch (err) {
      console.error('[Epic] Token refresh failed:', err.message);
      throw new Error('Epic authentication expired. Please re-authenticate.');
    }
  }

  async fetchOwnedGames(session) {
    const { access_token, token_type, account_id } = session;
    const authType = token_type || 'eg1';
    const headers = { Authorization: `${authType} ${access_token}` };
    console.log('[Epic] fetchOwnedGames auth:', JSON.stringify({ authType, account_id, tokenPrefix: access_token?.substring(0, 20) + '...' }));

    // Fetch library items (paginated)
    let allItems = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const params = { includeMetadata: true };
      if (cursor) params.cursor = cursor;
      console.log('[Epic] Library request:', EPIC_LIBRARY_URL, JSON.stringify(params));

      try {
        const res = await axios.get(EPIC_LIBRARY_URL, { headers, params });
        const records = res.data?.records || [];

        if (Array.isArray(records)) {
          if (allItems.length === 0 && records.length > 0) {
            console.log('[Epic] Sample library item keys:', Object.keys(records[0]));
            console.log('[Epic] Sample library item:', JSON.stringify(records[0]).substring(0, 500));
          }
          allItems.push(...records);
        }

        cursor = res.data?.responseMetadata?.nextCursor || null;
        hasMore = !!cursor;
      } catch (err) {
        console.error('[Epic] Library fetch failed:', err.message, err.response?.status, JSON.stringify(err.response?.data));
        hasMore = false;
      }

      await sleep(500);
    }

    // Fetch playtime
    let playtimeMap = {};
    try {
      const ptRes = await axios.get(`${EPIC_PLAYTIME_URL}/${account_id}/all`, { headers });
      const playtimes = Array.isArray(ptRes.data) ? ptRes.data : [];
      for (const pt of playtimes) {
        if (pt.artifactId) {
          playtimeMap[pt.artifactId] = Math.round((pt.totalTime || 0) / 60);
        }
      }
    } catch (err) {
      console.warn('[Epic] Playtime fetch failed:', err.message, err.response?.status, JSON.stringify(err.response?.data));
    }

    // Map to game format
    return allItems
      .filter(item => item.appName || item.catalogItemId)
      .map(item => {
        const id = item.appName || item.catalogItemId;
        return {
          launcher_game_id: id,
          title: item.appTitle || item.catalogItemTitle || id,
          playtime_minutes: playtimeMap[id] || 0,
        };
      });
  }
}

module.exports = EpicLauncher;
