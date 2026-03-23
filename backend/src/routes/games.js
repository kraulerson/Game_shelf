const { Router } = require('express');
const authMiddleware = require('../middleware/auth');

const router = Router();

router.use(authMiddleware);

// GET /api/games/filters — MUST be before /:id to avoid route conflict
router.get('/filters', (req, res) => {
  const db = req.app.locals.db;

  const genres = db.prepare(`
    SELECT g.name, COUNT(DISTINCT gg.game_id) as count
    FROM genres g
    JOIN game_genres gg ON gg.genre_id = g.id
    JOIN game_editions ge ON ge.game_id = gg.game_id AND ge.owned = 1
    GROUP BY g.name ORDER BY count DESC
  `).all();

  const tags = db.prepare(`
    SELECT t.name, COUNT(DISTINCT gt.game_id) as count
    FROM tags t
    JOIN game_tags gt ON gt.tag_id = t.id
    JOIN game_editions ge ON ge.game_id = gt.game_id AND ge.owned = 1
    GROUP BY t.name ORDER BY count DESC
  `).all();

  const launchers = db.prepare(`
    SELECT l.name, l.display_name, COUNT(DISTINCT ge.id) as count
    FROM launchers l
    JOIN game_editions ge ON ge.launcher_id = l.id AND ge.owned = 1
    WHERE l.enabled = 1
    GROUP BY l.name ORDER BY l.priority ASC
  `).all();

  const yearRange = db.prepare(`
    SELECT MIN(g.release_year) as release_year_min, MAX(g.release_year) as release_year_max
    FROM games g
    JOIN game_editions ge ON ge.game_id = g.id AND ge.owned = 1
    WHERE g.release_year IS NOT NULL
  `).get();

  const playtimeMax = db.prepare(`
    SELECT MAX(ge.playtime_minutes) as playtime_max_minutes
    FROM game_editions ge WHERE ge.owned = 1
  `).get();

  res.json({
    genres,
    tags,
    launchers,
    release_year_min: yearRange?.release_year_min || null,
    release_year_max: yearRange?.release_year_max || null,
    playtime_max_minutes: playtimeMax?.playtime_max_minutes || 0,
  });
});

// GET /api/games/:id
router.get('/:id', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;

  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  // Get all editions with launcher info
  const editions = db.prepare(`
    SELECT ge.id, ge.launcher_game_id, ge.launcher_url, ge.playtime_minutes, ge.owned,
           l.name as launcher_name, l.display_name as launcher_display_name, l.priority
    FROM game_editions ge
    JOIN launchers l ON l.id = ge.launcher_id
    WHERE ge.game_id = ?
    ORDER BY l.priority ASC
  `).all(id);

  // Compute is_primary (lowest priority = primary)
  const minPriority = editions.length > 0 ? Math.min(...editions.map(e => e.priority)) : null;
  const editionsWithPrimary = editions.map(e => ({
    id: e.id,
    launcher_name: e.launcher_name,
    launcher_display_name: e.launcher_display_name,
    launcher_game_id: e.launcher_game_id,
    launcher_url: e.launcher_url,
    playtime_minutes: e.playtime_minutes,
    owned: e.owned,
    is_primary: e.priority === minPriority,
  }));

  const genres = db.prepare(`
    SELECT g.name FROM genres g
    JOIN game_genres gg ON gg.genre_id = g.id
    WHERE gg.game_id = ?
  `).all(id).map(r => r.name);

  const tags = db.prepare(`
    SELECT t.id, t.name FROM tags t
    JOIN game_tags gt ON gt.tag_id = t.id
    WHERE gt.game_id = ?
  `).all(id);

  res.json({
    ...game,
    genres,
    tags,
    editions: editionsWithPrimary,
  });
});

// PUT /api/games/:id/tags — set user-created tags for a game
router.put('/:id/tags', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { tagIds = [] } = req.body || {};

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const deleteNonGenre = db.prepare(
    'DELETE FROM game_tags WHERE game_id = ? AND tag_id NOT IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)'
  );
  const insertTag = db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)');

  const updateTags = db.transaction(() => {
    deleteNonGenre.run(id);
    for (const tagId of tagIds) {
      insertTag.run(id, tagId);
    }
  });
  updateTags();

  res.json({ updated: true });
});

// GET /api/games
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const {
    search, genre, tag, launcher, sort = 'title_asc',
    page = '1', limit = '50', duplicates,
    release_year_min, release_year_max, playtime_min, playtime_max,
    owned = 'true',
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * limitNum;

  // Filters that apply inside the CTE (edition-level columns: ge.*, l.*)
  const innerConditions = [];
  const innerParams = [];

  if (owned !== 'all') {
    innerConditions.push('ge.owned = 1');
  }
  if (launcher) {
    const launchers = launcher.split(',').map(l => l.trim());
    const placeholders = launchers.map(() => '?').join(',');
    innerConditions.push(`l.name IN (${placeholders})`);
    innerParams.push(...launchers);
  }
  if (playtime_min) {
    innerConditions.push('ge.playtime_minutes >= ?');
    innerParams.push(parseInt(playtime_min, 10));
  }
  if (playtime_max) {
    innerConditions.push('ge.playtime_minutes <= ?');
    innerParams.push(parseInt(playtime_max, 10));
  }

  const innerWhere = innerConditions.length > 0 ? 'AND ' + innerConditions.join(' AND ') : '';

  // Filters that apply to the outer query (game-level columns: g.*)
  const outerConditions = [];
  const outerParams = [];

  // Search is handled separately per query mode since column names differ
  const searchTerm = search ? `%${search}%` : null;
  if (release_year_min) {
    outerConditions.push('g.release_year >= ?');
    outerParams.push(parseInt(release_year_min, 10));
  }
  if (release_year_max) {
    outerConditions.push('g.release_year <= ?');
    outerParams.push(parseInt(release_year_max, 10));
  }
  if (genre) {
    const genres = genre.split(',').map(g => g.trim());
    const placeholders = genres.map(() => '?').join(',');
    outerConditions.push(`g.id IN (SELECT gg.game_id FROM game_genres gg JOIN genres gr ON gr.id = gg.genre_id WHERE gr.name IN (${placeholders}))`);
    outerParams.push(...genres);
  }
  if (tag) {
    const tags = tag.split(',').map(t => t.trim());
    const placeholders = tags.map(() => '?').join(',');
    outerConditions.push(`g.id IN (SELECT gt.game_id FROM game_tags gt JOIN tags t ON t.id = gt.tag_id WHERE t.name IN (${placeholders}))`);
    outerParams.push(...tags);
  }

  const outerWhere = outerConditions.length > 0 ? 'AND ' + outerConditions.join(' AND ') : '';

  // Search clause added per query mode (column refs differ)
  const searchWhereDup = searchTerm ? 'AND (g.title LIKE ? OR ge.title LIKE ?)' : '';
  const searchWhereDedup = searchTerm ? 'AND (g.title LIKE ? OR r.edition_title LIKE ?)' : '';
  const searchParams = searchTerm ? [searchTerm, searchTerm] : [];

  // Sort uses column aliases from SELECT (r_playtime, r_title)
  const sortMap = {
    title_asc: 'COALESCE(g.title, r_title) COLLATE NOCASE ASC',
    title_desc: 'COALESCE(g.title, r_title) COLLATE NOCASE DESC',
    release_asc: 'g.release_year ASC',
    release_desc: 'g.release_year DESC',
    playtime_desc: 'r_playtime DESC',
  };
  const orderBy = sortMap[sort] || sortMap.title_asc;

  let query;
  let countQuery;
  let allParams;
  let countParams;

  if (duplicates === 'show') {
    query = `
      SELECT ge.id as edition_id, ge.launcher_game_id, ge.playtime_minutes as r_playtime,
             ge.owned, ge.title as r_title,
             g.id, g.title, g.slug, g.cover_url, g.icon_url, g.description,
             g.release_year, g.developer, g.publisher,
             l.name as launcher_name, l.display_name as launcher_display_name
      FROM game_editions ge
      JOIN launchers l ON l.id = ge.launcher_id
      LEFT JOIN games g ON g.id = ge.game_id
      WHERE 1=1 ${innerWhere} ${outerWhere} ${searchWhereDup}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;
    countQuery = `
      SELECT COUNT(*) as total
      FROM game_editions ge
      JOIN launchers l ON l.id = ge.launcher_id
      LEFT JOIN games g ON g.id = ge.game_id
      WHERE 1=1 ${innerWhere} ${outerWhere} ${searchWhereDup}
    `;
    countParams = [...innerParams, ...outerParams, ...searchParams];
    allParams = [...innerParams, ...outerParams, ...searchParams, limitNum, offset];
  } else {
    query = `
      WITH ranked AS (
        SELECT ge.id, ge.game_id, ge.launcher_id, ge.launcher_game_id,
               ge.playtime_minutes, ge.owned, ge.title as edition_title,
               l.name as launcher_name, l.display_name as launcher_display_name, l.priority,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(ge.game_id, ge.id * -1)
                 ORDER BY l.priority ASC
               ) as rn
        FROM game_editions ge
        JOIN launchers l ON l.id = ge.launcher_id
        WHERE 1=1 ${innerWhere}
      )
      SELECT r.id as edition_id, r.launcher_game_id, r.playtime_minutes as r_playtime,
             r.owned, r.edition_title as r_title,
             r.launcher_name, r.launcher_display_name,
             g.id, g.title, g.slug, g.cover_url, g.icon_url, g.description,
             g.release_year, g.developer, g.publisher
      FROM ranked r
      LEFT JOIN games g ON g.id = r.game_id
      WHERE r.rn = 1 ${outerWhere} ${searchWhereDedup}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;
    countQuery = `
      WITH ranked AS (
        SELECT ge.id, ge.game_id, ge.launcher_id, ge.launcher_game_id,
               ge.playtime_minutes, ge.owned, ge.title as edition_title,
               l.name as launcher_name, l.display_name as launcher_display_name, l.priority,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(ge.game_id, ge.id * -1)
                 ORDER BY l.priority ASC
               ) as rn
        FROM game_editions ge
        JOIN launchers l ON l.id = ge.launcher_id
        WHERE 1=1 ${innerWhere}
      )
      SELECT COUNT(*) as total
      FROM ranked r
      LEFT JOIN games g ON g.id = r.game_id
      WHERE r.rn = 1 ${outerWhere} ${searchWhereDedup}
    `;
    countParams = [...innerParams, ...outerParams, ...searchParams];
    allParams = [...innerParams, ...outerParams, ...searchParams, limitNum, offset];
  }

  const total = db.prepare(countQuery).get(...countParams)?.total || 0;
  const rows = db.prepare(query).all(...allParams);

  // Build also_on, genres, tags for each game
  const alsoOnStmt = db.prepare(`
    SELECT l.name as launcher_name, l.display_name as launcher_display_name,
           ge.playtime_minutes, ge.launcher_game_id
    FROM game_editions ge
    JOIN launchers l ON l.id = ge.launcher_id
    WHERE ge.game_id = ? AND ge.owned = 1
    ORDER BY l.priority ASC
  `);
  const genresStmt = db.prepare(`
    SELECT gr.name FROM genres gr
    JOIN game_genres gg ON gg.genre_id = gr.id WHERE gg.game_id = ?
  `);
  const tagsStmt = db.prepare(`
    SELECT t.name FROM tags t
    JOIN game_tags gt ON gt.tag_id = t.id WHERE gt.game_id = ?
  `);

  const games = rows.map(row => {
    const gameId = row.id;
    const alsoOn = gameId ? alsoOnStmt.all(gameId) : [];
    const genres = gameId ? genresStmt.all(gameId).map(r => r.name) : [];
    const tags = gameId ? tagsStmt.all(gameId).map(r => r.name) : [];

    return {
      id: gameId,
      title: row.title || row.r_title || row.launcher_game_id,
      slug: row.slug,
      cover_url: row.cover_url,
      icon_url: row.icon_url,
      description: row.description,
      release_year: row.release_year,
      developer: row.developer,
      publisher: row.publisher,
      genres,
      tags,
      playtime_minutes: row.r_playtime,
      launcher_name: row.launcher_name,
      launcher_display_name: row.launcher_display_name,
      launcher_game_id: row.launcher_game_id,
      also_on: alsoOn.length > 0 ? alsoOn : [{
        launcher_name: row.launcher_name,
        launcher_display_name: row.launcher_display_name,
        playtime_minutes: row.r_playtime,
        launcher_game_id: row.launcher_game_id,
      }],
    };
  });

  res.json({ games, total, page: pageNum, limit: limitNum });
});

module.exports = router;
