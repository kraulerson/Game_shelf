const igdbClient = require('./igdbClient');
const steamgriddbClient = require('./steamgriddbClient');
const { normalize, simplifyTitle, slugify, findBestMatch } = require('./titleMatcher');
const { cacheImage } = require('./imageCache');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Try SteamGridDB for images: by Steam App ID first, then by title search
async function getSteamGridDBImages(title, launcherName, launcherGameId) {
  // Try direct Steam App ID lookup first (most reliable)
  if (launcherName === 'steam' && launcherGameId) {
    const directImages = await steamgriddbClient.getImagesBySteamAppId(launcherGameId);
    if (directImages?.coverUrl || directImages?.heroUrl) {
      console.log(`[SteamGridDB] Matched by Steam App ID: ${launcherGameId} (${title})`);
      return directImages;
    }
  }

  // Fall back to title search
  const sgdbResults = await steamgriddbClient.searchGame(title);
  const sgdbMatch = sgdbResults ? findBestMatch(title, sgdbResults) : null;
  if (sgdbMatch) {
    console.log(`[SteamGridDB] Matched by title search: ${title}`);
    return steamgriddbClient.getImages(sgdbMatch.id);
  }

  return { coverUrl: null, heroUrl: null };
}

// Steam CDN direct image URLs — always available for Steam games, no API key needed
function getSteamCDNImages(launcherName, launcherGameId) {
  if (launcherName !== 'steam' || !launcherGameId) return null;
  return {
    coverUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${launcherGameId}/library_600x900_2x.jpg`,
    heroUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${launcherGameId}/library_hero.jpg`,
  };
}

// Get best available images: IGDB → SteamGridDB → Steam CDN
async function getBestImages(igdbMatch, title, launcherName, launcherGameId) {
  let coverUrl = igdbMatch?.cover?.url || null;
  let artworkUrl = igdbMatch?.artworks?.[0]?.url || null;

  // SteamGridDB fallback
  if (!coverUrl || !artworkUrl) {
    try {
      const sgdbImages = await getSteamGridDBImages(title, launcherName, launcherGameId);
      if (!coverUrl && sgdbImages?.coverUrl) coverUrl = sgdbImages.coverUrl;
      if (!artworkUrl && sgdbImages?.heroUrl) artworkUrl = sgdbImages.heroUrl;
    } catch (err) {
      console.warn(`[Gameshelf Metadata] SteamGridDB fallback failed for ${title}: ${err.message}`);
    }
  }

  // Steam CDN fallback (always works for Steam games)
  if (!coverUrl || !artworkUrl) {
    const cdnImages = getSteamCDNImages(launcherName, launcherGameId);
    if (cdnImages) {
      if (!coverUrl) { coverUrl = cdnImages.coverUrl; console.log(`[Steam CDN] Using cover for ${title}`); }
      if (!artworkUrl) { artworkUrl = cdnImages.heroUrl; console.log(`[Steam CDN] Using hero for ${title}`); }
    }
  }

  return { coverUrl, artworkUrl };
}

// Download and cache cover + hero images for a game
async function cacheGameImages(coverUrl, artworkUrl, gameId, title, db) {
  try {
    if (coverUrl) {
      const coverPath = await cacheImage(coverUrl, gameId, 'cover');
      if (coverPath) {
        db.prepare('UPDATE games SET cover_url = ? WHERE id = ?').run(coverPath, gameId);
        const iconPath = await cacheImage(coverUrl, gameId, 'icon');
        if (iconPath) db.prepare('UPDATE games SET icon_url = ? WHERE id = ?').run(iconPath, gameId);
      }
    }
  } catch (err) {
    console.warn(`[Gameshelf Metadata] Cover download failed for ${title}: ${err.message}`);
  }

  try {
    if (artworkUrl) {
      const heroPath = await cacheImage(artworkUrl, gameId, 'hero');
      if (heroPath) db.prepare('UPDATE games SET hero_url = ? WHERE id = ?').run(heroPath, gameId);
    }
  } catch (err) {
    console.warn(`[Gameshelf Metadata] Hero download failed for ${title}: ${err.message}`);
  }
}

async function enrichGame(gameEditionId, db) {
  const edition = db.prepare(`
    SELECT ge.*, l.name as launcher_name
    FROM game_editions ge
    JOIN launchers l ON l.id = ge.launcher_id
    WHERE ge.id = ?
  `).get(gameEditionId);
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

  // Search IGDB: external ID → full title → simplified title
  let match = await igdbClient.getByExternalId(edition.launcher_name, edition.launcher_game_id);
  if (match) {
    console.log(`[Gameshelf Metadata] IGDB matched by external ID: ${title}`);
  } else {
    const igdbResults = await igdbClient.search(normalizedTitle);
    match = igdbResults ? findBestMatch(title, igdbResults) : null;
    // Fallback: try simplified title (strip subtitle/edition)
    if (!match) {
      const simplified = simplifyTitle(title);
      if (simplified !== title) {
        const fallbackResults = await igdbClient.search(normalize(simplified));
        match = fallbackResults ? findBestMatch(simplified, fallbackResults) : null;
        if (match) console.log(`[Gameshelf Metadata] IGDB matched by simplified title: ${title} → ${simplified}`);
      }
    }
  }

  if (!match) {
    console.log(`[Gameshelf Metadata] No IGDB match for: ${title}`);

    // Cross-launcher: check if another launcher already has this game enriched
    const crossMatch = db.prepare(`
      SELECT g.id, g.title, g.slug FROM games g
      WHERE g.description IS NOT NULL
        AND (g.slug LIKE ? || '%' OR ? LIKE g.slug || '%')
      ORDER BY length(g.slug) DESC LIMIT 5
    `).all(slug, slug);

    // Verify prefix match on word boundary
    const validCross = crossMatch.find(g => {
      const shorter = slug.length <= g.slug.length ? slug : g.slug;
      const longer = slug.length <= g.slug.length ? g.slug : slug;
      return longer.startsWith(shorter) && (longer.length === shorter.length || longer[shorter.length] === '-');
    });

    if (validCross) {
      console.log(`[Gameshelf Metadata] Cross-launcher match: "${title}" → existing "${validCross.title}"`);
      db.prepare('UPDATE game_editions SET game_id = ? WHERE id = ?').run(validCross.id, gameEditionId);
      return { status: 'cross-launcher', gameId: validCross.id };
    }

    // Create minimal games row
    db.prepare(`
      INSERT INTO games (title, slug) VALUES (?, ?)
      ON CONFLICT(slug) DO UPDATE SET updated_at = datetime('now')
    `).run(title, slug);

    const game = db.prepare('SELECT id FROM games WHERE slug = ?').get(slug);
    db.prepare('UPDATE game_editions SET game_id = ? WHERE id = ?').run(game.id, gameEditionId);

    // Try SteamGridDB → Steam CDN for images (skip if manual cover set)
    const existingFlags = db.prepare('SELECT manual_cover FROM games WHERE id = ?').get(game.id);
    if (!existingFlags?.manual_cover) {
      const { coverUrl, artworkUrl } = await getBestImages(null, title, edition.launcher_name, edition.launcher_game_id);
      await cacheGameImages(coverUrl, artworkUrl, game.id, title, db);
    }

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

  // Upsert games row (respect manual override flags)
  db.prepare(`
    INSERT INTO games (title, slug, description, release_year, developer, publisher, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      title = CASE WHEN games.manual_title = 1 THEN games.title ELSE excluded.title END,
      slug = CASE WHEN games.manual_title = 1 THEN games.slug ELSE excluded.slug END,
      description = CASE WHEN games.manual_description = 1 THEN games.description ELSE excluded.description END,
      release_year = excluded.release_year,
      developer = excluded.developer,
      publisher = excluded.publisher,
      updated_at = datetime('now')
  `).run(gameTitle, gameSlug, description, releaseYear, developer, publisher);

  const game = db.prepare('SELECT id FROM games WHERE slug = ?').get(gameSlug);
  const gameId = game.id;

  // Download and cache images: IGDB → SteamGridDB → Steam CDN (skip if manual cover)
  const existingGame = db.prepare('SELECT manual_cover FROM games WHERE id = ?').get(gameId);
  if (!existingGame?.manual_cover) {
    const { coverUrl, artworkUrl } = await getBestImages(match, gameTitle, edition.launcher_name, edition.launcher_game_id);
    await cacheGameImages(coverUrl, artworkUrl, gameId, gameTitle, db);
  }

  // Clear stale genre/tag associations before re-inserting (preserve user-created tags)
  db.prepare('DELETE FROM game_genres WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_id IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)').run(gameId);

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

async function enrichUnderEnriched(db) {
  const underEnriched = db.prepare(`
    SELECT DISTINCT g.id, g.title, g.slug,
           ge.launcher_game_id, l.name as launcher_name,
           COALESCE(g.manual_description, 0) as manual_description,
           COALESCE(g.manual_cover, 0) as manual_cover
    FROM games g
    JOIN game_editions ge ON ge.game_id = g.id AND ge.owned = 1
    JOIN launchers l ON l.id = ge.launcher_id
    WHERE ((g.cover_url IS NULL AND COALESCE(g.manual_cover, 0) = 0)
        OR (g.description IS NULL AND COALESCE(g.manual_description, 0) = 0))
      AND (g.last_enrichment_at IS NULL
           OR g.last_enrichment_at < datetime('now', '-7 days'))
  `).all();

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (const game of underEnriched) {
    try {
      // Try IGDB: external ID → full title → simplified title
      let match = await igdbClient.getByExternalId(game.launcher_name, game.launcher_game_id);
      if (match) {
        console.log(`[Gameshelf Metadata] Re-enrich: IGDB matched by external ID: ${game.title}`);
      } else {
        const normalizedTitle = normalize(game.title);
        const igdbResults = await igdbClient.search(normalizedTitle);
        match = igdbResults ? findBestMatch(game.title, igdbResults) : null;
        // Fallback: try simplified title (strip subtitle/edition)
        if (!match) {
          const simplified = simplifyTitle(game.title);
          if (simplified !== game.title) {
            const fallbackResults = await igdbClient.search(normalize(simplified));
            match = fallbackResults ? findBestMatch(simplified, fallbackResults) : null;
            if (match) console.log(`[Gameshelf Metadata] Re-enrich: IGDB matched by simplified title: ${game.title} → ${simplified}`);
          }
        }
      }

      if (!match) {
        console.log(`[Gameshelf Metadata] Re-enrich: no IGDB match for: ${game.title}`);

        // Try SteamGridDB → Steam CDN for images (skip if manual cover set)
        if (!game.manual_cover) {
          const { coverUrl, artworkUrl } = await getBestImages(null, game.title, game.launcher_name, game.launcher_game_id);
          await cacheGameImages(coverUrl, artworkUrl, game.id, game.title, db);
        }

        db.prepare("UPDATE games SET last_enrichment_at = datetime('now') WHERE id = ?").run(game.id);
        skipped++;
        await sleep(500);
        continue;
      }

      const description = match.summary || null;
      const releaseYear = match.first_release_date
        ? new Date(match.first_release_date * 1000).getFullYear()
        : null;
      const companies = match.involved_companies || [];
      const developer = companies.find(c => c.developer)?.company?.name || null;
      const publisher = companies.find(c => c.publisher)?.company?.name || null;

      // Update game metadata + last_enrichment_at (respect manual override flags)
      db.prepare(`
        UPDATE games SET
          description = CASE WHEN manual_description = 1 THEN description ELSE COALESCE(?, description) END,
          release_year = COALESCE(?, release_year),
          developer = COALESCE(?, developer),
          publisher = COALESCE(?, publisher),
          last_enrichment_at = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(description, releaseYear, developer, publisher, game.id);

      // Download and cache images: IGDB → SteamGridDB → Steam CDN (skip if manual cover)
      if (!game.manual_cover) {
        const { coverUrl, artworkUrl } = await getBestImages(match, game.title, game.launcher_name, game.launcher_game_id);
        await cacheGameImages(coverUrl, artworkUrl, game.id, game.title, db);
      }

      // Update genres and tags (preserve user-created tags)
      db.prepare('DELETE FROM game_genres WHERE game_id = ?').run(game.id);
      db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_id IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)').run(game.id);

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
          insertGameGenre.run(game.id, genreRow.id);
          insertTag.run(genreName);
          const tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(genreName);
          insertGameTag.run(game.id, tagRow.id);
        }
      });
      upsertGenres(genres);

      enriched++;
      console.log(`[Gameshelf Metadata] Re-enriched: ${game.title}`);
    } catch (err) {
      console.error(`[Gameshelf Metadata] Re-enrich failed for "${game.title}": ${err.message}`);
      // Still mark last_enrichment_at to avoid infinite retries on crash-inducing games
      try {
        db.prepare("UPDATE games SET last_enrichment_at = datetime('now') WHERE id = ?").run(game.id);
      } catch (_) { /* ignore */ }
      failed++;
    }

    await sleep(500);
  }

  return { enriched, failed, skipped };
}

async function enrichAll(db) {
  const editions = db.prepare('SELECT id, title FROM game_editions WHERE game_id IS NULL AND parent_edition_id IS NULL').all();

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

    await sleep(500);
  }

  // Phase 2: retry under-enriched games
  const reEnrichResult = await enrichUnderEnriched(db);
  enriched += reEnrichResult.enriched;
  failed += reEnrichResult.failed;
  skipped += reEnrichResult.skipped;

  // Phase 3: clean up orphan game rows (no editions linked)
  const orphans = db.prepare(
    "DELETE FROM games WHERE id NOT IN " +
    "(SELECT DISTINCT game_id FROM game_editions WHERE game_id IS NOT NULL)"
  ).run();
  if (orphans.changes > 0) {
    console.log(`[Gameshelf Metadata] Cleaned up ${orphans.changes} orphan game rows`);
  }

  return { enriched, failed, skipped };
}

module.exports = { enrichGame, enrichAll, enrichUnderEnriched };
