const Database = require('better-sqlite3');
const { decrypt } = require('./src/utils/encrypt');
const axios = require('axios');

const db = new Database('/app/data/gameshelf.db');
const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'ubisoft'").get();
const creds = JSON.parse(decrypt(launcher.credentials_json));
const userId = creds.userId;

async function tryGet(label, url, extraHeaders = {}) {
  console.log(`\n=== ${label} ===`);
  const h = {
    'Authorization': 'Ubi_v1 t=' + creds.ticket,
    'Ubi-AppId': 'f35adcb5-1911-440c-b1c9-48fdc1701c68',
    'Ubi-SessionId': creds.sessionId,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ...extraHeaders,
  };
  try {
    const res = await axios.get(url, { headers: h });
    const text = JSON.stringify(res.data);
    console.log(text.slice(0, 2000));
    if (text.length > 2000) console.log('... (truncated, total chars:', text.length, ')');
  } catch (e) {
    console.log('Error:', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300));
  }
}

async function run() {
  console.log('userId:', userId);

  // Entitlements with platform header
  await tryGet('Entitlements + platform header',
    'https://public-ubiservices.ubi.com/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements',
    { 'Ubi-RequestedPlatformType': 'uplay' });

  // Try v3 entitlements
  await tryGet('v3 entitlements',
    `https://public-ubiservices.ubi.com/v3/profiles/${userId}/entitlements`);

  // Ownership by spaceId (global)
  await tryGet('Ownership (global space)',
    `https://public-ubiservices.ubi.com/v1/profiles/${userId}/ownership?spaceId=global`);

  // Club games endpoints
  await tryGet('Club aggregation',
    `https://public-ubiservices.ubi.com/v1/profiles/${userId}/club/aggregation/website/games`);

  // Try the store/catalog approach
  await tryGet('Game catalog (first 50)',
    'https://public-ubiservices.ubi.com/v1/spaces/global/ubiconnect/games/api/catalog?defaultOnly=true&offset=0&limit=50');

  // UbiConnect games API
  await tryGet('UbiConnect games API',
    'https://public-ubiservices.ubi.com/v1/spaces/global/ubiconnect/games/api');

  // Try product ownership
  await tryGet('Product ownership',
    `https://public-ubiservices.ubi.com/v1/profiles/${userId}/product/ownership`);

  // Try user games via connect
  await tryGet('Connect user games',
    `https://connect.ubi.com/api/v2/users/${userId}/games`);

  // Uplay PC specific
  await tryGet('Uplay PC ownership',
    `https://public-ubiservices.ubi.com/v1/profiles/me/uplay/ownership`);

  // Try demux AppId for entitlements
  await tryGet('Entitlements (demux AppId)',
    'https://public-ubiservices.ubi.com/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements',
    { 'Ubi-AppId': 'f68a4bb5-608a-4ff2-8123-be8ef797e0a6', 'Ubi-RequestedPlatformType': 'uplay' });

  db.close();
}

run();
