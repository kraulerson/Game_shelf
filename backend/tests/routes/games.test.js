const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-games';

describe('Games routes', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-games.db');
  let app;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';

    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));

    // Seed test data
    const db = app.locals.db;

    // Create launchers
    db.prepare('INSERT INTO launchers (name, display_name, enabled, priority) VALUES (?, ?, 1, ?)').run('steam', 'Steam', 1);
    db.prepare('INSERT INTO launchers (name, display_name, enabled, priority) VALUES (?, ?, 1, ?)').run('gog', 'GOG', 2);

    const steamId = db.prepare('SELECT id FROM launchers WHERE name = ?').get('steam').id;
    const gogId = db.prepare('SELECT id FROM launchers WHERE name = ?').get('gog').id;

    // Create games
    db.prepare('INSERT INTO games (title, slug, description, release_year, developer, publisher) VALUES (?, ?, ?, ?, ?, ?)').run(
      'Half-Life 2', 'half-life-2', 'A classic FPS', 2004, 'Valve', 'Valve'
    );
    db.prepare('INSERT INTO games (title, slug, release_year) VALUES (?, ?, ?)').run('Portal 2', 'portal-2', 2011);

    const hl2Id = db.prepare('SELECT id FROM games WHERE slug = ?').get('half-life-2').id;
    const portalId = db.prepare('SELECT id FROM games WHERE slug = ?').get('portal-2').id;

    // Create game_editions (HL2 on both Steam and GOG, Portal 2 on Steam only)
    db.prepare('INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, playtime_minutes, owned) VALUES (?, ?, ?, ?, ?, 1)').run(hl2Id, steamId, '220', 'Half-Life 2', 1200);
    db.prepare('INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, playtime_minutes, owned) VALUES (?, ?, ?, ?, ?, 1)').run(hl2Id, gogId, 'hl2gog', 'Half-Life 2', 50);
    db.prepare('INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, playtime_minutes, owned) VALUES (?, ?, ?, ?, ?, 1)').run(portalId, steamId, '620', 'Portal 2', 300);

    // Create genres and link
    db.prepare('INSERT INTO genres (name) VALUES (?)').run('Action');
    db.prepare('INSERT INTO genres (name) VALUES (?)').run('FPS');
    const actionId = db.prepare('SELECT id FROM genres WHERE name = ?').get('Action').id;
    const fpsId = db.prepare('SELECT id FROM genres WHERE name = ?').get('FPS').id;
    db.prepare('INSERT INTO game_genres (game_id, genre_id) VALUES (?, ?)').run(hl2Id, actionId);
    db.prepare('INSERT INTO game_genres (game_id, genre_id) VALUES (?, ?)').run(hl2Id, fpsId);
    db.prepare('INSERT INTO game_genres (game_id, genre_id) VALUES (?, ?)').run(portalId, actionId);
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  function authCookie() {
    const token = jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    return `gameshelf_session=${token}`;
  }

  it('GET /api/games should return 401 without auth', async () => {
    const res = await makeFetch(app, '/api/games');
    assert.equal(res.status, 401);
  });

  it('GET /api/games should return deduplicated game list', async () => {
    const res = await makeFetch(app, '/api/games', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.games.length, 2, 'Should return 2 unique games (HL2 deduped to Steam)');
    assert.ok(body.total >= 2);

    // HL2 should show Steam as primary (priority 1)
    const hl2 = body.games.find(g => g.slug === 'half-life-2');
    assert.ok(hl2, 'Should include Half-Life 2');
    assert.equal(hl2.launcher_name, 'steam');
    assert.ok(hl2.platforms.length >= 2, 'Should have platforms with both launchers');
  });

  it('GET /api/games?search= should filter by title', async () => {
    const res = await makeFetch(app, '/api/games?search=portal', {
      headers: { Cookie: authCookie() },
    });
    const body = await res.json();
    assert.equal(body.games.length, 1);
    assert.equal(body.games[0].slug, 'portal-2');
  });

  it('GET /api/games?duplicates=show should return all editions', async () => {
    const res = await makeFetch(app, '/api/games?duplicates=show', {
      headers: { Cookie: authCookie() },
    });
    const body = await res.json();
    assert.ok(body.games.length >= 3, 'Should return 3 editions (HL2 Steam, HL2 GOG, Portal 2 Steam)');
  });

  it('GET /api/games/:id should return full game detail', async () => {
    const db = app.locals.db;
    const game = db.prepare('SELECT id FROM games WHERE slug = ?').get('half-life-2');

    const res = await makeFetch(app, `/api/games/${game.id}`, {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Half-Life 2');
    assert.ok(Array.isArray(body.editions), 'Should have editions array');
    assert.equal(body.editions.length, 2, 'Should have 2 editions');
    assert.ok(Array.isArray(body.genres), 'Should have genres array');

    // Check is_display_edition
    const display = body.editions.find(e => e.is_display_edition);
    assert.ok(display, 'Should have a display edition');
    assert.ok(display.tier !== undefined, 'Should have tier');
    assert.ok(display.tier_label, 'Should have tier_label');
  });

  it('PATCH /api/games/:id should set manual_title flag', async () => {
    const db = app.locals.db;
    db.prepare("INSERT OR IGNORE INTO games (title, slug) VALUES ('Test Manual Title', 'test-manual-title')").run();
    const game = db.prepare("SELECT id FROM games WHERE slug = 'test-manual-title'").get();

    const res = await makeFetch(app, `/api/games/${game.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ title: 'New Title' }),
    });
    assert.equal(res.status, 200);

    const updated = db.prepare('SELECT manual_title, title FROM games WHERE id = ?').get(game.id);
    assert.equal(updated.manual_title, 1, 'manual_title should be set to 1');
    assert.equal(updated.title, 'New Title');
  });

  // REGRESSION: After re-enrich reverted title but kept old slug, editing again
  // generated a slug that already existed, causing a 500 UNIQUE constraint error.
  it('PATCH /api/games/:id should handle slug collision gracefully', async () => {
    const db = app.locals.db;
    db.prepare("INSERT OR IGNORE INTO games (title, slug) VALUES ('Existing Game', 'existing-game')").run();
    db.prepare("INSERT OR IGNORE INTO games (title, slug) VALUES ('Other Game', 'other-game')").run();
    const other = db.prepare("SELECT id FROM games WHERE slug = 'other-game'").get();

    const res = await makeFetch(app, `/api/games/${other.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ title: 'Existing Game' }),
    });
    assert.equal(res.status, 200);

    const updated = db.prepare('SELECT title, slug FROM games WHERE id = ?').get(other.id);
    assert.equal(updated.title, 'Existing Game');
    assert.ok(updated.slug.startsWith('existing-game'), 'slug should be based on title');
    assert.notEqual(updated.slug, 'existing-game', 'slug should have suffix to avoid collision');
  });

  it('PATCH /api/games/:id should update edition titles that match old game title', async () => {
    const db = app.locals.db;
    db.prepare("INSERT OR IGNORE INTO games (title, slug) VALUES ('Old Name', 'old-name')").run();
    const game = db.prepare("SELECT id FROM games WHERE slug = 'old-name'").get();
    const launcherId = db.prepare('SELECT id FROM launchers LIMIT 1').get().id;

    // Create two editions — one matching old title, one different
    db.prepare('INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, ?, 1)').run(
      game.id, launcherId, 'ed-match', 'Old Name'
    );
    db.prepare('INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, ?, 1)').run(
      game.id, launcherId, 'ed-diff', 'Old Name Deluxe Edition'
    );

    const res = await makeFetch(app, `/api/games/${game.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ title: 'New Name' }),
    });
    assert.equal(res.status, 200);

    const matchEd = db.prepare("SELECT title FROM game_editions WHERE launcher_game_id = 'ed-match'").get();
    assert.equal(matchEd.title, 'New Name', 'edition with matching title should be updated');

    const diffEd = db.prepare("SELECT title FROM game_editions WHERE launcher_game_id = 'ed-diff'").get();
    assert.equal(diffEd.title, 'Old Name Deluxe Edition', 'edition with different title should be untouched');
  });

  it('GET /api/games/filters should return filter options', async () => {
    const res = await makeFetch(app, '/api/games/filters', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.genres), 'Should have genres');
    assert.ok(Array.isArray(body.launchers), 'Should have launchers');
    assert.ok(body.genres.length > 0);
  });
});

function makeFetch(app, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${urlPath}`;
      fetch(url, options)
        .then(resolve)
        .catch(reject)
        .finally(() => server.close());
    });
  });
}
