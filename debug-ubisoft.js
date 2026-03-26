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

async function tryEndpoint(label, url, method, body) {
  console.log(`\n=== ${label} ===`);
  try {
    const res = method === 'post'
      ? await axios.post(url, body, { headers })
      : await axios.get(url, { headers });
    const data = res.data;
    if (Array.isArray(data)) {
      console.log('Array, count:', data.length);
      data.slice(0, 3).forEach(g => console.log(' -', JSON.stringify(g).slice(0, 200)));
    } else if (typeof data === 'object') {
      console.log(JSON.stringify(data).slice(0, 1500));
    }
  } catch (e) {
    console.log('Error:', e.response?.status, (e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message));
  }
}

async function run() {
  const userId = creds.userId;
  console.log('userId:', userId);

  // 1. Entitlements endpoint (might include legacy games)
  await tryEndpoint('Entitlements (me)',
    'https://public-ubiservices.ubi.com/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements',
    'get');

  // 2. Try different Ubi-AppId (the demux one)
  const altHeaders = { ...headers, 'Ubi-AppId': 'f68a4bb5-608a-4ff2-8123-be8ef797e0a6' };
  console.log('\n=== GraphQL with alt AppId (demux) ===');
  try {
    const res = await axios.post('https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', {
      query: `query { viewer { ownedGames: games(filterBy: {isOwned: true}, limit: 50) { totalCount nodes { id name } } } }`
    }, { headers: altHeaders });
    const games = res.data?.data?.viewer?.ownedGames;
    console.log('totalCount:', games?.totalCount, '| nodes:', games?.nodes?.length);
    if (games?.nodes) games.nodes.slice(0, 3).forEach(g => console.log(' -', g.name));
  } catch (e) {
    console.log('Error:', e.response?.status, e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message);
  }

  // 3. Try querying for "applications" instead of "games"
  const appQuery = `query { viewer { id ownedApplications: applications(filterBy: {isOwned: true}) { totalCount nodes { id name spaceId } } } }`;
  await tryEndpoint('GraphQL: applications',
    'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', 'post', { query: appQuery });

  // 4. Introspect the schema to see what query types exist
  const introspect = `query { __schema { queryType { fields { name description args { name type { name kind } } } } } }`;
  await tryEndpoint('GraphQL: schema introspection (queryType fields)',
    'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', 'post', { query: introspect });

  // 5. Check what fields are on Viewer type
  const viewerIntrospect = `query { __type(name: "User") { fields { name type { name kind ofType { name } } } } }`;
  await tryEndpoint('GraphQL: User type fields',
    'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', 'post', { query: viewerIntrospect });

  db.close();
}

run();
