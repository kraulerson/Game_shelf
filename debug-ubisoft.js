const Database = require('better-sqlite3');
const { decrypt } = require('./src/utils/encrypt');
const yaml = require('yaml');
const tls = require('tls');
const protobuf = require('protobufjs');
const path = require('path');
const glob = require('glob');
const fs = require('fs');
const axios = require('axios');

// Load proto definitions
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

function encode(data) {
  const msg = demuxUpstream.create(data);
  const payload = demuxUpstream.encode(msg).finish();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function readMessage(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error('Timeout'));
    }, 15000);
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

async function testDemux(version) {
  console.log(`\n=== Demux with API_VERSION ${version} ===`);
  const socket = tls.connect(443, 'dmx.upc.ubisoft.com', {
    servername: 'dmx.upc.ubisoft.com',
    rejectUnauthorized: false,
  });
  await new Promise((resolve, reject) => {
    socket.on('secureConnect', resolve);
    socket.on('error', reject);
    setTimeout(() => reject(new Error('TLS timeout')), 10000);
  });

  try {
    socket.write(encode({ push: { clientVersion: { version: version } } }));
    await new Promise(r => setTimeout(r, 500));

    socket.write(encode({
      request: {
        requestId: 1,
        authenticateReq: {
          clientId: 'uplay_pc',
          sendKeepAlive: false,
          token: { ubiTicket: creds.ticket },
        },
      },
    }));

    const resp = await readMessage(socket);
    const success = resp?.response?.authenticateRsp?.success;
    const outdated = resp?.push?.clientOutdated;
    if (success) {
      console.log('AUTH SUCCESS with version', version);
      return { socket, version };
    } else if (outdated) {
      console.log('clientOutdated with version', version);
    } else {
      console.log('Response:', JSON.stringify(resp).slice(0, 300));
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  socket.destroy();
  return null;
}

async function testHttpEndpoints() {
  const headers = {
    'Authorization': 'Ubi_v1 t=' + creds.ticket,
    'Ubi-AppId': 'f35adcb5-1911-440c-b1c9-48fdc1701c68',
    'Ubi-SessionId': creds.sessionId,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  // Try spaceId-based queries
  const UPLAY_PC_SPACE = '85016d9d-7b2f-4c1d-937b-5f3192004240';

  console.log('\n=== HTTP: Entitlements with spaceId ===');
  try {
    const res = await axios.get(
      `https://public-ubiservices.ubi.com/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements?spaceId=${UPLAY_PC_SPACE}`,
      { headers }
    );
    console.log(JSON.stringify(res.data).slice(0, 1000));
  } catch (e) {
    console.log('Error:', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300));
  }

  console.log('\n=== HTTP: Applications by spaceId ===');
  try {
    const res = await axios.get(
      `https://api-ubiservices.ubi.com/v2/applications?spaceIds=${UPLAY_PC_SPACE}`,
      { headers }
    );
    console.log(JSON.stringify(res.data).slice(0, 1000));
  } catch (e) {
    console.log('Error:', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300));
  }

  // Try the GraphQL with different filter
  console.log('\n=== GraphQL: games without isOwned filter ===');
  try {
    const q = `query { viewer { allGames: games(limit: 50) { totalCount nodes { id name } } } }`;
    const res = await axios.post(
      'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql',
      { query: q }, { headers }
    );
    const games = res.data?.data?.viewer?.allGames;
    console.log('totalCount:', games?.totalCount, '| nodes:', games?.nodes?.length);
  } catch (e) {
    console.log('Error:', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300));
  }
}

async function run() {
  console.log('Ticket:', creds.ticket ? creds.ticket.slice(0, 20) + '...' : 'MISSING');

  // Test HTTP endpoints
  await testHttpEndpoints();

  // Try demux with various recent version numbers
  // Ubisoft Connect versions: try recent ones (2024-2026 era)
  const versions = [13000, 12500, 12000, 11500, 11000, 10931];
  for (const v of versions) {
    const result = await testDemux(v);
    if (result) {
      console.log('\nFOUND WORKING VERSION:', v);
      // Continue with ownership query...
      const ownershipUpstream = root.lookupType('mg.protocol.ownership.Upstream');
      const ownershipDownstream = root.lookupType('mg.protocol.ownership.Downstream');

      result.socket.write(encode({
        request: {
          requestId: 2,
          openConnectionReq: { serviceName: 'ownership_service' },
        },
      }));
      const openResp = await readMessage(result.socket);
      const connId = openResp?.response?.openConnectionRsp?.connectionId;
      console.log('Connection ID:', connId);

      if (connId) {
        const servicePayload = ownershipUpstream.encode(ownershipUpstream.create({
          request: {
            requestId: 1,
            initializeReq: { getAssociations: true, protoVersion: 7, useStaging: false },
          },
        })).finish();

        result.socket.write(encode({
          push: { data: { connectionId: connId, data: servicePayload } },
        }));

        const ownerResp = await readMessage(result.socket);
        const connData = ownerResp?.push?.data?.data;
        if (connData) {
          const svcResp = ownershipDownstream.decode(connData);
          const games = svcResp?.response?.initializeRsp?.ownedGames?.ownedGames || [];
          console.log('Total products:', games.length);
          const baseGames = games.filter(g => g.productType === 0);
          console.log('Games (type=0):', baseGames.length);
          for (const g of baseGames) {
            let name = null;
            if (g.configuration) {
              try {
                const config = yaml.parse(g.configuration, { uniqueKeys: false, strict: false });
                name = config?.root?.name || config?.root?.sort_string || null;
              } catch (e) {}
            }
            console.log(` - ${name || '[NO NAME]'} (pid: ${g.productId})`);
          }
        } else {
          console.log('No ownership data:', JSON.stringify(ownerResp).slice(0, 500));
        }
      }
      result.socket.destroy();
      break;
    }
  }

  db.close();
}

run();
