const Database = require('better-sqlite3');
const { decrypt } = require('./src/utils/encrypt');
const axios = require('axios');

const db = new Database('/app/data/gameshelf.db');
const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'ubisoft'").get();

if (!launcher || !launcher.credentials_json) {
  console.log('No Ubisoft credentials found');
  process.exit(1);
}

const creds = JSON.parse(decrypt(launcher.credentials_json));
console.log('Has ticket:', !!creds.ticket);
console.log('Has sessionId:', !!creds.sessionId);
console.log('Expiration:', creds.expiration);

const query = `query AllGames {
  viewer {
    id
    ownedGames: games(filterBy: {isOwned: true}) {
      totalCount
      nodes {
        id
        spaceId
        name
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
    }
  }
}`;

axios.post('https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql', {
  query: query,
}, {
  headers: {
    'Authorization': 'Ubi_v1 t=' + creds.ticket,
    'Ubi-AppId': 'f35adcb5-1911-440c-b1c9-48fdc1701c68',
    'Ubi-SessionId': creds.sessionId,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
}).then(res => {
  const data = res.data;
  console.log('\n=== Raw response keys:', Object.keys(data));
  if (data.errors) console.log('GraphQL errors:', JSON.stringify(data.errors, null, 2));

  const games = data?.data?.viewer?.ownedGames;
  if (!games) {
    console.log('\nNo ownedGames in response. Full response:');
    console.log(JSON.stringify(data, null, 2).slice(0, 2000));
  } else {
    console.log('\ntotalCount:', games.totalCount);
    console.log('nodes count:', games.nodes?.length);
    if (games.nodes?.length > 0) {
      console.log('\nFirst 3 games:');
      games.nodes.slice(0, 3).forEach(g => {
        const platforms = g.viewer?.meta?.ownedPlatformGroups || [];
        const types = platforms.map(p => p.type);
        console.log(' -', g.name, '| platforms:', types.join(', ') || 'NONE');
      });
      const pcGames = games.nodes.filter(g => {
        const platforms = g.viewer?.meta?.ownedPlatformGroups || [];
        return platforms.some(p => p.type === 'PC');
      });
      console.log('\nPC games:', pcGames.length, 'of', games.nodes.length, 'total');
    }
  }
}).catch(err => {
  console.log('Request failed:', err.response?.status, err.response?.data || err.message);
});
