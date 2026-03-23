// One-time fix: correct Dead by Daylight title
var db = require("better-sqlite3")("/app/data/gameshelf.db");

var game = db.prepare(
  "SELECT id, title, slug FROM games WHERE slug = 'dead-daylight'"
).get();

if (game) {
  db.prepare(
    "UPDATE games SET title = 'Dead by Daylight', " +
    "slug = 'dead-by-daylight' WHERE id = ?"
  ).run(game.id);
  console.log("Fixed: id=" + game.id + " title updated to 'Dead by Daylight'");
} else {
  console.log("No game found with slug 'dead-daylight'");
}
