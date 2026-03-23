const { Router } = require('express');
const authMiddleware = require('../middleware/auth');

const router = Router();

router.use(authMiddleware);

// GET /api/tags — list all tags with game counts
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const tags = db.prepare(`
    SELECT t.id, t.name, COUNT(gt.game_id) as gameCount
    FROM tags t
    LEFT JOIN game_tags gt ON gt.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.name COLLATE NOCASE ASC
  `).all();

  // Mark genre-mirrored tags
  const genreNames = new Set(
    db.prepare('SELECT name FROM genres').all().map(r => r.name)
  );
  const result = tags.map(t => ({
    ...t,
    isGenre: genreNames.has(t.name),
  }));

  res.json(result);
});

// POST /api/tags — create a new tag
router.post('/', (req, res) => {
  const { name } = req.body || {};
  const trimmed = (name || '').trim();

  if (!trimmed) {
    return res.status(400).json({ error: 'Tag name is required' });
  }
  if (trimmed.length > 50) {
    return res.status(400).json({ error: 'Tag name must be 50 characters or less' });
  }

  const db = req.app.locals.db;
  const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(trimmed);
  if (existing) {
    return res.status(400).json({ error: 'A tag with this name already exists' });
  }

  const result = db.prepare('INSERT INTO tags (name) VALUES (?)').run(trimmed);
  res.json({ id: Number(result.lastInsertRowid), name: trimmed });
});

// DELETE /api/tags/:id — delete a tag
router.delete('/:id', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;

  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
  if (!tag) {
    return res.status(404).json({ error: 'Tag not found' });
  }

  const isGenre = db.prepare(
    'SELECT name FROM genres WHERE name = ?'
  ).get(tag.name);
  if (isGenre) {
    return res.status(400).json({ error: 'Cannot delete genre-mirrored tag. This tag is managed by metadata enrichment.' });
  }

  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  res.json({ deleted: true });
});

// GET /api/tags/:id/games — get games for bulk editor
router.get('/:id/games', (req, res) => {
  const db = req.app.locals.db;
  const tagId = req.params.id;
  const { page = '1', limit = '200', search } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 200));
  const offset = (pageNum - 1) * limitNum;

  const searchCondition = search ? 'AND (g.title LIKE ? OR ge.title LIKE ?)' : '';
  const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

  const games = db.prepare(`
    SELECT ge.id as edition_id,
           COALESCE(g.title, ge.title) as title,
           COALESCE(g.icon_url, g.cover_url) as icon_url,
           g.id as game_id, ge.launcher_game_id,
           l.name as launcher_name, l.display_name as launcher_display_name,
           CASE WHEN gt.tag_id IS NOT NULL THEN 1 ELSE 0 END as tagged
    FROM game_editions ge
    JOIN launchers l ON l.id = ge.launcher_id
    LEFT JOIN games g ON g.id = ge.game_id
    LEFT JOIN game_tags gt ON gt.game_id = g.id AND gt.tag_id = ?
    WHERE ge.owned = 1 AND ge.game_id IS NOT NULL
      ${searchCondition}
    ORDER BY COALESCE(g.title, ge.title) COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(tagId, ...searchParams, limitNum, offset);

  const total = db.prepare(`
    SELECT COUNT(*) as total
    FROM game_editions ge
    LEFT JOIN games g ON g.id = ge.game_id
    WHERE ge.owned = 1 AND ge.game_id IS NOT NULL
      ${searchCondition}
  `).get(...searchParams).total;

  const taggedCount = db.prepare(
    'SELECT COUNT(*) as c FROM game_tags WHERE tag_id = ?'
  ).get(tagId).c;

  res.json({ games, total, taggedCount, page: pageNum, limit: limitNum });
});

// PATCH /api/tags/:id/games — bulk add/remove games
router.patch('/:id/games', (req, res) => {
  const db = req.app.locals.db;
  const tagId = req.params.id;
  const { add = [], remove = [] } = req.body || {};

  const tag = db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId);
  if (!tag) {
    return res.status(404).json({ error: 'Tag not found' });
  }

  const insertStmt = db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)');
  const deleteStmt = db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_id = ?');

  const bulkUpdate = db.transaction(() => {
    for (const gameId of add) {
      insertStmt.run(gameId, tagId);
    }
    for (const gameId of remove) {
      deleteStmt.run(gameId, tagId);
    }
  });
  bulkUpdate();

  res.json({ updated: true });
});

module.exports = router;
