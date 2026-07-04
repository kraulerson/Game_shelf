const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { callOrchestrator, fetchAllGames } = require('../services/orchestrator');
const { syncCrossLauncherExclusions } = require('../services/crossLauncherExclusions');
const { fetchManualCoverage } = require('../services/manualCoverage');

const router = Router();
router.use(authMiddleware);

// Forward a call to the orchestrator and pass its status+body through; on a
// mapped error (offline/auth) reply with that error's status+body instead.
async function forward(res, method, path, opts) {
  try {
    const { status, data } = await callOrchestrator(method, path, opts);
    res.status(status).json(data);
  } catch (err) {
    res.status(err.status || 503).json(err.body || { status: 'orchestrator_offline' });
  }
}

// Paged to a full merged set for F15's bulk badge correlation.
router.get('/games', async (req, res) => {
  try {
    res.json(await fetchAllGames());
  } catch (err) {
    res.status(err.status || 503).json(err.body || { status: 'orchestrator_offline' });
  }
});

router.get('/jobs', (req, res) => forward(res, 'GET', '/api/v1/jobs', { params: req.query }));
router.get('/platforms', (req, res) => forward(res, 'GET', '/api/v1/platforms'));
router.get('/health', (req, res) => forward(res, 'GET', '/api/v1/health'));
router.get('/block-list', (req, res) => forward(res, 'GET', '/api/v1/block-list', { params: req.query }));

// Mutations
router.post('/block-list', (req, res) => forward(res, 'POST', '/api/v1/block-list', { data: req.body }));
router.delete('/block-list/:platform/:app_id', (req, res) =>
  forward(
    res,
    'DELETE',
    `/api/v1/block-list/${encodeURIComponent(req.params.platform)}/${encodeURIComponent(req.params.app_id)}`
  )
);

// Prefill threads query params (notably ?force=true — a forced prefill re-requests
// every chunk to repair an evicted/partial game) through to the orchestrator;
// validate/manifest take no params.
router.post('/games/:id/prefill', (req, res) =>
  forward(res, 'POST', `/api/v1/games/${encodeURIComponent(req.params.id)}/prefill`, {
    params: req.query,
  })
);
for (const action of ['validate', 'manifest/fetch']) {
  router.post(`/games/:id/${action}`, (req, res) =>
    forward(res, 'POST', `/api/v1/games/${encodeURIComponent(req.params.id)}/${action}`)
  );
}

router.post('/platforms/:name/library/sync', (req, res) =>
  forward(res, 'POST', `/api/v1/platforms/${encodeURIComponent(req.params.name)}/library/sync`)
);

// Full re-validation sweep over the entire steam library — backs the cache
// dashboard's "Refresh cache status" button. Always requests a FULL sweep so
// not-yet-validated games are included, not just the cached subset.
router.post('/sweep', (req, res) => forward(res, 'POST', '/api/v1/sweep', { data: { full: true } }));

// Piece 3: compute the Epic games already covered on Steam (a shared game_id with
// a Steam edition) and push them to the orchestrator as gameshelf exclusions, so
// its Epic scheduled prefill skips the redundant copies. Also runs on the daily
// cron; this route is the on-demand trigger.
router.post('/cross-launcher-exclusions/sync', async (req, res) => {
  try {
    const result = await syncCrossLauncherExclusions(req.app.locals.db);
    res.json(result);
  } catch (err) {
    res.status(err.status || 503).json(err.body || { status: 'orchestrator_offline' });
  }
});

// #222: coverage report for a manual-download launcher (GOG/Humble/Itch/Amazon).
// Diffs the owned library against the game folders the orchestrator lists on the
// lancache host, returning which owned games were never downloaded (missing).
// :launcher is the on-disk folder name (e.g. GOG); its lowercase is the launcher.
router.get('/manual-coverage/:launcher', async (req, res) => {
  try {
    const result = await fetchManualCoverage(req.app.locals.db, req.params.launcher);
    res.json(result);
  } catch (err) {
    res.status(err.status || 503).json(err.body || { status: 'orchestrator_offline' });
  }
});

module.exports = router;
