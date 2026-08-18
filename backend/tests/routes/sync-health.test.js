const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-jwt-secret-sync-health';

describe('GET /api/sync/health', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-sync-health.db');
  let app;
  let db;

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
    ({ app, db } = require('../../src/server'));

    const recent = new Date(Date.now() - 3600000).toISOString();
    const ancient = new Date(Date.now() - 200 * 3600000).toISOString();

    const ins = db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, priority, credentials_json, last_sync_at) ' +
      'VALUES (?, ?, 1, ?, ?, ?)'
    );
    ins.run('steam', 'Steam', 1, 'enc', recent);
    ins.run('humble', 'Humble', 2, 'enc', recent);
    ins.run('ubisoft', 'Ubisoft', 3, 'enc', ancient);
    // Configured-but-unused launcher: must never raise an alert.
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, priority) VALUES (?, ?, 1, ?)'
    ).run('xbox', 'Xbox', 4);

    const id = n => db.prepare('SELECT id FROM launchers WHERE name = ?').get(n).id;
    const job = db.prepare(
      'INSERT INTO sync_jobs (launcher_id, status, completed_at, error_message) VALUES (?, ?, ?, ?)'
    );
    job.run(id('steam'), 'success', recent, null);
    job.run(id('humble'), 'failed', recent, 'Humble session expired or invalid.');
    // Ubisoft's latest job looks FINE — it is stale only by last_sync_at. This is
    // the real-world shape that hid a four-month outage.
    job.run(id('ubisoft'), 'success', ancient, null);
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  const authCookie = () =>
    `gameshelf_session=${jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '1h' })}`;

  it('requires auth', async () => {
    const res = await makeFetch(app, '/api/sync/health');
    assert.equal(res.status, 401);
  });

  it('reports unhealthy and names exactly the launchers needing attention', async () => {
    const res = await makeFetch(app, '/api/sync/health', { headers: { Cookie: authCookie() } });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.healthy, false);
    assert.deepEqual(body.problems.map(p => p.name).sort(), ['humble', 'ubisoft']);

    const humble = body.problems.find(p => p.name === 'humble');
    assert.equal(humble.status, 'failed');
    assert.match(humble.detail, /session expired/i);

    const ubisoft = body.problems.find(p => p.name === 'ubisoft');
    assert.equal(ubisoft.status, 'stale', 'a launcher whose last success has aged out is stale');
  });

  it('reports every launcher so the UI can render full state', async () => {
    const res = await makeFetch(app, '/api/sync/health', { headers: { Cookie: authCookie() } });
    const body = await res.json();
    assert.deepEqual(
      body.launchers.map(l => l.name).sort(),
      ['humble', 'steam', 'ubisoft', 'xbox']
    );
    assert.equal(body.launchers.find(l => l.name === 'steam').status, 'ok');
    assert.equal(body.launchers.find(l => l.name === 'xbox').status, 'not_configured');
  });
});

function makeFetch(app, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${urlPath}`, options)
        .then(resolve)
        .catch(reject)
        .finally(() => server.close());
    });
  });
}
