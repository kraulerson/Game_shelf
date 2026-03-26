const Database = require('better-sqlite3');
const { decrypt } = require('./src/utils/encrypt');
const axios = require('axios');

const db = new Database('/app/data/gameshelf.db');
const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'ubisoft'").get();
const creds = JSON.parse(decrypt(launcher.credentials_json));

const headers = {
  'Authorization': 'Ubi_v1 t=' + creds.ticket,
  'Ubi-AppId': 'f35adcb5-1911-440c-b1c9-48fdc1701c68',
  'Ubi-SessionId': creds.sessionId,
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

const userId = creds.userId;

async function tryEndpoint(label, url, method = 'get', body = null) {
  console.log(`\n=== ${label} ===`);
  try {
    const res = method === 'get'
      ? await axios.get(url, { headers })
      : await axios.post(url, body, { headers });
    const data = res.data;
    if (Array.isArray(data)) {
      console.log('Array, count:', data.length);
      data.slice(0, 3).forEach(g => console.log(' -', JSON.stringify(g).slice(0, 150)));
    } else if (typeof data === 'object') {
      const keys = Object.keys(data);
      console.log('Object keys:', keys.join(', '));
      // Try to find game lists in common patterns
      for (const key of keys) {
        if (Array.isArray(data[key])) {
          console.log(`  ${key}: array of ${data[key].length}`);
          if (data[key].length > 0) data[key].slice(0, 2).forEach(g => console.log('   -', JSON.stringify(g).slice(0, 150)));
        }
      }
      if (keys.length <= 5) console.log(JSON.stringify(data).slice(0, 500));
    }
  } catch (e) {
    console.log('Error:', e.response?.status, e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
  }
}

async function run() {
  console.log('userId:', userId);

  // Ownership/entitlements endpoints
  await tryEndpoint('Ownership v1', `https://public-ubiservices.ubi.com/v1/profiles/${userId}/ownership`);
  await tryEndpoint('Ownership v2', `https://public-ubiservices.ubi.com/v2/profiles/${userId}/ownership`);
  await tryEndpoint('Ownership v3', `https://public-ubiservices.ubi.com/v3/profiles/${userId}/ownership`);

  // Club/library endpoints
  await tryEndpoint('Club games', `https://public-ubiservices.ubi.com/v1/profiles/${userId}/club/games`);
  await tryEndpoint('Uplay games', `https://public-ubiservices.ubi.com/v1/profiles/${userId}/uplay/games`);

  // Try different GraphQL with productType
  const gqlQuery = `query { viewer { id ownedGames: games(filterBy: {isOwned: true}, limit: 100, offset: 0) { totalCount nodes { id name } } } }`;
  await tryEndpoint('GraphQL with limit/offset', 'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', 'post', { query: gqlQuery });

  // Try alternative GraphQL queries
  const gql2 = `query { viewer { id games(limit: 100) { totalCount nodes { id name } } } }`;
  await tryEndpoint('GraphQL all games limit 100', 'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', 'post', { query: gql2 });

  // Entitlements
  await tryEndpoint('Entitlements', `https://public-ubiservices.ubi.com/v1/profiles/${userId}/entitlements`);
  await tryEndpoint('Entitlements v2', `https://public-ubiservices.ubi.com/v2/profiles/${userId}/entitlements`);

  db.close();
}

run();
