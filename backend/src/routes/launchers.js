const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/encrypt');

const router = Router();

// All launcher routes require authentication
router.use(authMiddleware);

// Static list of supported launchers
const AVAILABLE_LAUNCHERS = [
  { id: 'steam', display_name: 'Steam', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'ea', display_name: 'EA App', auth_type: 'auth_code', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: true },
  { id: 'epic', display_name: 'Epic Games', auth_type: 'auth_code', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'humble', display_name: 'Humble Bundle', auth_type: 'session_cookie', otp_supported: false, qr_supported: false, implemented: true, cookie_name: '_simpleauth_sess' },
  { id: 'itchio', display_name: 'itch.io', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'gog', display_name: 'GOG', auth_type: 'auth_code', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'battlenet', display_name: 'Battle.net', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false },
  { id: 'xbox', display_name: 'Xbox / Microsoft', auth_type: 'api_key', otp_supported: false, qr_supported: false, implemented: true },
  { id: 'amazon', display_name: 'Amazon Games', auth_type: 'file_import', otp_supported: false, qr_supported: false, implemented: true },
];

const LAUNCHER_MAP = Object.fromEntries(AVAILABLE_LAUNCHERS.map(l => [l.id, l]));

// Whether a TOTP secret is on file — never the secret itself. Nothing reads a stored
// secret back out to the client; the form is write-only by design.
//
// Unreadable counts as "not configured" rather than as a fault. The boot probe and
// Test Connection both already name that condition; this answers where a checkbox
// starts, and it must not be the reason the Setup page fails to load.
function hasTotpSecret(blob) {
  if (!blob) return false;
  try {
    return !!JSON.parse(decrypt(blob)).totp_secret;
  } catch {
    return false;
  }
}

// GET /api/launchers/available
router.get('/available', (req, res) => {
  const db = req.app.locals.db;
  const dbLaunchers = db.prepare(
    'SELECT name, credentials_json, priority, sync_locked FROM launchers'
  ).all();
  const dbMap = Object.fromEntries(dbLaunchers.map(r => [r.name, r]));

  const result = AVAILABLE_LAUNCHERS.map(l => {
    const row = dbMap[l.id];
    return {
      ...l,
      configured: row?.credentials_json != null,
      priority: row?.priority ?? 99,
      sync_locked: !!(row?.sync_locked),
      // Gated on otp_supported so a Steam API key is never decrypted to answer a
      // question about TOTP.
      totp_configured: l.otp_supported ? hasTotpSecret(row?.credentials_json) : false,
    };
  });

  res.json(result);
});

const multer = require('multer');
const uploadCache = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /api/launchers/amazon/preview — upload amazon-games.json, return parsed game list (no DB writes)
router.post('/amazon/preview', uploadCache.single('games_json'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'games_json file is required' });
  }

  const { parseGamesJson } = require('../services/launchers/amazon');

  let games;
  try {
    games = parseGamesJson(file.buffer);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({ games });
});

// POST /api/launchers/amazon/import — import approved games and lock sync
router.post('/amazon/import', (req, res) => {
  const { approved_games } = req.body || {};

  if (!Array.isArray(approved_games) || approved_games.length === 0) {
    return res.status(400).json({ error: 'approved_games must be a non-empty array' });
  }

  const db = req.app.locals.db;
  const { detectEditionTier } = require('../utils/editionTier');

  // Ensure amazon launcher row exists
  db.prepare(
    "INSERT OR IGNORE INTO launchers (name, display_name, enabled) VALUES ('amazon', 'Amazon Games', 1)"
  ).run();
  const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'amazon'").get();

  const upsert = db.prepare(`
    INSERT INTO game_editions (launcher_id, launcher_game_id, title, playtime_minutes, owned)
    VALUES (?, ?, ?, 0, 1)
    ON CONFLICT(launcher_id, launcher_game_id) DO UPDATE SET
      title = excluded.title,
      owned = 1
  `);
  const insertTier = db.prepare('INSERT OR IGNORE INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)');

  const importGames = db.transaction((gameList) => {
    for (const game of gameList) {
      const result = upsert.run(launcher.id, game.launcher_game_id, game.title);
      const editionId = result.lastInsertRowid ? Number(result.lastInsertRowid) : null;
      if (editionId) {
        insertTier.run(editionId, detectEditionTier(game.title));
      }
    }
  });

  importGames(approved_games);

  // Lock sync to prevent removal of imported games
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE id = ?').run(launcher.id);

  // Trigger enrichment
  const { enrichAll } = require('../services/metadata/enrichGame');
  enrichAll(db).catch(err => console.error('[Metadata] enrichAll error:', err.message));

  console.log(`[Amazon] Imported ${approved_games.length} games from games.db`);
  res.json({ imported: approved_games.length });
});

// POST /api/launchers/ubisoft/import-cache — upload local cache files for full library
router.post('/ubisoft/import-cache', uploadCache.fields([
  { name: 'configurations', maxCount: 1 },
  { name: 'ownership', maxCount: 1 },
]), (req, res) => {
  const configFile = req.files?.configurations?.[0];
  const ownerFile = req.files?.ownership?.[0];

  if (!configFile || !ownerFile) {
    return res.status(400).json({ error: 'Both configurations and ownership files are required' });
  }

  const db = req.app.locals.db;
  const launcher = db.prepare("SELECT * FROM launchers WHERE name = 'ubisoft'").get();
  if (!launcher) {
    return res.status(400).json({ error: 'Ubisoft launcher not configured. Add credentials first.' });
  }

  const { parseLocalCacheFiles } = require('../services/launchers/ubisoft');
  const { detectEditionTier } = require('../utils/editionTier');

  let games;
  try {
    games = parseLocalCacheFiles(configFile.buffer, ownerFile.buffer);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse cache files: ' + err.message });
  }

  // Upsert games as game_editions
  const upsert = db.prepare(`
    INSERT INTO game_editions (launcher_id, launcher_game_id, title, playtime_minutes, owned)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(launcher_id, launcher_game_id) DO UPDATE SET
      title = excluded.title,
      owned = 1
  `);
  const insertTier = db.prepare('INSERT OR IGNORE INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)');

  const importGames = db.transaction((gameList) => {
    for (const game of gameList) {
      const result = upsert.run(launcher.id, game.launcher_game_id, game.title, game.playtime_minutes);
      const editionId = result.lastInsertRowid ? Number(result.lastInsertRowid) : null;
      if (editionId) {
        insertTier.run(editionId, detectEditionTier(game.title));
      }
    }
  });

  importGames(games);

  // Lock sync to prevent API sync from removing cache-imported games
  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE id = ?').run(launcher.id);

  // Trigger enrichment
  const { enrichAll } = require('../services/metadata/enrichGame');
  enrichAll(db).catch(err => console.error('[Metadata] enrichAll error:', err.message));

  console.log(`[Ubisoft] Imported ${games.length} games from local cache files`);
  res.json({ imported: games.length, games: games.map(g => g.title) });
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

  if (launcher.auth_type === 'file_import') {
    return res.status(400).json({ error: `${launcher.display_name} uses file import — no credentials needed` });
  }

  const { username, password, api_key, steamid64, totp_secret, auth_code, session_cookie, remove_totp_secret } = req.body || {};

  // Every credential field is a string with something in it. [] and {} are truthy, so
  // without the type check they were stored verbatim over a real secret — a request
  // field VALUE destroying a credential, which this contract forbids. It is worse than
  // a plain overwrite: totp_configured reads !!totp_secret, so the UI still showed 2FA
  // configured while code generation threw.
  //
  // Whitespace does exactly the same damage and IS a string, so the type check alone
  // is not enough: ' ' stored over a real secret still reports as configured and
  // generates codes that can never authenticate.
  //
  // Trimming decides only whether a value counts as supplied — the value itself is
  // stored as sent, because a leading or trailing space in a password is legitimate
  // and silently trimming it would lock the operator out.
  //
  // "Supplied" means the same thing here and in the validation below, so a value that
  // does not count is refused rather than silently dropped.
  const given = (value) => typeof value === 'string' && value.trim() !== '';

  // A request that only asks for a removal is not creating or replacing anything, so
  // the fields required to CREATE a credential are not required of it. Unticking 2FA
  // happens from a reloaded page, which holds no password to send — demanding one made
  // the removal impossible from the only state it is ever done in.
  const removalOnly =
    remove_totp_secret === true &&
    launcher.otp_supported &&
    ![username, password, api_key, steamid64, totp_secret, auth_code, session_cookie].some(given);

  if (removalOnly) {
    const stored = req.app.locals.db
      .prepare('SELECT credentials_json FROM launchers WHERE name = ?')
      .get(id);

    // Without this a removal-only request inserts a row holding an empty credential,
    // which then reports itself as configured.
    if (!stored || !stored.credentials_json) {
      return res.status(404).json({ error: 'No credentials stored for this launcher' });
    }
  }

  // Validate required fields by auth_type. The whole chain is skipped for a
  // removal-only request, not just its first arm — skipping one branch drops through
  // to the else, which demands a username and password anyway.
  if (!removalOnly) {
    if (launcher.auth_type === 'api_key') {
      if (!given(api_key)) {
        return res.status(400).json({ error: 'api_key is required for this launcher' });
      }
    } else if (launcher.auth_type === 'auth_code') {
      if (!given(auth_code)) {
        return res.status(400).json({ error: 'auth_code is required for this launcher' });
      }
    } else if (launcher.auth_type === 'session_cookie') {
      if (!given(session_cookie)) {
        return res.status(400).json({ error: 'session_cookie is required for this launcher' });
      }
    } else {
      // credentials or credentials+totp
      if (!given(username) || !given(password)) {
        return res.status(400).json({ error: 'username and password are required for this launcher' });
      }
    }

    // Steam requires steamid64 alongside api_key
    if (id === 'steam' && !given(steamid64)) {
      return res.status(400).json({ error: 'steamid64 is required for Steam' });
    }
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
  } else if (launcher.auth_type === 'session_cookie') {
    payload = { session_cookie };
  } else {
    payload = {};
    if (given(username)) payload.username = username;
    if (given(password)) payload.password = password;
    if (given(api_key)) payload.api_key = api_key;
    if (given(steamid64)) payload.steamid64 = steamid64;
    if (given(totp_secret)) payload.totp_secret = totp_secret;
  }

  const db = req.app.locals.db;

  // Merge over what is already stored rather than replacing it. The Setup form has no
  // read-back of stored secrets by design, so after a page reload it holds nothing —
  // and a wholesale replace meant that re-saving a corrected password destroyed the
  // TOTP secret the user could never re-supply from the UI.
  //
  // Absence means "unchanged", and so does an empty value: a blank input is what a
  // reloaded form holds, what autofill leaves behind, and what a client that always
  // posts every key produces, none of which is a decision to destroy anything. No
  // field VALUE is destructive; removal takes an explicit verb instead, so there is
  // no shape a form can accidentally take that deletes a secret.
  //
  // auth_code and session_cookie exchanges replace outright: those mint a whole new
  // session, so merging stale fields into them would be wrong.
  let merged = payload;
  let priorUnreadable = false;
  let encrypted;

  const applyMerge = db.transaction(() => {
    if (launcher.auth_type !== 'auth_code' && launcher.auth_type !== 'session_cookie') {
      const existingRow = db
        .prepare('SELECT credentials_json FROM launchers WHERE name = ?')
        .get(id);

      let existing = {};
      if (existingRow && existingRow.credentials_json) {
        try {
          existing = JSON.parse(decrypt(existingRow.credentials_json));
        } catch (err) {
        // Unreadable stored blob: proceed rather than fail, so a key change or lost
        // salt does not also block recovery by re-entering credentials. But say so —
        // silently substituting {} means the operator cannot tell "your other fields
        // were preserved" from "they were unrecoverable and you have just overwritten
        // them".
          existing = {};
          priorUnreadable = true;
          console.error(
            `[launchers] Existing credentials for ${id} could not be decrypted ` +
              `(${err.message}); saving will replace them with only the fields supplied.`
          );
        }
      }

      merged = { ...existing, ...payload };

      // Applied after the merge so a request that both supplies and removes the same
      // field resolves one way every time.
      if (remove_totp_secret === true) delete merged.totp_secret;
    }

    encrypted = encrypt(JSON.stringify(merged));

    db.prepare(`
      INSERT INTO launchers (name, display_name, enabled, credentials_json)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(name) DO UPDATE SET
        credentials_json = excluded.credentials_json,
        enabled = 1
    `).run(id, launcher.display_name, encrypted);
  });

  applyMerge();

  // Only surfaced when it happened: adding a field unconditionally would change the
  // response shape for every existing caller for a condition that is almost never true.
  res.json(priorUnreadable ? { ok: true, priorUnreadable: true } : { ok: true });
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

  // Decrypt to verify credentials are valid (readable). Every other path in this PR
  // treats an unreadable blob as a named, reported condition; leaving this one as a
  // raw throw turned "Test Connection" into an opaque 500 exactly when the operator
  // is trying to work out what is wrong.
  try {
    decrypt(row.credentials_json);
  } catch {
    return res.status(409).json({
      error:
        'Stored credentials for this launcher cannot be decrypted. Either ' +
        'GAMESHELF_ENCRYPTION_KEY changed without running the rotation script, or ' +
        'the encryption-salt file beside the database is missing. Re-entering the ' +
        'credentials also resolves it.',
    });
  }

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
    'UPDATE launchers SET credentials_json = NULL, enabled = 0, last_sync_at = NULL, sync_locked = 0 WHERE name = ?'
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
    db.prepare('UPDATE launchers SET sync_locked = 1 WHERE id = ?').run(launcherId);
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

  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE id = ?').run(launcherId);

  res.json({ deleted_editions: deletedEditions, deleted_games: deletedGames });
});

// POST /api/launchers/:id/unlock-sync
router.post('/:id/unlock-sync', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const row = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!row) {
    return res.status(404).json({ error: 'Launcher not configured' });
  }

  db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run(id);
  res.json({ success: true });
});

// POST /api/launchers/:id/lock-sync
router.post('/:id/lock-sync', (req, res) => {
  const { id } = req.params;
  const launcher = LAUNCHER_MAP[id];

  if (!launcher) {
    return res.status(400).json({ error: `Unknown launcher: ${id}` });
  }

  const db = req.app.locals.db;
  const row = db.prepare('SELECT id FROM launchers WHERE name = ?').get(id);

  if (!row) {
    return res.status(404).json({ error: 'Launcher not configured' });
  }

  db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run(id);
  res.json({ success: true });
});

module.exports = router;
