const { Router } = require('express');
const multer = require('multer');
const fs = require('node:fs');
const pathMod = require('node:path');
const authMiddleware = require('../middleware/auth');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

const router = Router();

router.use(authMiddleware);

// GET /api/games/filters — MUST be before /:id to avoid route conflict
router.get('/filters', (req, res) => {
  const db = req.app.locals.db;

  const genres = db.prepare(`
    SELECT g.name, COUNT(DISTINCT gg.game_id) as count
    FROM genres g
    JOIN game_genres gg ON gg.genre_id = g.id
    JOIN game_editions ge ON ge.game_id = gg.game_id AND ge.owned = 1 AND ge.parent_edition_id IS NULL
    GROUP BY g.name ORDER BY count DESC
  `).all();

  const tags = db.prepare(`
    SELECT t.name, COUNT(DISTINCT gt.game_id) as count
    FROM tags t
    JOIN game_tags gt ON gt.tag_id = t.id
    JOIN game_editions ge ON ge.game_id = gt.game_id AND ge.owned = 1 AND ge.parent_edition_id IS NULL
    GROUP BY t.name ORDER BY count DESC
  `).all();

  const launchers = db.prepare(`
    SELECT l.name, l.display_name, COUNT(DISTINCT ge.id) as count
    FROM launchers l
    JOIN game_editions ge ON ge.launcher_id = l.id AND ge.owned = 1 AND ge.parent_edition_id IS NULL
    WHERE l.enabled = 1
    GROUP BY l.name ORDER BY l.priority ASC
  `).all();

  const yearRange = db.prepare(`
    SELECT MIN(g.release_year) as release_year_min, MAX(g.release_year) as release_year_max
    FROM games g
    JOIN game_editions ge ON ge.game_id = g.id AND ge.owned = 1 AND ge.parent_edition_id IS NULL
    WHERE g.release_year IS NOT NULL
  `).get();

  const playtimeMax = db.prepare(`
    SELECT MAX(ge.playtime_minutes) as playtime_max_minutes
    FROM game_editions ge WHERE ge.owned = 1 AND ge.parent_edition_id IS NULL
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

  // Get all editions with launcher and tier info
  const { getTierLabel } = require('../utils/editionTier');
  const editions = db.prepare(`
    SELECT ge.id, ge.launcher_game_id, ge.launcher_url, ge.playtime_minutes, ge.owned,
           ge.title as edition_title,
           l.name as launcher_name, l.display_name as launcher_display_name, l.priority,
           COALESCE(et.tier, 0) as tier,
           COALESCE(et.is_display_edition, 0) as is_display_override
    FROM game_editions ge
    JOIN launchers l ON l.id = ge.launcher_id
    LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
    WHERE ge.game_id = ? AND ge.parent_edition_id IS NULL
    ORDER BY COALESCE(et.is_display_edition, 0) DESC, COALESCE(et.tier, 0) DESC, l.priority ASC
  `).all(id);

  // DLC items for this game
  const dlc = db.prepare(`
    SELECT ge.id, ge.title as edition_title, ge.playtime_minutes,
           l.name as launcher_name, l.display_name as launcher_display_name
    FROM game_editions ge
    JOIN launchers l ON l.id = ge.launcher_id
    WHERE ge.game_id = ? AND ge.parent_edition_id IS NOT NULL AND ge.owned = 1
    ORDER BY ge.title ASC
  `).all(id);

  // Display edition is first row (sorted by override > tier > priority)
  const displayEdition = editions[0];
  const editionsWithTier = editions.map(e => ({
    id: e.id,
    launcher_name: e.launcher_name,
    launcher_display_name: e.launcher_display_name,
    launcher_game_id: e.launcher_game_id,
    launcher_url: e.launcher_url,
    edition_title: e.edition_title,
    playtime_minutes: e.playtime_minutes,
    owned: e.owned,
    tier: e.tier,
    tier_label: getTierLabel(e.tier),
    is_display_edition: displayEdition ? e.id === displayEdition.id : false,
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
    editions: editionsWithTier,
    dlc,
  });
});

// PATCH /api/games/:id — update game title and/or description
router.patch('/:id', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { title, description } = req.body || {};

  const hasTitle = title !== undefined && title !== null;
  const hasDescription = description !== undefined;

  if (!hasTitle && !hasDescription) {
    return res.status(400).json({ error: 'title or description is required' });
  }

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  if (hasTitle) {
    if (!title.trim()) {
      return res.status(400).json({ error: 'Title cannot be empty' });
    }
    const { slugify } = require('../services/metadata/titleMatcher');
    let slug = slugify(title.trim());

    // Handle slug collision — append suffix if slug exists on a different game
    const existing = db.prepare('SELECT id FROM games WHERE slug = ? AND id != ?').get(slug, id);
    if (existing) {
      let suffix = 2;
      while (db.prepare('SELECT id FROM games WHERE slug = ?').get(`${slug}-${suffix}`)) {
        suffix++;
      }
      slug = `${slug}-${suffix}`;
    }

    db.prepare(
      "UPDATE games SET title = ?, slug = ?, manual_title = 1, updated_at = datetime('now') WHERE id = ?"
    ).run(title.trim(), slug, id);
  }

  if (hasDescription) {
    const descValue = description.trim() || null;
    db.prepare(
      "UPDATE games SET description = ?, manual_description = 1, updated_at = datetime('now') WHERE id = ?"
    ).run(descValue, id);
  }

  res.json({ updated: true });
});

// POST /api/games/:id/display-edition — set manual display edition override
router.post('/:id/display-edition', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { edition_id } = req.body || {};

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  if (!edition_id) return res.status(400).json({ error: 'edition_id is required' });

  const edition = db.prepare(
    'SELECT id FROM game_editions WHERE id = ? AND game_id = ?'
  ).get(edition_id, id);
  if (!edition) return res.status(400).json({ error: 'Edition does not belong to this game' });

  const setDisplay = db.transaction((gameId, editionId) => {
    db.prepare(`
      UPDATE edition_tiers SET is_display_edition = 0
      WHERE game_edition_id IN (SELECT id FROM game_editions WHERE game_id = ?)
    `).run(gameId);
    db.prepare(
      'UPDATE edition_tiers SET is_display_edition = 1 WHERE game_edition_id = ?'
    ).run(editionId);
  });
  setDisplay(id, edition_id);

  res.json({ ok: true });
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

// POST /api/games/:id/cover — upload cover image
router.post('/:id/cover', upload.single('cover'), (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;

  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  const ext = extMap[req.file.mimetype] || '.jpg';

  const dataDir = pathMod.resolve(pathMod.dirname(process.env.GAMESHELF_DB_PATH || './data/gameshelf.db'));
  const gameDir = pathMod.join(dataDir, 'images', String(id));
  fs.mkdirSync(gameDir, { recursive: true });

  const filename = `cover${ext}`;
  fs.writeFileSync(pathMod.join(gameDir, filename), req.file.buffer);

  const coverUrl = `/data/images/${id}/${filename}`;
  db.prepare(
    "UPDATE games SET cover_url = ?, manual_cover = 1, updated_at = datetime('now') WHERE id = ?"
  ).run(coverUrl, id);

  res.json({ cover_url: coverUrl });
});

// DELETE /api/games/:id/manual-override — reset manual override flag
router.delete('/:id/manual-override', (req, res) => {
  const db = req.app.locals.db;
  const { id } = req.params;
  const { field } = req.body || {};

  const validFields = { description: 'manual_description', cover: 'manual_cover' };
  const column = validFields[field];
  if (!column) {
    return res.status(400).json({ error: 'field must be "description" or "cover"' });
  }

  const game = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  db.prepare(`UPDATE games SET ${column} = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// Multer error handler
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Only JPEG')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// GET /api/games
router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const {
    search, genre, tag, launcher, sort = 'title_asc',
    page = '1', limit = '50', duplicates, starts_with,
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

  // starts_with clause — dual expressions like search (column refs differ per mode)
  let startsWithDup = '';
  let startsWithDedup = '';
  const startsWithParams = [];
  if (starts_with) {
    if (starts_with === '#') {
      startsWithDup = "AND COALESCE(g.title, ge.title) NOT GLOB '[A-Za-z]*'";
      startsWithDedup = "AND COALESCE(g.title, r.edition_title) NOT GLOB '[A-Za-z]*'";
    } else {
      startsWithDup = 'AND COALESCE(g.title, ge.title) LIKE ? COLLATE NOCASE';
      startsWithDedup = 'AND COALESCE(g.title, r.edition_title) LIKE ? COLLATE NOCASE';
      startsWithParams.push(`${starts_with}%`);
    }
  }

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
             COALESCE(et.tier, 0) as display_tier, ge.title as display_edition_title,
             g.id, g.title, g.slug, g.cover_url, g.icon_url, g.description,
             g.release_year, g.developer, g.publisher,
             l.name as launcher_name, l.display_name as launcher_display_name
      FROM game_editions ge
      JOIN launchers l ON l.id = ge.launcher_id
      LEFT JOIN games g ON g.id = ge.game_id
      LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
      WHERE ge.parent_edition_id IS NULL AND ge.title NOT LIKE '%Demo%' AND ge.title NOT LIKE '%Beta%' AND ge.title NOT LIKE '% Test' AND ge.title NOT LIKE '%Test %' ${innerWhere} ${outerWhere} ${searchWhereDup} ${startsWithDup}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;
    countQuery = `
      SELECT COUNT(*) as total
      FROM game_editions ge
      JOIN launchers l ON l.id = ge.launcher_id
      LEFT JOIN games g ON g.id = ge.game_id
      WHERE ge.parent_edition_id IS NULL AND ge.title NOT LIKE '%Demo%' AND ge.title NOT LIKE '%Beta%' AND ge.title NOT LIKE '% Test' AND ge.title NOT LIKE '%Test %' ${innerWhere} ${outerWhere} ${searchWhereDup} ${startsWithDup}
    `;
    countParams = [...innerParams, ...outerParams, ...searchParams, ...startsWithParams];
    allParams = [...innerParams, ...outerParams, ...searchParams, ...startsWithParams, limitNum, offset];
  } else {
    query = `
      WITH ranked AS (
        SELECT ge.id, ge.game_id, ge.launcher_id, ge.launcher_game_id,
               ge.playtime_minutes, ge.owned, ge.title as edition_title,
               l.name as launcher_name, l.display_name as launcher_display_name, l.priority,
               COALESCE(et.tier, 0) as edition_tier,
               COALESCE(et.is_display_edition, 0) as is_display_override,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(ge.game_id, ge.id * -1)
                 ORDER BY COALESCE(et.is_display_edition, 0) DESC, COALESCE(et.tier, 0) DESC, l.priority ASC
               ) as rn
        FROM game_editions ge
        JOIN launchers l ON l.id = ge.launcher_id
        LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
        WHERE ge.parent_edition_id IS NULL AND ge.title NOT LIKE '%Demo%' AND ge.title NOT LIKE '%Beta%' AND ge.title NOT LIKE '% Test' AND ge.title NOT LIKE '%Test %' ${innerWhere}
      )
      SELECT r.id as edition_id, r.launcher_game_id, r.playtime_minutes as r_playtime,
             r.owned, r.edition_title as r_title,
             r.edition_tier as display_tier, r.edition_title as display_edition_title,
             r.launcher_name, r.launcher_display_name,
             g.id, g.title, g.slug, g.cover_url, g.icon_url, g.description,
             g.release_year, g.developer, g.publisher
      FROM ranked r
      LEFT JOIN games g ON g.id = r.game_id
      WHERE r.rn = 1 ${outerWhere} ${searchWhereDedup} ${startsWithDedup}
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
                 ORDER BY COALESCE(et.is_display_edition, 0) DESC, COALESCE(et.tier, 0) DESC, l.priority ASC
               ) as rn
        FROM game_editions ge
        JOIN launchers l ON l.id = ge.launcher_id
        LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
        WHERE ge.parent_edition_id IS NULL AND ge.title NOT LIKE '%Demo%' AND ge.title NOT LIKE '%Beta%' AND ge.title NOT LIKE '% Test' AND ge.title NOT LIKE '%Test %' ${innerWhere}
      )
      SELECT COUNT(*) as total
      FROM ranked r
      LEFT JOIN games g ON g.id = r.game_id
      WHERE r.rn = 1 ${outerWhere} ${searchWhereDedup} ${startsWithDedup}
    `;
    countParams = [...innerParams, ...outerParams, ...searchParams, ...startsWithParams];
    allParams = [...innerParams, ...outerParams, ...searchParams, ...startsWithParams, limitNum, offset];
  }

  const total = db.prepare(countQuery).get(...countParams)?.total || 0;
  const rows = db.prepare(query).all(...allParams);

  // Build platforms, genres, tags for each game
  const platformsStmt = db.prepare(`
    SELECT DISTINCT l.name as launcher_name, l.display_name as launcher_display_name
    FROM game_editions ge
    JOIN launchers l ON l.id = ge.launcher_id
    WHERE ge.game_id = ? AND ge.owned = 1 AND ge.parent_edition_id IS NULL
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

  const dlcCountStmt = db.prepare(
    'SELECT COUNT(*) as c FROM game_editions WHERE game_id = ? AND parent_edition_id IS NOT NULL AND owned = 1'
  );

  const games = rows.map(row => {
    const gameId = row.id;
    const platformsList = gameId ? platformsStmt.all(gameId) : [];
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
      display_edition_title: row.display_edition_title || row.r_title,
      display_tier: row.display_tier || 0,
      platforms: platformsList.length > 0 ? platformsList : [{
        launcher_name: row.launcher_name,
        launcher_display_name: row.launcher_display_name,
      }],
      dlc_count: gameId ? (dlcCountStmt.get(gameId)?.c || 0) : 0,
    };
  });

  res.json({ games, total, page: pageNum, limit: limitNum });
});

module.exports = router;
