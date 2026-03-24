-- Gameshelf Database Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS launchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  credentials_json TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  cover_url TEXT,
  hero_url TEXT,
  icon_url TEXT,
  description TEXT,
  release_year INTEGER,
  developer TEXT,
  publisher TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_editions (
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
  epic_namespace TEXT,
  epic_catalog_id TEXT,
  sandbox_type TEXT,
  parent_edition_id INTEGER REFERENCES game_editions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (launcher_id) REFERENCES launchers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_editions_launcher_game
  ON game_editions(launcher_id, launcher_game_id);

CREATE TABLE IF NOT EXISTS genres (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS game_genres (
  game_id INTEGER NOT NULL,
  genre_id INTEGER NOT NULL,
  PRIMARY KEY (game_id, genre_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_tags (
  game_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (game_id, tag_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  launcher_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  games_found INTEGER DEFAULT 0,
  games_updated INTEGER DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY (launcher_id) REFERENCES launchers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_launcher_id ON sync_jobs(launcher_id);

-- Phase 11: edition tier tracking
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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
