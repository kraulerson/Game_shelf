const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('enrichGame cross-launcher sequel guard', () => {
  const testDbPath = path.join(__dirname, '..', '..', 'data', 'test-enrich-sequel.db');
  let db, enrichGame;

  before(() => {
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
    process.env.GAMESHELF_ENCRYPTION_KEY = 'a]V3$k9Lm!pQ2rZ&wX8yB#dF5gH7jN0s';
    process.env.GAMESHELF_JWT_SECRET = 'test-jwt';
    process.env.GAMESHELF_DB_PATH = testDbPath;
    // No IGDB creds — enrichGame falls straight to the cross-launcher / minimal path.
    delete require.cache[require.resolve('../../../src/db/migrate')];
    db = require('../../../src/db/migrate').runMigrations(testDbPath);
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (1,'steam','Steam',1,1)").run();
    db.prepare("INSERT INTO launchers (id,name,display_name,enabled,priority) VALUES (2,'epic','Epic',1,2)").run();
    ({ enrichGame } = require('../../../src/services/metadata/enrichGame'));
  });
  after(() => {
    if (db) db.close();
    for (const s of ['', '-wal', '-shm']) { const f = testDbPath + s; if (fs.existsSync(f)) fs.unlinkSync(f); }
  });

  it('does NOT cross-match a sequel onto its predecessor game', async () => {
    // An enriched "Portal 2" game already exists (has description).
    db.prepare("INSERT INTO games (title, slug, description) VALUES ('Portal 2','portal-2','desc')").run();
    const g = db.prepare("SELECT id FROM games WHERE slug='portal-2'").get();
    db.prepare("INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (1,'400','Portal')").run();
    const ed = db.prepare("SELECT id FROM game_editions WHERE launcher_game_id='400'").get();

    await enrichGame(ed.id, db);

    const row = db.prepare('SELECT game_id FROM game_editions WHERE id = ?').get(ed.id);
    assert.ok(row.game_id, 'game_id set');
    assert.notEqual(row.game_id, g.id, 'Portal must NOT land on the Portal 2 game');
    const own = db.prepare('SELECT slug FROM games WHERE id = ?').get(row.game_id);
    assert.equal(own.slug, 'portal', 'Portal gets its own game');
  });

  it('DOES cross-match a true edition across launchers', async () => {
    db.prepare("INSERT INTO games (title, slug, description) VALUES ('Torchlight II','torchlight-ii','desc')").run();
    const g = db.prepare("SELECT id FROM games WHERE slug='torchlight-ii'").get();
    db.prepare("INSERT INTO game_editions (launcher_id, launcher_game_id, title) VALUES (2,'tl2','Torchlight II')").run();
    const ed = db.prepare("SELECT id FROM game_editions WHERE launcher_game_id='tl2'").get();

    await enrichGame(ed.id, db);

    const row = db.prepare('SELECT game_id FROM game_editions WHERE id = ?').get(ed.id);
    assert.equal(row.game_id, g.id, 'Torchlight II (Epic) joins the existing Torchlight II game');
  });
});
