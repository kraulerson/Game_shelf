const Database = require('better-sqlite3');
const { decrypt } = require('./src/utils/encrypt');
const yaml = require('yaml');
const tls = require('tls');
const protobuf = require('protobufjs');
const path = require('path');
const glob = require('glob');
const fs = require('fs');
const axios = require('axios');

const protoDir = path.join(__dirname, 'node_modules/ubisoft-demux/dist/proto');
const protoFiles = glob.sync(`${protoDir}/**/*.proto`);
const root = new protobuf.Root();
root.resolvePath = (origin, target) => {
  const resolved = path.resolve(protoDir, target);
  if (fs.existsSync(resolved)) return resolved;
  return path.resolve(path.dirname(origin), target);
};
root.loadSync(protoFiles);

const demuxUpstream = root.lookupType('mg.protocol.demux.Upstream');
const demuxDownstream = root.lookupType('mg.protocol.demux.Downstream');

const db = new Database('/app/data/gameshelf.db');
const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'ubisoft'").get();
const creds = JSON.parse(decrypt(launcher.credentials_json));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const DEMUX_APP_ID = 'f68a4bb5-608a-4ff2-8123-be8ef797e0a6';

function encode(data) {
  const payload = demuxUpstream.encode(demuxUpstream.create(data)).finish();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function readMessage(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.removeListener('data', onData); reject(new Error('Timeout')); }, 15000);
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length >= 4 + len) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          resolve(demuxDownstream.decode(buf.subarray(4, 4 + len)));
        }
      }
    }
    socket.on('data', onData);
  });
}

async function getDemuxTicket() {
  // Get a fresh ticket using the demux-specific AppId
  console.log('Getting ticket with demux AppId...');
  try {
    const res = await axios.post('https://public-ubiservices.ubi.com/v3/profiles/sessions',
      { rememberMe: true },
      {
        headers: {
          'Content-Type': 'application/json',
          'Ubi-AppId': DEMUX_APP_ID,
          'User-Agent': UA,
          'Authorization': 'rm_v1 t=' + creds.rememberMeTicket,
        },
      }
    );
    console.log('Got demux ticket, expiration:', res.data.expiration);
    return res.data.ticket;
  } catch (e) {
    console.log('Demux ticket via rememberMe failed:', e.response?.status);
    // Try basic auth
    try {
      const basicAuth = 'Basic ' + Buffer.from(creds.username + ':' + creds.password).toString('base64');
      const res = await axios.post('https://public-ubiservices.ubi.com/v3/profiles/sessions',
        { rememberMe: true },
        {
          headers: {
            'Content-Type': 'application/json',
            'Ubi-AppId': DEMUX_APP_ID,
            'User-Agent': UA,
            'Authorization': basicAuth,
          },
        }
      );
      if (res.data.twoFactorAuthenticationTicket) {
        console.log('2FA required for demux ticket — using existing ticket instead');
        return null;
      }
      console.log('Got demux ticket via basic auth');
      return res.data.ticket;
    } catch (e2) {
      console.log('Basic auth also failed:', e2.response?.status);
      return null;
    }
  }
}

async function tryDemux(ticket, version) {
  const socket = tls.connect(443, 'dmx.upc.ubisoft.com', {
    servername: 'dmx.upc.ubisoft.com', rejectUnauthorized: false,
  });
  await new Promise((resolve, reject) => {
    socket.on('secureConnect', resolve);
    socket.on('error', reject);
    setTimeout(() => reject(new Error('TLS timeout')), 10000);
  });

  socket.write(encode({ push: { clientVersion: { version } } }));
  await new Promise(r => setTimeout(r, 300));

  socket.write(encode({
    request: {
      requestId: 1,
      authenticateReq: {
        clientId: 'uplay_pc',
        sendKeepAlive: false,
        token: { ubiTicket: ticket },
      },
    },
  }));

  const resp = await readMessage(socket);
  return { socket, resp };
}

async function run() {
  // Step 1: Get a ticket with the demux AppId
  const demuxTicket = await getDemuxTicket();
  const clubTicket = creds.ticket;

  const tickets = [];
  if (demuxTicket) tickets.push({ name: 'demux-appid', ticket: demuxTicket });
  tickets.push({ name: 'club-appid', ticket: clubTicket });

  // Step 2: Try each ticket with versions near the boundary
  const versions = [11150, 11199, 11200, 11500, 12000];

  for (const { name, ticket } of tickets) {
    for (const v of versions) {
      console.log(`\nv${v} ticket=${name}:`);
      try {
        const { socket, resp } = await tryDemux(ticket, v);
        const success = resp?.response?.authenticateRsp?.success;
        const outdated = resp?.push?.clientOutdated;

        if (success) {
          console.log('SUCCESS!');

          // Get ownership
          const ownershipUpstream = root.lookupType('mg.protocol.ownership.Upstream');
          const ownershipDownstream = root.lookupType('mg.protocol.ownership.Downstream');

          socket.write(encode({
            request: { requestId: 2, openConnectionReq: { serviceName: 'ownership_service' } },
          }));
          const openResp = await readMessage(socket);
          const connId = openResp?.response?.openConnectionRsp?.connectionId;

          if (connId) {
            const svcPayload = ownershipUpstream.encode(ownershipUpstream.create({
              request: { requestId: 1, initializeReq: { getAssociations: true, protoVersion: 7, useStaging: false } },
            })).finish();
            socket.write(encode({ push: { data: { connectionId: connId, data: svcPayload } } }));

            const ownerResp = await readMessage(socket);
            const connData = ownerResp?.push?.data?.data;
            if (connData) {
              const svcResp = ownershipDownstream.decode(connData);
              const games = (svcResp?.response?.initializeRsp?.ownedGames?.ownedGames || []).filter(g => g.productType === 0);
              console.log('Games found:', games.length);
              for (const g of games) {
                let name = null;
                if (g.configuration) {
                  try { name = yaml.parse(g.configuration, { uniqueKeys: false, strict: false })?.root?.name; } catch(e) {}
                }
                console.log(` - ${name || '[NO NAME]'} (pid: ${g.productId})`);
              }
            }
          }
          socket.destroy();
          db.close();
          return;
        } else if (outdated) {
          console.log('OUTDATED');
        } else {
          console.log('FAIL (success=false)');
        }
        socket.destroy();
      } catch (e) {
        console.log('ERROR:', e.message);
      }
    }
  }

  console.log('\nNo working combination found.');
  db.close();
}

run();
