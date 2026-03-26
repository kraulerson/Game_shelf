const crypto = require('crypto');

const HMAC_KEYS = {
  v1: 'ISa3dpGOc8wW7Adn4auACSQmaccrOyR2',
  v2: 'nt5FfJbdPzNcl2pkC3zgjO43Knvscxft',
};

// Fixed dummy hardware values — EA validates structure, not actual hardware
const HW = {
  bsn: 'SystemSerialNumber',
  gid: 0,
  hsn: 'AAAA1111BBBB2222',
  msn: '000000000000001',
  mac: '$aabbccddeeff',
  osn: '00000-00000-00000-AAAAA',
  osi: '20240101120000.000000+000',
};

function fnv1aHash(input) {
  let hash = BigInt('0xcbf29ce484222325');
  const prime = BigInt('0x100000001b3');
  const buffer = Buffer.from(input, 'utf8');
  for (const byte of buffer) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & BigInt('0xFFFFFFFFFFFFFFFF');
  }
  return hash.toString();
}

function generatePcSign(sv = 'v1') {
  const hardwareConcat = [HW.bsn, HW.gid, HW.hsn, HW.msn, HW.mac, HW.osn, HW.osi]
    .map(String).join('');
  const mid = fnv1aHash(hardwareConcat);

  const now = new Date();
  const ts = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()} `
    + `${now.getUTCHours()}:${now.getUTCMinutes()}:${now.getUTCSeconds()}`
    + `:${now.getUTCMilliseconds()}`;

  const payloadObj = {
    av: 'v1',
    bsn: HW.bsn,
    gid: HW.gid,
    hsn: HW.hsn,
    mac: HW.mac,
    mid: mid,
    msn: HW.msn,
    sv: sv,
    ts: ts,
  };

  // Critical: must have exactly one space after each colon and comma
  const payloadString = JSON.stringify(payloadObj)
    .replaceAll('":', '": ')
    .replaceAll(',', ', ');

  const payload = Buffer.from(payloadString).toString('base64url');
  const signature = crypto.createHmac('sha256', HMAC_KEYS[sv])
    .update(payload)
    .digest()
    .toString('base64url');

  return `${payload}.${signature}`;
}

function generateEaAuthUrl() {
  const pcSign = generatePcSign();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'JUNO_PC_CLIENT',
    display: 'junoClient/login',
    redirect_uri: 'qrc:///html/login_successful.html',
    locale: 'en_US',
    pc_sign: pcSign,
  });
  return `https://accounts.ea.com/connect/auth?${params.toString()}`;
}

module.exports = { generatePcSign, generateEaAuthUrl, fnv1aHash };
