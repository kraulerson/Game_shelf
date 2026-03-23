var db = require("better-sqlite3")("/app/data/gameshelf.db");

var games = db.prepare(
  "SELECT g.id, g.title, g.slug, " +
  "ge.launcher_game_id, l.name as launcher " +
  "FROM games g " +
  "JOIN game_editions ge ON ge.game_id = g.id AND ge.owned = 1 " +
  "JOIN launchers l ON l.id = ge.launcher_id " +
  "WHERE g.cover_url IS NULL " +
  "ORDER BY g.title"
).all();

games.forEach(function(r) {
  console.log(
    r.launcher + " | " +
    r.launcher_game_id + " | " +
    r.title + " | slug:" + r.slug
  );
});
