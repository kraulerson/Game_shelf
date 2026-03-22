const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Phase 3 migration', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-migrate-p3.db');
  let db;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt-secret';
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

  it('game_editions.game_id should be nullable', () => {
    const cols = db.pragma('table_info(game_editions)');
    const gameIdCol = cols.find(c => c.name === 'game_id');
    assert.ok(gameIdCol, 'game_id column should exist');
    assert.equal(gameIdCol.notnull, 0, 'game_id should be nullable');
  });

  it('game_editions should have a title column', () => {
    const cols = db.pragma('table_info(game_editions)');
    const titleCol = cols.find(c => c.name === 'title');
    assert.ok(titleCol, 'title column should exist');
  });

  it('should have unique index on (launcher_id, launcher_game_id)', () => {
    const indexes = db.pragma('index_list(game_editions)');
    const idx = indexes.find(i => i.name === 'idx_game_editions_launcher_game');
    assert.ok(idx, 'idx_game_editions_launcher_game should exist');
    assert.equal(idx.unique, 1, 'index should be unique');
  });

  it('should NOT have the old UNIQUE(game_id, launcher_id) constraint', () => {
    const indexes = db.pragma('index_list(game_editions)');
    const autoIdx = indexes.find(i => i.name.includes('autoindex'));
    assert.equal(autoIdx, undefined, 'Should not have autoindex from old UNIQUE constraint');
  });

  it('sync_jobs should have games_found and games_updated columns', () => {
    const cols = db.pragma('table_info(sync_jobs)');
    const gamesFound = cols.find(c => c.name === 'games_found');
    const gamesUpdated = cols.find(c => c.name === 'games_updated');
    assert.ok(gamesFound, 'games_found column should exist');
    assert.ok(gamesUpdated, 'games_updated column should exist');
  });

  it('should allow inserting game_editions with null game_id', () => {
    db.prepare('INSERT OR IGNORE INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('test_launcher', 'Test');
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('test_launcher');

    db.prepare(
      'INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title) VALUES (NULL, ?, ?, ?)'
    ).run(launcher.id, 'test_game_1', 'Test Game');

    const row = db.prepare('SELECT * FROM game_editions WHERE launcher_game_id = ?').get('test_game_1');
    assert.equal(row.game_id, null);
    assert.equal(row.title, 'Test Game');
  });
});
