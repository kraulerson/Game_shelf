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
});
