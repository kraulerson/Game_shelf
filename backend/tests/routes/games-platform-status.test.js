// Per-store status on the library card (#31): each entry of a game's
// `platforms[]` must carry enough to resolve THAT store's status client-side —
// its `launcher_game_id` (for the lancache hook's platform:app_id lookup) and,
// for a manual launcher, that launcher's own download status. Purely additive:
// every field the card already reads must be unchanged.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-platstatus';
const testDbPath = path.join(__dirname, '..', 'data', 'test-platform-status.db');

let app, mock, db;

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      // Only BioShock Infinite is on disk under GOG.
      if (/\/api\/v1\/manual-downloads\/GOG$/.test(req.url)) {
        return send(200, { launcher: 'GOG', present: true, entries: ['bioshock_infinite'] });
      }
      send(404, { detail: 'not found' });
    });
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function authCookie() {
  return `gameshelf_session=${jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function makeFetch(a, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const url = `http://127.0.0.1:${server.address().port}${urlPath}`;
      fetch(url, options).then(resolve).catch(reject).finally(() => server.close());
    });
  });
}

describe('GET /api/games platforms[] per-store status (#31)', () => {
  before(async () => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    mock = await startMock();
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';
    process.env.ORCH_API_URL = mock.url;
    process.env.ORCH_TOKEN = 'test-orch-token';
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(testDbPath);
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (1,'steam','Steam',1,1)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (2,'epic','Epic Games',1,2)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (5,'gog','GOG',1,3)").run();

    // Game 1 — BioShock Infinite: Steam + Epic + GOG, downloaded on GOG.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (1,'BioShock Infinite','bioshock-infinite')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (10,1,1,'8870','BioShock Infinite',1)").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (11,1,2,'epic-bioshock','BioShock Infinite',1)").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned,gog_slug) VALUES (12,1,5,'gog-bioshock','BioShock Infinite',1,'bioshock_infinite')").run();

    // Game 2 — GOG-only, NOT on disk.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (2,'Some Other Game','some-other-game')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned,gog_slug) VALUES (13,2,5,'gog-other','Some Other Game',1,'not_on_disk')").run();

    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));
  });

  after(() => {
    mock.server.close();
    try { db.close(); } catch { /* already closed */ }
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  async function listGames() {
    const res = await makeFetch(app, '/api/games?owned=true', { headers: { Cookie: authCookie() } });
    assert.equal(res.status, 200);
    return (await res.json()).games;
  }

  it('every platforms[] entry carries its own launcher_game_id', async () => {
    const g1 = (await listGames()).find((g) => g.id === 1);
    const byName = Object.fromEntries(g1.platforms.map((p) => [p.launcher_name, p]));
    assert.equal(byName.steam.launcher_game_id, '8870');
    assert.equal(byName.epic.launcher_game_id, 'epic-bioshock');
    assert.equal(byName.gog.launcher_game_id, 'gog-bioshock');
  });

  it('one entry per owned launcher — no duplicate rows from the added column', async () => {
    const g1 = (await listGames()).find((g) => g.id === 1);
    const names = g1.platforms.map((p) => p.launcher_name);
    assert.deepEqual([...names].sort(), ['epic', 'gog', 'steam']);
    assert.equal(names.length, new Set(names).size, 'no launcher appears twice');
  });

  it('a manual-launcher entry carries THAT launcher download status', async () => {
    const games = await listGames();
    const g1 = games.find((g) => g.id === 1);
    const g2 = games.find((g) => g.id === 2);
    assert.equal(g1.platforms.find((p) => p.launcher_name === 'gog').download_status, 'downloaded');
    assert.equal(g2.platforms.find((p) => p.launcher_name === 'gog').download_status, 'not_downloaded');
  });

  it('a lancache launcher entry has no manual download status', async () => {
    const g1 = (await listGames()).find((g) => g.id === 1);
    assert.equal(g1.platforms.find((p) => p.launcher_name === 'steam').download_status, null);
    assert.equal(g1.platforms.find((p) => p.launcher_name === 'epic').download_status, null);
  });

  it('existing platforms[] fields and the top-level download_status are unchanged', async () => {
    const games = await listGames();
    const g1 = games.find((g) => g.id === 1);
    const g2 = games.find((g) => g.id === 2);
    const steam = g1.platforms.find((p) => p.launcher_name === 'steam');
    assert.equal(steam.launcher_display_name, 'Steam');
    assert.equal(g1.download_status, 'downloaded', 'union download_status untouched');
    assert.equal(g2.download_status, 'not_downloaded');
    assert.equal(g1.cache_launcher_name, 'steam');
    assert.equal(g1.cache_launcher_game_id, '8870');
  });
});
