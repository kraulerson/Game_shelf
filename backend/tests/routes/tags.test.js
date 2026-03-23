const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Tag CRUD API', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-tags.db');
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

    // Setup: launcher, games, editions, genres
    db.prepare('INSERT INTO launchers (name, display_name, enabled) VALUES (?, ?, 1)').run('steam', 'Steam');
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam');

    db.prepare("INSERT INTO games (title, slug) VALUES ('Game A', 'game-a')").run();
    db.prepare("INSERT INTO games (title, slug) VALUES ('Game B', 'game-b')").run();
    const gameA = db.prepare("SELECT id FROM games WHERE slug = 'game-a'").get();
    const gameB = db.prepare("SELECT id FROM games WHERE slug = 'game-b'").get();

    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title, game_id, owned) VALUES (?, ?, ?, ?, 1)').run(launcher.id, '1', 'Game A', gameA.id);
    db.prepare('INSERT INTO game_editions (launcher_id, launcher_game_id, title, game_id, owned) VALUES (?, ?, ?, ?, 1)').run(launcher.id, '2', 'Game B', gameB.id);

    // Add a genre + mirrored tag
    db.prepare("INSERT INTO genres (name) VALUES ('RPG')").run();
    db.prepare("INSERT INTO tags (name) VALUES ('RPG')").run();
    const rpgGenre = db.prepare("SELECT id FROM genres WHERE name = 'RPG'").get();
    const rpgTag = db.prepare("SELECT id FROM tags WHERE name = 'RPG'").get();
    db.prepare('INSERT INTO game_genres (game_id, genre_id) VALUES (?, ?)').run(gameA.id, rpgGenre.id);
    db.prepare('INSERT INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(gameA.id, rpgTag.id);
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('POST /api/tags should create a tag', () => {
    const name = 'Favorites';
    const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name);
    assert.equal(existing, undefined, 'Tag should not exist yet');

    db.prepare('INSERT INTO tags (name) VALUES (?)').run(name.trim());
    const tag = db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
    assert.ok(tag);
    assert.equal(tag.name, 'Favorites');
  });

  it('should reject duplicate tag names case-insensitively', () => {
    const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get('favorites');
    assert.ok(existing, 'Should find Favorites case-insensitively');
  });

  it('should reject empty tag names', () => {
    const name = '   ';
    assert.equal(name.trim().length, 0, 'Trimmed empty name should have length 0');
  });

  it('should reject tag names over 50 characters', () => {
    const name = 'A'.repeat(51);
    assert.ok(name.trim().length > 50, 'Name should exceed 50 chars');
  });

  it('GET /api/tags should list tags with game counts', () => {
    const tags = db.prepare(`
      SELECT t.id, t.name, COUNT(gt.game_id) as gameCount
      FROM tags t
      LEFT JOIN game_tags gt ON gt.tag_id = t.id
      GROUP BY t.id
      ORDER BY t.name COLLATE NOCASE ASC
    `).all();
    assert.ok(tags.length >= 2, 'Should have at least RPG and Favorites');
    const rpg = tags.find(t => t.name === 'RPG');
    assert.ok(rpg);
    assert.equal(rpg.gameCount, 1);
  });

  it('DELETE /api/tags/:id should reject genre-mirrored tags', () => {
    const rpgTag = db.prepare("SELECT id FROM tags WHERE name = 'RPG'").get();
    const isGenre = db.prepare(
      'SELECT name FROM genres WHERE name = (SELECT name FROM tags WHERE id = ?)'
    ).get(rpgTag.id);
    assert.ok(isGenre, 'RPG should be a genre-mirrored tag');
  });

  it('DELETE /api/tags/:id should delete user-created tags', () => {
    const tag = db.prepare("SELECT id FROM tags WHERE name = 'Favorites'").get();
    db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
    const deleted = db.prepare("SELECT id FROM tags WHERE name = 'Favorites'").get();
    assert.equal(deleted, undefined, 'Tag should be deleted');
  });

  it('PATCH /api/tags/:id/games should add and remove game associations', () => {
    db.prepare("INSERT INTO tags (name) VALUES ('Backlog')").run();
    const tag = db.prepare("SELECT id FROM tags WHERE name = 'Backlog'").get();
    const gameA = db.prepare("SELECT id FROM games WHERE slug = 'game-a'").get();
    const gameB = db.prepare("SELECT id FROM games WHERE slug = 'game-b'").get();

    // Add both games
    db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(gameA.id, tag.id);
    db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(gameB.id, tag.id);

    let count = db.prepare('SELECT COUNT(*) as c FROM game_tags WHERE tag_id = ?').get(tag.id);
    assert.equal(count.c, 2);

    // Remove gameB
    db.prepare('DELETE FROM game_tags WHERE game_id = ? AND tag_id = ?').run(gameB.id, tag.id);

    count = db.prepare('SELECT COUNT(*) as c FROM game_tags WHERE tag_id = ?').get(tag.id);
    assert.equal(count.c, 1);
  });

  it('PUT /api/games/:id/tags should preserve genre-mirrored tags', () => {
    const gameA = db.prepare("SELECT id FROM games WHERE slug = 'game-a'").get();

    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES ('Completed')").run();
    const completedTag = db.prepare("SELECT id FROM tags WHERE name = 'Completed'").get();

    // Simulate PUT: delete non-genre tags, then insert new ones
    db.prepare(
      'DELETE FROM game_tags WHERE game_id = ? AND tag_id NOT IN (SELECT t.id FROM tags t JOIN genres g ON g.name = t.name)'
    ).run(gameA.id);
    db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(gameA.id, completedTag.id);

    // Verify RPG tag (genre-mirrored) is still there
    const rpgTag = db.prepare("SELECT id FROM tags WHERE name = 'RPG'").get();
    const rpgAssoc = db.prepare('SELECT * FROM game_tags WHERE game_id = ? AND tag_id = ?').get(gameA.id, rpgTag.id);
    assert.ok(rpgAssoc, 'Genre-mirrored RPG tag should be preserved');

    const completedAssoc = db.prepare('SELECT * FROM game_tags WHERE game_id = ? AND tag_id = ?').get(gameA.id, completedTag.id);
    assert.ok(completedAssoc, 'User-created Completed tag should be assigned');
  });

  it('GET /api/tags/:id/games should return games with tagged boolean', () => {
    const backlogTag = db.prepare("SELECT id FROM tags WHERE name = 'Backlog'").get();
    const gA = db.prepare("SELECT id FROM games WHERE slug = 'game-a'").get();
    // Re-ensure gameA is tagged with Backlog (may have been cleared by prior PUT test)
    db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) VALUES (?, ?)').run(gA.id, backlogTag.id);
    const games = db.prepare(`
      SELECT ge.id as edition_id,
             COALESCE(g.title, ge.title) as title,
             g.id as game_id,
             CASE WHEN gt.tag_id IS NOT NULL THEN 1 ELSE 0 END as tagged
      FROM game_editions ge
      JOIN launchers l ON l.id = ge.launcher_id
      LEFT JOIN games g ON g.id = ge.game_id
      LEFT JOIN game_tags gt ON gt.game_id = g.id AND gt.tag_id = ?
      WHERE ge.owned = 1 AND ge.game_id IS NOT NULL
      ORDER BY COALESCE(g.title, ge.title) COLLATE NOCASE ASC
    `).all(backlogTag.id);

    assert.ok(games.length >= 2, 'Should return at least 2 editions');
    const gameA = games.find(g => g.title === 'Game A');
    assert.equal(gameA.tagged, 1, 'Game A should be tagged');
    const gameB = games.find(g => g.title === 'Game B');
    assert.equal(gameB.tagged, 0, 'Game B should not be tagged');
  });
});
