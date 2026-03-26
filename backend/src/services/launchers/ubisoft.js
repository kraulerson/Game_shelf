const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Ubisoft Connect integration using email/password Basic Auth + GraphQL.
 *
 * Auth flow: User provides email/password during setup. First sync logs in
 * via Basic Auth, handles email-based 2FA via two-phase sync flow, stores
 * ticket + rememberMeTicket for refresh.
 *
 * Credentials shape (after login):
 * { username, password, ticket, sessionId, rememberMeTicket, userId, expiration }
 */

const UBI_APP_ID = 'f35adcb5-1911-440c-b1c9-48fdc1701c68';
const UBI_AUTH_URL = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';
const UBI_GRAPHQL_URL = 'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql';
const UBI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OWNED_GAMES_QUERY = `
query AllGames {
  viewer {
    id
    ...ownedGamesList
  }
}
fragment gameProps on Game {
  id
  spaceId
  name
}
fragment ownedGameProps on Game {
  ...gameProps
  viewer {
    meta {
      id
      ownedPlatformGroups {
        id
        name
        type
      }
    }
  }
}
fragment ownedGamesList on User {
  ownedGames: games(filterBy: {isOwned: true}) {
    totalCount
    nodes {
      ...ownedGameProps
    }
  }
}`;

function buildHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Ubi-AppId': UBI_APP_ID,
    'User-Agent': UBI_USER_AGENT,
    ...extra,
  };
}

class UbisoftLauncher extends BaseLauncher {
  /**
   * Login with email/password Basic Auth.
   * If 2FA is triggered and otp_code is provided, completes 2FA.
   * If 2FA is triggered without otp_code, throws OTP_REQUIRED.
   */
  async _login(username, password, otpCode) {
    const basicAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
      headers: buildHeaders({ Authorization: basicAuth }),
    });

    const data = res.data;

    // 2FA challenge
    if (data.twoFactorAuthenticationTicket) {
      if (!otpCode) {
        throw new Error('OTP_REQUIRED:Check your email for a verification code');
      }

      // Complete 2FA with code
      const res2fa = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
        headers: buildHeaders({
          Authorization: `ubi_2fa_v1 t=${data.twoFactorAuthenticationTicket}`,
          'Ubi-2faCode': otpCode,
        }),
      });

      return res2fa.data;
    }

    return data;
  }

  /**
   * Refresh using rememberMeTicket.
   */
  async _refreshWithRememberMe(rememberMeTicket) {
    const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
      headers: buildHeaders({ Authorization: `rm_v1 t=${rememberMeTicket}` }),
    });
    return res.data;
  }

  /**
   * Not used for credentials+totp type — setup stores email/password directly.
   * Login happens during sync via refreshIfNeeded().
   */
  async authenticate(credentials) {
    return credentials;
  }

  /**
   * Check ticket expiry and refresh if needed.
   * Handles: initial login (no ticket), rememberMeTicket refresh, and full re-login.
   */
  async refreshIfNeeded(credentials) {
    const { username, password, ticket, sessionId, rememberMeTicket, expiration, otp_code } = credentials;

    // If ticket exists and not expired (with 60s buffer), use it
    if (ticket && expiration) {
      const expiresAtMs = new Date(expiration).getTime();
      if (Date.now() < expiresAtMs - 60000) {
        return { session: { ticket, sessionId }, updatedCredentials: null };
      }
    }

    let data;

    // Try rememberMeTicket refresh first (avoids 2FA)
    if (rememberMeTicket) {
      try {
        console.log('[Ubisoft] Refreshing with rememberMeTicket...');
        data = await this._refreshWithRememberMe(rememberMeTicket);
      } catch (err) {
        console.warn('[Ubisoft] rememberMeTicket refresh failed, falling back to login:', err.message);
        data = null;
      }
    }

    // Fall back to full login
    if (!data) {
      console.log('[Ubisoft] Logging in with credentials...');
      data = await this._login(username, password, otp_code);
    }

    const session = { ticket: data.ticket, sessionId: data.sessionId };
    const updatedCredentials = {
      username,
      password,
      ticket: data.ticket,
      sessionId: data.sessionId,
      rememberMeTicket: data.rememberMeTicket,
      userId: data.userId,
      expiration: data.expiration,
    };

    console.log('[Ubisoft] Authentication successful');
    return { session, updatedCredentials };
  }

  /**
   * Fetch owned PC games from Ubisoft's GraphQL API.
   */
  async fetchOwnedGames(session) {
    const { ticket, sessionId } = session;

    const res = await axios.post(UBI_GRAPHQL_URL, {
      query: OWNED_GAMES_QUERY,
    }, {
      headers: buildHeaders({
        Authorization: `Ubi_v1 t=${ticket}`,
        'Ubi-SessionId': sessionId,
      }),
    });

    const nodes = res.data?.data?.viewer?.ownedGames?.nodes || [];

    // The uplay/graphql endpoint only returns PC games, so no platform filter needed
    return nodes.map(node => ({
      launcher_game_id: node.id,
      title: node.name,
      playtime_minutes: 0,
    }));
  }
}

module.exports = UbisoftLauncher;
