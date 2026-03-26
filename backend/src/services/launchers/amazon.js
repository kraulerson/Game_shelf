const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
const BaseLauncher = require('./base');

/**
 * Parse an Amazon Games games.db SQLite file and extract game entries.
 * Supports two known schemas:
 *   - DbSet table (ProductTitle, ProductIdStr)
 *   - entitlements table (product_id, product_title, product_type)
 */
function parseGamesDb(buffer) {
  const tmpPath = path.join(os.tmpdir(), `amazon-games-${Date.now()}.db`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    const db = new Database(tmpPath, { readonly: true });

    let games;

    // Check which table exists
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map(r => r.name.toLowerCase());

    if (tables.includes('dbset')) {
      const rows = db.prepare(
        'SELECT ProductIdStr as product_id, ProductTitle as title FROM DbSet WHERE ProductTitle IS NOT NULL'
      ).all();
      games = rows.map(r => ({
        launcher_game_id: r.product_id || r.title,
        title: r.title,
      }));
    } else if (tables.includes('entitlements')) {
      const rows = db.prepare(
        "SELECT product_id, product_title as title FROM entitlements WHERE product_type = 'GAME'"
      ).all();
      games = rows.map(r => ({
        launcher_game_id: r.product_id,
        title: r.title,
      }));
    } else {
      db.close();
      throw new Error('No recognized table found (expected DbSet or entitlements)');
    }

    db.close();
    games.sort((a, b) => a.title.localeCompare(b.title));
    return games;
  } catch (err) {
    if (err.message.includes('No recognized table')) throw err;
    if (err.message.includes('Failed to parse')) throw err;
    throw new Error('Failed to parse games.db: ' + err.message);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

class AmazonLauncher extends BaseLauncher {
  async fetchOwnedGames() {
    throw new Error('Amazon Games uses file import only — no API sync available.');
  }
}

module.exports = AmazonLauncher;
module.exports.parseGamesDb = parseGamesDb;
