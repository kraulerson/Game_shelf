var db = require("better-sqlite3")("/app/data/gameshelf.db");

// Find games with no cover
var nocover = db.prepare(
  "SELECT g.id, g.title, g.slug, " +
  "(SELECT COUNT(*) FROM game_editions ge " +
  "WHERE ge.game_id = g.id) as editions " +
  "FROM games g WHERE g.cover_url IS NULL " +
  "ORDER BY g.title"
).all();

console.log("=== Games with no cover ===");
nocover.forEach(function(r) {
  var label = r.editions === 0 ? "ORPHAN" : "LINKED(" + r.editions + ")";
  console.log(label + " | " + r.title + " | id:" + r.id);
});

console.log("");
console.log("Total no-cover:", nocover.length);
console.log("Orphans:", nocover.filter(function(r) {
  return r.editions === 0;
}).length);

// Check for duplicate slugs
console.log("");
console.log("=== Duplicate slugs ===");
var dupes = db.prepare(
  "SELECT slug, COUNT(*) as c FROM games " +
  "GROUP BY slug HAVING c > 1"
).all();
dupes.forEach(function(r) {
  console.log(r.slug + " (" + r.c + " rows)");
});
