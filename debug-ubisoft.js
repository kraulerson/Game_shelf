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
const API_VERSION = 11200;

function encode(data) {
  const payload = demuxUpstream.encode(demuxUpstream.create(data)).finish();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

// Improved reader: handles multi-chunk large messages and multiple messages in buffer
function readMessage(socket, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error(`Timeout after ${timeout}ms (buffer: ${buf.length} bytes)`));
    }, timeout);
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return; // wait for more data
        const msgBuf = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        clearTimeout(timer);
        socket.removeListener('data', onData);
        try {
          resolve(demuxDownstream.decode(msgBuf));
        } catch (e) {
          reject(e);
        }
        return;
      }
    }
    socket.on('data', onData);
  });
}

async function getDemuxTicket() {
  console.log('Getting ticket with demux AppId...');
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
  console.log('Got ticket, expiration:', res.data.expiration);
  return res.data.ticket;
}

async function run() {
  const ticket = await getDemuxTicket();

  console.log('Connecting to demux...');
  const socket = tls.connect(443, 'dmx.upc.ubisoft.com', {
    servername: 'dmx.upc.ubisoft.com', rejectUnauthorized: false,
  });
  await new Promise((resolve, reject) => {
    socket.on('secureConnect', resolve);
    socket.on('error', reject);
    setTimeout(() => reject(new Error('TLS timeout')), 10000);
  });
  console.log('TLS connected');

  try {
    // Step 0: clientVersion
    socket.write(encode({ push: { clientVersion: { version: API_VERSION } } }));
    await new Promise(r => setTimeout(r, 300));

    // Step 1: Auth
    console.log('Authenticating...');
    socket.write(encode({
      request: {
        requestId: 1,
        authenticateReq: { clientId: 'uplay_pc', sendKeepAlive: false, token: { ubiTicket: ticket } },
      },
    }));
    const authResp = await readMessage(socket);
    console.log('Auth success:', authResp?.response?.authenticateRsp?.success);

    // Step 2: Open ownership
    console.log('Opening ownership_service...');
    socket.write(encode({
      request: { requestId: 2, openConnectionReq: { serviceName: 'ownership_service' } },
    }));
    const openResp = await readMessage(socket);
    const connId = openResp?.response?.openConnectionRsp?.connectionId;
    console.log('Connection ID:', connId);

    if (!connId) {
      console.log('Failed to open:', JSON.stringify(openResp).slice(0, 500));
      return;
    }

    // Step 3: Initialize ownership (large response — 30s timeout)
    console.log('Fetching ownership (this may take a moment)...');
    const ownershipUpstream = root.lookupType('mg.protocol.ownership.Upstream');
    const ownershipDownstream = root.lookupType('mg.protocol.ownership.Downstream');

    const svcPayload = ownershipUpstream.encode(ownershipUpstream.create({
      request: { requestId: 1, initializeReq: { getAssociations: true, protoVersion: 7, useStaging: false } },
    })).finish();
    socket.write(encode({ push: { data: { connectionId: connId, data: svcPayload } } }));

    const ownerResp = await readMessage(socket, 30000);
    const connData = ownerResp?.push?.data?.data;

    if (!connData) {
      console.log('No connection data in response.');
      console.log('Response type:', ownerResp?.response ? 'response' : ownerResp?.push ? 'push' : 'unknown');
      console.log('Full:', JSON.stringify(ownerResp).slice(0, 1000));
      return;
    }

    const svcResp = ownershipDownstream.decode(connData);
    const allProducts = svcResp?.response?.initializeRsp?.ownedGames?.ownedGames || [];
    console.log('\nTotal products:', allProducts.length);

    const types = {};
    allProducts.forEach(g => { types[g.productType] = (types[g.productType] || 0) + 1; });
    console.log('By type:', JSON.stringify(types));

    const games = allProducts.filter(g => g.productType === 0);
    console.log('Games (type=0):', games.length, '\n');

    for (const g of games) {
      let name = null;
      if (g.configuration) {
        try {
          const config = yaml.parse(g.configuration, { uniqueKeys: false, strict: false });
          name = config?.root?.name || config?.root?.sort_string || null;
        } catch (e) {}
      }
      console.log(` - ${name || '[NO NAME]'} (pid: ${g.productId}, state: ${g.state})`);
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    socket.destroy();
    db.close();
  }
}

run();
