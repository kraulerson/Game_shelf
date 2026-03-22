const igdbClient = require('./igdbClient');
const { normalize, slugify, findBestMatch } = require('./titleMatcher');
const { cacheImage } = require('./imageCache');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enrichGame(gameEditionId, db) {
  const edition = db.prepare('SELECT * FROM game_editions WHERE id = ?').get(gameEditionId);
  if (!edition) {
    throw new Error(`game_edition not found: ${gameEditionId}`);
  }

  const title = edition.title;
  if (!title) {
    console.warn(`[Gameshelf Metadata] game_edition ${gameEditionId} has no title, skipping`);
    return { status: 'skipped', reason: 'no title' };
  }

  const normalizedTitle = normalize(title);
  const slug = slugify(title);

  // Search IGDB
  const igdbResults = await igdbClient.search(normalizedTitle);
  const match = igdbResults ? findBestMatch(title, igdbResults) : null;

  // TODO: RAWG.io fallback would slot in here if match is null
  // e.g., if (!match) match = await rawgClient.search(normalizedTitle);

  if (!match) {
    console.log(`[Gameshelf Metadata] No IGDB match for: ${title}`);
    // Create minimal games row
    db.prepare(`
      INSERT INTO games (title, slug) VALUES (?, ?)
      ON CONFLICT(slug) DO UPDATE SET updated_at = datetime('now')
    `).run(title, slug);

    const game = db.prepare('SELECT id FROM games WHERE slug = ?').get(slug);
    db.prepare('UPDATE game_editions SET game_id = ? WHERE id = ?').run(game.id, gameEditionId);

    return { status: 'minimal', gameId: game.id };
  }

  // Extract metadata from IGDB match
  const gameTitle = match.name || title;
  const gameSlug = slugify(gameTitle);
  const description = match.summary || null;
  const releaseYear = match.first_release_date
    ? new Date(match.first_release_date * 1000).getFullYear()
    : null;

  // Extract developer and publisher from involved_companies
  const companies = match.involved_companies || [];
  const developer = companies.find(c => c.developer)?.company?.name || null;
  const publisher = companies.find(c => c.publisher)?.company?.name || null;

  // Upsert games row
  db.prepare(`
    INSERT INTO games (title, slug, description, release_year, developer, publisher, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      release_year = excluded.release_year,
      developer = excluded.developer,
      publisher = excluded.publisher,
      updated_at = datetime('now')
  `).run(gameTitle, gameSlug, description, releaseYear, developer, publisher);

  const game = db.prepare('SELECT id FROM games WHERE slug = ?').get(gameSlug);
  const gameId = game.id;

  // Download and cache images (only if URLs exist)
  try {
    const coverUrl = match.cover?.url || null;
    const artworkUrl = match.artworks?.[0]?.url || null;

    if (coverUrl) {
      const coverPath = await cacheImage(coverUrl, gameId, 'cover');
      if (coverPath) {
        db.prepare('UPDATE games SET cover_url = ? WHERE id = ?').run(coverPath, gameId);
        // Copy cover as icon
        const iconPath = await cacheImage(coverUrl, gameId, 'icon');
        if (iconPath) {
          db.prepare('UPDATE games SET icon_url = ? WHERE id = ?').run(iconPath, gameId);
        }
      }
    }

    if (artworkUrl) {
      const heroPath = await cacheImage(artworkUrl, gameId, 'hero');
      if (heroPath) {
        db.prepare('UPDATE games SET hero_url = ? WHERE id = ?').run(heroPath, gameId);
      }
    }
  } catch (err) {
    console.warn(`[Gameshelf Metadata] Image download failed for ${gameTitle}: ${err.message}`);
  }

  // Clear stale genre/tag associations before re-inserting
  db.prepare('DELETE FROM game_genres WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(gameId);

  // Upsert genres and mirror as tags
  const genres = match.genres || [];
  const insertGenre = db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)');
  const insertGameGenre = db.prepare('INSERT OR IGNORE INTO game_genres (game_id, genre_id) VALUES (?, ?)');
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const insertGameTag = db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)');

  const upsertGenres = db.transaction((genreList) => {
    for (const genre of genreList) {
      const genreName = genre.name || genre;
      if (!genreName) continue;

      insertGenre.run(genreName);
      const genreRow = db.prepare('SELECT id FROM genres WHERE name = ?').get(genreName);
      insertGameGenre.run(gameId, genreRow.id);

      // Mirror as tag
      insertTag.run(genreName);
      const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(genreName);
      insertGameTag.run(gameId, tagRow.id);
    }
  });
  upsertGenres(genres);

  // Link game_edition to games row
  db.prepare('UPDATE game_editions SET game_id = ? WHERE id = ?').run(gameId, gameEditionId);

  return { status: 'enriched', gameId };
}

async function enrichAll(db) {
  const editions = db.prepare('SELECT id, title FROM game_editions WHERE game_id IS NULL').all();

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (const edition of editions) {
    try {
      const result = await enrichGame(edition.id, db);
      if (result.status === 'enriched' || result.status === 'minimal') enriched++;
      else skipped++;
    } catch (err) {
      console.error(`[Gameshelf Metadata] Failed to enrich "${edition.title}": ${err.message}`);
      failed++;
    }

    // 500ms delay between calls to avoid rate limiting
    await sleep(500);
  }

  return { enriched, failed, skipped };
}

module.exports = { enrichGame, enrichAll };
