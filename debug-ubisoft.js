const Database = require('better-sqlite3');
const { decrypt } = require('./src/utils/encrypt');
const tls = require('tls');
const protobuf = require('protobufjs');
const path = require('path');
const glob = require('glob');
const fs = require('fs');

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

async function tryAuth(version, clientId) {
  const socket = tls.connect(443, 'dmx.upc.ubisoft.com', {
    servername: 'dmx.upc.ubisoft.com', rejectUnauthorized: false,
  });
  await new Promise((resolve, reject) => {
    socket.on('secureConnect', resolve);
    socket.on('error', reject);
    setTimeout(() => reject(new Error('TLS timeout')), 10000);
  });

  try {
    socket.write(encode({ push: { clientVersion: { version } } }));
    await new Promise(r => setTimeout(r, 300));

    socket.write(encode({
      request: {
        requestId: 1,
        authenticateReq: {
          clientId: clientId,
          sendKeepAlive: false,
          token: { ubiTicket: creds.ticket },
        },
      },
    }));

    const resp = await readMessage(socket);
    const success = resp?.response?.authenticateRsp?.success;
    const outdated = resp?.push?.clientOutdated;
    const result = success ? 'SUCCESS' : outdated ? 'OUTDATED' : 'FAIL';
    console.log(`v${version} client=${clientId}: ${result}`);
    if (success) return socket;
  } catch (e) {
    console.log(`v${version} client=${clientId}: ERROR ${e.message}`);
  }
  socket.destroy();
  return null;
}

async function run() {
  console.log('Ticket exists:', !!creds.ticket);

  // Test version range 11000-11500 with different clientIds
  const clientIds = ['uplay_pc', 'uplay_pc_thininstaller'];
  const versions = [11100, 11200, 11300, 11400, 11500, 12000, 13000, 14000, 15000];

  for (const clientId of clientIds) {
    for (const v of versions) {
      const socket = await tryAuth(v, clientId);
      if (socket) {
        console.log(`\nWORKING: version=${v} clientId=${clientId}`);
        socket.destroy();
        return;
      }
    }
  }

  console.log('\nNo working combination found.');
  db.close();
}

run();
