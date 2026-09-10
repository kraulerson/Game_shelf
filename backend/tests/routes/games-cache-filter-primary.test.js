const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

// Two defects, one filter:
//
//  1. _cache_status only ever holds Steam/Epic rows (the orchestrator tracks
//     nothing else), so every GOG/Amazon/Humble/Itch edition LEFT JOINed to NULL
//     and COALESCE(...,'unknown') made the game match "Unknown". Live: 924 of
//     2247 owned games. A manual-launcher-only game must match NO cache status.
//
//  2. The filter was EXISTS(any owned edition ...) while the card's badge comes
//     from ONE edition (resolveCacheLauncher). A Steam-cached / Epic-blocked game
//     matched "Blocked" while its card said "Cached". The filter must test only
//     the edition whose badge is displayed — and, when a launcher filter is
//     active, the top-priority owned edition AMONG THE SELECTED LAUNCHERS.

const JWT_SECRET = 'test-jwt-cache-filter-primary';
const testDbPath = path.join(__dirname, '..', 'data', 'test-cache-filter-primary.db');
let app, mock;

const ORCH_GAMES = [
  // The multi-launcher game: cached on Steam (the primary), blocked on Epic.
  { id: 1, platform: 'steam', app_id: '110', status: 'up_to_date' },
  { id: 2, platform: 'epic', app_id: '120', status: 'failed', blocked: true },
  // Single-launcher Steam control (the common case — must not regress).
  { id: 3, platform: 'steam', app_id: '130', status: 'not_downloaded' },
  // Epic-primary game (no Steam edition at all).
  { id: 4, platform: 'epic', app_id: '140', status: 'validation_failed' },
];

const ALL_STATUSES = ['up_to_date', 'not_downloaded', 'validation_failed', 'failed', 'blocked', 'unknown'];

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
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
  // priority: Steam 1, Epic 2 explicitly ranked; GOG/Amazon left at the default 0
  // (= unranked, sorts last) exactly as a real install has them.
  db.prepare(`INSERT INTO launchers (id, name, display_name, enabled, priority) VALUES
    (1,'steam','Steam',1,1),(2,'epic','Epic',1,2),(3,'gog','GOG',1,0),(4,'amazon','Amazon',1,0)`).run();
  const insGame = db.prepare('INSERT INTO games (id, title, slug) VALUES (?,?,?)');
  const insEd = db.prepare(
    'INSERT INTO game_editions (game_id, launcher_id, launcher_game_id, title, owned, parent_edition_id) VALUES (?,?,?,?,1,NULL)'
  );
  insGame.run(101, 'Amazon Only', 'amazon-only');
  insEd.run(101, 4, 'A1', 'ed');

  insGame.run(102, 'Trilogy Everywhere', 'trilogy-everywhere');
  insEd.run(102, 1, '110', 'ed');   // Steam, up_to_date  <- the displayed badge
  insEd.run(102, 2, '120', 'ed');   // Epic, blocked
  insEd.run(102, 3, 'G1', 'ed');    // GOG, untracked

  insGame.run(103, 'Solo Steam', 'solo-steam');
  insEd.run(103, 1, '130', 'ed');

  insGame.run(104, 'GOG Only', 'gog-only');
  insEd.run(104, 3, 'G2', 'ed');

  insGame.run(105, 'Epic Primary', 'epic-primary');
  insEd.run(105, 2, '140', 'ed');

  insGame.run(106, 'Unrecorded Steam', 'unrecorded-steam');
  insEd.run(106, 1, '999', 'ed');   // no orchestrator row -> genuinely unknown
}
async function get(qs) {
  const res = await makeFetch(app, `/api/games?${qs}`, { headers: { Cookie: authCookie() } });
  return res.json();
}
async function titles(qs) {
  const body = await get(qs);
  return body.games.map((g) => g.title).sort();
}

describe('cache_status filter follows the displayed edition', () => {
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
  });
  after(() => { mock.server.close(); });

  // --- Defect 1: manual launchers are not lancache-tracked -------------------
  it('a manual-launcher-only game matches NO cache_status, including unknown', async () => {
    for (const status of ALL_STATUSES) {
      const found = await titles(`cache_status=${status}`);
      assert.ok(!found.includes('Amazon Only'), `Amazon Only must not match cache_status=${status} (got ${JSON.stringify(found)})`);
    }
  });

  it('a game with no owned lancache edition never appears for any cache_status', async () => {
    for (const status of ALL_STATUSES) {
      const found = await titles(`cache_status=${status}`);
      assert.ok(!found.includes('GOG Only'), `GOG Only must not match cache_status=${status} (got ${JSON.stringify(found)})`);
    }
  });

  it('a Steam edition with no orchestrator record still matches unknown', async () => {
    assert.ok((await titles('cache_status=unknown')).includes('Unrecorded Steam'));
  });

  // --- Defect 2: the filter tests the displayed edition ----------------------
  it('cache_status=blocked does NOT return a game whose displayed (Steam) badge is Cached', async () => {
    assert.ok(!(await titles('cache_status=blocked')).includes('Trilogy Everywhere'));
  });

  it('cache_status=up_to_date DOES return it (Steam is the displayed edition)', async () => {
    assert.ok((await titles('cache_status=up_to_date')).includes('Trilogy Everywhere'));
  });

  // --- The launcher-interaction rule ----------------------------------------
  it('launcher=epic&cache_status=blocked returns it (the Epic copy IS blocked)', async () => {
    assert.deepEqual(await titles('launcher=epic&cache_status=blocked'), ['Trilogy Everywhere']);
  });

  it('launcher=steam&cache_status=up_to_date returns it', async () => {
    assert.deepEqual(await titles('launcher=steam&cache_status=up_to_date'), ['Trilogy Everywhere']);
  });

  it('launcher=steam&cache_status=blocked returns nothing (Steam copy is cached)', async () => {
    assert.deepEqual(await titles('launcher=steam&cache_status=blocked'), []);
  });

  it('launcher=gog&cache_status=unknown returns nothing (GOG is not lancache-tracked)', async () => {
    assert.deepEqual(await titles('launcher=gog&cache_status=unknown'), []);
  });

  // --- No regression for the single-launcher common case --------------------
  it('a single-launcher Steam game matches exactly its own status and nothing else', async () => {
    for (const status of ALL_STATUSES) {
      const found = await titles(`cache_status=${status}`);
      assert.equal(
        found.includes('Solo Steam'),
        status === 'not_downloaded',
        `Solo Steam under cache_status=${status} (got ${JSON.stringify(found)})`
      );
    }
  });

  it('an Epic-only game resolves against its Epic edition', async () => {
    for (const status of ALL_STATUSES) {
      const found = await titles(`cache_status=${status}`);
      assert.equal(
        found.includes('Epic Primary'),
        status === 'validation_failed',
        `Epic Primary under cache_status=${status} (got ${JSON.stringify(found)})`
      );
    }
  });

  it('total matches the returned set when the filter narrows to the displayed edition', async () => {
    const body = await get('cache_status=blocked');
    assert.equal(body.total, body.games.length);
    assert.deepEqual(body.games.map((g) => g.title), []);
  });
});
