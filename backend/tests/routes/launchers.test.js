const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-launchers';

describe('Launcher routes', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-launchers.db');
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

  it('GET /api/launchers/available should return 9 launchers', async () => {
    const res = await makeFetch(app, '/api/launchers/available', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 9);
    assert.equal(body[0].id, 'steam');
    assert.equal(body[0].display_name, 'Steam');
  });

  it('POST /api/launchers/:id/credentials should save encrypted credentials', async () => {
    const res = await makeFetch(app, '/api/launchers/steam/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ api_key: 'test-steam-key', steamid64: '76561198012345678' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });

  it('POST /api/launchers/:id/credentials should reject invalid launcher', async () => {
    const res = await makeFetch(app, '/api/launchers/fakeLauncher/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'user', password: 'pass' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/launchers/:id/credentials should validate required fields for api_key type', async () => {
    const res = await makeFetch(app, '/api/launchers/itchio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ username: 'user', password: 'pass' }),
    });
    assert.equal(res.status, 400);
  });

  it('GET /api/launchers/:id/test should return stub response', async () => {
    // Steam credentials already saved above
    const res = await makeFetch(app, '/api/launchers/steam/test', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.message.includes('Steam'));
  });

  it('POST /api/launchers/priority should update priorities', async () => {
    // Save credentials for gog too
    await makeFetch(app, '/api/launchers/gog/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ auth_code: 'gog-test-code' }),
    });

    const res = await makeFetch(app, '/api/launchers/priority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify([
        { name: 'steam', priority: 1 },
        { name: 'gog', priority: 2 },
      ]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });

  it('POST /api/launchers/:id/approve should set sync_locked on the launcher', async () => {
    const db = app.locals.db;

    // Setup: ensure xbox launcher exists with credentials and editions
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ api_key: 'test-xbox-key' }));
    db.prepare(
      'INSERT OR REPLACE INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('xbox', 'Xbox / Microsoft', creds);

    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('xbox');
    // Insert two editions
    const ins = db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, 1)'
    );
    ins.run(launcher.id, 'xbox-game-1', 'Halo Infinite');
    ins.run(launcher.id, 'xbox-game-2', 'Forza Horizon 5');

    const editions = db.prepare(
      'SELECT id FROM game_editions WHERE launcher_id = ? AND owned = 1'
    ).all(launcher.id);

    // Approve only the first edition
    const res = await makeFetch(app, '/api/launchers/xbox/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ approved_edition_ids: [editions[0].id] }),
    });

    assert.equal(res.status, 200);

    // Verify sync_locked is set
    const updated = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('xbox');
    assert.equal(updated.sync_locked, 1, 'sync_locked should be 1 after approval');
  });

  it('POST /api/launchers/:id/approve should lock even when all games approved', async () => {
    const db = app.locals.db;

    // Unlock from previous test
    db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run('xbox');

    // Re-add an edition since previous test deleted some
    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('xbox');
    db.prepare(
      'INSERT OR IGNORE INTO game_editions (launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, 1)'
    ).run(launcher.id, 'xbox-game-3', 'Sea of Thieves');

    const editions = db.prepare(
      'SELECT id FROM game_editions WHERE launcher_id = ? AND owned = 1 AND parent_edition_id IS NULL'
    ).all(launcher.id);

    // Approve ALL editions
    const res = await makeFetch(app, '/api/launchers/xbox/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ approved_edition_ids: editions.map(e => e.id) }),
    });

    assert.equal(res.status, 200);

    const updated = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('xbox');
    assert.equal(updated.sync_locked, 1, 'sync_locked should be 1 even when all approved');
  });

  it('POST /api/launchers/:id/unlock-sync should clear sync_locked', async () => {
    const db = app.locals.db;
    db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run('xbox');

    const res = await makeFetch(app, '/api/launchers/xbox/unlock-sync', {
      method: 'POST',
      headers: { Cookie: authCookie() },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    const row = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('xbox');
    assert.equal(row.sync_locked, 0, 'sync_locked should be 0 after unlock');
  });

  it('POST /api/launchers/:id/unlock-sync should return 400 for unknown launcher', async () => {
    const res = await makeFetch(app, '/api/launchers/fakeLauncher/unlock-sync', {
      method: 'POST',
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 400);
  });

  it('DELETE /api/launchers/:id/credentials should reset sync_locked', async () => {
    const db = app.locals.db;
    db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run('xbox');

    const res = await makeFetch(app, '/api/launchers/xbox/credentials', {
      method: 'DELETE',
      headers: { Cookie: authCookie() },
    });

    assert.equal(res.status, 200);

    const row = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('xbox');
    assert.equal(row.sync_locked, 0, 'sync_locked should be reset when credentials removed');
  });

  it('POST /api/sync/:launcherName should return 409 when sync-locked', async () => {
    const db = app.locals.db;
    db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run('steam');

    try {
      const res = await makeFetch(app, '/api/sync/steam', {
        method: 'POST',
        headers: { Cookie: authCookie() },
      });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.ok(body.error.includes('locked'), 'Error should mention locked');
    } finally {
      db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run('steam');
    }
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
