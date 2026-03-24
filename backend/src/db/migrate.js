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

  // Phase 11 migration: edition_tiers table
  const hasEditionTiers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='edition_tiers'"
  ).get();
  if (!hasEditionTiers) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS edition_tiers (
        id INTEGER PRIMARY KEY,
        game_edition_id INTEGER NOT NULL REFERENCES game_editions(id) ON DELETE CASCADE,
        tier INTEGER NOT NULL DEFAULT 0,
        is_display_edition INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(game_edition_id)
      );
      CREATE INDEX IF NOT EXISTS idx_edition_tiers_lookup
        ON edition_tiers(game_edition_id, tier, is_display_edition);
    `);

    // Initial population: detect tiers for all existing editions
    const { detectEditionTier } = require('../utils/editionTier');
    const editions = db.prepare('SELECT id, title FROM game_editions WHERE title IS NOT NULL').all();
    const insertTier = db.prepare(
      'INSERT OR IGNORE INTO edition_tiers (game_edition_id, tier) VALUES (?, ?)'
    );
    const populateAll = db.transaction((eds) => {
      for (const ed of eds) {
        insertTier.run(ed.id, detectEditionTier(ed.title));
      }
    });
    populateAll(editions);
    console.log(`[Migration] Phase 11: Created edition_tiers, populated ${editions.length} rows`);
  }

  // Phase 11b: consolidate duplicate games rows (same title, different IDs)
  // This fixes data created when Epic/other launchers enriched separately from Steam
  const dupeGroups = db.prepare(`
    SELECT title, COUNT(*) as c FROM games GROUP BY title HAVING c > 1
  `).all();
  if (dupeGroups.length > 0) {
    let merged = 0;
    const consolidate = db.transaction(() => {
      for (const { title } of dupeGroups) {
        // Pick canonical game: prefer one with description, then cover_url, then lowest id
        const candidates = db.prepare(`
          SELECT id, title, slug,
            CASE WHEN description IS NOT NULL THEN 1 ELSE 0 END as has_desc,
            CASE WHEN cover_url IS NOT NULL THEN 1 ELSE 0 END as has_cover
          FROM games WHERE title = ? ORDER BY has_desc DESC, has_cover DESC, id ASC
        `).all(title);

        const canonical = candidates[0];
        const dupes = candidates.slice(1);

        for (const dupe of dupes) {
          // Re-link editions
          db.prepare('UPDATE game_editions SET game_id = ? WHERE game_id = ?').run(canonical.id, dupe.id);
          // Re-link genres (ignore conflicts)
          db.prepare('INSERT OR IGNORE INTO game_genres (game_id, genre_id) SELECT ?, genre_id FROM game_genres WHERE game_id = ?').run(canonical.id, dupe.id);
          db.prepare('DELETE FROM game_genres WHERE game_id = ?').run(dupe.id);
          // Re-link tags (ignore conflicts)
          db.prepare('INSERT OR IGNORE INTO game_tags (game_id, tag_id) SELECT ?, tag_id FROM game_tags WHERE game_id = ?').run(canonical.id, dupe.id);
          db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(dupe.id);
          // Delete dupe game
          db.prepare('DELETE FROM games WHERE id = ?').run(dupe.id);
          merged++;
        }
      }
    });
    consolidate();
    console.log(`[Migration] Phase 11b: Consolidated ${merged} duplicate game rows across ${dupeGroups.length} titles`);
  }

  // Phase 12: Epic catalog resolution columns
  const geColsP12 = db.pragma('table_info(game_editions)');
  if (!geColsP12.some(c => c.name === 'epic_namespace')) {
    db.exec('ALTER TABLE game_editions ADD COLUMN epic_namespace TEXT');
    db.exec('ALTER TABLE game_editions ADD COLUMN epic_catalog_id TEXT');
    db.exec('ALTER TABLE game_editions ADD COLUMN sandbox_type TEXT');
    console.log('[Migration] Phase 12: Added epic_namespace, epic_catalog_id, sandbox_type columns');
  }
  if (!geColsP12.some(c => c.name === 'parent_edition_id')) {
    db.exec('ALTER TABLE game_editions ADD COLUMN parent_edition_id INTEGER REFERENCES game_editions(id)');
    console.log('[Migration] Phase 12: Added parent_edition_id column');
  }

  return db;
}

module.exports = { runMigrations };
