const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

describe('Amazon parseGamesDb', () => {
  it('should extract games from a SQLite games.db buffer', () => {
    // Create a minimal SQLite DB in a temp file
    const tmpPath = path.join(__dirname, 'test-amazon-games.db');
    const db = new Database(tmpPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS "DbSet" (
        Id TEXT PRIMARY KEY,
        ProductTitle TEXT,
        ProductIdStr TEXT,
        InstallDirectory TEXT,
        Installed INTEGER
      )
    `);
    db.prepare('INSERT INTO DbSet (Id, ProductTitle, ProductIdStr, Installed) VALUES (?, ?, ?, ?)').run(
      'amzn1.adg.product.aaaa-bbbb', 'Ghostwire: Tokyo', 'amzn1.adg.product.aaaa-bbbb', 1
    );
    db.prepare('INSERT INTO DbSet (Id, ProductTitle, ProductIdStr, Installed) VALUES (?, ?, ?, ?)').run(
      'amzn1.adg.product.cccc-dddd', 'Fallout 76', 'amzn1.adg.product.cccc-dddd', 0
    );
    db.close();

    const buffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);

    const { parseGamesDb } = require('../../../src/services/launchers/amazon');
    const games = parseGamesDb(buffer);

    assert.ok(Array.isArray(games), 'should return an array');
    assert.equal(games.length, 2);
    assert.equal(games[0].title, 'Fallout 76');  // sorted alphabetically
    assert.equal(games[1].title, 'Ghostwire: Tokyo');
    assert.ok(games[0].launcher_game_id, 'should have launcher_game_id');
  });

  it('should handle entitlements table as alternative schema', () => {
    const tmpPath = path.join(__dirname, 'test-amazon-entitlements.db');
    const db = new Database(tmpPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS entitlements (
        product_id TEXT PRIMARY KEY,
        product_title TEXT,
        product_type TEXT
      )
    `);
    db.prepare('INSERT INTO entitlements (product_id, product_title, product_type) VALUES (?, ?, ?)').run(
      'amzn1.adg.product.eeee', 'Test Game', 'GAME'
    );
    db.prepare('INSERT INTO entitlements (product_id, product_title, product_type) VALUES (?, ?, ?)').run(
      'amzn1.adg.product.ffff', 'Some DLC', 'DLC'
    );
    db.close();

    const buffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);

    const { parseGamesDb } = require('../../../src/services/launchers/amazon');
    const games = parseGamesDb(buffer);

    assert.equal(games.length, 1, 'should filter out non-GAME entries');
    assert.equal(games[0].title, 'Test Game');
  });

  it('should throw on invalid SQLite data', () => {
    const { parseGamesDb } = require('../../../src/services/launchers/amazon');
    assert.throws(() => parseGamesDb(Buffer.from('not a database')), /Failed to parse/);
  });
});
