const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { callOrchestrator, fetchAllGames } = require('../services/orchestrator');

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

for (const action of ['prefill', 'validate', 'manifest/fetch']) {
  router.post(`/games/:id/${action}`, (req, res) =>
    forward(res, 'POST', `/api/v1/games/${encodeURIComponent(req.params.id)}/${action}`)
  );
}

router.post('/platforms/:name/library/sync', (req, res) =>
  forward(res, 'POST', `/api/v1/platforms/${encodeURIComponent(req.params.name)}/library/sync`)
);

module.exports = router;
