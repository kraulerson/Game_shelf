const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Cross-launcher exclusions (Piece 3): an Epic game that is ALSO owned on Steam
// (a shared game_id with a Steam edition) is redundant to prefill on Epic —
// Steam self-prefills. This service computes that set and pushes it to the
// orchestrator so its Epic scheduled prefill skips the Epic copies.

describe('crossLauncherExclusions.computeSteamCoveredEpicAppIds', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-cross-launcher.db');
  let db, compute;

  before(() => {
    for (const s of ['', '-wal', '-shm']) {
      const f = testDbPath + s;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(testDbPath);
    ({ computeSteamCoveredEpicAppIds: compute } = require('../../src/services/crossLauncherExclusions'));

    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (1,'steam','Steam',1,1)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (2,'epic','Epic',1,2)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (3,'gog','GOG',1,3)").run();

    // Game 10: owned on BOTH Steam and Epic -> the Epic copy ('epic-cs') is covered.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (10,'Counter-Strike','counter-strike')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (100,10,1,'440','CS (Steam)')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (101,10,2,'epic-cs','CS (Epic)')").run();

    // Game 20: Epic ONLY -> must NOT be covered (Steam doesn't have it).
    db.prepare("INSERT INTO games (id,title,slug) VALUES (20,'Alan Wake','alan-wake')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (200,20,2,'epic-only','Alan Wake (Epic)')").run();

    // Game 30: Steam ONLY -> nothing Epic to return.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (30,'Dota 2','dota-2')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (300,30,1,'570','Dota 2 (Steam)')").run();

    // Game 40: Epic + GOG (no Steam) -> NOT covered; only Steam coverage counts.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (40,'The Witcher 3','the-witcher-3')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (400,40,2,'epic-w3','W3 (Epic)')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (401,40,3,'gog-w3','W3 (GOG)')").run();

    // Game 50: ungrouped Epic edition (game_id NULL) -> excluded (no coverage decision).
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (500,NULL,2,'epic-orphan','Orphan (Epic)')").run();

    // Game 60: Steam + TWO distinct Epic editions -> both Epic app_ids covered.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (60,'Borderlands 3','borderlands-3')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (600,60,1,'397540','BL3 (Steam)')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (601,60,2,'epic-bl3-a','BL3 (Epic)')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (602,60,2,'epic-bl3-b','BL3 Deluxe (Epic)')").run();

    // Game 70: Steam + Epic, operator OVERRODE prefill to the Epic edition ->
    // its Epic app_id must NOT be covered (Epic should get prefilled instead).
    db.prepare("INSERT INTO games (id,title,slug) VALUES (70,'Override Game','override-game')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (700,70,1,'700steam','OG (Steam)')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (701,70,2,'epic-override','OG (Epic)')").run();
    db.prepare("INSERT INTO edition_tiers (game_edition_id, is_prefill_edition) VALUES (701, 1)").run();
  });

  after(() => {
    if (db) db.close();
    for (const s of ['', '-wal', '-shm']) {
      const f = testDbPath + s;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('returns the Epic app_id of a game also owned on Steam', () => {
    const ids = compute(db);
    assert.ok(ids.includes('epic-cs'));
  });

  it('does NOT return the Steam app_id, only the Epic one', () => {
    const ids = compute(db);
    assert.ok(!ids.includes('440'));
    assert.ok(!ids.includes('570'));
  });

  it('excludes an Epic-only game (not on Steam)', () => {
    assert.ok(!compute(db).includes('epic-only'));
  });

  it('excludes an Epic game covered only on GOG (Steam coverage only)', () => {
    assert.ok(!compute(db).includes('epic-w3'));
  });

  it('excludes an ungrouped Epic edition (game_id NULL)', () => {
    assert.ok(!compute(db).includes('epic-orphan'));
  });

  it('returns both Epic editions when a game has two, deduped + sorted', () => {
    const ids = compute(db);
    assert.ok(ids.includes('epic-bl3-a'));
    assert.ok(ids.includes('epic-bl3-b'));
    // deterministic: sorted, no duplicates
    assert.deepEqual(ids, [...new Set(ids)].sort());
  });

  it('returns exactly the covered Epic set', () => {
    assert.deepEqual(compute(db).sort(), ['epic-bl3-a', 'epic-bl3-b', 'epic-cs']);
  });

  it('excludes an Epic edition the operator chose to prefill (is_prefill_edition=1)', () => {
    const ids = compute(db);
    assert.ok(!ids.includes('epic-override'), 'overridden Epic edition is NOT in the covered set');
    assert.ok(ids.includes('epic-cs'), 'a normal Steam+Epic game is still covered by default');
  });
});

describe('crossLauncherExclusions.syncCrossLauncherExclusions', () => {
  const { syncCrossLauncherExclusions } = require('../../src/services/crossLauncherExclusions');

  // Minimal fake db: compute is exercised in the suite above, so here we only
  // need the query to run. Reuse a real migrated DB with one covered pair.
  const testDbPath = path.join(__dirname, '..', 'data', 'test-cross-launcher-sync.db');
  let db;

  before(() => {
    for (const s of ['', '-wal', '-shm']) {
      const f = testDbPath + s;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_DB_PATH = testDbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(testDbPath);
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (1,'steam','Steam',1,1)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (2,'epic','Epic',1,2)").run();
    db.prepare("INSERT INTO games (id,title,slug) VALUES (10,'CS','cs')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (100,10,1,'440','CS (Steam)')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (101,10,2,'epic-cs','CS (Epic)')").run();
  });

  after(() => {
    if (db) db.close();
    for (const s of ['', '-wal', '-shm']) {
      const f = testDbPath + s;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  function stubClient(response) {
    const calls = [];
    return {
      calls,
      callOrchestrator: async (method, urlPath, opts) => {
        calls.push({ method, path: urlPath, opts });
        if (response instanceof Error) throw response;
        return response;
      },
    };
  }

  it('PUTs the computed app_ids to the gameshelf reconcile endpoint', async () => {
    const client = stubClient({ status: 200, data: { platform: 'epic', added: 1, removed: 0, total: 1 } });
    await syncCrossLauncherExclusions(db, { client });
    assert.equal(client.calls.length, 1);
    const call = client.calls[0];
    assert.equal(call.method, 'PUT');
    assert.equal(call.path, '/api/v1/prefill-exclusions/gameshelf/epic');
    assert.deepEqual(call.opts.data, { app_ids: ['epic-cs'] });
  });

  it('returns the pushed count and the orchestrator response', async () => {
    const client = stubClient({ status: 200, data: { platform: 'epic', added: 1, removed: 0, total: 1 } });
    const result = await syncCrossLauncherExclusions(db, { client });
    assert.equal(result.pushed, 1);
    assert.equal(result.total, 1);
  });

  it('throws with the orchestrator status on a non-200 response', async () => {
    const client = stubClient({ status: 503, data: { detail: 'database unavailable' } });
    await assert.rejects(() => syncCrossLauncherExclusions(db, { client }), { status: 503 });
  });

  it('propagates an offline transport error', async () => {
    const offline = Object.assign(new Error('orchestrator offline'), { status: 503 });
    const client = stubClient(offline);
    await assert.rejects(() => syncCrossLauncherExclusions(db, { client }), { status: 503 });
  });
});
