var db = require("better-sqlite3")("/app/data/gameshelf.db");
var axios = require("axios");
var fs = require("fs");
var path = require("path");

async function fix() {
  var game = db.prepare(
    "SELECT g.id FROM game_editions ge " +
    "JOIN games g ON g.id = ge.game_id " +
    "WHERE ge.launcher_game_id = '381210'"
  ).get();

  if (!game) {
    console.log("Game not found");
    return;
  }

  var gid = game.id;
  console.log("Fixing game id:", gid);

  var desc = "Dead by Daylight is an asymmetric multiplayer " +
    "horror game where one player takes on the role of a " +
    "savage Killer, and the other four players play as Survivors.";

  db.prepare(
    "UPDATE games SET title = ?, slug = ?, description = ?, " +
    "developer = ?, publisher = ?, release_year = ?, " +
    "last_enrichment_at = datetime('now'), " +
    "updated_at = datetime('now') WHERE id = ?"
  ).run(
    "Dead by Daylight",
    "dead-by-daylight",
    desc,
    "Behaviour Interactive",
    "Behaviour Interactive",
    2016,
    gid
  );

  var imgDir = "/app/data/images/" + gid;
  fs.mkdirSync(imgDir, { recursive: true });

  var coverUrl =
    "https://cdn.akamai.steamstatic.com/steam/apps/381210/library_600x900_2x.jpg";
  var heroUrl =
    "https://cdn.akamai.steamstatic.com/steam/apps/381210/library_hero.jpg";

  var cover = await axios.get(coverUrl, { responseType: "arraybuffer" });
  fs.writeFileSync(path.join(imgDir, "cover.jpg"), cover.data);
  fs.writeFileSync(path.join(imgDir, "icon.jpg"), cover.data);

  var hero = await axios.get(heroUrl, { responseType: "arraybuffer" });
  fs.writeFileSync(path.join(imgDir, "hero.jpg"), hero.data);

  db.prepare(
    "UPDATE games SET cover_url = ?, icon_url = ?, hero_url = ? " +
    "WHERE id = ?"
  ).run(
    "/data/images/" + gid + "/cover.jpg",
    "/data/images/" + gid + "/icon.jpg",
    "/data/images/" + gid + "/hero.jpg",
    gid
  );

  console.log("Done - Dead by Daylight corrected");
}

fix().catch(function(e) { console.log("Error:", e.message); });
