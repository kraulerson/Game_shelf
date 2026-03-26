const axios = require('axios');
const BaseLauncher = require('./base');

/**
 * Ubisoft Connect integration.
 *
 * Two game sources:
 * 1. GraphQL API — returns ~16 native Ubisoft Store purchases with clean names
 * 2. Local cache file import — user uploads configurations + ownership files
 *    from their Windows machine for the complete library (Prime Gaming, etc.)
 *
 * Auth: email/password Basic Auth with email-based 2FA via two-phase sync flow.
 * Credentials: { username, password, ticket, sessionId, rememberMeTicket, userId, expiration }
 */

const UBI_APP_ID = 'f35adcb5-1911-440c-b1c9-48fdc1701c68';
const UBI_AUTH_URL = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';
const UBI_GRAPHQL_URL = 'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql';
const UBI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

function buildHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Ubi-AppId': UBI_APP_ID,
    'User-Agent': UBI_USER_AGENT,
    ...extra,
  };
}

function readVarint(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return { value: result, pos };
}

/**
 * Parse the Ubisoft Connect local cache files to extract owned games.
 * configurations: protobuf file with game metadata (YAML configs)
 * ownership: protobuf file with owned product IDs
 */
function parseLocalCacheFiles(configBuf, ownershipBuf) {
  // Parse configurations → map of productId → { name, isDlc, hasStartGame }
  const productMap = {};
  let pos = 0;
  while (pos < configBuf.length) {
    const tag = readVarint(configBuf, pos); pos = tag.pos;
    const fn = tag.value >> 3, wt = tag.value & 7;
    if (wt === 2) {
      const len = readVarint(configBuf, pos); pos = len.pos;
      const end = pos + len.value;
      if (fn === 1) {
        let ep = pos, uid = 0, config = '';
        while (ep < end) {
          const et = readVarint(configBuf, ep); ep = et.pos;
          const efn = et.value >> 3, ewt = et.value & 7;
          if (ewt === 0) { const v = readVarint(configBuf, ep); ep = v.pos; if (efn === 1) uid = v.value; }
          else if (ewt === 2) { const l = readVarint(configBuf, ep); ep = l.pos; if (efn === 3) config = configBuf.toString('utf8', ep, ep + l.value); ep += l.value; }
          else break;
        }
        if (config && uid) {
          const isDlc = /is_dlc:\s*yes/i.test(config) || /is_ulc:\s*yes/i.test(config);
          const hasStart = /start_game:/i.test(config);
          if (!isDlc && hasStart) {
            // Extract name from multiple sources (best to worst)
            let name = null;
            const placeholder = /^(l\d+|NAME|GAMENAME|GAME_NAME|BACKGROUNDIMAGE|THUMBIMAGE)$/i;

            // 1. display_name field
            const dn = config.match(/display_name:\s*(.+?)\s*$/m);
            if (dn && dn[1].length > 2 && !placeholder.test(dn[1])) name = dn[1].replace(/^["']|["']$/g, '');

            // 2. name field (if not placeholder)
            if (!name) {
              const nm = config.match(/^\s*name:\s*["']?(.+?)["']?\s*$/m);
              if (nm && nm[1].length > 2 && !placeholder.test(nm[1])) name = nm[1];
            }

            // 3. Comment header (e.g., "# Child of Light")
            if (!name) {
              const lines = config.split('\n');
              for (const line of lines) {
                const cm = line.match(/^#\s+([A-Za-z][\w\s:®™'&\-!.]+)/);
                if (cm && cm[1].length > 3 && !cm[1].startsWith('---')) {
                  name = cm[1].trim();
                  break;
                }
              }
            }

            // 4. sort_string (clean up internal codes like "Assassin's Creed 05.1")
            if (!name) {
              const ss = config.match(/sort_string:\s*(.+?)\s*$/m);
              if (ss && ss[1].length > 2) name = ss[1].replace(/^["']|["']$/g, '');
            }

            productMap[uid] = name || null;
          }
        }
      }
      pos = end;
    } else if (wt === 0) { pos = readVarint(configBuf, pos).pos; }
    else break;
  }

  // Parse ownership file → set of owned product IDs
  // Skip 0x108 byte header
  const ownedIds = new Set();
  pos = 0x108;
  while (pos < ownershipBuf.length) {
    try {
      const tag = readVarint(ownershipBuf, pos); pos = tag.pos;
      const wt = tag.value & 7;
      if (wt === 2) {
        const len = readVarint(ownershipBuf, pos); pos = len.pos;
        const end = pos + len.value;
        let ep = pos, pid = 0;
        while (ep < end) {
          const et = readVarint(ownershipBuf, ep); ep = et.pos;
          const efn = et.value >> 3, ewt = et.value & 7;
          if (ewt === 0) { const v = readVarint(ownershipBuf, ep); ep = v.pos; if (efn === 1) pid = v.value; }
          else if (ewt === 2) { const l = readVarint(ownershipBuf, ep); ep = l.pos; ep += l.value; }
          else break;
        }
        if (pid > 0) ownedIds.add(pid);
        pos = end;
      } else if (wt === 0) { pos = readVarint(ownershipBuf, pos).pos; }
      else break;
    } catch (e) { break; }
  }

  // Cross-reference: owned IDs that have a config entry (base game with start_game)
  const games = [];
  for (const id of ownedIds) {
    if (id in productMap) {
      games.push({
        launcher_game_id: String(id),
        title: productMap[id] || `Ubisoft Game ${id}`,
        playtime_minutes: 0,
      });
    }
  }

  return games;
}

class UbisoftLauncher extends BaseLauncher {
  async _login(username, password, otpCode) {
    const basicAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
      headers: buildHeaders({ Authorization: basicAuth }),
    });

    const data = res.data;

    if (data.twoFactorAuthenticationTicket) {
      if (!otpCode) {
        throw new Error('OTP_REQUIRED:Check your email for a verification code');
      }

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

  async _refreshWithRememberMe(rememberMeTicket) {
    const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
      headers: buildHeaders({ Authorization: `rm_v1 t=${rememberMeTicket}` }),
    });
    return res.data;
  }

  async authenticate(credentials) {
    return credentials;
  }

  async refreshIfNeeded(credentials) {
    const { username, password, ticket, sessionId, rememberMeTicket, expiration, otp_code } = credentials;

    if (ticket && expiration) {
      const expiresAtMs = new Date(expiration).getTime();
      if (Date.now() < expiresAtMs - 60000) {
        return { session: { ticket, sessionId }, updatedCredentials: null };
      }
    }

    let data;

    if (rememberMeTicket) {
      try {
        console.log('[Ubisoft] Refreshing with rememberMeTicket...');
        data = await this._refreshWithRememberMe(rememberMeTicket);
      } catch (err) {
        console.warn('[Ubisoft] rememberMeTicket refresh failed, falling back to login:', err.message);
        data = null;
      }
    }

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
    console.log(`[Ubisoft] GraphQL returned ${nodes.length} games`);

    return nodes.map(node => ({
      launcher_game_id: node.id,
      title: node.name,
      playtime_minutes: 0,
    }));
  }
}

module.exports = UbisoftLauncher;
module.exports.parseLocalCacheFiles = parseLocalCacheFiles;
