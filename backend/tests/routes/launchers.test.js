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

  it('GET /api/launchers/available should return 10 launchers', async () => {
    const res = await makeFetch(app, '/api/launchers/available', {
      headers: { Cookie: authCookie() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 10);
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

  it('GET /api/launchers/available should include sync_locked field', async () => {
    const res = await makeFetch(app, '/api/launchers/available', {
      headers: { Cookie: authCookie() },
    });
    const body = await res.json();
    const xbox = body.find(l => l.id === 'xbox');
    assert.ok(xbox, 'Xbox should be in the list');
    assert.ok('sync_locked' in xbox, 'sync_locked field should be present');
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

  // REGRESSION: XboxApproval confirmation dialog said "re-sync to recover"
  // which was misleading after adding sync lock — user must unlock first.
  it('regression: XboxApproval confirmation text should mention unlock step', () => {
    const fs = require('node:fs');
    const approvalSource = fs.readFileSync(
      require('node:path').join(__dirname, '../../../frontend/src/pages/XboxApproval.jsx'),
      'utf8'
    );
    assert.ok(
      approvalSource.includes('unlock and re-sync to recover'),
      'Confirmation text should mention unlock step, not just "re-sync"'
    );
    assert.ok(
      !approvalSource.includes('(re-sync to recover)'),
      'Old text "(re-sync to recover)" should be replaced'
    );
  });

  // Amazon Games: preview should parse games.db and return game list without DB writes
  it('POST /api/launchers/amazon/preview should return parsed games', async () => {
    const Database = require('better-sqlite3');
    const tmpPath = require('node:path').join(__dirname, 'test-amazon-preview.db');
    const tmpDb = new Database(tmpPath);
    tmpDb.exec(`
      CREATE TABLE IF NOT EXISTS "DbSet" (
        Id TEXT PRIMARY KEY,
        ProductTitle TEXT,
        ProductIdStr TEXT,
        Installed INTEGER
      )
    `);
    tmpDb.prepare('INSERT INTO DbSet (Id, ProductTitle, ProductIdStr, Installed) VALUES (?, ?, ?, ?)').run(
      'amzn1.preview.aaa', 'Preview Game', 'amzn1.preview.aaa', 1
    );
    tmpDb.close();

    const fileBuffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);

    const boundary = '----TestBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="games_db"; filename="games.db"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await makeFetch(app, '/api/launchers/amazon/preview', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Cookie: authCookie(),
      },
      body,
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.games), 'should return games array');
    assert.equal(data.games.length, 1);
    assert.equal(data.games[0].title, 'Preview Game');

    // Verify no DB writes happened
    const db = app.locals.db;
    const amazonRow = db.prepare("SELECT id FROM launchers WHERE name = 'amazon'").get();
    if (amazonRow) {
      const editions = db.prepare('SELECT COUNT(*) as c FROM game_editions WHERE launcher_id = ?').get(amazonRow.id);
      assert.equal(editions.c, 0, 'preview should not write to game_editions');
    }
  });

  // Amazon Games: import should upsert games and set sync_locked
  it('POST /api/launchers/amazon/import should upsert games and lock sync', async () => {
    const db = app.locals.db;

    const res = await makeFetch(app, '/api/launchers/amazon/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: authCookie(),
      },
      body: JSON.stringify({
        approved_games: [
          { launcher_game_id: 'amzn1.import.aaa', title: 'Imported Game A' },
          { launcher_game_id: 'amzn1.import.bbb', title: 'Imported Game B' },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.imported, 2);

    // Verify games exist in DB
    const launcher = db.prepare("SELECT id, sync_locked FROM launchers WHERE name = 'amazon'").get();
    assert.ok(launcher, 'amazon launcher row should exist');
    assert.equal(launcher.sync_locked, 1, 'sync_locked should be 1 after import');

    const editions = db.prepare(
      'SELECT COUNT(*) as c FROM game_editions WHERE launcher_id = ? AND owned = 1'
    ).get(launcher.id);
    assert.equal(editions.c, 2, 'should have 2 game editions');
  });

  it('POST /api/launchers/amazon/credentials should return 400 for file_import launcher', async () => {
    const res = await makeFetch(app, '/api/launchers/amazon/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('file import'), 'should mention file import');
  });

  // REGRESSION: Ubisoft cache-imported games were removed when a subsequent
  // GraphQL sync ran, because the sync engine marked API-missing games as
  // unowned. Fix: cache import now locks the launcher like Xbox approval does.
  it('regression: ubisoft cache import should set sync_locked', async () => {
    const db = app.locals.db;
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ email: 'test@test.com', password: 'test' }));

    // Ensure ubisoft launcher exists and is unlocked
    db.prepare(
      'INSERT OR REPLACE INTO launchers (name, display_name, enabled, credentials_json, sync_locked) VALUES (?, ?, 1, ?, 0)'
    ).run('ubisoft', 'Ubisoft Connect', creds);

    const before = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('ubisoft');
    assert.equal(before.sync_locked, 0, 'sync_locked should start at 0');

    // Build minimal valid protobuf config buffer: one game (uid=100, name="Test Game")
    const configYaml = Buffer.from('name: Test Game\nstart_game: yes');
    const configInner = Buffer.concat([
      Buffer.from([0x08, 0x64]),               // field 1, wire type 0, varint 100
      Buffer.from([0x1A, configYaml.length]),   // field 3, wire type 2, length
      configYaml,
    ]);
    const configBuf = Buffer.concat([
      Buffer.from([0x0A, configInner.length]),  // field 1, wire type 2, length
      configInner,
    ]);

    // Build minimal valid protobuf ownership buffer: 0x108 header + one entry (pid=100)
    const ownerHeader = Buffer.alloc(0x108);
    const ownerEntry = Buffer.concat([
      Buffer.from([0x0A, 0x02]),  // field 1, wire type 2, length 2
      Buffer.from([0x08, 0x64]),  // field 1, wire type 0, varint 100
    ]);
    const ownershipBuf = Buffer.concat([ownerHeader, ownerEntry]);

    // Build multipart form body with binary buffers
    const boundary = '----TestBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="configurations"; filename="configurations"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      configBuf,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="ownership"; filename="ownership"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      ownershipBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await makeFetch(app, '/api/launchers/ubisoft/import-cache', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Cookie: authCookie(),
      },
      body,
    });

    assert.equal(res.status, 200, 'Cache import should succeed');

    const after = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('ubisoft');
    assert.equal(after.sync_locked, 1, 'sync_locked should be 1 after cache import');
  });

  // REGRESSION: Xbox games reappeared after approval because approval
  // hard-deleted rejected games, then sync re-inserted them from the API.
  // Fix: approval now locks the launcher so sync is blocked until unlocked.
  it('regression: approve should lock sync, preventing games from reappearing', async () => {
    const db = app.locals.db;

    // Ensure xbox is unlocked and has credentials
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ api_key: 'test-xbox-key' }));
    db.prepare(
      'INSERT OR REPLACE INTO launchers (name, display_name, enabled, credentials_json, sync_locked) VALUES (?, ?, 1, ?, 0)'
    ).run('xbox', 'Xbox / Microsoft', creds);

    const launcher = db.prepare('SELECT id FROM launchers WHERE name = ?').get('xbox');

    // Clean up any leftover editions from previous tests
    db.prepare('DELETE FROM game_editions WHERE launcher_id = ?').run(launcher.id);

    // Simulate: user has 3 games from Xbox API sync
    const ins = db.prepare(
      'INSERT INTO game_editions (launcher_id, launcher_game_id, title, owned) VALUES (?, ?, ?, 1)'
    );
    ins.run(launcher.id, 'reg-game-1', 'Owned Game');
    ins.run(launcher.id, 'reg-game-2', 'Game Pass Game');
    ins.run(launcher.id, 'reg-game-3', 'Another GP Game');

    const ownedEdition = db.prepare(
      "SELECT id FROM game_editions WHERE launcher_id = ? AND launcher_game_id = 'reg-game-1'"
    ).get(launcher.id);

    // Step 1: Approve only the owned game (delete the Game Pass games)
    const approveRes = await makeFetch(app, '/api/launchers/xbox/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: JSON.stringify({ approved_edition_ids: [ownedEdition.id] }),
    });
    assert.equal(approveRes.status, 200);

    // Verify: rejected games are deleted
    const remaining = db.prepare(
      'SELECT COUNT(*) as c FROM game_editions WHERE launcher_id = ? AND owned = 1'
    ).get(launcher.id);
    assert.equal(remaining.c, 1, 'Only approved game should remain');

    // Verify: launcher is now locked
    const lockedRow = db.prepare('SELECT sync_locked FROM launchers WHERE name = ?').get('xbox');
    assert.equal(lockedRow.sync_locked, 1, 'Launcher should be locked after approval');

    // Step 2: Attempt to sync — should be blocked
    const syncRes = await makeFetch(app, '/api/sync/xbox', {
      method: 'POST',
      headers: { Cookie: authCookie() },
    });
    assert.equal(syncRes.status, 409, 'Sync should be blocked with 409');

    // Verify: games did NOT reappear
    const afterSync = db.prepare(
      'SELECT COUNT(*) as c FROM game_editions WHERE launcher_id = ? AND owned = 1'
    ).get(launcher.id);
    assert.equal(afterSync.c, 1, 'Rejected games must not reappear after blocked sync');
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
