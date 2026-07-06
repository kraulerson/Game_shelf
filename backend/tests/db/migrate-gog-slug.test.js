const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('migrate: game_editions.gog_slug', () => {
  const dbPath = path.join(__dirname, '..', 'data', 'test-gog-slug-migrate.db');
  let db;
  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = dbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = dbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(dbPath);
  });
  after(() => {
    try { db.close(); } catch {}
    for (const s of ['', '-wal', '-shm']) { const f = dbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('adds gog_slug to game_editions', () => {
    const cols = db.pragma('table_info(game_editions)');
    assert.ok(cols.some((c) => c.name === 'gog_slug'), 'gog_slug column exists');
  });
});
