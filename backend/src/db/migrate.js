const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;
const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'changeme123';

function runMigrations(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  db.transaction(() => {
    db.exec(schema);
  })();

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const hash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, BCRYPT_ROUNDS);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      DEFAULT_ADMIN_USER,
      hash
    );
  }

  // Phase 3 migration: update game_editions and sync_jobs
  const gameEditionsCols = db.pragma('table_info(game_editions)');
  const hasTitle = gameEditionsCols.some(c => c.name === 'title');
  const gameIdCol = gameEditionsCols.find(c => c.name === 'game_id');
  const needsMigration = !hasTitle || (gameIdCol && gameIdCol.notnull === 1);

  if (needsMigration) {
    db.transaction(() => {
      db.exec('ALTER TABLE game_editions RENAME TO game_editions_old');
      db.exec(`
        CREATE TABLE game_editions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER,
          launcher_id INTEGER NOT NULL,
          launcher_game_id TEXT,
          title TEXT,
          launcher_url TEXT,
          owned INTEGER NOT NULL DEFAULT 1,
          install_state TEXT,
          playtime_minutes INTEGER DEFAULT 0,
          last_played_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (launcher_id) REFERENCES launchers(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO game_editions (id, game_id, launcher_id, launcher_game_id, launcher_url, owned, install_state, playtime_minutes, last_played_at, created_at)
        SELECT id, game_id, launcher_id, launcher_game_id, launcher_url, owned, install_state, playtime_minutes, last_played_at, created_at
        FROM game_editions_old
      `);
      db.exec('DROP TABLE game_editions_old');
    })();
  }

  // Ensure unique index exists (idempotent)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_game_editions_launcher_game
      ON game_editions(launcher_id, launcher_game_id)
  `);

  // Phase 3: add games_found and games_updated to sync_jobs
  const syncJobsCols = db.pragma('table_info(sync_jobs)');
  if (!syncJobsCols.some(c => c.name === 'games_found')) {
    db.exec('ALTER TABLE sync_jobs ADD COLUMN games_found INTEGER DEFAULT 0');
  }
  if (!syncJobsCols.some(c => c.name === 'games_updated')) {
    db.exec('ALTER TABLE sync_jobs ADD COLUMN games_updated INTEGER DEFAULT 0');
  }

  // Phase 6 migration: add last_enrichment_at to games
  const gamesCols = db.pragma('table_info(games)');
  if (!gamesCols.some(c => c.name === 'last_enrichment_at')) {
    db.exec('ALTER TABLE games ADD COLUMN last_enrichment_at TEXT');
  }

  return db;
}

module.exports = { runMigrations };
