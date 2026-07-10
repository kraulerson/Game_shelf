// Manual-download coverage checker (#222).
//
// Games downloaded by hand (GOG / Humble / Itch / Amazon — launchers with no
// prefill automation) live in per-launcher folders on the lancache host, listed
// by the orchestrator's GET /api/v1/manual-downloads/{launcher}. This diffs the
// owned library per launcher against those folders (matched by slug) and reports
// which owned games were never downloaded.

const { slugify, simplifyTitle } = require('./metadata/titleMatcher');
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
      `SELECT DISTINCT g.id AS id, g.title AS title, g.slug AS slug,
              ge.title AS edition_title, ge.gog_slug AS gog_slug
         FROM game_editions ge
         JOIN launchers l ON l.id = ge.launcher_id AND l.name = ?
         JOIN games g ON g.id = ge.game_id
        WHERE ge.owned = 1`
    )
    .all(launcherName);
}

// Raw (un-slugified) folder forms for exact gog_slug comparison: the GOG product
// slug is stored raw (underscored), and gogrepoc names folders after it — so we
// compare the stored slug directly against the folder name and its
// GOG-suffix-stripped form (both lowercased).
function folderRawForms(name) {
  const raw = String(name).toLowerCase();
  const stripped = raw.replace(_GOG_FOLDER_SUFFIX, '');
  return stripped !== raw ? [raw, stripped] : [raw];
}

// Loose-file launchers (Humble/Itch) store installer/archive FILES, not per-game
// folders: `AndYetItMovesv1.3.0Setup.exe`, `Totem 1.06.zip`. Normalize a filename
// down to a title slug by stripping extension/version/platform noise and splitting
// camelCase. Ordered — each rule fixes a real observed filename (#222).
const _EXT = /\.(exe|zip|rar|7z|msi|bin|sh|dmg|pkg|tar|gz|iso)$/i;
const _BRACKET = /[([{][^)\]}]*[)\]}]/g;
const _DATE = /\d{4}[-_.]\d{2}[-_.]\d{2}/g; // bounded by _/-, not \b (both word chars)
// Split a version glued to the END of a word (Movesv1.3.0 -> Moves v1.3.0). The
// letter class excludes v/V so a standalone version marker (`v1.0.0`) isn't itself
// split into a stray "v" + digits.
const _GLUED_VER = /([A-UW-Za-uw-z])(v?\d+(?:[._]\d+)+)/g;
const _CAMEL1 = /([a-z])([A-Z])/g; // lowercase->Upper ONLY (keeps 2D / Cub3D)
const _CAMEL2 = /([A-Z]+)([A-Z][a-z])/g; // HTTPServer -> HTTP Server
const _SEP = /[_-]+/g;
const _VER = /v?\d+(?:[._]\d+)+[a-z]?/g; // dotted version incl trailing letter (0.3.5b); no /i so it won't eat an UpperCase word after (…v1.3.0Setup)
const _VER2 = /\bv\d+\b/gi; // v2
const _LONGID = /\b\d{5,}\b/g; // build/epoch ids
const _PLATFORM =
  /\b(?:windows?|win64|win32|win|pc|osx|macos|mac|linux|x64|x86|64bit|32bit|64|32|setup|installer|install|release|build|final|full|std|en|eng|remaster|classic)\b/gi;

function normalizeFileEntry(name) {
  let s = String(name).replace(_EXT, '');
  s = s.replace(_BRACKET, ' ');
  s = s.replace(_DATE, ' ');
  s = s.replace(_GLUED_VER, '$1 $2');
  s = s.replace(_CAMEL1, '$1 $2').replace(_CAMEL2, '$1 $2');
  s = s.replace(_SEP, ' ');
  s = s.replace(_VER, ' ').replace(_VER2, ' ');
  s = s.replace(_LONGID, ' ');
  s = s.replace(_PLATFORM, ' ');
  return slugify(s);
}

// Entry -> slug form(s). Dir launchers (GOG/Amazon) keep the folder-slug forms
// (with GOG _game/_base handling); file launchers (Humble/Itch) normalize the
// loose installer filename.
function entryForms(name, mode) {
  return mode === 'file' ? [normalizeFileEntry(name)] : folderSlugForms(name);
}

// Shared matcher: which owned game ids are present in the entry list, and which
// forms/aliases were consumed (for extra_folders). Precedence: alias map (exact
// entry name -> game slug) > exact gog_slug (dir) > fuzzy slug/title/edition-title
// /subtitle-stripped title. `mode`='dir'|'file'; `aliases` is {entryName: slug}.
function matchGames(games, entries, { mode = 'dir', aliases = {} } = {}) {
  const list = (entries || []).map((name) => ({
    name,
    forms: entryForms(name, mode), // slugified (dashed)
    raw: mode === 'file' ? [] : folderRawForms(name), // raw (underscored) — dir only
    aliasSlug: aliases[name] ? String(aliases[name]).toLowerCase() : null,
  }));
  const allForms = new Set(list.flatMap((f) => f.forms));
  const rawForms = new Set(list.flatMap((f) => f.raw));
  const aliasSlugs = new Set(list.map((f) => f.aliasSlug).filter(Boolean));
  const presentIds = new Set();
  const usedForms = new Set();
  const usedAliasSlugs = new Set();
  for (const g of games) {
    let matched = false;
    const gslug = g.slug ? String(g.slug).toLowerCase() : null;
    // 1. alias: an on-disk entry explicitly maps to this game's slug
    if (gslug && aliasSlugs.has(gslug)) {
      matched = true;
      usedAliasSlugs.add(gslug);
    }
    // 2. GOG raw-slug exact match (dir mode)
    if (!matched && g.gog_slug) {
      const gs = String(g.gog_slug).toLowerCase();
      if (rawForms.has(gs)) {
        matched = true;
        usedForms.add(gs);
      }
    }
    // 3. fuzzy: slug / title / edition_title / subtitle-stripped title
    if (!matched) {
      const cands = [g.slug, g.title, g.edition_title, g.title ? simplifyTitle(g.title) : null]
        .filter(Boolean)
        .map((c) => (c === g.slug ? c : slugify(c)));
      const hit = cands.find((s) => allForms.has(s));
      if (hit) {
        matched = true;
        usedForms.add(hit);
      }
    }
    if (matched) presentIds.add(g.id);
  }
  return { presentIds, usedForms, usedAliasSlugs, folders: list };
}

// The set of owned game ids present in the entry list (pure — no db).
function computeDownloadedIds(games, entries, opts = {}) {
  return matchGames(games, entries, opts).presentIds;
}

// db-bound: owned game ids for `launcherName` present in `entries`.
function downloadedGameIds(db, launcherName, entries, opts = {}) {
  return computeDownloadedIds(ownedGamesForLauncher(db, launcherName), entries, opts);
}

// Diff the owned library against the downloaded entry names. Returns
// { total_owned, present, missing:[{id,title,slug}], extra_folders:[entryName] }.
function computeManualCoverage(games, entries, opts = {}) {
  const { presentIds, usedForms, usedAliasSlugs, folders } = matchGames(games, entries, opts);
  const missing = games
    .filter((g) => !presentIds.has(g.id))
    .map((g) => ({ id: g.id, title: g.title, slug: g.slug }));
  // Entries whose every form (slug/raw) AND alias slug went unused (downloaded but
  // unrecognized). Report the ORIGINAL entry name for eyeball cross-reference.
  const extra_folders = folders
    .filter((f) => {
      const formsUsed = f.forms.some((s) => usedForms.has(s)) || f.raw.some((s) => usedForms.has(s));
      const aliasUsed = f.aliasSlug && usedAliasSlugs.has(f.aliasSlug);
      return !formsUsed && !aliasUsed;
    })
    .map((f) => f.name);
  return { total_owned: games.length, present: presentIds.size, missing, extra_folders };
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
  folderRawForms,
  normalizeFileEntry,
  ownedGamesForLauncher,
  computeDownloadedIds,
  downloadedGameIds,
  computeManualCoverage,
  fetchManualCoverage,
};
