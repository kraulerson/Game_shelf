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
      // Note: game_id may or may not be set due to fire-and-forget enrichAll() after sync
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
    const creds = encrypt(JSON.stringify({ access_token: 'old', refresh_token: 'expired' }));
    db.prepare(
      'INSERT OR REPLACE INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('gog', 'GOG', creds);

    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => { throw new Error('Token refresh failed'); };

    try {
      const jobId = await syncLauncher('gog', db);
      const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'failed');
      assert.ok(job.error_message, 'error_message should be set');
    } finally {
      axios.get = originalGet;
    }
  });

  it('syncLauncher should unwrap session even when credentials are not refreshed', async () => {
    // REGRESSION: syncEngine must unwrap { session, updatedCredentials: null }
    // so fetchOwnedGames receives { access_token, ... } not the wrapper object.
    const { encrypt } = require('../../src/utils/encrypt');
    const epicCreds = encrypt(JSON.stringify({
      access_token: 'test_epic_token',
      token_type: 'bearer',
      refresh_token: 'test_refresh',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
      account_id: 'test_account',
    }));
    db.prepare(
      'INSERT OR REPLACE INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('epic', 'Epic Games', epicCreds);

    const axios = require('axios');
    const originalGet = axios.get;
    let capturedHeaders = null;
    axios.get = async (url, opts) => {
      if (!capturedHeaders && opts?.headers?.Authorization) {
        capturedHeaders = opts.headers;
      }
      return { data: { records: [], responseMetadata: {} } };
    };

    try {
      await syncLauncher('epic', db);
      assert.ok(capturedHeaders, 'Should have made an API call with headers');
      assert.ok(
        capturedHeaders.Authorization.includes('test_epic_token'),
        `Authorization header must contain the actual token, got: ${capturedHeaders.Authorization}`
      );
      assert.ok(
        !capturedHeaders.Authorization.includes('undefined'),
        'Authorization header must not contain "undefined"'
      );
    } finally {
      axios.get = originalGet;
    }
  });

  it('syncLauncher should create edition_tiers for synced games', async () => {
    const axios = require('axios');
    const originalGet = axios.get;
    axios.get = async () => ({
      data: { response: { games: [
        { appid: 999, name: 'Fallout NV GOTY', playtime_forever: 100 },
      ]}}
    });

    try {
      await syncLauncher('steam', db);
      const ed = db.prepare('SELECT id FROM game_editions WHERE launcher_game_id = ?').get('999');
      assert.ok(ed, 'Edition should exist');
      const tier = db.prepare('SELECT tier FROM edition_tiers WHERE game_edition_id = ?').get(ed.id);
      assert.ok(tier, 'Tier row should exist');
      assert.equal(tier.tier, 4); // GOTY = tier 4
    } finally {
      axios.get = originalGet;
    }
  });

  it('syncLauncher should mark job as awaiting_otp when launcher throws OTP_REQUIRED', async () => {
    // REGRESSION: OTP_REQUIRED errors must not be treated as failures.
    // They indicate the launcher needs a 2FA code — the job should park
    // as awaiting_otp with the instruction text in error_message.
    const { encrypt } = require('../../src/utils/encrypt');
    const creds = encrypt(JSON.stringify({ username: 'u', password: 'p' }));
    db.prepare(
      'INSERT OR REPLACE INTO launchers (name, display_name, enabled, credentials_json) VALUES (?, ?, 1, ?)'
    ).run('humble', 'Humble Bundle', creds);

    const axios = require('axios');
    const originalPost = axios.post;
    axios.post = async () => ({
      data: { humble_guard_required: true, success: false },
      headers: {},
    });

    try {
      const jobId = await syncLauncher('humble', db);
      const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'awaiting_otp', 'Job should be awaiting_otp, not failed');
      assert.ok(job.error_message.includes('code emailed'), `Instruction text should mention email, got: ${job.error_message}`);
      assert.equal(job.completed_at, null, 'completed_at should remain null while awaiting OTP');
    } finally {
      axios.post = originalPost;
    }
  });

  it('syncLauncher should complete sync when OTP code is provided (Phase 2)', async () => {
    // REGRESSION: When called with an otpCode, Humble should skip the
    // initial guard-less POST and submit the code directly.
    const axios = require('axios');
    const originalPost = axios.post;
    const originalGet = axios.get;
    const postCalls = [];

    axios.post = async (url, data) => {
      const params = Object.fromEntries(data.entries());
      postCalls.push(params);
      if (params.guard && params.guard !== '') {
        return {
          data: { success: true },
          headers: { 'set-cookie': ['_simpleauth_sess=test123; Path=/'] },
        };
      }
      return { data: { humble_guard_required: true, success: false }, headers: {} };
    };
    axios.get = async () => ({ data: [] }); // empty orders

    try {
      const jobId = await syncLauncher('humble', db, 'ABC123');
      const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'success', 'Job should succeed with OTP code');
      // Phase 2 should only make ONE POST (with the guard code), not two
      assert.equal(postCalls.length, 1, 'Should skip initial guard-less POST');
      assert.equal(postCalls[0].guard, 'ABC123', 'Should submit the OTP code as guard');
    } finally {
      axios.post = originalPost;
      axios.get = originalGet;
    }
  });

  it('syncLauncher should fail when launcher is sync-locked', async () => {
    // Lock the launcher
    db.prepare('UPDATE launchers SET sync_locked = 1 WHERE name = ?').run('steam');

    try {
      const jobId = await syncLauncher('steam', db);
      const job = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'failed');
      assert.ok(job.error_message.includes('sync-locked'), 'Error should mention sync-locked');
    } finally {
      // Unlock for subsequent tests
      db.prepare('UPDATE launchers SET sync_locked = 0 WHERE name = ?').run('steam');
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
