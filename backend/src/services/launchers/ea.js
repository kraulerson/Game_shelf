const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * EA App integration using OAuth authorization code flow + Juno GraphQL API.
 *
 * Auth flow: User logs in at EA's OAuth URL, gets a one-time auth code,
 * pastes it into Gameshelf. We exchange it for access + refresh tokens.
 *
 * Credentials shape (after initial auth):
 * { access_token, refresh_token, expires_at }
 */

const EA_CLIENT_ID = 'JUNO_PC_CLIENT';
const EA_CLIENT_SECRET = '4mRLtYMb6vq9qglomWEaT4auACSQmaccrOyR2';
const EA_TOKEN_URL = 'https://accounts.ea.com/connect/token';
const EA_REDIRECT_URI = 'qrc:///html/login_successful.html';
const EA_GRAPHQL_URL = 'https://service-aggregation-layer.juno.ea.com/graphql';

const OWNED_GAMES_QUERY = `
query getPreloadedOwnedGames($next: String, $locale: Locale, $limit: Int,
    $type: [GameProductType!]!, $entitlementEnabled: Boolean,
    $storefronts: [UserGameProductStorefront!],
    $ownershipMethods: [OwnershipMethod!],
    $platforms: [GamePlatform!]!) {
  me {
    ownedGameProducts(
      storefronts: $storefronts
      locale: $locale
      paging: {limit: $limit, next: $next}
      productFound: true
      orderBy: {field: NAME, direction: ASC}
      ownershipMethod: $ownershipMethods
      type: $type
      downloadableOnly: false
      entitlementEnabled: $entitlementEnabled
      platforms: $platforms
    ) {
      items {
        id: originOfferId
        status
        product {
          id
          name
          gameSlug
          baseItem(availabilities: [VISIBLE]) {
            title
            gameType
          }
        }
      }
    }
  }
}`;

const OWNED_GAMES_VARIABLES = {
  locale: 'DEFAULT',
  limit: 9999,
  type: ['DIGITAL_FULL_GAME', 'PACKAGED_FULL_GAME'],
  entitlementEnabled: true,
  storefronts: ['EA'],
  platforms: ['PC'],
  ownershipMethods: ['PURCHASE', 'REDEMPTION', 'ENTITLEMENT_GRANT'],
};

class EALauncher extends BaseLauncher {
  /**
   * Exchange a one-time authorization code for tokens.
   */
  async authenticate(credentials) {
    const { auth_code } = credentials;

    const res = await axios.post(EA_TOKEN_URL, new URLSearchParams({
      grant_type: 'authorization_code',
      code: auth_code,
      client_id: EA_CLIENT_ID,
      client_secret: EA_CLIENT_SECRET,
      redirect_uri: EA_REDIRECT_URI,
      token_format: 'JWS',
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = res.data;
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();

    console.log('[EA] Token exchange successful');
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
    };
  }

  /**
   * Check token expiry and refresh if needed.
   * Returns { session, updatedCredentials } for syncEngine to persist.
   */
  async refreshIfNeeded(credentials) {
    const { access_token, refresh_token, expires_at } = credentials;

    // Check if access token is still valid (with 60s buffer)
    const expiresAtMs = new Date(expires_at).getTime();
    if (Date.now() < expiresAtMs - 60000) {
      return { session: access_token, updatedCredentials: null };
    }

    // Access token expired — refresh it
    console.log('[EA] Access token expired, refreshing...');
    try {
      const res = await axios.post(EA_TOKEN_URL, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
        client_id: EA_CLIENT_ID,
        client_secret: EA_CLIENT_SECRET,
        token_format: 'JWS',
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const data = res.data;
      const newExpiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();

      const updatedCredentials = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: newExpiresAt,
      };

      console.log('[EA] Token refreshed successfully');
      return { session: data.access_token, updatedCredentials };
    } catch (err) {
      console.error('[EA] Token refresh failed:', err.message);
      throw new Error('EA authentication expired. Please re-authenticate.');
    }
  }

  /**
   * Fetch owned games from EA's Juno GraphQL API.
   */
  async fetchOwnedGames(session) {
    const res = await axios.post(EA_GRAPHQL_URL, {
      query: OWNED_GAMES_QUERY,
      variables: OWNED_GAMES_VARIABLES,
    }, {
      headers: {
        'Authorization': `Bearer ${session}`,
        'User-Agent': 'EAApp/PC/13.468.0.5981/GOG_Galaxy',
        'x-client-id': 'EAX-JUNO-CLIENT',
        'Content-Type': 'application/json',
      },
    });

    const items = res.data?.data?.me?.ownedGameProducts?.items || [];

    return items
      .filter(item => {
        const gameType = item.product?.baseItem?.gameType;
        return !gameType || gameType === 'BASE_GAME';
      })
      .map(item => ({
        launcher_game_id: item.id || item.product?.id,
        title: item.product?.name || item.product?.baseItem?.title || item.id,
        playtime_minutes: 0,
      }));
  }
}

module.exports = EALauncher;
