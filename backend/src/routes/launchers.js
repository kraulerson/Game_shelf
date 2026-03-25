const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/encrypt');

const router = Router();

// All launcher routes require authentication
router.use(authMiddleware);

// Static list of supported launchers
const AVAILABLE_LAUNCHERS = [
  { id: 'steam', display_name: 'Steam', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'ea', display_name: 'EA App', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'epic', display_name: 'Epic Games', auth_type: 'auth_code', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'humble', display_name: 'Humble Bundle', auth_type: 'credentials', otp_supported: true, qr_supported: false, implemented: true, otp_instruction: 'Enter the code emailed to you' },
  { id: 'itchio', display_name: 'itch.io', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'gog', display_name: 'GOG', auth_type: 'credentials', otp_supported: true, qr_supported: false, implemented: true, otp_instruction: 'Enter the code from your authenticator app' },
  { id: 'battlenet', display_name: 'Battle.net', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'xbox', display_name: 'Xbox / Microsoft', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
];

const LAUNCHER_MAP = Object.fromEntries(AVAILABLE_LAUNCHERS.map(l => [l.id, l]));

// GET /api/launchers/available
router.get('/available', (req, res) => {
  const db = req.app.locals.db;
  const dbLaunchers = db.prepare(
    'SELECT name, credentials_json IS NOT NULL as configured, priority FROM launchers'
  ).all();
  const dbMap = Object.fromEntries(dbLaunchers.map(r => [r.name, r]));

  const result = AVAILABLE_LAUNCHERS.map(l => ({
    ...l,
    configured: !!(dbMap[l.id]?.configured),
    priority: dbMap[l.id]?.priority ?? 99,
  }));

  res.json(result);
});

// POST /api/launchers/:id/credentials
router.post('/:id/credentials', async (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  if (!launcher.implemented) {
    return res.status(400).json({ error: 'This launcher is not yet implemented' });
  }

  const { username, password, api_key, steamid64, totp_secret, auth_code } = req.body || {};

  // Validate required fields by auth_type
  if (launcher.auth_type === 'api_key') {
    if (!api_key) {
      return res.status(400).json({ error: 'api_key is required for this launcher' });
    }
  } else if (launcher.auth_type === 'auth_code') {
    if (!auth_code) {
      return res.status(400).json({ error: 'auth_code is required for this launcher' });
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

  let payload;

  if (launcher.auth_type === 'auth_code') {
    // Exchange auth code for tokens via the launcher class
    try {
      const { LAUNCHER_CLASSES } = require('../services/launchers');
      const LauncherClass = LAUNCHER_CLASSES[id];
      const instance = new LauncherClass(id, null);
      payload = await instance.authenticate({ auth_code });
    } catch (err) {
      return res.status(400).json({ error: `Authentication failed: ${err.message}` });
    }
  } else {
    payload = {};
    if (username) payload.username = username;
    if (password) payload.password = password;
    if (api_key) payload.api_key = api_key;
    if (steamid64) payload.steamid64 = steamid64;
    if (totp_secret) payload.totp_secret = totp_secret;
  }

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

// DELETE /api/launchers/:id/credentials
router.delete('/:id/credentials', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const row = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!row) {
    return res.json({ removed: false, launcher: launcher.display_name, gamesAffected: 0 });
  }

  db.prepare(
    'UPDATE launchers SET credentials_json = NULL, enabled = 0, last_sync_at = NULL WHERE name = ?'
  ).run(id);

  const result = db.prepare(
    'UPDATE game_editions SET owned = 0 WHERE launcher_id = ?'
  ).run(row.id);

  res.json({ removed: true, launcher: launcher.display_name, gamesAffected: result.changes });
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

// GET /api/launchers/:id/editions — lightweight list for approval page
router.get('/:id/editions', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const launcherRow = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!launcherRow) {
    return res.status(404).json({ error: 'Launcher not configured' });
  }

  const editions = db.prepare(`
    SELECT ge.id as edition_id, ge.title, g.cover_url
    FROM game_editions ge
    LEFT JOIN games g ON g.id = ge.game_id
    WHERE ge.launcher_id = ? AND ge.owned = 1 AND ge.parent_edition_id IS NULL
    ORDER BY ge.title ASC
  `).all(launcherRow.id);

  res.json({ editions });
});

// POST /api/launchers/:id/approve
router.post('/:id/approve', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const { approved_edition_ids } = req.body || {};

  if (!Array.isArray(approved_edition_ids) || approved_edition_ids.length === 0) {
    return res.status(400).json({ error: 'approved_edition_ids must be a non-empty array' });
  }

  const db = req.app.locals.db;
  const launcherRow = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!launcherRow) {
    return res.status(404).json({ error: 'Launcher not configured' });
  }

  const launcherId = launcherRow.id;

  // Find all owned editions for this launcher (excluding DLC children)
  const allEditions = db.prepare(
    'SELECT id, game_id FROM game_editions WHERE launcher_id = ? AND owned = 1 AND parent_edition_id IS NULL'
  ).all(launcherId);

  const approvedSet = new Set(approved_edition_ids.map(Number));
  const toDelete = allEditions.filter(e => !approvedSet.has(e.id));

  if (toDelete.length === 0) {
    return res.json({ deleted_editions: 0, deleted_games: 0 });
  }

  const deleteDlcChildren = db.prepare('DELETE FROM game_editions WHERE parent_edition_id = ?');
  const deleteEdition = db.prepare('DELETE FROM game_editions WHERE id = ?');
  const countRemainingEditions = db.prepare(
    'SELECT COUNT(*) as c FROM game_editions WHERE game_id = ?'
  );
  const deleteGame = db.prepare('DELETE FROM games WHERE id = ?');

  let deletedEditions = 0;
  let deletedGames = 0;

  const runApproval = db.transaction(() => {
    for (const edition of toDelete) {
      // Delete DLC children first (parent_edition_id FK has no CASCADE)
      const dlcResult = deleteDlcChildren.run(edition.id);
      deletedEditions += dlcResult.changes;
      // Delete the edition itself
      deleteEdition.run(edition.id);
      deletedEditions++;

      // If game has no remaining editions, delete the game too
      if (edition.game_id) {
        const remaining = countRemainingEditions.get(edition.game_id);
        if (remaining.c === 0) {
          deleteGame.run(edition.game_id);
          deletedGames++;
        }
      }
    }
  });

  runApproval();

  res.json({ deleted_editions: deletedEditions, deleted_games: deletedGames });
});

module.exports = router;
