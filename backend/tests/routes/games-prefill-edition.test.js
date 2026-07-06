const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-prefill-edition';
const dbPath = path.join(__dirname, '..', 'data', 'test-prefill-edition-route.db');

let app, db;

function authCookie() {
  return `gameshelf_session=${jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '1h' })}`;
}

// Mirror the route-test harness in cache.test.js: start the app on an ephemeral
// port and drive it with a real fetch.
function makeFetch(a, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const url = `http://127.0.0.1:${server.address().port}${urlPath}`;
      fetch(url, options).then(resolve).catch(reject).finally(() => server.close());
    });
  });
}

const post = (id, body) =>
  makeFetch(app, `/api/games/${id}/prefill-edition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
    body: JSON.stringify(body),
  });

describe('POST /api/games/:id/prefill-edition', () => {
  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = dbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = dbPath;
    process.env.NODE_ENV = 'test';
    process.env.ORCH_API_URL = 'http://127.0.0.1:9'; // unreachable -> fire-and-forget sync fails fast, route still ok
    process.env.ORCH_TOKEN = 'test-orch-token';
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(dbPath);
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (1,'steam','Steam',1,1)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (2,'epic','Epic',1,2)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (3,'gog','GOG',1,3)").run();
    // Game 10: Steam + Epic
    db.prepare("INSERT INTO games (id,title,slug) VALUES (10,'Dual','dual')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (100,10,1,'s10','Dual Steam')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (101,10,2,'e10','Dual Epic')").run();
    // Game 20: Epic only
    db.prepare("INSERT INTO games (id,title,slug) VALUES (20,'EpicOnly','epic-only')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (200,20,2,'e20','EO Epic')").run();
    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));
  });
  after(() => {
    try { db.close(); } catch {}
    for (const s of ['', '-wal', '-shm']) { const f = dbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('sets is_prefill_edition on the Epic edition of a Steam+Epic game', async () => {
    const r = await post(10, { edition_id: 101 });
    assert.equal(r.status, 200);
    const row = db.prepare('SELECT is_prefill_edition FROM edition_tiers WHERE game_edition_id = 101').get();
    assert.equal(row.is_prefill_edition, 1);
  });

  it('clearing (edition_id: null) resets the override', async () => {
    await post(10, { edition_id: 101 });
    const r = await post(10, { edition_id: null });
    assert.equal(r.status, 200);
    const row = db.prepare('SELECT is_prefill_edition FROM edition_tiers WHERE game_edition_id = 101').get();
    assert.equal(row.is_prefill_edition, 0);
  });

  it('400 when the target edition is not Epic', async () => {
    const r = await post(10, { edition_id: 100 }); // Steam edition
    assert.equal(r.status, 400);
  });

  it('400 when the game is not also on Steam', async () => {
    const r = await post(20, { edition_id: 200 }); // Epic-only game
    assert.equal(r.status, 400);
  });

  it('404 for an unknown game', async () => {
    const r = await post(9999, { edition_id: 1 });
    assert.equal(r.status, 404);
  });
});
