'use strict';

// #223/#224 — pick the launcher whose cache status represents a (possibly
// multi-launcher) game. A game owned on Steam + Epic + GOG should show the
// cache status of the launcher you'd actually prefill, not whichever edition
// is the fanciest *tier*. Order of preference:
//   1. the manually-promoted edition (edition_tiers.is_display_edition)
//   2. the explicit user launcher priority (launchers.priority ASC; lower wins)
//   3. a canonical launcher order (Steam > Epic > GOG > ...) — the tiebreak
//      when priorities are all still at their DEFAULT 0 (unconfigured)
//   4. edition tier, then id, for full determinism
//
// This is intentionally independent of the *display* edition pick in
// routes/games.js (which is tier-driven for title/art): cache status follows
// the launcher, display follows the best edition.

// Lower number = higher preference. Mirrors Game_shelf's AVAILABLE_LAUNCHERS
// order and #224's default priority (Steam > Epic > GOG).
const CANONICAL_ORDER_SQL = `CASE l.name
  WHEN 'steam' THEN 1
  WHEN 'epic' THEN 2
  WHEN 'gog' THEN 3
  WHEN 'ea' THEN 4
  WHEN 'ubisoft' THEN 5
  WHEN 'humble' THEN 6
  WHEN 'itchio' THEN 7
  WHEN 'xbox' THEN 8
  WHEN 'amazon' THEN 9
  ELSE 99 END`;

// A launcher's EFFECTIVE display priority. priority is user-set (1 = highest); the
// default 0 means "unranked" and must sort LAST — otherwise a never-ranked launcher
// (0) outranks every explicitly-ranked one and hijacks the badge/display. When 0 is
// pushed last, CANONICAL_ORDER_SQL (Steam>Epic>...>Amazon) governs unranked launchers,
// so lancache launchers win by default. Assumes the launchers table is aliased `l`.
const EFFECTIVE_PRIORITY_SQL = `CASE WHEN l.priority = 0 THEN 999 ELSE l.priority END`;

/**
 * Resolve the launcher (name + launcher_game_id) whose cache status should be
 * shown for a grouped game.
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} gameId  games.id (null for an ungrouped single edition)
 * @returns {{launcher_name: string, launcher_game_id: string}|null}
 */
function resolveCacheLauncher(db, gameId) {
  if (!gameId) return null;
  const row = db
    .prepare(
      `SELECT ge.launcher_game_id AS launcher_game_id, l.name AS launcher_name
       FROM game_editions ge
       JOIN launchers l ON l.id = ge.launcher_id
       LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
       WHERE ge.game_id = ? AND ge.owned = 1 AND ge.parent_edition_id IS NULL
       ORDER BY COALESCE(et.is_display_edition, 0) DESC,
                ${EFFECTIVE_PRIORITY_SQL} ASC,
                ${CANONICAL_ORDER_SQL} ASC,
                COALESCE(et.tier, 0) DESC,
                ge.id ASC
       LIMIT 1`
    )
    .get(gameId);
  return row || null;
}

module.exports = { resolveCacheLauncher, CANONICAL_ORDER_SQL, EFFECTIVE_PRIORITY_SQL };
