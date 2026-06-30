const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-cache-filter';
const testDbPath = path.join(__dirname, '..', 'data', 'test-cache-filter.db');
let app, mock;

const ORCH_GAMES = [
  { id: 1, platform: 'steam', app_id: '10', status: 'up_to_date' },
  { id: 2, platform: 'steam', app_id: '20', status: 'not_downloaded' },
  { id: 3, platform: 'epic', app_id: '30', status: 'not_downloaded' },
  { id: 4, platform: 'epic', app_id: '40', status: 'validation_failed' },
  { id: 6, platform: 'steam', app_id: '50', status: 'failed' },
];
let orchUp = true;

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!orchUp) { res.destroy(); return; }
      if (req.url.startsWith('/api/v1/games?')) {
        const u = new URL('http://x' + req.url);
        const offset = Number(u.searchParams.get('offset') || 0);
        const page = ORCH_GAMES.slice(offset, offset + 500);
        return send(200, { games: page, meta: { total: ORCH_GAMES.length, limit: 500, offset, has_more: false } });
      }
      send(404, { detail: 'nf' });
    });
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
function authCookie() { return `gameshelf_session=${jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '1h' })}`; }
function makeFetch(a, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const url = `http://127.0.0.1:${server.address().port}${urlPath}`;
      fetch(url, options).then(resolve).catch(reject).finally(() => server.close());
    });
  });
}
function seed(db) {
  db.prepare("INSERT INTO launchers (id, name, display_name, enabled, priority) VALUES (1,'steam','Steam',1,1),(2,'epic','Epic',1,2)").run();
  const insGame = db.prepare("INSERT INTO games (id, title, slug) VALUES (?,?,?)");
  const insEd = db.prepare("INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned, parent_edition_id) VALUES (?,?,?,?,1,NULL)");
  const rows = [
    [1, 'Cached Steam', 'cached-steam', 1, '10'],
    [2, 'Uncached Steam', 'uncached-steam', 1, '20'],
    [3, 'Uncached Epic', 'uncached-epic', 2, '30'],
    [4, 'Partial Epic', 'partial-epic', 2, '40'],
    [5, 'Unknown Steam', 'unknown-steam', 1, '99'],
    [6, 'Broken Steam', 'broken-steam', 1, '50'],
  ];
  for (const [gid, title, slug] of rows) insGame.run(gid, title, slug);
  for (const [gid, , , lid, lgid] of rows) insEd.run(gid, lid, lgid, 'ed');
}
async function get(qs) {
  const res = await makeFetch(app, `/api/games?${qs}`, { headers: { Cookie: authCookie() } });
  return res.json();
}

describe('cache_status filter', () => {
  before(async () => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    mock = await startMock();
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = JWT_SECRET;
    process.env.GAMESHELF_DB_PATH = testDbPath;
    process.env.NODE_ENV = 'test';
    process.env.ORCH_API_URL = mock.url;
    process.env.ORCH_TOKEN = 'test-orch-token';
    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));
    seed(app.locals.db);
    orchUp = true;
  });
  after(() => { mock.server.close(); });

  it('cache_status=up_to_date returns only the cached game', async () => {
    const body = await get('cache_status=up_to_date');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Cached Steam']);
  });
  it('cache_status=not_downloaded returns both uncached games', async () => {
    const body = await get('cache_status=not_downloaded');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Uncached Epic', 'Uncached Steam']);
  });
  it('failed matches only failed (validation_failed is now the separate "Partial")', async () => {
    const body = await get('cache_status=failed');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Broken Steam']);
  });
  it('validation_failed (Partial) matches only the partially-cached game', async () => {
    const body = await get('cache_status=validation_failed');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Partial Epic']);
  });
  it('failed + validation_failed together match both', async () => {
    const body = await get('cache_status=failed,validation_failed');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Broken Steam', 'Partial Epic']);
  });
  it('unknown includes games with no orchestrator record', async () => {
    const body = await get('cache_status=unknown');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Unknown Steam']);
  });
  it('launcher=epic + not_downloaded matches the Epic edition specifically', async () => {
    const body = await get('launcher=epic&cache_status=not_downloaded');
    assert.deepEqual(body.games.map(g => g.title).sort(), ['Uncached Epic']);
  });
  it('total reflects the filter (pagination correctness)', async () => {
    const body = await get('cache_status=not_downloaded&limit=1');
    assert.equal(body.total, 2);
    assert.equal(body.games.length, 1);
  });
  it('orchestrator offline -> cache_filter_unavailable flag is a boolean and games still returned', async () => {
    orchUp = false;
    const body = await get('cache_status=up_to_date');
    assert.equal(typeof body.cache_filter_unavailable, 'boolean');
    assert.ok(Array.isArray(body.games));
    orchUp = true;
  });
});
