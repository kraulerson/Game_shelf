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

// GOG names its download folders `<slug>_game` or `<slug>_base`
// (doom_3_bfg_edition_game, blade_of_darkness_base) — a suffix the game title
// doesn't carry. So a folder contributes BOTH its full slug AND a
// suffix-stripped slug. Both are kept (not just the stripped one) so a game
// literally named "…Game" (e.g. "Treasure Adventure Game" → folder
// 'treasure_adventure_game') still matches via the full form.
const _GOG_FOLDER_SUFFIX = /_(?:game|base|gog)$/i;

function folderSlugForms(name) {
  const full = folderSlug(name);
  const stripped = folderSlug(String(name).replace(_GOG_FOLDER_SUFFIX, ''));
  const forms = [full];
  if (stripped && stripped !== full) forms.push(stripped);
  return forms.filter(Boolean);
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
// { total_owned, present, missing:[{id,title,slug}], extra_folders:[folderName] }.
function computeManualCoverage(games, folderNames) {
  // Each folder contributes 1-2 slug forms (full + GOG-suffix-stripped).
  const folders = (folderNames || []).map((name) => ({ name, forms: folderSlugForms(name) }));
  const allForms = new Set(folders.flatMap((f) => f.forms));
  const usedForms = new Set();
  const missing = [];
  let present = 0;
  for (const g of games) {
    // A game is present if any of its identifiers slugifies to a folder form —
    // the canonical slug, the title, or the launcher edition title (all the SAME
    // game, so no cross-game false positive).
    const candidates = [g.slug, g.title, g.edition_title]
      .filter(Boolean)
      .map((c) => (c === g.slug ? c : slugify(c)));
    const match = candidates.find((s) => allForms.has(s));
    if (match) {
      present += 1;
      usedForms.add(match);
    } else {
      missing.push({ id: g.id, title: g.title, slug: g.slug });
    }
  }
  // Folders whose every slug form went unmatched (downloaded but unrecognized).
  // Report the ORIGINAL folder name so the operator can cross-reference by eye.
  const extra_folders = folders.filter((f) => !f.forms.some((s) => usedForms.has(s))).map((f) => f.name);
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

module.exports = {
  folderSlug,
  folderSlugForms,
  ownedGamesForLauncher,
  computeManualCoverage,
  fetchManualCoverage,
};
