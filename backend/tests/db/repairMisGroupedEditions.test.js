const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('repairMisGroupedEditions (issue #10)', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-phase15.db');
  let db, repair;

  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(testDbPath);
    ({ repairMisGroupedEditions: repair } = require('../../src/db/repairMisGroupedEditions'));

    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (2,'epic','Epic',1,2)").run();
    // One mis-grouped game: real DAI GOTY + 6 unrelated Epic games (distinct namespaces).
    db.prepare("INSERT INTO games (id,title,slug) VALUES (?,?,?)")
      .run(900, 'Dragon Age: Inquisition – Game of the Year Edition',
           'dragon-age-inquisition-game-of-the-year-edition');
    const insEd = db.prepare(
      "INSERT INTO game_editions (game_id,launcher_id,launcher_game_id,title,owned,epic_namespace) VALUES (?,2,?,?,1,?)");
    insEd.run(900, 'daigoty', 'Dragon Age: Inquisition – Game of the Year Edition', 'ns-dai'); // real
    const wrong = [
      ['w1', 'Warhammer 40,000: Mechanicus', 'ns1'], ['w2', 'Gloomhaven', 'ns2'],
      ['w3', 'Bloons TD 6', 'ns3'], ['w4', 'Insurmountable', 'ns4'],
      ['w5', 'Unrailed', 'ns5'], ['w6', 'Filament', 'ns6'],
    ];
    for (const [lg, t, ns] of wrong) insEd.run(900, lg, t, ns);
  });

  after(() => {
    if (db) db.close();
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('re-homes the 6 unrelated editions off the mis-grouped game, keeps the real one', () => {
    const moved = repair(db);
    assert.equal(moved, 6);
    const kept = db.prepare("SELECT title FROM game_editions WHERE game_id=900").all().map(r => r.title);
    assert.deepEqual(kept, ['Dragon Age: Inquisition – Game of the Year Edition']);
    const gloom = db.prepare(
      "SELECT g.title FROM games g JOIN game_editions ge ON ge.game_id=g.id WHERE ge.launcher_game_id='w2'").get();
    assert.equal(gloom.title, 'Gloomhaven'); // now its own game
  });

  it('is idempotent — a second run moves nothing', () => {
    assert.equal(repair(db), 0);
  });
});
