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
});
