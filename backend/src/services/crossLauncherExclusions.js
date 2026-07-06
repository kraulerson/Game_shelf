// Cross-launcher prefill exclusions (Piece 3).
//
// When a game is owned on BOTH Steam and Epic, Steam's copy is cached by the
// host SteamPrefill cron (which auto-grabs new purchases), so caching the Epic
// copy too is redundant WAN + disk. Game_shelf holds the authoritative
// cross-launcher identity — editions of the same game share a `game_id` across
// launchers (linked at enrich time via sameGameSlug). This service computes the
// Epic editions whose game is also on Steam and pushes their app_ids to the
// orchestrator's reconcile endpoint, which turns them into `source='gameshelf'`
// exclusions so its Epic scheduled prefill skips them.
//
// The Epic app_id the orchestrator keys on IS `game_editions.launcher_game_id`
// (the same value cache-status matching already uses — see routes/games.js).

const orchestrator = require('./orchestrator');

// Return the sorted, de-duplicated Epic launcher_game_ids for games that also
// have a Steam edition (shared game_id). Pure read; never throws on empty.
function computeSteamCoveredEpicAppIds(db) {
  const rows = db
    .prepare(
      `SELECT DISTINCT CAST(ge.launcher_game_id AS TEXT) AS app_id
         FROM game_editions ge
         JOIN launchers le ON le.id = ge.launcher_id AND le.name = 'epic'
         LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
        WHERE ge.game_id IS NOT NULL
          AND ge.launcher_game_id IS NOT NULL
          AND COALESCE(et.is_prefill_edition, 0) = 0
          AND EXISTS (
            SELECT 1 FROM game_editions ge2
              JOIN launchers ls ON ls.id = ge2.launcher_id AND ls.name = 'steam'
             WHERE ge2.game_id = ge.game_id
          )`
    )
    .all();
  const ids = rows.map((r) => r.app_id).filter((id) => id != null && id !== '');
  return [...new Set(ids)].sort();
}

// Compute the covered Epic set and PUT it to the orchestrator's gameshelf
// reconcile endpoint (full-set semantics: the orchestrator adds new exclusions
// and removes stale gameshelf ones). Returns { pushed, ...orchestratorResponse }.
// Throws { status, body } on a non-200 or transport/offline error (the caller —
// cron or route — decides how to surface it).
async function syncCrossLauncherExclusions(db, { client = orchestrator } = {}) {
  const appIds = computeSteamCoveredEpicAppIds(db);
  const { status, data } = await client.callOrchestrator(
    'PUT',
    '/api/v1/prefill-exclusions/gameshelf/epic',
    { data: { app_ids: appIds } }
  );
  if (status !== 200) {
    throw Object.assign(new Error('cross-launcher exclusion push failed'), {
      status,
      body: data,
    });
  }
  return { pushed: appIds.length, ...data };
}

module.exports = { computeSteamCoveredEpicAppIds, syncCrossLauncherExclusions };
