const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-manual-metadata';

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

describe('Manual metadata editing API', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-manual-metadata.db');
  let app;
  let gameId;

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

    const db = app.locals.db;

    db.prepare('INSERT INTO launchers (name, display_name, enabled, priority) VALUES (?, ?, 1, 1)').run('itch', 'itch.io');
    const launcherId = db.prepare('SELECT id FROM launchers WHERE name = ?').get('itch').id;

    db.prepare('INSERT INTO games (title, slug) VALUES (?, ?)').run('Earth Clicker', 'earth-clicker');
    gameId = db.prepare('SELECT id FROM games WHERE slug = ?').get('earth-clicker').id;

    db.prepare('INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, ?, 1)').run(
      gameId, launcherId, 'earth-clicker', 'Earth Clicker'
    );
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

  it('PATCH /api/games/:id with description should update and set manual flag', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ description: 'A clicker game about Earth.' }),
    });
    assert.equal(res.status, 200);

    const db = app.locals.db;
    const game = db.prepare('SELECT description, manual_description FROM games WHERE id = ?').get(gameId);
    assert.equal(game.description, 'A clicker game about Earth.');
    assert.equal(game.manual_description, 1);
  });

  it('PATCH /api/games/:id with empty description should clear it and keep flag', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ description: '' }),
    });
    assert.equal(res.status, 200);

    const db = app.locals.db;
    const game = db.prepare('SELECT description, manual_description FROM games WHERE id = ?').get(gameId);
    assert.equal(game.description, null);
    assert.equal(game.manual_description, 1);
  });

  it('PATCH /api/games/:id with title still works as before', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ title: 'Earth Clicker Renamed' }),
    });
    assert.equal(res.status, 200);

    const db = app.locals.db;
    const game = db.prepare('SELECT title FROM games WHERE id = ?').get(gameId);
    assert.equal(game.title, 'Earth Clicker Renamed');
  });

  it('PATCH /api/games/:id with neither title nor description returns 400', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  // --- Cover upload tests ---

  it('POST /api/games/:id/cover should upload and set manual flag', async () => {
    // Minimal valid 1x1 PNG
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
      0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);

    const formData = new FormData();
    formData.append('cover', new Blob([pngHeader], { type: 'image/png' }), 'test-cover.png');

    const res = await makeFetch(app, `/api/games/${gameId}/cover`, {
      method: 'POST',
      headers: { Cookie: authCookie() },
      body: formData,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.cover_url, 'Should return cover_url');
    assert.ok(body.cover_url.includes(`/data/images/${gameId}/cover`), 'Path should include game ID');

    const db = app.locals.db;
    const game = db.prepare('SELECT cover_url, manual_cover FROM games WHERE id = ?').get(gameId);
    assert.equal(game.manual_cover, 1);
    assert.equal(game.cover_url, body.cover_url);
  });

  it('POST /api/games/:id/cover should reject non-image files', async () => {
    const formData = new FormData();
    formData.append('cover', new Blob(['not an image'], { type: 'text/plain' }), 'test.txt');

    const res = await makeFetch(app, `/api/games/${gameId}/cover`, {
      method: 'POST',
      headers: { Cookie: authCookie() },
      body: formData,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/games/:id/cover should reject missing file', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}/cover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
    });
    assert.equal(res.status, 400);
  });

  // --- Override reset tests ---

  it('DELETE /api/games/:id/manual-override should reset description flag', async () => {
    const db = app.locals.db;
    db.prepare('UPDATE games SET manual_description = 1, description = ? WHERE id = ?').run('Manual desc', gameId);

    const res = await makeFetch(app, `/api/games/${gameId}/manual-override`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ field: 'description' }),
    });
    assert.equal(res.status, 200);

    const game = db.prepare('SELECT manual_description, description FROM games WHERE id = ?').get(gameId);
    assert.equal(game.manual_description, 0);
    assert.equal(game.description, 'Manual desc', 'Content should be preserved');
  });

  it('DELETE /api/games/:id/manual-override should reset cover flag', async () => {
    const db = app.locals.db;
    db.prepare('UPDATE games SET manual_cover = 1 WHERE id = ?').run(gameId);

    const res = await makeFetch(app, `/api/games/${gameId}/manual-override`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ field: 'cover' }),
    });
    assert.equal(res.status, 200);

    const game = db.prepare('SELECT manual_cover FROM games WHERE id = ?').get(gameId);
    assert.equal(game.manual_cover, 0);
  });

  // REGRESSION: Re-enrich used the edition title ("Anno 7") instead of the manually
  // edited game title ("Anno 2205"), causing IGDB search with the wrong title and
  // creating a new games row that overwrote the manual edit.
  it('POST /api/metadata/re-enrich/:gameId should preserve manual_title', async () => {
    const db = app.locals.db;

    // Set manual title on the game
    db.prepare("UPDATE games SET title = 'Custom Title', slug = 'custom-title', manual_title = 1 WHERE id = ?").run(gameId);

    const res = await makeFetch(app, `/api/metadata/re-enrich/${gameId}`, {
      method: 'POST',
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);

    // Verify title was NOT overwritten
    const game = db.prepare('SELECT title, slug, manual_title FROM games WHERE id = ?').get(gameId);
    assert.equal(game.title, 'Custom Title', 'manual title should be preserved after re-enrich');
    assert.equal(game.slug, 'custom-title', 'manual slug should be preserved after re-enrich');
    assert.equal(game.manual_title, 1, 'manual_title flag should remain set');

    // Restore for other tests
    db.prepare("UPDATE games SET title = 'Earth Clicker', slug = 'earth-clicker', manual_title = 0 WHERE id = ?").run(gameId);
  });

  it('DELETE /api/games/:id/manual-override with invalid field returns 400', async () => {
    const res = await makeFetch(app, `/api/games/${gameId}/manual-override`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ field: 'invalid_field' }),
    });
    assert.equal(res.status, 400);
  });
});
