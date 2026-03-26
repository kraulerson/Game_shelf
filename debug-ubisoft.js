const Database = require('better-sqlite3');
const { decrypt } = require('./src/utils/encrypt');
const { UbisoftDemux } = require('ubisoft-demux');
const yaml = require('yaml');

const db = new Database('/app/data/gameshelf.db');
const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'ubisoft'").get();
const creds = JSON.parse(decrypt(launcher.credentials_json));

async function run() {
  console.log('Ticket exists:', !!creds.ticket);

  const ubiDemux = new UbisoftDemux({ timeout: 15000 });

  try {
    console.log('Authenticating with Demux...');
    const authResp = await ubiDemux.basicRequest({
      authenticateReq: {
        clientId: 'uplay_pc',
        sendKeepAlive: false,
        token: { ubiTicket: creds.ticket },
      },
    });

    if (!authResp.authenticateRsp?.success) {
      console.log('Auth failed:', JSON.stringify(authResp));
      return;
    }
    console.log('Demux auth successful');

    console.log('Opening ownership_service...');
    const ownershipConn = await ubiDemux.openConnection('ownership_service');

    const initResp = await ownershipConn.request({
      request: {
        requestId: 1,
        initializeReq: {
          getAssociations: true,
          protoVersion: 7,
          useStaging: false,
        },
      },
    });

    const ownedGames = initResp.response?.initializeRsp?.ownedGames?.ownedGames || [];
    console.log('Total owned products:', ownedGames.length);

    // Show breakdown by productType
    const types = {};
    ownedGames.forEach(g => { types[g.productType] = (types[g.productType] || 0) + 1; });
    console.log('By productType:', JSON.stringify(types));
    console.log('  0=Game, 1=AddOn, 2=PreOrderGame, 4=Trial, 6=Bundle, 7=SeasonPass');

    // Filter to games only (productType 0)
    const games = ownedGames.filter(g => g.productType === 0);
    console.log('\nGames (productType=0):', games.length);

    let named = 0;
    let unnamed = 0;
    for (const game of games) {
      let name = null;
      if (game.configuration) {
        try {
          const config = yaml.parse(game.configuration, { uniqueKeys: false, strict: false });
          name = config?.root?.name || config?.root?.sort_string || null;
        } catch (e) {}
      }
      if (name) {
        named++;
        console.log(` - ${name} (productId: ${game.productId}, state: ${game.state})`);
      } else {
        unnamed++;
        console.log(` - [NO NAME] productId: ${game.productId}, uplayId: ${game.uplayId}, state: ${game.state}`);
      }
    }
    console.log(`\nNamed: ${named}, Unnamed: ${unnamed}`);

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await ubiDemux.destroy();
    db.close();
  }
}

run();
