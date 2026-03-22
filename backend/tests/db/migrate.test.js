const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

describe('migration runner', () => {
  const testDbPath = path.join(__dirname, '..', '..', 'data', 'test-migrate.db');

  before(() => {
    const dir = path.dirname(testDbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('should create all tables', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name);

    assert.deepEqual(tables, [
      'game_editions', 'game_genres', 'game_tags',
      'games', 'genres', 'launchers',
      'settings', 'sync_jobs', 'tags', 'users'
    ]);

    db.close();
  });

  it('should enable WAL mode', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const mode = db.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');

    db.close();
  });

  it('should enable foreign keys', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const fk = db.pragma('foreign_keys', { simple: true });
    assert.equal(fk, 1);

    db.close();
  });

  it('should seed default admin user', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const user = db.prepare('SELECT username FROM users').get();
    assert.equal(user.username, 'admin');

    db.close();
  });

  it('should not duplicate admin user on re-run', () => {
    const { runMigrations } = require('../../src/db/migrate');

    let db = runMigrations(testDbPath);
    db.close();
    db = runMigrations(testDbPath);

    const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
    assert.equal(count.c, 1);

    db.close();
  });

  it('should hash the admin password with bcrypt', () => {
    const { runMigrations } = require('../../src/db/migrate');
    const db = runMigrations(testDbPath);

    const user = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
    assert.ok(user.password_hash.startsWith('$2'), 'password should be bcrypt hashed');

    db.close();
  });

  it('should be idempotent — running multiple times does not error', () => {
    const { runMigrations } = require('../../src/db/migrate');

    assert.doesNotThrow(() => {
      const db1 = runMigrations(testDbPath);
      db1.close();
      const db2 = runMigrations(testDbPath);
      db2.close();
      const db3 = runMigrations(testDbPath);
      db3.close();
    });
  });
});
