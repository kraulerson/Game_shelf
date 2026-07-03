// Repair the Epic import mis-grouping (issue #10): a single game_id that
// accumulated editions from many distinct Epic namespaces — the old prefix
// matcher (enrichGame cross-launcher + migrate Phase 12b) collapsed unrelated
// codename-titled Epic games onto one game. Keep the editions that genuinely
// belong to the game (their title-slug is prefix-related to the game slug) and
// re-home the rest into their own game rows (reusing an existing same-slug game
// if one exists — a cross-launcher merge). Returns the count of editions moved.
const { slugify } = require('../services/metadata/titleMatcher');

// A legit game's editions/DLC share 1-2 Epic namespaces; anything spanning more
// than this on ONE game is the mis-grouping signature.
const NAMESPACE_THRESHOLD = 5;
const MIN_SLUG = 4;

// One slug is a prefix of the other on a word boundary, and the shared prefix is
// itself meaningful (a 1-3 char overlap is not a real match).
function isPrefixRelated(a, b) {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < MIN_SLUG) return false;
  return longer.startsWith(shorter) &&
    (longer.length === shorter.length || longer[shorter.length] === '-');
}

function repairMisGroupedEditions(db) {
  const broken = db.prepare(`
    SELECT ge.game_id AS gid, g.slug AS gameSlug,
           COUNT(DISTINCT ge.epic_namespace) AS nsCount
    FROM game_editions ge JOIN games g ON g.id = ge.game_id
    WHERE ge.game_id IS NOT NULL AND ge.epic_namespace IS NOT NULL
    GROUP BY ge.game_id
    HAVING nsCount > ?
  `).all(NAMESPACE_THRESHOLD);
  if (broken.length === 0) return 0;

  const edsOf = db.prepare('SELECT id, title FROM game_editions WHERE game_id = ? AND title IS NOT NULL');
  const flatten = db.prepare('UPDATE game_editions SET parent_edition_id = NULL WHERE game_id = ?');
  const insGame = db.prepare("INSERT INTO games (title, slug) VALUES (?, ?) ON CONFLICT(slug) DO NOTHING");
  const findGame = db.prepare('SELECT id FROM games WHERE slug = ?');
  const relink = db.prepare('UPDATE game_editions SET game_id = ?, parent_edition_id = NULL WHERE id = ?');

  let reHomed = 0;
  // FK must toggle outside the transaction (SQLite forbids changing it within one).
  db.pragma('foreign_keys = OFF');
  const run = db.transaction(() => {
    for (const { gid, gameSlug } of broken) {
      flatten.run(gid); // its parent-nesting chains are noise — drop them
      for (const ed of edsOf.all(gid)) {
        const s = slugify(ed.title);
        if (!s || isPrefixRelated(s, gameSlug)) continue; // genuinely belongs here — keep
        insGame.run(ed.title, s); // reuse an existing same-slug game, else create
        const g = findGame.get(s);
        if (g && g.id !== gid) {
          relink.run(g.id, ed.id);
          reHomed++;
        }
      }
    }
  });
  run();
  db.pragma('foreign_keys = ON');
  return reHomed;
}

module.exports = { repairMisGroupedEditions, isPrefixRelated };
