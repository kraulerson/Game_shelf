const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Phase 12 migration', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-phase12.db');
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

  it('game_editions should have Phase 12 columns', () => {
    const cols = db.pragma('table_info(game_editions)').map(c => c.name);
    assert.ok(cols.includes('epic_namespace'));
    assert.ok(cols.includes('epic_catalog_id'));
    assert.ok(cols.includes('sandbox_type'));
    assert.ok(cols.includes('parent_edition_id'));
  });
});
