const Database = require('better-sqlite3');
const { decrypt } = require('./src/utils/encrypt');
const yaml = require('yaml');
const tls = require('tls');
const protobuf = require('protobufjs');
const path = require('path');
const glob = require('glob');

// Load proto definitions with correct root path
const protoDir = path.join(__dirname, 'node_modules/ubisoft-demux/dist/proto');
const protoFiles = glob.sync(`${protoDir}/**/*.proto`);
const root = new protobuf.Root();
root.resolvePath = (origin, target) => {
  // Resolve imports relative to the proto root directory, not the importing file
  const resolved = path.resolve(protoDir, target);
  const fs = require('fs');
  if (fs.existsSync(resolved)) return resolved;
  // Fall back to default resolution
  return path.resolve(path.dirname(origin), target);
};
root.loadSync(protoFiles);

const demuxUpstream = root.lookupType('mg.protocol.demux.Upstream');
const demuxDownstream = root.lookupType('mg.protocol.demux.Downstream');
const ownershipUpstream = root.lookupType('mg.protocol.ownership.Upstream');
const ownershipDownstream = root.lookupType('mg.protocol.ownership.Downstream');

const db = new Database('/app/data/gameshelf.db');
const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'ubisoft'").get();
const creds = JSON.parse(decrypt(launcher.credentials_json));

let requestId = 0;

function encodeDemux(data) {
  const msg = demuxUpstream.create(data);
  return demuxUpstream.encode(msg).finish();
}

function decodeDemux(buffer) {
  return demuxDownstream.decode(buffer);
}

function sendMessage(socket, data) {
  return new Promise((resolve, reject) => {
    const payload = encodeDemux(data);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));

    let responseBuffer = Buffer.alloc(0);
    const onData = (chunk) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      // Try to parse: 4-byte length prefix + message
      while (responseBuffer.length >= 4) {
        const msgLen = responseBuffer.readUInt32BE(0);
        if (responseBuffer.length < 4 + msgLen) break;
        const msgBuf = responseBuffer.subarray(4, 4 + msgLen);
        responseBuffer = responseBuffer.subarray(4 + msgLen);
        socket.removeListener('data', onData);
        try {
          resolve(decodeDemux(msgBuf));
        } catch (e) {
          reject(e);
        }
        return;
      }
    };
    socket.on('data', onData);
    setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error('Timeout waiting for response'));
    }, 15000);
  });
}

function sendOwnership(socket, connectionId, data) {
  return new Promise((resolve, reject) => {
    const serviceMsg = ownershipUpstream.create(data);
    const servicePayload = ownershipUpstream.encode(serviceMsg).finish();

    const demuxData = {
      push: {
        data: {
          connectionId: connectionId,
          data: servicePayload,
        },
      },
    };
    const payload = encodeDemux(demuxData);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));

    let responseBuffer = Buffer.alloc(0);
    const onData = (chunk) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      while (responseBuffer.length >= 4) {
        const msgLen = responseBuffer.readUInt32BE(0);
        if (responseBuffer.length < 4 + msgLen) break;
        const msgBuf = responseBuffer.subarray(4, 4 + msgLen);
        responseBuffer = responseBuffer.subarray(4 + msgLen);
        socket.removeListener('data', onData);
        try {
          const demuxResp = decodeDemux(msgBuf);
          const serviceData = demuxResp?.push?.data?.data;
          if (serviceData) {
            resolve(ownershipDownstream.decode(serviceData));
          } else {
            resolve(demuxResp);
          }
        } catch (e) {
          reject(e);
        }
        return;
      }
    };
    socket.on('data', onData);
    setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error('Timeout waiting for ownership response'));
    }, 15000);
  });
}

async function run() {
  console.log('Ticket exists:', !!creds.ticket);
  console.log('Connecting to dmx.upc.ubisoft.com:443...');

  const socket = tls.connect(443, 'dmx.upc.ubisoft.com', { rejectUnauthorized: true });

  await new Promise((resolve, reject) => {
    socket.on('secureConnect', resolve);
    socket.on('error', reject);
    setTimeout(() => reject(new Error('TLS connect timeout')), 10000);
  });
  console.log('TLS connected');

  try {
    // Step 1: Authenticate
    console.log('Sending auth request...');
    const authResp = await sendMessage(socket, {
      request: {
        requestId: ++requestId,
        authenticateReq: {
          clientId: 'uplay_pc',
          sendKeepAlive: false,
          token: {
            ubiTicket: creds.ticket,
          },
        },
      },
    });
    console.log('Auth response:', JSON.stringify(authResp).slice(0, 300));

    const success = authResp?.response?.authenticateRsp?.success;
    if (!success) {
      console.log('Auth failed');
      return;
    }
    console.log('Authenticated!');

    // Step 2: Open ownership_service
    console.log('Opening ownership_service...');
    const openResp = await sendMessage(socket, {
      request: {
        requestId: ++requestId,
        openConnectionReq: {
          serviceName: 'ownership_service',
        },
      },
    });
    console.log('Open response:', JSON.stringify(openResp).slice(0, 300));

    const connectionId = openResp?.response?.openConnectionRsp?.connectionId;
    if (!connectionId) {
      console.log('Failed to open connection');
      return;
    }
    console.log('Connection opened, ID:', connectionId);

    // Step 3: Initialize ownership
    console.log('Initializing ownership...');
    const initResp = await sendOwnership(socket, connectionId, {
      request: {
        requestId: 1,
        initializeReq: {
          getAssociations: true,
          protoVersion: 7,
          useStaging: false,
        },
      },
    });

    const ownedGames = initResp?.response?.initializeRsp?.ownedGames?.ownedGames || [];
    console.log('Total products:', ownedGames.length);

    const games = ownedGames.filter(g => g.productType === 0);
    console.log('Games (type=0):', games.length);

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
