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

// Query 1: Current query
const query1 = `query { viewer { id ownedGames: games(filterBy: {isOwned: true}) { totalCount nodes { id name } } } }`;

// Query 2: Try without filter
const query2 = `query { viewer { id allGames: games { totalCount nodes { id name } } } }`;

// Query 3: Try with limit and offset
const query3 = `query { viewer { id ownedGames: games(filterBy: {isOwned: true}, limit: 100) { totalCount nodes { id name } } } }`;

async function run() {
  console.log('=== Query 1: isOwned filter ===');
  try {
    const res1 = await axios.post('https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', { query: query1 }, { headers });
    const games1 = res1.data?.data?.viewer?.ownedGames;
    console.log('totalCount:', games1?.totalCount, '| nodes:', games1?.nodes?.length);
    games1?.nodes?.forEach(g => console.log(' -', g.name));
  } catch (e) { console.log('Error:', e.response?.status, e.response?.data?.errors?.[0]?.message || e.message); }

  console.log('\n=== Query 2: no filter ===');
  try {
    const res2 = await axios.post('https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', { query: query2 }, { headers });
    const games2 = res2.data?.data?.viewer?.allGames;
    console.log('totalCount:', games2?.totalCount, '| nodes:', games2?.nodes?.length);
    if (games2?.nodes) games2.nodes.forEach(g => console.log(' -', g.name));
  } catch (e) { console.log('Error:', e.response?.status, e.response?.data?.errors?.[0]?.message || e.message); }

  console.log('\n=== Query 3: isOwned with limit 100 ===');
  try {
    const res3 = await axios.post('https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', { query: query3 }, { headers });
    const games3 = res3.data?.data?.viewer?.ownedGames;
    console.log('totalCount:', games3?.totalCount, '| nodes:', games3?.nodes?.length);
  } catch (e) { console.log('Error:', e.response?.status, e.response?.data?.errors?.[0]?.message || e.message); }

  // Query 4: Try the ownership endpoint directly (REST, not GraphQL)
  console.log('\n=== Query 4: REST ownership endpoint ===');
  try {
    const res4 = await axios.get('https://public-ubiservices.ubi.com/v1/profiles/' + creds.userId + '/club/aggregation/website/owned-games', { headers });
    const data = res4.data;
    console.log('Type:', typeof data, '| isArray:', Array.isArray(data));
    if (Array.isArray(data)) {
      console.log('Count:', data.length);
      data.slice(0, 5).forEach(g => console.log(' -', g.name || g.title || JSON.stringify(g).slice(0, 100)));
    } else {
      console.log(JSON.stringify(data).slice(0, 500));
    }
  } catch (e) { console.log('Error:', e.response?.status, e.message); }

  db.close();
}

run();
