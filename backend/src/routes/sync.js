const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { syncLauncher, syncAll } = require('../services/syncEngine');

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

  res.json(jobs);
});

// POST /api/sync/:launcherName — after static routes to avoid matching "status" as a launcherName
router.post('/:launcherName', (req, res) => {
  const db = req.app.locals.db;
  const { launcherName } = req.params;
  // Fire and forget
  syncLauncher(launcherName, db).catch(err =>
    console.error(`[Sync] ${launcherName} sync error:`, err.message)
  );
  res.json({ message: `Sync started for ${launcherName}` });
});

module.exports = router;
