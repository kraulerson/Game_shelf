const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Phase 6 migration: last_enrichment_at column', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-migrate-phase6.db');
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

  it('games table should have last_enrichment_at column', () => {
    const cols = db.pragma('table_info(games)');
    const col = cols.find(c => c.name === 'last_enrichment_at');
    assert.ok(col, 'last_enrichment_at column should exist');
  });

  it('last_enrichment_at should default to NULL', () => {
    db.prepare("INSERT INTO games (title, slug) VALUES ('Test Game', 'test-game')").run();
    const game = db.prepare("SELECT last_enrichment_at FROM games WHERE slug = 'test-game'").get();
    assert.equal(game.last_enrichment_at, null);
    db.prepare("DELETE FROM games WHERE slug = 'test-game'").run();
  });
});
