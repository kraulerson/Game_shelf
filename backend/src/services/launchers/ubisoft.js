const axios = require('axios');
const tls = require('tls');
const protobuf = require('protobufjs');
const path = require('path');
const glob = require('glob');
const fs = require('fs');
const yaml = require('yaml');
const BaseLauncher = require('./base');

/**
 * Ubisoft Connect integration using email/password Basic Auth + demux ownership service.
 *
 * Auth flow: User provides email/password during setup. First sync logs in
 * via Basic Auth with the demux AppId, handles email-based 2FA via two-phase
 * sync flow, stores ticket + rememberMeTicket for refresh.
 *
 * Game library: Uses demux ownership_service (TLS socket + protobuf) for the
 * complete game list (including redeemed keys, Prime Gaming, etc.). Falls back
 * to GraphQL if demux fails.
 *
 * Credentials shape (after login):
 * { username, password, ticket, sessionId, rememberMeTicket, userId, expiration,
 *   demuxTicket, demuxRememberMeTicket, demuxExpiration }
 */

const UBI_DEMUX_APP_ID = 'f68a4bb5-608a-4ff2-8123-be8ef797e0a6';
const UBI_CLUB_APP_ID = 'f35adcb5-1911-440c-b1c9-48fdc1701c68';
const UBI_AUTH_URL = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';
const UBI_GRAPHQL_URL = 'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql';
const UBI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEMUX_HOST = 'dmx.upc.ubisoft.com';
const DEMUX_VERSION = 11200;

const OWNED_GAMES_QUERY = `
query AllGames {
  viewer {
    id
    ownedGames: games(filterBy: {isOwned: true}) {
      totalCount
      nodes { id spaceId name }
    }
  }
}`;

// Lazy-load protobuf definitions (loaded once on first use)
let _protoRoot = null;
function getProtoRoot() {
  if (_protoRoot) return _protoRoot;
  const protoDir = path.join(__dirname, '../../../node_modules/ubisoft-demux/dist/proto');
  if (!fs.existsSync(protoDir)) return null;
  const protoFiles = glob.sync(`${protoDir}/**/*.proto`);
  if (protoFiles.length === 0) return null;
  _protoRoot = new protobuf.Root();
  _protoRoot.resolvePath = (origin, target) => {
    const resolved = path.resolve(protoDir, target);
    if (fs.existsSync(resolved)) return resolved;
    return path.resolve(path.dirname(origin), target);
  };
  _protoRoot.loadSync(protoFiles);
  return _protoRoot;
}

function buildHeaders(appId, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Ubi-AppId': appId,
    'User-Agent': UBI_USER_AGENT,
    ...extra,
  };
}

class UbisoftLauncher extends BaseLauncher {
  /**
   * Login with email/password Basic Auth using specified AppId.
   * If 2FA is triggered and otp_code is provided, completes 2FA.
   * If 2FA is triggered without otp_code, throws OTP_REQUIRED.
   */
  async _login(appId, username, password, otpCode) {
    const basicAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
      headers: buildHeaders(appId, { Authorization: basicAuth }),
    });

    const data = res.data;

    if (data.twoFactorAuthenticationTicket) {
      if (!otpCode) {
        throw new Error('OTP_REQUIRED:Check your email for a verification code');
      }

      const res2fa = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
        headers: buildHeaders(appId, {
          Authorization: `ubi_2fa_v1 t=${data.twoFactorAuthenticationTicket}`,
          'Ubi-2faCode': otpCode,
        }),
      });

      return res2fa.data;
    }

    return data;
  }

  /**
   * Refresh using rememberMeTicket with specified AppId.
   */
  async _refreshWithRememberMe(appId, rememberMeTicket) {
    const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
      headers: buildHeaders(appId, { Authorization: `rm_v1 t=${rememberMeTicket}` }),
    });
    return res.data;
  }

  /**
   * Get a valid ticket for a given AppId, using rememberMe refresh or full login.
   */
  async _getTicket(appId, credentials, rmTicketKey, ticketKey, expirationKey) {
    const { username, password, otp_code } = credentials;
    const rmTicket = credentials[rmTicketKey];
    const ticket = credentials[ticketKey];
    const expiration = credentials[expirationKey];

    // Check if existing ticket is still valid
    if (ticket && expiration) {
      const expiresAtMs = new Date(expiration).getTime();
      if (Date.now() < expiresAtMs - 60000) {
        return { ticket, isNew: false };
      }
    }

    // Try rememberMeTicket refresh (avoids 2FA)
    if (rmTicket) {
      try {
        console.log(`[Ubisoft] Refreshing ${appId === UBI_DEMUX_APP_ID ? 'demux' : 'club'} ticket...`);
        const data = await this._refreshWithRememberMe(appId, rmTicket);
        return { data, isNew: true };
      } catch (err) {
        console.warn(`[Ubisoft] rememberMe refresh failed for ${appId}:`, err.message);
      }
    }

    // Full login
    console.log(`[Ubisoft] Logging in with ${appId === UBI_DEMUX_APP_ID ? 'demux' : 'club'} AppId...`);
    const data = await this._login(appId, username, password, otp_code);
    return { data, isNew: true };
  }

  async authenticate(credentials) {
    return credentials;
  }

  /**
   * Get both club and demux tickets. Returns session with both.
   */
  async refreshIfNeeded(credentials) {
    const { username, password } = credentials;

    // Get club ticket (for GraphQL fallback)
    const clubResult = await this._getTicket(
      UBI_CLUB_APP_ID, credentials,
      'rememberMeTicket', 'ticket', 'expiration'
    );

    // Get demux ticket (for ownership_service)
    let demuxResult;
    try {
      demuxResult = await this._getTicket(
        UBI_DEMUX_APP_ID, credentials,
        'demuxRememberMeTicket', 'demuxTicket', 'demuxExpiration'
      );
    } catch (err) {
      // If demux login fails (e.g., 2FA already consumed by club login), proceed without it
      console.warn('[Ubisoft] Demux ticket failed, will use GraphQL fallback:', err.message);
      demuxResult = null;
    }

    const updatedCredentials = { username, password };

    // Club credentials
    if (clubResult.isNew && clubResult.data) {
      updatedCredentials.ticket = clubResult.data.ticket;
      updatedCredentials.sessionId = clubResult.data.sessionId;
      updatedCredentials.rememberMeTicket = clubResult.data.rememberMeTicket;
      updatedCredentials.userId = clubResult.data.userId;
      updatedCredentials.expiration = clubResult.data.expiration;
    } else if (clubResult.ticket) {
      updatedCredentials.ticket = clubResult.ticket;
      updatedCredentials.sessionId = credentials.sessionId;
      updatedCredentials.rememberMeTicket = credentials.rememberMeTicket;
      updatedCredentials.userId = credentials.userId;
      updatedCredentials.expiration = credentials.expiration;
    }

    // Demux credentials
    if (demuxResult?.isNew && demuxResult.data) {
      updatedCredentials.demuxTicket = demuxResult.data.ticket;
      updatedCredentials.demuxRememberMeTicket = demuxResult.data.rememberMeTicket;
      updatedCredentials.demuxExpiration = demuxResult.data.expiration;
    } else if (demuxResult?.ticket) {
      updatedCredentials.demuxTicket = demuxResult.ticket;
      updatedCredentials.demuxRememberMeTicket = credentials.demuxRememberMeTicket;
      updatedCredentials.demuxExpiration = credentials.demuxExpiration;
    } else {
      // Preserve existing demux creds if available
      updatedCredentials.demuxTicket = credentials.demuxTicket;
      updatedCredentials.demuxRememberMeTicket = credentials.demuxRememberMeTicket;
      updatedCredentials.demuxExpiration = credentials.demuxExpiration;
    }

    const session = {
      ticket: updatedCredentials.ticket,
      sessionId: updatedCredentials.sessionId,
      demuxTicket: updatedCredentials.demuxTicket,
    };

    console.log('[Ubisoft] Authentication successful');
    return { session, updatedCredentials };
  }

  /**
   * Fetch games via demux ownership_service (returns complete library).
   */
  async _fetchViaDemux(demuxTicket) {
    const root = getProtoRoot();
    if (!root) throw new Error('Protobuf definitions not available');

    const demuxUpstream = root.lookupType('mg.protocol.demux.Upstream');
    const demuxDownstream = root.lookupType('mg.protocol.demux.Downstream');
    const ownershipUpstream = root.lookupType('mg.protocol.ownership.Upstream');
    const ownershipDownstream = root.lookupType('mg.protocol.ownership.Downstream');

    function encode(data) {
      const payload = demuxUpstream.encode(demuxUpstream.create(data)).finish();
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      return Buffer.concat([header, payload]);
    }

    function readMessage(socket, timeout = 30000) {
      return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => { socket.removeListener('data', onData); reject(new Error('Demux timeout')); }, timeout);
        function onData(chunk) {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (buf.length < 4 + len) return;
            const msgBuf = buf.subarray(4, 4 + len);
            buf = buf.subarray(4 + len);
            clearTimeout(timer);
            socket.removeListener('data', onData);
            resolve(demuxDownstream.decode(msgBuf));
            return;
          }
        }
        socket.on('data', onData);
      });
    }

    // Read messages until we get one matching a predicate, skipping others
    function readUntil(socket, predicate, timeout = 30000) {
      return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => {
          socket.removeListener('data', onData);
          reject(new Error('Demux timeout waiting for matching message'));
        }, timeout);
        function onData(chunk) {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (buf.length < 4 + len) return;
            const msgBuf = buf.subarray(4, 4 + len);
            buf = buf.subarray(4 + len);
            try {
              const msg = demuxDownstream.decode(msgBuf);
              if (predicate(msg)) {
                clearTimeout(timer);
                socket.removeListener('data', onData);
                resolve(msg);
                return;
              }
              // Skip non-matching messages (keepalives, acks, etc.)
              console.log('[Ubisoft] Skipping demux message:', msg.response ? 'response' : msg.push ? 'push' : 'unknown');
            } catch (e) {
              // Skip decode errors
            }
          }
        }
        socket.on('data', onData);
      });
    }

    const socket = tls.connect(443, DEMUX_HOST, {
      servername: DEMUX_HOST, rejectUnauthorized: false,
    });
    await new Promise((resolve, reject) => {
      socket.on('secureConnect', resolve);
      socket.on('error', reject);
      setTimeout(() => reject(new Error('TLS connect timeout')), 10000);
    });

    try {
      // clientVersion must be first
      socket.write(encode({ push: { clientVersion: { version: DEMUX_VERSION } } }));
      await new Promise(r => setTimeout(r, 300));

      // Authenticate
      socket.write(encode({
        request: {
          requestId: 1,
          authenticateReq: { clientId: 'uplay_pc', sendKeepAlive: false, token: { ubiTicket: demuxTicket } },
        },
      }));
      const authResp = await readMessage(socket);
      console.log('[Ubisoft] Demux auth success:', !!authResp?.response?.authenticateRsp?.success);
      if (!authResp?.response?.authenticateRsp?.success) {
        throw new Error('Demux auth failed: ' + JSON.stringify(authResp).slice(0, 200));
      }

      // Open ownership_service
      console.log('[Ubisoft] Opening ownership_service...');
      socket.write(encode({
        request: { requestId: 2, openConnectionReq: { serviceName: 'ownership_service' } },
      }));
      const openResp = await readMessage(socket);
      const connId = openResp?.response?.openConnectionRsp?.connectionId;
      console.log('[Ubisoft] Ownership connection ID:', connId, '| resp keys:', Object.keys(openResp || {}));
      if (!connId) throw new Error('Failed to open ownership_service: ' + JSON.stringify(openResp).slice(0, 200));

      // Initialize ownership
      console.log('[Ubisoft] Sending ownership init request...');
      const svcPayload = ownershipUpstream.encode(ownershipUpstream.create({
        request: { requestId: 1, initializeReq: { getAssociations: true, protoVersion: 7, useStaging: false } },
      })).finish();
      socket.write(encode({ push: { data: { connectionId: connId, data: svcPayload } } }));

      // Wait for a push message containing connection data (skip acks, keepalives)
      console.log('[Ubisoft] Waiting for ownership response (30s timeout)...');
      const ownerResp = await readUntil(socket, msg => {
        const hasConnData = !!msg?.push?.data?.data;
        const hasResponse = !!msg?.response;
        const hasPush = !!msg?.push;
        if (!hasConnData) {
          console.log('[Ubisoft] Demux msg received - response:', hasResponse, 'push:', hasPush,
            'pushKeys:', msg?.push ? Object.keys(msg.push) : 'n/a',
            'dataKeys:', msg?.push?.data ? Object.keys(msg.push.data) : 'n/a');
        }
        return hasConnData;
      }, 30000);
      const connData = ownerResp.push.data.data;

      const svcResp = ownershipDownstream.decode(connData);
      const allProducts = svcResp?.response?.initializeRsp?.ownedGames?.ownedGames || [];

      // Filter to base games (productType 0), parse names from YAML config
      return allProducts
        .filter(g => g.productType === 0)
        .map(g => {
          let name = null;
          if (g.configuration) {
            try {
              const config = yaml.parse(g.configuration, { uniqueKeys: false, strict: false });
              name = config?.root?.name || config?.root?.sort_string || null;
            } catch (e) { /* ignore malformed YAML */ }
          }
          return {
            launcher_game_id: String(g.productId),
            title: name || `Ubisoft Product ${g.productId}`,
            playtime_minutes: 0,
          };
        })
        .filter(g => g.title && !g.title.startsWith('Ubisoft Product'));
    } finally {
      socket.destroy();
    }
  }

  /**
   * Fetch games via GraphQL (returns only native purchases, ~16 games).
   */
  async _fetchViaGraphQL(ticket, sessionId) {
    const res = await axios.post(UBI_GRAPHQL_URL, {
      query: OWNED_GAMES_QUERY,
    }, {
      headers: buildHeaders(UBI_CLUB_APP_ID, {
        Authorization: `Ubi_v1 t=${ticket}`,
        'Ubi-SessionId': sessionId,
      }),
    });

    const nodes = res.data?.data?.viewer?.ownedGames?.nodes || [];
    return nodes.map(node => ({
      launcher_game_id: node.id,
      title: node.name,
      playtime_minutes: 0,
    }));
  }

  /**
   * Fetch owned games. Tries demux first (complete list), falls back to GraphQL.
   */
  async fetchOwnedGames(session) {
    const { ticket, sessionId, demuxTicket } = session;

    // Try demux ownership_service for complete library
    if (demuxTicket) {
      try {
        console.log('[Ubisoft] Fetching games via demux ownership_service...');
        const games = await this._fetchViaDemux(demuxTicket);
        console.log(`[Ubisoft] Demux returned ${games.length} games`);
        return games;
      } catch (err) {
        console.warn('[Ubisoft] Demux fetch failed, falling back to GraphQL:', err.message);
      }
    }

    // Fallback: GraphQL (only returns ~16 native purchases)
    console.log('[Ubisoft] Fetching games via GraphQL (limited to native purchases)...');
    const games = await this._fetchViaGraphQL(ticket, sessionId);
    console.log(`[Ubisoft] GraphQL returned ${games.length} games`);
    return games;
  }
}

module.exports = UbisoftLauncher;
