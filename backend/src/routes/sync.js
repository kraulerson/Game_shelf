const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { syncLauncher, syncAll } = require('../services/syncEngine');
const { summarizeSyncHealth } = require('../services/syncHealth');

const OTP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const router = Router();

router.use(authMiddleware);

// POST /api/sync/all
router.post('/all', (req, res) => {
  const db = req.app.locals.db;
  // Fire and forget — do not await
  syncAll(db).catch(err => console.error('[Sync] syncAll error:', err.message));
  res.json({ message: 'Gameshelf sync started' });
});

// GET /api/sync/status — MUST be defined before /:launcherName to avoid route conflicts
router.get('/status', (req, res) => {
  const db = req.app.locals.db;

  const jobs = db.prepare(`
    SELECT sj.*, l.name as launcher_name, l.display_name
    FROM sync_jobs sj
    JOIN launchers l ON l.id = sj.launcher_id
    WHERE sj.id IN (
      SELECT MAX(id) FROM sync_jobs GROUP BY launcher_id
    )
    ORDER BY l.priority ASC
  `).all();

  res.json({ jobs, otp_window_ms: OTP_WINDOW_MS });
});

// GET /api/sync/health — MUST be defined before /:launcherName to avoid route conflicts.
//
// /status reports raw jobs; this answers "is anything broken?". The distinction
// matters because a launcher can stop syncing without its latest job ever looking
// wrong: syncAll treats an awaiting_otp job as neither success nor failure and
// continues, so staleness is derived from launchers.last_sync_at instead.
router.get('/health', (req, res) => {
  const db = req.app.locals.db;

  const launchers = db.prepare(
    'SELECT id, name, display_name, enabled, credentials_json, last_sync_at, sync_locked ' +
    'FROM launchers ORDER BY priority ASC'
  ).all();

  const latestJobs = db.prepare(`
    SELECT sj.* FROM sync_jobs sj
    WHERE sj.id IN (SELECT MAX(id) FROM sync_jobs GROUP BY launcher_id)
  `).all();
  const jobByLauncher = new Map(latestJobs.map(j => [j.launcher_id, j]));

  const rows = launchers.map(l => ({ launcher: l, job: jobByLauncher.get(l.id) || null }));
  const summary = summarizeSyncHealth(rows);

  // credentials_json must never leave the server, even encrypted.
  res.json({
    healthy: summary.healthy,
    problems: summary.problems,
    launchers: summary.launchers,
  });
});

// POST /api/sync/:launcherName/otp — MUST be before /:launcherName to avoid route conflicts
router.post('/:launcherName/otp', (req, res) => {
  const db = req.app.locals.db;
  const { launcherName } = req.params;
  const { otp_code } = req.body || {};

  if (!otp_code) {
    return res.status(400).json({ error: 'otp_code is required' });
  }

  // Find the launcher
  const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get(launcherName);
  if (!launcher) {
    return res.status(404).json({ error: `Launcher not found: ${launcherName}` });
  }

  // Find the latest sync job for this launcher
  const job = db.prepare(
    'SELECT id, status, started_at FROM sync_jobs WHERE launcher_id = ? ORDER BY id DESC LIMIT 1'
  ).get(launcher.id);

  if (!job || job.status !== 'awaiting_otp') {
    return res.status(400).json({ error: 'No pending OTP request — click Sync to start' });
  }

  // Check 5-minute window
  const elapsed = Date.now() - new Date(job.started_at).getTime();
  if (elapsed > OTP_WINDOW_MS) {
    return res.status(400).json({ error: 'OTP window expired — click Sync to restart' });
  }

  // Mark the old awaiting_otp job as superseded
  db.prepare('UPDATE sync_jobs SET status = ?, completed_at = ? WHERE id = ?')
    .run('failed', new Date().toISOString(), job.id);

  // Fire and forget — resume sync with the code
  syncLauncher(launcherName, db, otp_code).catch(err =>
    console.error(`[Sync] ${launcherName} OTP sync error:`, err.message)
  );
  res.json({ message: `Sync resumed for ${launcherName}` });
});

// POST /api/sync/:launcherName — after static routes to avoid matching "status" as a launcherName
router.post('/:launcherName', (req, res) => {
  const db = req.app.locals.db;
  const { launcherName } = req.params;

  // Check sync lock before firing sync
  const launcher = db.prepare('SELECT sync_locked, display_name FROM launchers WHERE name = ?').get(launcherName);
  if (launcher && launcher.sync_locked) {
    return res.status(409).json({
      error: `${launcher.display_name || launcherName} is locked. Unlock it in Settings before syncing.`
    });
  }

  const { otp_code } = req.body || {};
  // Fire and forget
  syncLauncher(launcherName, db, otp_code).catch(err =>
    console.error(`[Sync] ${launcherName} sync error:`, err.message)
  );
  res.json({ message: `Sync started for ${launcherName}` });
});

module.exports = router;
