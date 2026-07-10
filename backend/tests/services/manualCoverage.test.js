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

  it('lists downloaded folders that match no owned game as extra_folders (by name)', () => {
    const games = [{ id: 1, title: 'Trine 2', slug: 'trine-2' }];
    const r = computeManualCoverage(games, ['trine_2', 'some_unowned_title']);
    assert.deepEqual(r.extra_folders, ['some_unowned_title']);
  });

  it('matches a GOG folder with a _game / _base suffix', () => {
    const games = [
      { id: 1, title: 'Doom 3: BFG Edition', slug: 'doom-3-bfg-edition' },
      { id: 2, title: 'Blade of Darkness', slug: 'blade-of-darkness' },
    ];
    const r = computeManualCoverage(games, ['doom_3_bfg_edition_game', 'blade_of_darkness_base']);
    assert.equal(r.present, 2);
    assert.deepEqual(r.missing, []);
  });

  it('still matches a game literally named "…Game" via the full folder form', () => {
    // Stripping _game must NOT break 'treasure_adventure_game' <-> "Treasure Adventure Game".
    const games = [{ id: 1, title: 'Treasure Adventure Game', slug: 'treasure-adventure-game' }];
    const r = computeManualCoverage(games, ['treasure_adventure_game']);
    assert.equal(r.present, 1);
    assert.deepEqual(r.missing, []);
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

describe('manualCoverage exact gog_slug match + downloadedGameIds', () => {
  const { computeManualCoverage, computeDownloadedIds } = require('../../src/services/manualCoverage');

  it('matches on gog_slug even when title/slug would not', () => {
    // title "Baldur's Gate II: Enhanced Edition" slugifies to baldurs-gate-ii...,
    // which does NOT equal the folder slug — only gog_slug does.
    const games = [
      { id: 1, title: "Baldur's Gate II: Enhanced Edition", slug: 'baldurs-gate-ii-ee', edition_title: null, gog_slug: 'baldurs_gate_2_enhanced_edition' },
    ];
    const r = computeManualCoverage(games, ['baldurs_gate_2_enhanced_edition']);
    assert.equal(r.present, 1);
    assert.equal(r.missing.length, 0);
  });

  it('matches gog_slug against a folder carrying a _game/_base suffix', () => {
    const games = [{ id: 1, title: 'X', slug: 'x', edition_title: null, gog_slug: 'blade_of_darkness' }];
    const r = computeManualCoverage(games, ['blade_of_darkness_base']);
    assert.equal(r.present, 1);
  });

  it('falls back to fuzzy title-slug match when gog_slug is null', () => {
    const games = [{ id: 2, title: 'Ancient Enemy', slug: 'a96de508', edition_title: null, gog_slug: null }];
    const r = computeManualCoverage(games, ['ancient_enemy']);
    assert.equal(r.present, 1);
  });

  it('computeDownloadedIds returns exactly the matched owned game ids', () => {
    const games = [
      { id: 1, title: 'X', slug: 'x', edition_title: null, gog_slug: 'baldurs_gate_2_enhanced_edition' },
      { id: 2, title: 'Missing Game', slug: 'missing-game', edition_title: null, gog_slug: 'missing_game' },
    ];
    const ids = computeDownloadedIds(games, ['baldurs_gate_2_enhanced_edition']);
    assert.deepEqual([...ids], [1]);
  });
});

describe('manualCoverage.normalizeFileEntry (file-mode)', () => {
  const { normalizeFileEntry } = require('../../src/services/manualCoverage');
  const cases = [
    ['AndYetItMovesv1.3.0Setup.exe', 'and-yet-it-moves'],
    ['LoneSurvivor-PC.zip', 'lone-survivor'],
    ['TokiTori_2013-07-03_Windows_1372878397.zip', 'toki-tori'],
    ['voxatron_0.3.5b_setup.exe', 'voxatron'],
    ['2D TreasureHunter.zip', '2d-treasure-hunter'],
    ['Cub3D - A Perspective Shifting Puzzle RPG.zip', 'cub3d-a-perspective-shifting-puzzle-rpg'],
    ['fumiko-windows-64.zip', 'fumiko'],
    ['frisbros-window-64.zip', 'frisbros'],
    ['BladesAdrift.zip', 'blades-adrift'],
    ['Annulus 2.31.zip', 'annulus'],
    ['rumble_v1.0.0_win64.zip', 'rumble'],
    ['Totem 1.06.zip', 'totem'],
  ];
  for (const [input, expected] of cases) {
    it(`normalizes ${input} -> ${expected}`, () => {
      assert.equal(normalizeFileEntry(input), expected);
    });
  }
});

describe('manualCoverage file-mode + aliases + simplifyTitle', () => {
  const { computeDownloadedIds, computeManualCoverage } = require('../../src/services/manualCoverage');

  it('file-mode matches a normalized filename to an owned title', () => {
    const games = [{ id: 1, title: 'Toki Tori', slug: 'toki-tori' }];
    const ids = computeDownloadedIds(
      games,
      ['TokiTori_2013-07-03_Windows_1372878397.zip'],
      { mode: 'file' }
    );
    assert.ok(ids.has(1));
  });

  it('file-mode matches a subtitle-less filename via simplifyTitle', () => {
    const games = [
      { id: 2, title: "Lone Survivor: The Director's Cut", slug: 'lone-survivor-the-directors-cut' },
    ];
    const ids = computeDownloadedIds(games, ['LoneSurvivor-PC.zip'], { mode: 'file' });
    assert.ok(ids.has(2));
  });

  it('alias covers an opaque filename (game present only if its slug === alias slug)', () => {
    const games = [
      { id: 3, title: 'Steel Storm: Burning Retribution', slug: 'steel-storm-burning-retribution' },
      { id: 4, title: 'Unrelated', slug: 'unrelated' },
    ];
    const opts = {
      mode: 'file',
      aliases: { 'steelstorm-br-2.00.02818-release.exe': 'steel-storm-burning-retribution' },
    };
    const ids = computeDownloadedIds(games, ['steelstorm-br-2.00.02818-release.exe'], opts);
    assert.deepEqual([...ids], [3]);
  });

  it('an alias entry that matches a game is NOT reported as extra', () => {
    const games = [
      { id: 3, title: 'Steel Storm: Burning Retribution', slug: 'steel-storm-burning-retribution' },
    ];
    const opts = {
      mode: 'file',
      aliases: { 'steelstorm-br-2.00.02818-release.exe': 'steel-storm-burning-retribution' },
    };
    const r = computeManualCoverage(games, ['steelstorm-br-2.00.02818-release.exe'], opts);
    assert.equal(r.present, 1);
    assert.deepEqual(r.extra_folders, []);
  });

  it('an unmatched file is reported as extra_folders (original name)', () => {
    const games = [{ id: 1, title: 'Toki Tori', slug: 'toki-tori' }];
    const r = computeManualCoverage(games, ['DitV-Windows.zip'], { mode: 'file' });
    assert.deepEqual(r.extra_folders, ['DitV-Windows.zip']);
  });
});
