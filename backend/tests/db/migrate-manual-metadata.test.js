const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Manual metadata migration', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-manual-metadata-migrate.db');

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('should add manual_description and manual_cover columns to games', () => {
    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const cols = db.pragma('table_info(games)');
    const manualDesc = cols.find(c => c.name === 'manual_description');
    const manualCover = cols.find(c => c.name === 'manual_cover');

    assert.ok(manualDesc, 'manual_description column should exist');
    assert.equal(manualDesc.dflt_value, '0', 'manual_description should default to 0');
    assert.ok(manualCover, 'manual_cover column should exist');
    assert.equal(manualCover.dflt_value, '0', 'manual_cover should default to 0');

    db.close();
  });

  it('should be idempotent — running migrations twice should not error', () => {
    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const cols = db.pragma('table_info(games)');
    assert.ok(cols.find(c => c.name === 'manual_description'));
    assert.ok(cols.find(c => c.name === 'manual_cover'));

    db.close();
  });
});
