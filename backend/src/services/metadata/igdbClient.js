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

async function authenticate() {
  const creds = getCredentials();
  if (!creds) return null;

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

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
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 429) {
      // Rate limited — wait 500ms and retry once
      await sleep(500);
      try {
        const retryRes = await axios(config);
        return retryRes.data;
      } catch (retryErr) {
        console.error('[IGDB] Rate limit retry failed:', retryErr.message);
        return null;
      }
    }
    console.error('[IGDB] Request failed:', err.message);
    return null;
  }
}

async function search(title) {
  const escapedTitle = title.replace(/"/g, '\\"');
  const body = `search "${escapedTitle}"; fields ${IGDB_FIELDS}; limit 5;`;
  return igdbRequest(body);
}

async function getById(igdbId) {
  const body = `where id = ${igdbId}; fields ${IGDB_FIELDS}; limit 1;`;
  const results = await igdbRequest(body);
  return results && results.length > 0 ? results[0] : null;
}

module.exports = { search, getById };
