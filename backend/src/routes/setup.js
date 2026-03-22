const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { generateQRSetupData } = require('../utils/totp');
const { decrypt } = require('../utils/encrypt');

const router = Router();

// All setup routes require authentication
router.use(authMiddleware);

// GET /api/setup/status
router.get('/status', (req, res) => {
  const db = req.app.locals.db;

  // Check if any launcher is enabled with credentials
  const enabledLauncher = db.prepare(
    'SELECT id FROM launchers WHERE enabled = 1 AND credentials_json IS NOT NULL'
  ).get();

  if (enabledLauncher) {
    return res.json({ complete: true });
  }

  // Fallback: check settings table
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('setup_complete');
  res.json({ complete: setting ? setting.value === 'true' : false });
});

// POST /api/setup/complete
router.post('/complete', (req, res) => {
  const db = req.app.locals.db;

  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('setup_complete', 'true');

  res.json({ ok: true });
});

// GET /api/setup/qr/:launcher_id
router.get('/qr/:launcher_id', (req, res) => {
  const db = req.app.locals.db;
  const { launcher_id } = req.params;

  const launcher = db.prepare('SELECT credentials_json FROM launchers WHERE name = ?').get(launcher_id);

  if (!launcher || !launcher.credentials_json) {
    return res.status(404).json({ error: 'Launcher not found or no credentials stored' });
  }

  const credentials = JSON.parse(decrypt(launcher.credentials_json));

  if (!credentials.totp_secret) {
    return res.status(400).json({ error: 'No TOTP secret configured for this launcher' });
  }

  const uri = generateQRSetupData(launcher_id, credentials.username || launcher_id, credentials.totp_secret);
  res.json({ uri });
});

module.exports = router;
