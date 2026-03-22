const { Router } = require('express');
const authMiddleware = require('../middleware/auth');
const { enrichGame, enrichAll } = require('../services/metadata/enrichGame');

const router = Router();

router.use(authMiddleware);

// POST /api/metadata/enrich/:gameEditionId
router.post('/enrich/:gameEditionId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { gameEditionId } = req.params;
    const result = await enrichGame(Number(gameEditionId), db);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/metadata/enrich-all
router.post('/enrich-all', (req, res) => {
  const db = req.app.locals.db;
  // Fire and forget
  enrichAll(db).catch(err => console.error('[Metadata] enrichAll error:', err.message));
  res.json({ message: 'Gameshelf enrichment started' });
});

// GET /api/metadata/status
router.get('/status', (req, res) => {
  const db = req.app.locals.db;

  const total = db.prepare('SELECT COUNT(*) as count FROM games').get().count;
  const unenriched = db.prepare('SELECT COUNT(*) as count FROM games WHERE cover_url IS NULL').get().count;

  res.json({ unenriched, total });
});

module.exports = router;
