const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-dlstatus';
const testDbPath = path.join(__dirname, '..', 'data', 'test-download-status.db');

let app, mock, db;

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (/\/api\/v1\/manual-downloads\/GOG$/.test(req.url)) {
        return send(200, { launcher: 'GOG', present: true, entries: ['baldurs_gate_2_enhanced_edition'] });
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

describe('GET /api/games download_status (#222)', () => {
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
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (5,'gog','GOG',1,3)").run();
    // Game 1: downloaded (gog_slug matches the folder). Game 2: not downloaded.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (1,'Baldurs Gate II','baldurs-gate-ii')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned,gog_slug) VALUES (10,1,5,'g1','BG2',1,'baldurs_gate_2_enhanced_edition')").run();
    db.prepare("INSERT INTO games (id,title,slug) VALUES (2,'Some Other Game','some-other-game')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned,gog_slug) VALUES (11,2,5,'g2','SOG',1,'not_on_disk')").run();
    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));
  });
  after(() => {
    mock.server.close();
    try { db.close(); } catch {}
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('surfaces download_status per game in the list', async () => {
    const res = await makeFetch(app, '/api/games?owned=true', { headers: { Cookie: authCookie() } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const g1 = body.games.find((g) => g.id === 1);
    const g2 = body.games.find((g) => g.id === 2);
    assert.equal(g1.download_status, 'downloaded');
    assert.equal(g2.download_status, 'not_downloaded');
  });

  it('?download_status=downloaded filters to downloaded GOG games', async () => {
    const res = await makeFetch(app, '/api/games?owned=true&download_status=downloaded', { headers: { Cookie: authCookie() } });
    const body = await res.json();
    assert.ok(body.games.every((g) => g.download_status === 'downloaded'), 'all returned are downloaded');
    assert.ok(body.games.some((g) => g.id === 1), 'game 1 present');
    assert.ok(!body.games.some((g) => g.id === 2), 'game 2 absent');
  });

  it('?download_status=not_downloaded filters to owned-but-missing GOG games', async () => {
    const res = await makeFetch(app, '/api/games?owned=true&download_status=not_downloaded', { headers: { Cookie: authCookie() } });
    const body = await res.json();
    assert.ok(body.games.some((g) => g.id === 2), 'game 2 present');
    assert.ok(!body.games.some((g) => g.id === 1), 'game 1 absent');
  });
});
