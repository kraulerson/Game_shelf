var db = require("better-sqlite3")("/app/data/gameshelf.db");

var games = db.prepare(
  "SELECT id, title, " +
  "description IS NOT NULL as has_desc " +
  "FROM games WHERE cover_url IS NULL " +
  "ORDER BY title"
).all();

games.forEach(function(r) {
  console.log(r.has_desc ? "HAS_DESC" : "NO_DESC", "|", r.title);
});

console.log("---");

var dbd = db.prepare(
  "SELECT g.title, g.id, ge.owned, ge.game_id " +
  "FROM game_editions ge " +
  "LEFT JOIN games g ON g.id = ge.game_id " +
  "WHERE ge.title LIKE '%Dead by Daylight%' " +
  "OR g.title LIKE '%Dead by Daylight%'"
).all();

console.log("DbD:", JSON.stringify(dbd));
