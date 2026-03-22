const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('Sync engine', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-sync-engine.db');
  let db;
  let syncLauncher, syncAll;

  before(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;

    delete require.cache[require.resolve('../../src/db/migrate')];
    const { runMigrations } = require('../../src/db/migrate');
    db = runMigrations(testDbPath);

    // Insert a test launcher with encrypted credentials
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ api_key: 'test-key', steamid64: '123' }));
    db.prepare(
      'INSERT INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('steam', 'Steam', creds);

    ({ syncLauncher, syncAll } = require('../../src/services/syncEngine'));
  });

  after(() => {
    if (db) db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('syncLauncher should create a sync_jobs row and upsert games', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => ({
      data: { response: { games: [
        { appid: 440, name: 'TF2', playtime_forever: 100 },
      ]}}
    });

    try {
      const jobId = await syncLauncher('steam', db);
      assert.ok(jobId, 'Should return a job ID');

      const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'success');
      assert.equal(job.games_found, 1);

      const edition = db.prepare(
        'SELECT * FROM game_editions WHERE launcher_game_id = ?'
      ).get('440');
      assert.ok(edition, 'Should have created a game_edition');
      assert.equal(edition.title, 'TF2');
      assert.equal(edition.playtime_minutes, 100);
      assert.equal(edition.owned, 1);
      assert.equal(edition.game_id, null);
    } finally {
      axios.get = originalGet;
    }
  });

  it('syncLauncher should mark missing games as owned=0', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => ({
      data: { response: { games: [
        { appid: 570, name: 'Dota 2', playtime_forever: 200 },
      ]}}
    });

    try {
      await syncLauncher('steam', db);

      const tf2 = db.prepare('SELECT owned FROM game_editions WHERE launcher_game_id = ?').get('440');
      assert.equal(tf2.owned, 0, 'TF2 should be marked as not owned');

      const dota = db.prepare('SELECT owned FROM game_editions WHERE launcher_game_id = ?').get('570');
      assert.equal(dota.owned, 1, 'Dota 2 should be owned');
    } finally {
      axios.get = originalGet;
    }
  });

  it('syncLauncher should handle errors gracefully', async () => {
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ username: 'u', password: 'p' }));
    db.prepare(
      'INSERT OR IGNORE INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', creds);

    const axios = require('axios');
    const originalPost = axios.post;
    axios.post = async () => { throw new Error('Auth failed'); };

    try {
      const jobId = await syncLauncher('gog', db);
      const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'failed');
      assert.ok(job.error_message.includes('Auth failed'));
    } finally {
      axios.post = originalPost;
    }
  });

  it('syncLauncher should update launchers.last_sync_at on success', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => ({
      data: { response: { games: [
        { appid: 440, name: 'TF2', playtime_forever: 100 },
      ]}}
    });

    try {
      await syncLauncher('steam', db);
      const launcher = db.prepare('SELECT last_sync_at FROM launchers WHERE name = ?').get('steam');
      assert.ok(launcher.last_sync_at, 'last_sync_at should be set');
    } finally {
      axios.get = originalGet;
    }
  });
});
