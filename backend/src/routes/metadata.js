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

// POST /api/metadata/re-enrich/:gameId — reset and re-enrich a specific game
router.post('/re-enrich/:gameId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { gameId } = req.params;

    // Reset the game so enrichment picks it up
    db.prepare(
      "UPDATE games SET cover_url = NULL, hero_url = NULL, icon_url = NULL, " +
      "description = NULL, last_enrichment_at = NULL WHERE id = ?"
    ).run(gameId);

    // Find an edition to re-enrich through
    const edition = db.prepare(
      "SELECT id FROM game_editions WHERE game_id = ? LIMIT 1"
    ).get(gameId);

    if (!edition) {
      return res.status(404).json({ error: 'No edition found for this game' });
    }

    const result = await enrichGame(edition.id, db);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/metadata/status
router.get('/status', (req, res) => {
  const db = req.app.locals.db;

  // Only count games that have at least one non-DLC edition (exclude orphans and DLC-only)
  const total = db.prepare(
    "SELECT COUNT(*) as count FROM games g " +
    "WHERE EXISTS (SELECT 1 FROM game_editions ge WHERE ge.game_id = g.id AND ge.parent_edition_id IS NULL)"
  ).get().count;
  const unenriched = db.prepare(
    "SELECT COUNT(*) as count FROM games g " +
    "WHERE g.cover_url IS NULL " +
    "AND EXISTS (SELECT 1 FROM game_editions ge WHERE ge.game_id = g.id AND ge.parent_edition_id IS NULL)"
  ).get().count;

  const unenrichedList = db.prepare(
    "SELECT g.id, g.title FROM games g " +
    "WHERE g.cover_url IS NULL " +
    "AND EXISTS (SELECT 1 FROM game_editions ge WHERE ge.game_id = g.id AND ge.parent_edition_id IS NULL) " +
    "ORDER BY g.title ASC LIMIT 50"
  ).all();

  res.json({ unenriched, total, unenrichedList });
});

module.exports = router;
