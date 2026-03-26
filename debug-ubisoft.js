const Database = require('better-sqlite3');
const { decrypt } = require('./src/utils/encrypt');
const yaml = require('yaml');
const tls = require('tls');
const protobuf = require('protobufjs');
const path = require('path');
const glob = require('glob');
const fs = require('fs');

// Load proto definitions with correct root path resolution
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

const API_VERSION = 10931;

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

async function run() {
  console.log('Ticket:', creds.ticket ? creds.ticket.slice(0, 20) + '...' : 'MISSING');

  const socket = tls.connect(443, 'dmx.upc.ubisoft.com', {
    servername: 'dmx.upc.ubisoft.com',
    rejectUnauthorized: false,
  });

  await new Promise((resolve, reject) => {
    socket.on('secureConnect', resolve);
    socket.on('error', reject);
    setTimeout(() => reject(new Error('TLS timeout')), 10000);
  });
  console.log('TLS connected');

  try {
    // Step 0: Send clientVersion push FIRST (required by protocol)
    console.log('Sending clientVersion...');
    socket.write(encode({ push: { clientVersion: { version: API_VERSION } } }));

    // Small delay for server to process
    await new Promise(r => setTimeout(r, 500));

    // Step 1: Authenticate
    console.log('Sending auth request...');
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

    const authResp = await readMessage(socket);
    const success = authResp?.response?.authenticateRsp?.success;
    console.log('Auth success:', success);
    if (!success) {
      console.log('Auth response:', JSON.stringify(authResp).slice(0, 500));
      return;
    }

    // Step 2: Open ownership_service
    console.log('Opening ownership_service...');
    socket.write(encode({
      request: {
        requestId: 2,
        openConnectionReq: { serviceName: 'ownership_service' },
      },
    }));

    const openResp = await readMessage(socket);
    const connId = openResp?.response?.openConnectionRsp?.connectionId;
    console.log('Connection ID:', connId);
    if (!connId) {
      console.log('Open response:', JSON.stringify(openResp).slice(0, 500));
      return;
    }

    // Step 3: Send ownership initialize via push (service message wrapped in demux push)
    console.log('Initializing ownership...');
    const ownershipUpstream = root.lookupType('mg.protocol.ownership.Upstream');
    const ownershipDownstream = root.lookupType('mg.protocol.ownership.Downstream');

    const servicePayload = ownershipUpstream.encode(ownershipUpstream.create({
      request: {
        requestId: 1,
        initializeReq: {
          getAssociations: true,
          protoVersion: 7,
          useStaging: false,
        },
      },
    })).finish();

    socket.write(encode({
      push: {
        data: {
          connectionId: connId,
          data: servicePayload,
        },
      },
    }));

    // Read the ownership response (comes as a push with connectionData)
    const ownershipResp = await readMessage(socket);
    const connData = ownershipResp?.push?.data?.data;
    if (!connData) {
      console.log('Ownership response (no connData):', JSON.stringify(ownershipResp).slice(0, 500));
      return;
    }

    const serviceResp = ownershipDownstream.decode(connData);
    const ownedGames = serviceResp?.response?.initializeRsp?.ownedGames?.ownedGames || [];
    console.log('\nTotal products:', ownedGames.length);

    const types = {};
    ownedGames.forEach(g => { types[g.productType] = (types[g.productType] || 0) + 1; });
    console.log('By type:', JSON.stringify(types), '(0=Game 1=AddOn 4=Trial 6=Bundle 7=SeasonPass)');

    const games = ownedGames.filter(g => g.productType === 0);
    console.log('\nGames (type=0):', games.length);

    for (const game of games) {
      let name = null;
      if (game.configuration) {
        try {
          const config = yaml.parse(game.configuration, { uniqueKeys: false, strict: false });
          name = config?.root?.name || config?.root?.sort_string || null;
        } catch (e) {}
      }
      console.log(` - ${name || '[NO NAME]'} (pid: ${game.productId}, state: ${game.state})`);
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    socket.destroy();
    db.close();
  }
}

run();
