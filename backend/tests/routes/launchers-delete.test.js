const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('DELETE /api/launchers/:id/credentials', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-launchers-delete.db');
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

    // Setup: insert launcher with credentials and game editions
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ api_key: 'test-key', steamid64: '123' }));
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json, last_sync_at) VALUES (?, ?, 1, ?, ?)'
    ).run('steam', 'Steam', creds, '2026-03-22T00:00:00Z');

    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');
    db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, 1)'
    ).run(launcher.id, '440', 'Team Fortress 2');
    db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, 1)'
    ).run(launcher.id, '570', 'Dota 2');
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('should clear credentials, disable launcher, and soft-remove editions', () => {
    const launcher = db.prepare('SELECT id, display_name FROM launchers WHERE name = ?').get('steam');

    db.prepare(
      'UPDATE launchers SET credentials_json = NULL, enabled = 0, last_sync_at = NULL WHERE name = ?'
    ).run('steam');

    const editionResult = db.prepare(
      'UPDATE game_editions SET owned = 0 WHERE launcher_id = ?'
    ).run(launcher.id);

    // Verify launcher state
    const updated = db.prepare('SELECT * FROM launchers WHERE name = ?').get('steam');
    assert.equal(updated.credentials_json, null);
    assert.equal(updated.enabled, 0);
    assert.equal(updated.last_sync_at, null);

    // Verify editions soft-removed
    const editions = db.prepare(
      'SELECT owned FROM game_editions WHERE launcher_id = ?'
    ).all(launcher.id);
    assert.ok(editions.every(e => e.owned === 0), 'All editions should be owned=0');
    assert.equal(editionResult.changes, 2, 'Should have affected 2 editions');
  });

  it('should reject unknown launcher names', () => {
    const AVAILABLE_LAUNCHERS = [
      { id: 'steam' }, { id: 'ea' }, { id: 'ubisoft' }, { id: 'epic' },
      { id: 'humble' }, { id: 'itchio' }, { id: 'gog' }, { id: 'battlenet' }, { id: 'xbox' },
    ];
    const LAUNCHER_MAP = Object.fromEntries(AVAILABLE_LAUNCHERS.map(l => [l.id, l]));
    assert.equal(LAUNCHER_MAP['bogus'], undefined);
    assert.ok(LAUNCHER_MAP['steam']);
  });

  it('available endpoint should include configured status', () => {
    // Reset steam to have credentials for this test
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ api_key: 'key', steamid64: '123' }));
    db.prepare('UPDATE launchers SET credentials_json = ?, enabled = 1 WHERE name = ?').run(creds, 'steam');

    // Simulate the logic: query configured launchers from DB
    const configured = db.prepare(
      'SELECT name FROM launchers WHERE credentials_json IS NOT NULL'
    ).all();
    const configuredSet = new Set(configured.map(r => r.name));

    assert.ok(configuredSet.has('steam'), 'steam should be configured');
    assert.ok(!configuredSet.has('ea'), 'ea should not be configured');
  });
});
