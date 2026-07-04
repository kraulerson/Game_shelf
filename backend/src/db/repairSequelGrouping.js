// Phase 16 repair: split sequels the old prefix matcher merged onto one game
// (Portal + Portal 2, Darksiders + Darksiders II). For each game holding editions
// of more than one base game, keep the editions that belong (sameGameSlug with the
// game's own slug) and re-home the rest — reusing an existing game whose base slug
// exactly matches (so the original Darksiders lands on the Warmastered game, not
// the Genesis spinoff), else creating a new game row. DLC children follow their
// base edition. Idempotent. Companion to Phase 15 (Epic namespace repair).
const { slugify } = require('../services/metadata/titleMatcher');
const { canonicalBaseSlug, isSequelPair } = require('../services/metadata/gameIdentity');

function repairSequelGrouping(db) {
  const games = db.prepare(`
    SELECT g.id AS gid, g.slug AS gslug
    FROM games g JOIN game_editions ge ON ge.game_id = g.id
    WHERE ge.parent_edition_id IS NULL
    GROUP BY g.id
    HAVING COUNT(ge.id) > 1
  `).all();
  if (games.length === 0) return 0;

  const edsOf = db.prepare(
    'SELECT id, title FROM game_editions WHERE game_id = ? AND parent_edition_id IS NULL AND title IS NOT NULL');
  const childrenOf = db.prepare('SELECT id FROM game_editions WHERE parent_edition_id = ?');
  const candGames = db.prepare('SELECT id, slug FROM games WHERE slug LIKE ?');
  const insGame = db.prepare("INSERT INTO games (title, slug) VALUES (?, ?) ON CONFLICT(slug) DO NOTHING");
  const findGame = db.prepare('SELECT id FROM games WHERE slug = ?');
  const relink = db.prepare('UPDATE game_editions SET game_id = ? WHERE id = ?');
  const delEmpty = db.prepare(
    'DELETE FROM games WHERE id = ? AND NOT EXISTS (SELECT 1 FROM game_editions WHERE game_id = ?)');

  let moved = 0;
  // FK must toggle outside the transaction (SQLite forbids changing it within one).
  db.pragma('foreign_keys = OFF');
  const run = db.transaction(() => {
    for (const { gid, gslug } of games) {
      for (const ed of edsOf.all(gid)) {
        const es = slugify(ed.title);
        // Split ONLY a wrongly-merged numeric sequel of this game. Same-game
        // editions and non-prefix (IGDB/manual-grouped) editions are left in place.
        if (!es || !isSequelPair(es, gslug)) continue;
        const ebase = canonicalBaseSlug(es);
        // Reuse an existing game whose base slug EXACTLY equals this edition's base.
        // Deterministic when several share a base: prefer an exact-slug match, else
        // the lowest game id (so re-homing is stable across runs).
        let target = candGames.all(ebase + '%')
          .filter(c => c.id !== gid && canonicalBaseSlug(c.slug) === ebase)
          .sort((a, b) => (a.slug === es ? -1 : b.slug === es ? 1 : a.id - b.id))[0];
        if (!target) {
          insGame.run(ed.title, es);
          target = findGame.get(es);
        }
        if (target && target.id !== gid) {
          relink.run(target.id, ed.id);
          for (const child of childrenOf.all(ed.id)) relink.run(target.id, child.id);
          moved++;
        }
      }
      delEmpty.run(gid, gid); // drop the game if it lost all its editions
    }
  });
  run();
  db.pragma('foreign_keys = ON');
  return moved;
}

module.exports = { repairSequelGrouping };
