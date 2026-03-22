const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/encrypt');

const router = Router();

// All launcher routes require authentication
router.use(authMiddleware);

// Static list of supported launchers
const AVAILABLE_LAUNCHERS = [
  { id: 'steam', display_name: 'Steam', auth_type: 'api_key', otp_supported: false, qr_supported: false },
  { id: 'ea', display_name: 'EA App', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'epic', display_name: 'Epic Games', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'humble', display_name: 'Humble Bundle', auth_type: 'credentials', otp_supported: false, qr_supported: false },
  { id: 'itchio', display_name: 'itch.io', auth_type: 'api_key', otp_supported: false, qr_supported: false },
  { id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: false, qr_supported: false },
  { id: 'battlenet', display_name: 'Battle.net', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false },
  { id: 'xbox', display_name: 'Xbox / Microsoft', auth_type: 'credentials', otp_supported: false, qr_supported: false },
];

const LAUNCHER_MAP = Object.fromEntries(AVAILABLE_LAUNCHERS.map(l => [l.id, l]));

// GET /api/launchers/available
router.get('/available', (req, res) => {
  res.json(AVAILABLE_LAUNCHERS);
});

// POST /api/launchers/:id/credentials
router.post('/:id/credentials', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const { username, password, api_key, steamid64, totp_secret } = req.body || {};

  // Validate required fields by auth_type
  if (launcher.auth_type === 'api_key') {
    if (!api_key) {
      return res.status(400).json({ error: 'api_key is required for this launcher' });
    }
  } else {
    // credentials or credentials+totp
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required for this launcher' });
    }
  }

  // Steam requires steamid64 alongside api_key
  if (id === 'steam' && !steamid64) {
    return res.status(400).json({ error: 'steamid64 is required for Steam' });
  }

  const payload = {};
  if (username) payload.username = username;
  if (password) payload.password = password;
  if (api_key) payload.api_key = api_key;
  if (steamid64) payload.steamid64 = steamid64;
  if (totp_secret) payload.totp_secret = totp_secret;

  const encryptedCredentials = encrypt(JSON.stringify(payload));

  const db = req.app.locals.db;

  // Upsert: insert or update by name
  db.prepare(`
    INSERT INTO launchers (name, display_name, enabled, credentials_json)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(name) DO UPDATE SET
      credentials_json = excluded.credentials_json,
      enabled = 1
  `).run(id, launcher.display_name, encryptedCredentials);

  res.json({ ok: true });
});

// GET /api/launchers/:id/test
router.get('/:id/test', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const row = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get(id);

  if (!row || !row.credentials_json) {
    return res.status(404).json({ error: 'No credentials stored for this launcher' });
  }

  // Decrypt to verify credentials are valid (readable)
  decrypt(row.credentials_json);

  // TODO: Implement actual auth endpoint pinging per launcher
  res.json({ success: true, message: `Connection test not yet implemented for ${launcher.display_name}` });
});

// POST /api/launchers/priority
router.post('/priority', (req, res) => {
  const priorities = req.body;

  if (!Array.isArray(priorities)) {
    return res.status(400).json({ error: 'Expected an array of {name, priority}' });
  }

  const db = req.app.locals.db;
  const update = db.prepare('UPDATE launchers SET priority = ? WHERE name = ?');

  const updateAll = db.transaction((items) => {
    for (const { name, priority } of items) {
      update.run(priority, name);
    }
  });

  updateAll(priorities);

  res.json({ ok: true });
});

module.exports = router;
