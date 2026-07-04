const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('repairSequelGrouping (Phase 16)', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-phase16.db');
  let db, repair;

  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    delete require.cache[require.resolve('../../src/db/migrate')];
    db = require('../../src/db/migrate').runMigrations(testDbPath);
    ({ repairSequelGrouping: repair } = require('../../src/db/repairSequelGrouping'));

    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (1,'steam','Steam',1,1)").run();

    // Game A: "Portal 2" wrongly holds Portal + Portal 2.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (10,'Portal 2','portal-2')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (100,10,1,'400','Portal')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (101,10,1,'620','Portal 2')").run();

    // Game B: "Darksiders II: Deathinitive Edition" holds Darksiders II + its Deathinitive
    // (keep) plus the original "Darksiders" (must re-home into the Warmastered game).
    db.prepare("INSERT INTO games (id,title,slug) VALUES (20,'Darksiders II: Deathinitive Edition','darksiders-ii-deathinitive-edition')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (200,20,1,'d0','Darksiders')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (201,20,1,'d1','Darksiders II')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (202,20,1,'d2','Darksiders II Deathinitive Edition')").run();

    // Game C: existing "Darksiders: Warmastered Edition" — the re-home target for the original.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (30,'Darksiders: Warmastered Edition','darksiders-warmastered-edition')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (300,30,1,'d3','Darksiders Warmastered Edition')").run();

    // Game D: healthy multi-edition game (must be untouched).
    db.prepare("INSERT INTO games (id,title,slug) VALUES (40,'Trine 2','trine-2')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (400,40,1,'t0','Trine 2')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (401,40,1,'t1','Trine 2: Complete Story')").run();

    // Game E: an IGDB-grouped SAME game whose alt-title carries a number — NOT a
    // prefix pair ("deus-ex-invisible-war" vs "deus-ex-2-invisible-war"). Must stay
    // together: the grouping came from IGDB, not the buggy prefix matcher.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (50,'Deus Ex: Invisible War','deus-ex-invisible-war')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (500,50,1,'dx0','Deus Ex: Invisible War')").run();
    db.prepare("INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title) VALUES (501,50,1,'dx1','Deus Ex 2: Invisible War')").run();
  });
  after(() => {
    if (db) db.close();
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('splits Portal off Portal 2 into its own game', () => {
    const moved = repair(db);
    assert.ok(moved >= 2, `moved ${moved}`);
    const portal = db.prepare('SELECT game_id FROM game_editions WHERE id=100').get();
    assert.notEqual(portal.game_id, 10, 'Portal left the Portal 2 game');
    const portalGame = db.prepare('SELECT slug FROM games WHERE id=?').get(portal.game_id);
    assert.equal(portalGame.slug, 'portal');
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=101').get().game_id, 10, 'Portal 2 stays');
  });

  it('re-homes the original Darksiders into the Warmastered game, keeps II + Deathinitive', () => {
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=200').get().game_id, 30, 'Darksiders -> Warmastered game');
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=201').get().game_id, 20, 'Darksiders II stays');
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=202').get().game_id, 20, 'Deathinitive stays');
  });

  it('leaves the healthy game untouched', () => {
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=400').get().game_id, 40);
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=401').get().game_id, 40);
  });

  it('does NOT split an IGDB-grouped same-game pair whose alt-title has a number', () => {
    // "Deus Ex 2: Invisible War" is not a prefix pair with "Deus Ex: Invisible War"
    // — it must stay grouped, not be re-homed into a bare "deus-ex-2" game.
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=500').get().game_id, 50);
    assert.equal(db.prepare('SELECT game_id FROM game_editions WHERE id=501').get().game_id, 50);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM games WHERE slug='deus-ex-2-invisible-war'").get().c, 0);
  });

  it('is idempotent — a second run moves nothing', () => {
    assert.equal(repair(db), 0);
  });
});
