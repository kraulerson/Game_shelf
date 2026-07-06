const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('migrate: edition_tiers.is_prefill_edition', () => {
  const dbPath = path.join(__dirname, '..', 'data', 'test-prefill-migrate.db');
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

  it('adds is_prefill_edition to edition_tiers (default 0)', () => {
    const cols = db.prepare('PRAGMA table_info(edition_tiers)').all();
    const col = cols.find((c) => c.name === 'is_prefill_edition');
    assert.ok(col, 'is_prefill_edition column exists');
    assert.equal(col.dflt_value, '0');
  });
});
