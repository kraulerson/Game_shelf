// Manual-download coverage checker (#222).
//
// Games downloaded by hand (GOG / Humble / Itch / Amazon — launchers with no
// prefill automation) live in per-launcher folders on the lancache host, listed
// by the orchestrator's GET /api/v1/manual-downloads/{launcher}. This diffs the
// owned library per launcher against those folders (matched by slug) and reports
// which owned games were never downloaded.

const { slugify } = require('./metadata/titleMatcher');
const orchestrator = require('./orchestrator');

// Folder names use launcher slugs with '_' / '-' separators (GOG:
// 'alien_breed_2_assault'). slugify() strips those chars, so turn them into
// spaces first — then it maps to the same slug as a game title.
function folderSlug(name) {
  return slugify(String(name).replace(/[_-]+/g, ' '));
}

// Owned games (id/title/slug + edition title) that have an edition on
// `launcherName` (the lowercase Game_shelf launcher name).
function ownedGamesForLauncher(db, launcherName) {
  return db
    .prepare(
      `SELECT DISTINCT g.id AS id, g.title AS title, g.slug AS slug, ge.title AS edition_title
         FROM game_editions ge
         JOIN launchers l ON l.id = ge.launcher_id AND l.name = ?
         JOIN games g ON g.id = ge.game_id
        WHERE ge.owned = 1`
    )
    .all(launcherName);
}

// Diff the owned library against the downloaded folder names. Returns
// { total_owned, present, missing:[{id,title,slug}], extra_folders:[slug] }.
function computeManualCoverage(games, folderNames) {
  const folderSlugs = new Set((folderNames || []).map(folderSlug).filter(Boolean));
  const usedFolders = new Set();
  const missing = [];
  let present = 0;
  for (const g of games) {
    // A game is present if any of its identifiers slugifies to a folder — the
    // canonical slug, the title, or the launcher edition title (all the SAME
    // game, so no cross-game false positive).
    const candidates = [g.slug, g.title, g.edition_title]
      .filter(Boolean)
      .map((c) => (c === g.slug ? c : slugify(c)));
    const match = candidates.find((s) => folderSlugs.has(s));
    if (match) {
      present += 1;
      usedFolders.add(match);
    } else {
      missing.push({ id: g.id, title: g.title, slug: g.slug });
    }
  }
  const extra_folders = [...folderSlugs].filter((s) => !usedFolders.has(s));
  return { total_owned: games.length, present, missing, extra_folders };
}

// End-to-end: fetch the folder listing from the orchestrator and diff it against
// the owned library. `launcherFolder` is the on-disk folder name (e.g. 'GOG');
// the owned query uses its lowercase as the Game_shelf launcher name.
async function fetchManualCoverage(db, launcherFolder, { client = orchestrator } = {}) {
  const { status, data } = await client.callOrchestrator(
    'GET',
    `/api/v1/manual-downloads/${encodeURIComponent(launcherFolder)}`
  );
  if (status !== 200) {
    throw Object.assign(new Error('manual-downloads fetch failed'), { status, body: data });
  }
  const games = ownedGamesForLauncher(db, String(launcherFolder).toLowerCase());
  const report = computeManualCoverage(games, data.entries || []);
  return { launcher: launcherFolder, present_folder: Boolean(data.present), ...report };
}

module.exports = { folderSlug, ownedGamesForLauncher, computeManualCoverage, fetchManualCoverage };
