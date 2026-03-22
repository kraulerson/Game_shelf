const { decrypt } = require('../utils/encrypt');
const { LAUNCHER_CLASSES } = require('./launchers');

async function syncLauncher(launcherName, db) {
  const launcher = db.prepare('SELECT * FROM launchers WHERE name = ?').get(launcherName);

  if (!launcher) {
    throw new Error(`Launcher not found: ${launcherName}`);
  }

  if (!launcher.credentials_json) {
    throw new Error(`No credentials for launcher: ${launcherName}`);
  }

  // Create sync job
  const now = new Date().toISOString();
  const jobResult = db.prepare(
    'INSERT INTO sync_jobs (launcher_id, status, started_at) VALUES (?, ?, ?)'
  ).run(launcher.id, 'running', now);
  const jobId = Number(jobResult.lastInsertRowid);

  try {
    // Decrypt credentials
    const credentials = JSON.parse(decrypt(launcher.credentials_json));

    // Instantiate launcher class
    const LauncherClass = LAUNCHER_CLASSES[launcherName];
    if (!LauncherClass) {
      throw new Error(`No launcher implementation for: ${launcherName}`);
    }
    const instance = new LauncherClass(launcherName, db);

    // Authenticate and fetch games
    const session = await instance.refreshIfNeeded(credentials);
    const games = await instance.fetchOwnedGames(session);

    // Upsert game_editions
    const upsert = db.prepare(`
      INSERT INTO game_editions (launcher_id, launcher_game_id, title, playtime_minutes, owned)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(launcher_id, launcher_game_id) DO UPDATE SET
        title = excluded.title,
        playtime_minutes = excluded.playtime_minutes,
        owned = 1
    `);

    // Note: gamesUpdated counts rows touched by upsert, not rows with actual value changes.
    // SQLite reports changes=1 for ON CONFLICT DO UPDATE even if values are identical.
    let gamesUpdated = 0;
    const returnedIds = new Set();

    const upsertAll = db.transaction((items) => {
      for (const game of items) {
        returnedIds.add(game.launcher_game_id);
        const result = upsert.run(
          launcher.id,
          game.launcher_game_id,
          game.title,
          game.playtime_minutes
        );
        if (result.changes > 0) gamesUpdated++;
      }
    });
    upsertAll(games);

    // Mark missing games as owned=0 (soft removal).
    // Skip if no games returned — avoids accidentally marking everything as unowned
    // when the API returns empty due to an error or transient issue.
    if (returnedIds.size > 0) {
      const allEditions = db.prepare(
        'SELECT launcher_game_id FROM game_editions WHERE launcher_id = ? AND owned = 1'
      ).all(launcher.id);

      const markUnowned = db.prepare(
        'UPDATE game_editions SET owned = 0 WHERE launcher_id = ? AND launcher_game_id = ?'
      );

      const markAll = db.transaction((editions) => {
        for (const edition of editions) {
          if (!returnedIds.has(edition.launcher_game_id)) {
            markUnowned.run(launcher.id, edition.launcher_game_id);
          }
        }
      });
      markAll(allEditions);
    }

    // Update sync job to success
    const completedAt = new Date().toISOString();
    db.prepare(
      'UPDATE sync_jobs SET status = ?, completed_at = ?, games_found = ?, games_updated = ? WHERE id = ?'
    ).run('success', completedAt, games.length, gamesUpdated, jobId);

    // Update launcher last_sync_at
    db.prepare('UPDATE launchers SET last_sync_at = ? WHERE id = ?').run(completedAt, launcher.id);

    return jobId;
  } catch (err) {
    const completedAt = new Date().toISOString();
    db.prepare(
      'UPDATE sync_jobs SET status = ?, completed_at = ?, error_message = ? WHERE id = ?'
    ).run('failed', completedAt, err.message, jobId);
    console.error(`[Sync] ${launcherName} failed:`, err.message);
    return jobId;
  }
}

async function syncAll(db) {
  const launchers = db.prepare(
    'SELECT name FROM launchers WHERE enabled = 1 AND credentials_json IS NOT NULL'
  ).all();

  const succeeded = [];
  const failed = [];
  const skipped = [];

  for (const launcher of launchers) {
    const jobId = await syncLauncher(launcher.name, db);
    const job = db.prepare('SELECT status, games_found FROM sync_jobs WHERE id = ?').get(jobId);

    if (job.status === 'failed') {
      failed.push(launcher.name);
    } else if (job.games_found === 0) {
      skipped.push(launcher.name);
    } else {
      succeeded.push(launcher.name);
    }
  }

  return { succeeded, failed, skipped };
}

module.exports = { syncLauncher, syncAll };
