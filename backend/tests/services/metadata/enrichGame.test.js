const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Enrichment orchestrator', () => {
  const testDbPath = path.join(__dirname, '..', '..', 'data', 'test-enrich.db');
  let db;
  let enrichGame, enrichAll;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    // No IGDB credentials — tests exercise the no-match / fallback path

    delete require.cache[require.resolve('../../../src/db/migrate')];
    const { runMigrations } = require('../../../src/db/migrate');
    db = runMigrations(testDbPath);

    // Insert a launcher and game_edition with null game_id
    db.prepare('INSERT INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('steam', 'Steam');
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (?, ?, ?)'
    ).run(launcher.id, '440', 'Team Fortress 2');

    ({ enrichGame, enrichAll } = require('../../../src/services/metadata/enrichGame'));
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('enrichGame should create a minimal games row when IGDB is unavailable', async () => {
    const edition = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('440');

    await enrichGame(edition.id, db);

    const updated = db.prepare('SELECT game_id FROM game_editions WHERE id = ?').get(edition.id);
    assert.ok(updated.game_id, 'game_id should be set');

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(updated.game_id);
    assert.ok(game, 'games row should exist');
    assert.equal(game.title, 'Team Fortress 2');
    assert.ok(game.slug, 'slug should be set');
  });

  it('enrichAll should process unlinked editions', async () => {
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (?, ?, ?)'
    ).run(launcher.id, '570', 'Dota 2');

    const result = await enrichAll(db);
    assert.ok(result.enriched >= 0 || result.skipped >= 0, 'Should return counts');

    const edition = db.prepare('SELECT game_id FROM game_editions WHERE launcher_game_id = ?').get('570');
    assert.ok(edition.game_id, 'Dota 2 should have game_id');
  });

  it('enrichGame should handle already-linked editions gracefully', async () => {
    const edition = db.prepare('SELECT id, game_id FROM game_editions WHERE launcher_game_id = ?').get('440');
    const originalGameId = edition.game_id;

    await enrichGame(edition.id, db);

    const updated = db.prepare('SELECT game_id FROM game_editions WHERE id = ?').get(edition.id);
    assert.equal(updated.game_id, originalGameId, 'game_id should remain the same');
  });
});
