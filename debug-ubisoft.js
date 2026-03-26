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

async function run() {
  let allGames = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const query = `query { viewer { ownedGames: games(filterBy: {isOwned: true}, limit: ${limit}, offset: ${offset}) { totalCount nodes { id name } } } }`;
    const res = await axios.post('https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', { query }, { headers });
    const games = res.data?.data?.viewer?.ownedGames;

    if (!games || !games.nodes?.length) break;

    console.log(`Page offset=${offset}: ${games.nodes.length} games (totalCount: ${games.totalCount})`);
    allGames.push(...games.nodes);

    if (allGames.length >= games.totalCount || games.nodes.length < limit) break;
    offset += limit;
  }

  console.log(`\nTotal fetched: ${allGames.length}`);
  allGames.forEach((g, i) => console.log(`${i + 1}. ${g.name}`));

  db.close();
}

run();
