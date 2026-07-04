const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// #223/#224: the cache badge for a multi-launcher game must reflect the
// highest-priority OWNED launcher (respecting the manual is_display_edition
// override), NOT whichever edition happens to be the highest *tier*.
describe('resolveCacheLauncher (#223 multi-launcher cache badge)', () => {
  const testDbPath = path.join(__dirname, '..', 'data', 'test-cache-launcher.db');
  let db, resolveCacheLauncher;

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
    ({ resolveCacheLauncher } = require('../../src/services/cacheLauncher'));

    const insL = db.prepare(
      'INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (?,?,?,1,?)'
    );
    // steam/epic/gog left at the DEFAULT priority 0 (the unconfigured real case)
    // so the canonical order (steam>epic>gog) is what breaks the tie.
    insL.run(1, 'steam', 'Steam', 0);
    insL.run(2, 'epic', 'Epic', 0);
    insL.run(3, 'gog', 'GOG', 0);
    // ea/amazon carry EXPLICIT user priorities that DISAGREE with the canonical
    // order (canonical: ea=4 < amazon=9; user: amazon=1 < ea=5) so a passing
    // test proves user priority is honoured BEFORE the canonical fallback.
    insL.run(4, 'ea', 'EA', 5);
    insL.run(5, 'amazon', 'Amazon', 1);

    const insEd = db.prepare(
      'INSERT INTO game_editions (id,game_id,launcher_id,launcher_game_id,title,owned) VALUES (?,?,?,?,?,1)'
    );

    // 100 Portal: Steam + GOG, priorities tie at 0 -> Steam wins (canonical). #223 bug.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (100,'Portal','portal')").run();
    insEd.run(1000, 100, 1, 'steam-portal', 'Portal');
    insEd.run(1001, 100, 3, 'gog-portal', 'Portal');

    // 200 Celeste: Epic + Steam, tie -> Steam wins over Epic (canonical).
    db.prepare("INSERT INTO games (id,title,slug) VALUES (200,'Celeste','celeste')").run();
    insEd.run(2000, 200, 2, 'epic-celeste', 'Celeste');
    insEd.run(2001, 200, 1, 'steam-celeste', 'Celeste');

    // 300 Bastion: Steam + GOG, but the GOG edition is manually promoted.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (300,'Bastion','bastion')").run();
    insEd.run(3000, 300, 1, 'steam-bastion', 'Bastion');
    insEd.run(3001, 300, 3, 'gog-bastion', 'Bastion');
    db.prepare('INSERT INTO edition_tiers (game_edition_id,tier,is_display_edition) VALUES (3001,0,1)').run();

    // 400 Conflict: EA(priority 5) + Amazon(priority 1). Amazon wins on the
    // explicit user priority even though EA ranks better canonically.
    db.prepare("INSERT INTO games (id,title,slug) VALUES (400,'Conflict','conflict')").run();
    insEd.run(4000, 400, 4, 'ea-conflict', 'Conflict');
    insEd.run(4001, 400, 5, 'amazon-conflict', 'Conflict');
  });

  after(() => {
    if (db) db.close();
    for (const s of ['', '-wal', '-shm']) {
      const f = testDbPath + s;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('picks Steam over GOG when priorities tie (canonical order) — the #223 bug', () => {
    const r = resolveCacheLauncher(db, 100);
    assert.equal(r.launcher_name, 'steam');
    assert.equal(r.launcher_game_id, 'steam-portal');
  });

  it('picks Steam over Epic when priorities tie', () => {
    assert.equal(resolveCacheLauncher(db, 200).launcher_name, 'steam');
  });

  it('honours the manual is_display_edition override', () => {
    const r = resolveCacheLauncher(db, 300);
    assert.equal(r.launcher_name, 'gog');
    assert.equal(r.launcher_game_id, 'gog-bastion');
  });

  it('honours explicit user priority ahead of the canonical order', () => {
    const r = resolveCacheLauncher(db, 400);
    assert.equal(r.launcher_name, 'amazon');
    assert.equal(r.launcher_game_id, 'amazon-conflict');
  });

  it('returns null for a null/absent gameId', () => {
    assert.equal(resolveCacheLauncher(db, null), null);
  });
});
