const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Phase 11 migration: edition_tiers', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-phase11.db');
  let db;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    db = runMigrations(testDbPath);
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('edition_tiers table should exist', () => {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='edition_tiers'"
    ).get();
    assert.ok(table);
  });

  it('edition_tiers should have correct columns', () => {
    const cols = db.pragma('table_info(edition_tiers)').map(c => c.name);
    assert.ok(cols.includes('game_edition_id'));
    assert.ok(cols.includes('tier'));
    assert.ok(cols.includes('is_display_edition'));
    assert.ok(!cols.includes('game_id'), 'Should NOT have game_id (denormalization avoided)');
  });

  it('should auto-detect tier from edition title', () => {
    db.prepare('INSERT OR IGNORE INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('steam', 'Steam');
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (?, ?, ?)').run(launcher.id, 'test-goty', 'Fallout NV GOTY');

    const ed = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('test-goty');

    const { detectEditionTier } = require('../../src/utils/editionTier');
    db.prepare('INSERT OR IGNORE INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)').run(ed.id, detectEditionTier('Fallout NV GOTY'));

    const tier = db.prepare('SELECT tier FROM edition_tiers WHERE game_edition_id = ?').get(ed.id);
    assert.equal(tier.tier, 4);
  });

  it('should consolidate duplicate games rows into one', () => {
    // Create two games with the same title (simulates cross-launcher enrichment bug)
    db.prepare('INSERT INTO games (title, slug, description) VALUES (?, ?, ?)').run('Satisfactory', 'satisfactory-steam', 'A factory building game');
    db.prepare('INSERT INTO games (title, slug) VALUES (?, ?)').run('Satisfactory', 'satisfactory-epic');

    const game1 = db.prepare("SELECT id FROM games WHERE slug = 'satisfactory-steam'").get();
    const game2 = db.prepare("SELECT id FROM games WHERE slug = 'satisfactory-epic'").get();

    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title, game_id) VALUES (?, ?, ?, ?)').run(launcher.id, 'sat-steam', 'Satisfactory', game1.id);
    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title, game_id) VALUES (?, ?, ?, ?)').run(launcher.id, 'sat-epic', 'Satisfactory', game2.id);

    // Run consolidation (same logic as migration 11b)
    const dupeGroups = db.prepare("SELECT title, COUNT(*) as c FROM games GROUP BY title HAVING c > 1").all();
    const consolidate = db.transaction(() => {
      for (const { title } of dupeGroups) {
        const candidates = db.prepare(`
          SELECT id, CASE WHEN description IS NOT NULL THEN 1 ELSE 0 END as has_desc,
            CASE WHEN cover_url IS NOT NULL THEN 1 ELSE 0 END as has_cover
          FROM games WHERE title = ? ORDER BY has_desc DESC, has_cover DESC, id ASC
        `).all(title);
        const canonical = candidates[0];
        for (const dupe of candidates.slice(1)) {
          db.prepare('UPDATE game_editions SET game_id = ? WHERE game_id = ?').run(canonical.id, dupe.id);
          db.prepare('DELETE FROM games WHERE id = ?').run(dupe.id);
        }
      }
    });
    consolidate();

    // REGRESSION: duplicate games must be merged
    const remaining = db.prepare("SELECT COUNT(*) as c FROM games WHERE title = 'Satisfactory'").get();
    assert.equal(remaining.c, 1, 'Should have exactly one Satisfactory game');

    // Both editions should point to the canonical game (the one with description)
    const editions = db.prepare("SELECT game_id FROM game_editions WHERE launcher_game_id IN ('sat-steam', 'sat-epic')").all();
    assert.equal(editions[0].game_id, editions[1].game_id, 'Both editions should share the same game_id');
    assert.equal(editions[0].game_id, game1.id, 'Should keep the game with description');
  });
});
