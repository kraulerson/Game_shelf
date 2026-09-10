const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

// The download_status filter must correlate with the selected launcher(s).
// Before this fix, `launcher` was an INNER (edition-level) CTE condition while
// download_status was an OUTER game-level condition built from the hardcoded
// MANUAL_LAUNCHERS list — so launcher=steam&download_status=not_downloaded
// returned games merely owned on Steam that were separately not-downloaded on
// some manual launcher. Mirrors the EXISTS-over-editions shape cache_status uses.

const JWT_SECRET = 'test-jwt-secret-dlstatus-launcher';
const testDbPath = path.join(__dirname, '..', 'data', 'test-download-status-launcher.db');

let app, mock, db;

// On-disk listings per manual-launcher folder. GOG/Amazon are dir-mode,
// Humble/Itch.io are file-mode (loose installer filenames).
const ENTRIES = {
  GOG: ['alpha_game'],
  'Amazon Games': ['Epsilon'],
  'Humble Bundle': ['Bravo.zip'],
  'Itch.io': [],
};

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const m = /\/api\/v1\/manual-downloads\/([^?]+)/.exec(req.url);
      if (m) {
        const folder = decodeURIComponent(m[1]);
        if (ENTRIES[folder]) return send(200, { launcher: folder, present: true, entries: ENTRIES[folder] });
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

async function ids(urlPath) {
  const res = await makeFetch(app, urlPath, { headers: { Cookie: authCookie() } });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.games.map((g) => g.id).sort((a, b) => a - b);
}

describe('GET /api/games download_status correlates with launcher', () => {
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

    const ins = (sql, ...a) => db.prepare(sql).run(...a);
    ins("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (1,'steam','Steam',1,1)");
    ins("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (5,'gog','GOG',1,3)");
    ins("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (6,'humble','Humble Bundle',1,5)");
    ins("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (7,'amazon','Amazon Games',1,6)");

    // 1 Alpha    : gog (downloaded)      + humble (NOT downloaded)
    // 2 Bravo    : gog (NOT downloaded)  + humble (downloaded)
    // 3 Gamma    : gog (NOT downloaded)
    // 4 Delta    : steam                 + humble (NOT downloaded)   <- the reported bug
    // 5 Epsilon  : amazon (downloaded)   + humble (NOT downloaded)
    ins("INSERT INTO games (id,title,slug) VALUES (1,'Alpha','alpha')");
    ins("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned,gog_slug) VALUES (10,1,5,'a1','Alpha',1,'alpha_game')");
    ins("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (11,1,6,'a2','Alpha',1)");

    ins("INSERT INTO games (id,title,slug) VALUES (2,'Bravo','bravo')");
    ins("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned,gog_slug) VALUES (20,2,5,'b1','Bravo',1,'bravo_not_on_disk')");
    ins("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (21,2,6,'b2','Bravo',1)");

    ins("INSERT INTO games (id,title,slug) VALUES (3,'Gamma','gamma')");
    ins("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned,gog_slug) VALUES (30,3,5,'c1','Gamma',1,'gamma_not_on_disk')");

    ins("INSERT INTO games (id,title,slug) VALUES (4,'Delta','delta')");
    ins("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (40,4,1,'d1','Delta',1)");
    ins("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (41,4,6,'d2','Delta',1)");

    ins("INSERT INTO games (id,title,slug) VALUES (5,'Epsilon','epsilon')");
    ins("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (50,5,7,'e1','Epsilon',1)");
    ins("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (51,5,6,'e2','Epsilon',1)");

    delete require.cache[require.resolve('../../src/server')];
    ({ app } = require('../../src/server'));
  });
  after(() => {
    mock.server.close();
    try { db.close(); } catch {}
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  // Sanity: the fixture matches as intended, independent of the filter shape.
  it('surfaces the union download_status per row (fixture sanity)', async () => {
    const res = await makeFetch(app, '/api/games?owned=true', { headers: { Cookie: authCookie() } });
    const body = await res.json();
    const byId = Object.fromEntries(body.games.map((g) => [g.id, g.download_status]));
    assert.deepEqual(byId, {
      1: 'downloaded', 2: 'downloaded', 3: 'not_downloaded', 4: 'not_downloaded', 5: 'downloaded',
    });
  });

  // The reported bug: Steam editions have no manual-download status at all, so the
  // correlation must yield zero rows — naturally, with no special-casing.
  it('launcher=steam&download_status=not_downloaded returns nothing', async () => {
    assert.deepEqual(await ids('/api/games?owned=true&launcher=steam&download_status=not_downloaded'), []);
  });

  it('launcher=steam&download_status=downloaded returns nothing', async () => {
    assert.deepEqual(await ids('/api/games?owned=true&launcher=steam&download_status=downloaded'), []);
  });

  it('launcher=humble&download_status=not_downloaded lists only games missing ON HUMBLE', async () => {
    // 2 is downloaded on humble (but NOT on gog) — it must not appear.
    assert.deepEqual(await ids('/api/games?owned=true&launcher=humble&download_status=not_downloaded'), [1, 4, 5]);
  });

  it('launcher=humble&download_status=downloaded lists only games downloaded ON HUMBLE', async () => {
    // 1 is downloaded on gog and owned-but-missing on humble — it must not appear.
    assert.deepEqual(await ids('/api/games?owned=true&launcher=humble&download_status=downloaded'), [2]);
  });

  it('launcher=gog&download_status=not_downloaded lists only games missing ON GOG', async () => {
    assert.deepEqual(await ids('/api/games?owned=true&launcher=gog&download_status=not_downloaded'), [2, 3]);
  });

  it('two manual launchers select the union of those two only', async () => {
    // 5 is downloaded on amazon only — outside the humble+gog selection.
    assert.deepEqual(await ids('/api/games?owned=true&launcher=humble,gog&download_status=downloaded'), [1, 2]);
  });

  it('no launcher filter keeps the legacy game-level union behaviour', async () => {
    assert.deepEqual(await ids('/api/games?owned=true&download_status=downloaded'), [1, 2, 5]);
    assert.deepEqual(await ids('/api/games?owned=true&download_status=not_downloaded'), [3, 4]);
  });

  it('no download_status filter is unaffected by the launcher filter', async () => {
    assert.deepEqual(await ids('/api/games?owned=true&launcher=humble'), [1, 2, 4, 5]);
    assert.deepEqual(await ids('/api/games?owned=true'), [1, 2, 3, 4, 5]);
  });
});
