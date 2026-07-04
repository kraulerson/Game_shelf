const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('migrate Phase 12b sequel guard', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-p12b-sequel.db');

  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
  });
  after(() => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('keeps a sequel pair separate but merges a true edition pair', () => {
    delete require.cache[require.resolve('../../src/db/migrate')];
    let { runMigrations } = require('../../src/db/migrate');
    let db = runMigrations(testDbPath);
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (1,'steam','Steam',1,1)").run();
    // Sequel pair (must stay separate): portal / portal-2
    db.prepare("INSERT INTO games (title,slug,description) VALUES ('Portal','portal','d')").run();
    db.prepare("INSERT INTO games (title,slug,description) VALUES ('Portal 2','portal-2','d')").run();
    const p1 = db.prepare("SELECT id FROM games WHERE slug='portal'").get();
    const p2 = db.prepare("SELECT id FROM games WHERE slug='portal-2'").get();
    db.prepare("INSERT INTO game_editions (game_id,launcher_id,launcher_game_id,title) VALUES (?,1,'400','Portal')").run(p1.id);
    db.prepare("INSERT INTO game_editions (game_id,launcher_id,launcher_game_id,title) VALUES (?,1,'620','Portal 2')").run(p2.id);
    // Edition pair (must merge): darksiders-ii / darksiders-ii-deathinitive-edition
    db.prepare("INSERT INTO games (title,slug,description) VALUES ('Darksiders II','darksiders-ii','d')").run();
    db.prepare("INSERT INTO games (title,slug,description) VALUES ('Darksiders II Deathinitive Edition','darksiders-ii-deathinitive-edition','d')").run();
    const d1 = db.prepare("SELECT id FROM games WHERE slug='darksiders-ii'").get();
    const d2 = db.prepare("SELECT id FROM games WHERE slug='darksiders-ii-deathinitive-edition'").get();
    db.prepare("INSERT INTO game_editions (game_id,launcher_id,launcher_game_id,title) VALUES (?,1,'50650','Darksiders II')").run(d1.id);
    db.prepare("INSERT INTO game_editions (game_id,launcher_id,launcher_game_id,title) VALUES (?,1,'388410','Darksiders II Deathinitive Edition')").run(d2.id);
    db.close();

    // Re-run migrations: Phase 12b executes over the inserted rows.
    delete require.cache[require.resolve('../../src/db/migrate')];
    ({ runMigrations } = require('../../src/db/migrate'));
    db = runMigrations(testDbPath);

    const portalGames = db.prepare("SELECT COUNT(*) c FROM games WHERE slug IN ('portal','portal-2')").get().c;
    assert.equal(portalGames, 2, 'Portal and Portal 2 stay separate');
    const darkGames = db.prepare("SELECT COUNT(*) c FROM games WHERE slug IN ('darksiders-ii','darksiders-ii-deathinitive-edition')").get().c;
    assert.equal(darkGames, 1, 'Darksiders II + Deathinitive merged to one game');
    db.close();
  });
});
