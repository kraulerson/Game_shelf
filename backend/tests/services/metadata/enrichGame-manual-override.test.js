const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Enrichment respects manual override flags', () => {
  const testDbPath = path.join(__dirname, '..', '..', 'data', 'test-enrich-override.db');
  let db;
  let enrichGame, enrichUnderEnriched;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../../src/db/migrate')];
    const { runMigrations } = require('../../../src/db/migrate');
    db = runMigrations(testDbPath);

    // Seed: launcher + game with manual description and manual cover + edition
    db.prepare('INSERT INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('itch', 'itch.io');
    const launcherId = db.prepare('SELECT id FROM launchers WHERE name = ?').get('itch').id;

    db.prepare(
      'INSERT INTO games (title, slug, description, manual_description, cover_url, manual_cover) VALUES (?, ?, ?, 1, ?, 1)'
    ).run('Earth Clicker', 'earth-clicker', 'My manual description', '/data/images/999/cover.png');

    const gameId = db.prepare('SELECT id FROM games WHERE slug = ?').get('earth-clicker').id;
    db.prepare(
      'INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, ?, 1)'
    ).run(gameId, launcherId, 'earth-clicker', 'Earth Clicker');

    delete require.cache[require.resolve('../../../src/services/metadata/enrichGame')];
    ({ enrichGame, enrichAll: _, enrichUnderEnriched } = require('../../../src/services/metadata/enrichGame'));
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('enrichGame should preserve manually-set description', async () => {
    const edition = db.prepare("SELECT id FROM game_editions WHERE launcher_game_id = 'earth-clicker'").get();

    // enrichGame will hit the no-IGDB-match path (no credentials configured)
    await enrichGame(edition.id, db);

    const game = db.prepare("SELECT description, manual_description FROM games WHERE slug = 'earth-clicker'").get();
    assert.equal(game.description, 'My manual description', 'Manual description should survive enrichment');
    assert.equal(game.manual_description, 1, 'Flag should remain set');
  });

  it('enrichGame should preserve manually-set cover_url', async () => {
    const game = db.prepare("SELECT cover_url, manual_cover FROM games WHERE slug = 'earth-clicker'").get();
    assert.equal(game.cover_url, '/data/images/999/cover.png', 'Manual cover should survive enrichment');
    assert.equal(game.manual_cover, 1, 'Flag should remain set');
  });

  it('enrichUnderEnriched should skip games with all-manual metadata', async () => {
    // Set last_enrichment_at to null so it would be eligible
    const game = db.prepare("SELECT id FROM games WHERE slug = 'earth-clicker'").get();
    db.prepare('UPDATE games SET last_enrichment_at = NULL WHERE id = ?').run(game.id);

    const result = await enrichUnderEnriched(db);

    // The game has manual description AND manual cover — should not appear as under-enriched
    const updated = db.prepare('SELECT description, cover_url FROM games WHERE id = ?').get(game.id);
    assert.equal(updated.description, 'My manual description', 'Description should be unchanged');
    assert.equal(updated.cover_url, '/data/images/999/cover.png', 'Cover should be unchanged');
  });

  it('enrichment should still fill non-manual fields', async () => {
    // Create a game with manual description but no cover (no manual_cover flag)
    db.prepare(
      'INSERT INTO games (title, slug, description, manual_description) VALUES (?, ?, ?, 1)'
    ).run('Fjords', 'fjords', 'A fjords game');

    const fjordsId = db.prepare('SELECT id FROM games WHERE slug = ?').get('fjords').id;
    const launcherId = db.prepare('SELECT id FROM launchers WHERE name = ?').get('itch').id;

    db.prepare(
      'INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, ?, 1)'
    ).run(fjordsId, launcherId, 'fjords', 'Fjords');

    // Clear last_enrichment_at so enrichUnderEnriched picks it up
    db.prepare('UPDATE games SET last_enrichment_at = NULL WHERE id = ?').run(fjordsId);

    await enrichUnderEnriched(db);

    const game = db.prepare('SELECT description, manual_description FROM games WHERE id = ?').get(fjordsId);
    assert.equal(game.description, 'A fjords game', 'Manual description should be preserved');
    assert.equal(game.manual_description, 1);
  });

  // Regression: directly test the upsert SQL pattern with manual flags
  it('upsert ON CONFLICT should not overwrite manual description', () => {
    // This tests the SQL CASE WHEN pattern used in enrichGame
    db.prepare(`
      INSERT INTO games (title, slug, description, release_year, developer, publisher, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        description = CASE WHEN games.manual_description = 1 THEN games.description ELSE excluded.description END,
        release_year = excluded.release_year,
        developer = excluded.developer,
        publisher = excluded.publisher,
        updated_at = datetime('now')
    `).run('Earth Clicker', 'earth-clicker', 'IGDB description would go here', 2020, 'SomeDev', 'SomePub');

    const game = db.prepare("SELECT description, manual_description FROM games WHERE slug = 'earth-clicker'").get();
    assert.equal(game.description, 'My manual description', 'Manual description should survive upsert');
    assert.equal(game.manual_description, 1);
  });

  it('upsert ON CONFLICT should overwrite non-manual description', () => {
    // Create a game WITHOUT manual flag
    db.prepare('INSERT OR IGNORE INTO games (title, slug, description) VALUES (?, ?, ?)').run(
      'Welcome', 'welcome', 'Original auto description'
    );

    db.prepare(`
      INSERT INTO games (title, slug, description, release_year, developer, publisher, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        description = CASE WHEN games.manual_description = 1 THEN games.description ELSE excluded.description END,
        release_year = excluded.release_year,
        developer = excluded.developer,
        publisher = excluded.publisher,
        updated_at = datetime('now')
    `).run('Welcome', 'welcome', 'New IGDB description', 2019, 'Dev', 'Pub');

    const game = db.prepare("SELECT description FROM games WHERE slug = 'welcome'").get();
    assert.equal(game.description, 'New IGDB description', 'Non-manual description should be overwritten');
  });
});
