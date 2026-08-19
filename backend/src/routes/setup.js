const { Router } = require('express');
const authMiddleware = require('../middleware/auth');

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

module.exports = router;
