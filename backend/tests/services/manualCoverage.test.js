const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// #222: coverage checker for manually-downloaded games (GOG/Humble/Itch/Amazon).
// Diff the owned library per launcher against the game folders the orchestrator
// lists under /lancache/lancache/cache/<Launcher>/, matching by slug.

describe('manualCoverage.folderSlug + computeManualCoverage', () => {
  const { folderSlug, computeManualCoverage } = require('../../src/services/manualCoverage');

  it('normalizes an underscore folder name to a slug', () => {
    assert.equal(folderSlug('alien_breed_2_assault'), 'alien-breed-2-assault');
    assert.equal(folderSlug('akalabeth_world_of_doom'), 'akalabeth-world-of-doom');
  });

  it('marks an owned game present when a folder matches its slug', () => {
    const games = [{ id: 1, title: 'Alien Breed 2: Assault', slug: 'alien-breed-2-assault' }];
    const r = computeManualCoverage(games, ['alien_breed_2_assault', '!downloading']);
    assert.equal(r.total_owned, 1);
    assert.equal(r.present, 1);
    assert.deepEqual(r.missing, []);
  });

  it('reports an owned game with no matching folder as missing', () => {
    const games = [
      { id: 1, title: 'Trine 2', slug: 'trine-2' },
      { id: 2, title: 'Baldurs Gate 3', slug: 'baldurs-gate-3' },
    ];
    const r = computeManualCoverage(games, ['trine_2']);
    assert.equal(r.present, 1);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].title, 'Baldurs Gate 3');
  });

  it('matches on the edition title when the canonical slug differs', () => {
    const games = [{ id: 1, title: 'Some Game', slug: 'some-game', edition_title: 'Alan Wake' }];
    const r = computeManualCoverage(games, ['alan_wake']);
    assert.equal(r.present, 1);
    assert.deepEqual(r.missing, []);
  });

  it('lists downloaded folders that match no owned game as extra_folders', () => {
    const games = [{ id: 1, title: 'Trine 2', slug: 'trine-2' }];
    const r = computeManualCoverage(games, ['trine_2', 'some_random_game']);
    assert.deepEqual(r.extra_folders, ['some-random-game']);
  });

  it('handles an empty folder list (everything missing)', () => {
    const games = [{ id: 1, title: 'Trine 2', slug: 'trine-2' }];
    const r = computeManualCoverage(games, []);
    assert.equal(r.present, 0);
    assert.equal(r.missing.length, 1);
  });
});

describe('manualCoverage.fetchManualCoverage', () => {
  const { fetchManualCoverage } = require('../../src/services/manualCoverage');
  const testDbPath = path.join(__dirname, '..', 'data', 'test-manual-coverage.db');
  let db;

  before(() => {
    for (const s of ['', '-wal', '-shm']) {
      const f = testDbPath + s;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.env.GAMESHELF_DB_PATH = testDbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(testDbPath);
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (5,'gog','GOG',1,3)").run();
    // Two owned GOG games; one is downloaded (folder present), one is not.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (1,'Trine 2','trine-2')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (10,1,5,'g1','Trine 2',1)").run();
    db.prepare("INSERT INTO games (id,title,slug) VALUES (2,'Baldurs Gate 3','baldurs-gate-3')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (11,2,5,'g2','Baldurs Gate 3',1)").run();
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
      callOrchestrator: async (method, urlPath) => {
        calls.push({ method, path: urlPath });
        if (response instanceof Error) throw response;
        return response;
      },
    };
  }

  it('diffs the owned GOG library against the orchestrator folder listing', async () => {
    const client = stubClient({ status: 200, data: { launcher: 'GOG', present: true, entries: ['trine_2'] } });
    const r = await fetchManualCoverage(db, 'GOG', { client });
    assert.equal(client.calls[0].path, '/api/v1/manual-downloads/GOG');
    assert.equal(r.launcher, 'GOG');
    assert.equal(r.total_owned, 2);
    assert.equal(r.present, 1);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].title, 'Baldurs Gate 3');
  });

  it('throws with the orchestrator status on a non-200', async () => {
    const client = stubClient({ status: 503, data: { detail: 'agent unavailable' } });
    await assert.rejects(() => fetchManualCoverage(db, 'GOG', { client }), { status: 503 });
  });

  it('reports present_folder false when the launcher folder does not exist yet', async () => {
    const client = stubClient({ status: 200, data: { launcher: 'Humble', present: false, entries: [] } });
    const r = await fetchManualCoverage(db, 'Humble', { client });
    assert.equal(r.present_folder, false);
    assert.equal(r.total_owned, 0); // no humble launcher owned games seeded
  });
});
