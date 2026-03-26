const Database = require('better-sqlite3');
const { decrypt, encrypt } = require('./src/utils/encrypt');
const { UbisoftDemux } = require('ubisoft-demux');
const yaml = require('yaml');
const axios = require('axios');

const db = new Database('/app/data/gameshelf.db');
const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'ubisoft'").get();
const creds = JSON.parse(decrypt(launcher.credentials_json));

const UBI_APP_ID = 'f35adcb5-1911-440c-b1c9-48fdc1701c68';
const UBI_AUTH_URL = 'https://public-ubiservices.ubi.com/v3/profiles/sessions';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function refreshTicket() {
  // Try rememberMeTicket first
  if (creds.rememberMeTicket) {
    console.log('Refreshing with rememberMeTicket...');
    try {
      const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
        headers: {
          'Content-Type': 'application/json',
          'Ubi-AppId': UBI_APP_ID,
          'User-Agent': UA,
          Authorization: 'rm_v1 t=' + creds.rememberMeTicket,
        },
      });
      const data = res.data;
      console.log('Refreshed. New expiration:', data.expiration);
      // Update stored credentials
      creds.ticket = data.ticket;
      creds.sessionId = data.sessionId;
      creds.rememberMeTicket = data.rememberMeTicket;
      creds.expiration = data.expiration;
      const encrypted = encrypt(JSON.stringify(creds));
      db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(encrypted, 'ubisoft');
      return data.ticket;
    } catch (e) {
      console.log('rememberMeTicket refresh failed:', e.response?.status, e.message);
    }
  }

  // Fall back to Basic auth
  console.log('Logging in with credentials...');
  const basicAuth = 'Basic ' + Buffer.from(creds.username + ':' + creds.password).toString('base64');
  const res = await axios.post(UBI_AUTH_URL, { rememberMe: true }, {
    headers: {
      'Content-Type': 'application/json',
      'Ubi-AppId': UBI_APP_ID,
      'User-Agent': UA,
      Authorization: basicAuth,
    },
  });
  const data = res.data;
  if (data.twoFactorAuthenticationTicket) {
    console.log('2FA required — cannot refresh automatically. Run a sync from the UI first.');
    process.exit(1);
  }
  console.log('Logged in. Expiration:', data.expiration);
  creds.ticket = data.ticket;
  creds.sessionId = data.sessionId;
  creds.rememberMeTicket = data.rememberMeTicket;
  creds.expiration = data.expiration;
  const encrypted = encrypt(JSON.stringify(creds));
  db.prepare('UPDATE launchers SET credentials_json = ? WHERE name = ?').run(encrypted, 'ubisoft');
  return data.ticket;
}

async function run() {
  const ticket = await refreshTicket();
  console.log('\nConnecting to Demux...');

  const ubiDemux = new UbisoftDemux({ timeout: 15000 });

  try {
    const authResp = await ubiDemux.basicRequest({
      authenticateReq: {
        clientId: 'uplay_pc',
        sendKeepAlive: false,
        token: { ubiTicket: ticket },
      },
    });

    if (!authResp.authenticateRsp?.success) {
      console.log('Demux auth failed:', JSON.stringify(authResp));
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

    const types = {};
    ownedGames.forEach(g => { types[g.productType] = (types[g.productType] || 0) + 1; });
    console.log('By productType:', JSON.stringify(types));

    const games = ownedGames.filter(g => g.productType === 0);
    console.log('\nGames (productType=0):', games.length);

    for (const game of games) {
      let name = null;
      if (game.configuration) {
        try {
          const config = yaml.parse(game.configuration, { uniqueKeys: false, strict: false });
          name = config?.root?.name || config?.root?.sort_string || null;
        } catch (e) {}
      }
      console.log(` - ${name || '[NO NAME]'} (productId: ${game.productId}, state: ${game.state})`);
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await ubiDemux.destroy();
    db.close();
  }
}

run();
