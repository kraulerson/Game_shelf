const axios = require('axios');

const IGDB_FIELDS = 'id,name,summary,cover.url,artworks.url,genres.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,first_release_date';

let cachedToken = null;
let tokenExpiresAt = 0;

function getCredentials() {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('[IGDB] IGDB_CLIENT_ID or IGDB_CLIENT_SECRET not set. Metadata enrichment disabled.');
    return null;
  }
  return { clientId, clientSecret };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function authenticate() {
  const creds = getCredentials();
  if (!creds) return null;

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  try {
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: 'client_credentials',
      },
    });

    cachedToken = res.data.access_token;
    tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
    return cachedToken;
  } catch (err) {
    console.error('[IGDB] OAuth token refresh failed:', err.message);
    cachedToken = null;
    tokenExpiresAt = 0;
    return null;
  }
}

async function igdbRequest(body) {
  const creds = getCredentials();
  if (!creds) return null;

  const token = await authenticate();
  if (!token) return null;

  const config = {
    method: 'post',
    url: 'https://api.igdb.com/v4/games',
    headers: {
      'Client-ID': creds.clientId,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    data: body,
  };

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios(config);
      return res.data;
    } catch (err) {
      const status = err.response?.status;

      // 401: token expired mid-batch — clear and re-auth once
      if (status === 401 && attempt === 1) {
        console.warn('[IGDB] Got 401, re-authenticating...');
        cachedToken = null;
        tokenExpiresAt = 0;
        const newToken = await authenticate();
        if (newToken) {
          config.headers['Authorization'] = `Bearer ${newToken}`;
          continue;
        }
        console.error('[IGDB] Re-authentication failed');
        return null;
      }

      // 429: rate limited — exponential backoff
      if (status === 429) {
        const retryAfter = err.response?.headers?.['retry-after'];
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, attempt) * 1000;
        console.warn(`[IGDB] Rate limited (429), retry ${attempt}/${maxRetries} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      // Other errors: log and return null
      console.error(`[IGDB] Request failed (attempt ${attempt}/${maxRetries}):`, err.message);
      return null;
    }
  }

  console.error('[IGDB] All retries exhausted');
  return null;
}

// IGDB external_games category IDs per platform
const PLATFORM_CATEGORIES = {
  steam: 1,
  gog: 5,
  itchio: 15,
  epic: 26,
};

async function search(title) {
  const escapedTitle = title.replace(/"/g, '\\"');
  const body = `search "${escapedTitle}"; fields ${IGDB_FIELDS}; limit 5;`;
  return igdbRequest(body);
}

async function getByExternalId(launcherName, launcherGameId) {
  const category = PLATFORM_CATEGORIES[launcherName];
  if (!category || !launcherGameId) return null;

  const body = `where external_games.uid = "${launcherGameId}" & external_games.category = ${category}; fields ${IGDB_FIELDS}; limit 1;`;
  const results = await igdbRequest(body);
  return results && results.length > 0 ? results[0] : null;
}

async function getById(igdbId) {
  const body = `where id = ${igdbId}; fields ${IGDB_FIELDS}; limit 1;`;
  const results = await igdbRequest(body);
  return results && results.length > 0 ? results[0] : null;
}

module.exports = { search, getByExternalId, getById };
