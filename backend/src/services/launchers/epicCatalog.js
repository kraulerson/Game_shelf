const axios = require('axios');
const { isLikelyCodename } = require('../../utils/codenameDetector');

const CATALOG_URL = 'https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/bulk/items';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Group DLC under parent games by epic_namespace.
 * Base game = sandbox_type 'PUBLIC' or highest edition tier or longest title.
 * Sets parent_edition_id on DLC items and copies game_id from parent.
 */
function nestDLC(db, launcherId) {
  const namespaces = db.prepare(`
    SELECT epic_namespace, COUNT(*) as c FROM game_editions
    WHERE launcher_id = ? AND epic_namespace IS NOT NULL
    GROUP BY epic_namespace HAVING c > 1
  `).all(launcherId);

  if (namespaces.length === 0) return;

  const getEditions = db.prepare(`
    SELECT ge.id, ge.sandbox_type, ge.title, COALESCE(et.tier, 0) as tier
    FROM game_editions ge
    LEFT JOIN edition_tiers et ON et.game_edition_id = ge.id
    WHERE ge.launcher_id = ? AND ge.epic_namespace = ?
    ORDER BY
      CASE WHEN ge.sandbox_type = 'PUBLIC' THEN 0 ELSE 1 END ASC,
      COALESCE(et.tier, 0) DESC,
      length(ge.title) DESC
  `);
  const resetParent = db.prepare('UPDATE game_editions SET parent_edition_id = NULL WHERE launcher_id = ? AND epic_namespace = ?');
  const setParent = db.prepare('UPDATE game_editions SET parent_edition_id = ? WHERE id = ?');

  const nestAll = db.transaction(() => {
    for (const { epic_namespace } of namespaces) {
      // Reset for idempotency on re-sync
      resetParent.run(launcherId, epic_namespace);

      const editions = getEditions.all(launcherId, epic_namespace);
      if (editions.length < 2) continue;

      const baseGame = editions[0];
      for (let i = 1; i < editions.length; i++) {
        setParent.run(baseGame.id, editions[i].id);
      }
    }
  });
  nestAll();

  // Copy game_id from parent to children
  db.prepare(`
    UPDATE game_editions SET game_id = (
      SELECT pe.game_id FROM game_editions pe WHERE pe.id = game_editions.parent_edition_id
    ) WHERE parent_edition_id IS NOT NULL AND game_id IS NULL
  `).run();

  console.log(`[Epic Catalog] Nested DLC for ${namespaces.length} namespaces`);
}

/**
 * Resolve codename titles via Epic catalog API.
 * Queries bulk items endpoint per namespace, updates edition + game titles.
 */
async function resolveCodenames(db, launcherId, session) {
  // Get all editions grouped by namespace for batched API calls
  const namespaces = db.prepare(`
    SELECT DISTINCT epic_namespace FROM game_editions
    WHERE launcher_id = ? AND epic_namespace IS NOT NULL AND epic_catalog_id IS NOT NULL
  `).all(launcherId);

  if (namespaces.length === 0) return;

  const authHeader = `${session.token_type || 'bearer'} ${session.access_token}`;
  let resolved = 0;

  const updateTitle = db.prepare('UPDATE game_editions SET title = ? WHERE epic_catalog_id = ? AND launcher_id = ?');
  const updateGameTitle = db.prepare(`
    UPDATE games SET title = ? WHERE id = (
      SELECT game_id FROM game_editions WHERE epic_catalog_id = ? AND launcher_id = ?
    )
  `);

  for (const { epic_namespace } of namespaces) {
    // Get all catalog IDs in this namespace
    const editions = db.prepare(
      'SELECT epic_catalog_id, title, launcher_game_id FROM game_editions WHERE launcher_id = ? AND epic_namespace = ? AND epic_catalog_id IS NOT NULL'
    ).all(launcherId, epic_namespace);

    if (editions.length === 0) continue;

    try {
      // Query catalog API with id + namespace params
      const catalogIds = editions.map(e => e.epic_catalog_id);
      const res = await axios.get(CATALOG_URL, {
        headers: { Authorization: authHeader },
        params: {
          id: catalogIds.join(','),
          namespace: epic_namespace,
          country: 'US',
          locale: 'en-US',
        },
      });

      const items = res.data || {};

      for (const edition of editions) {
        const catalogItem = items[edition.epic_catalog_id];
        if (!catalogItem?.title) continue;

        // Update if catalog returns a different title AND current title is single-word
        const isSingleWord = !/\s/.test(edition.title) && !/-/.test(edition.title);
        if (!isSingleWord || edition.title === catalogItem.title) continue;

        updateTitle.run(catalogItem.title, edition.epic_catalog_id, launcherId);
        updateGameTitle.run(catalogItem.title, edition.epic_catalog_id, launcherId);
        resolved++;
      }
    } catch (err) {
      // 404 for some namespaces is expected (delisted games, etc.)
      if (err.response?.status !== 404) {
        console.warn(`[Epic Catalog] Failed to resolve namespace ${epic_namespace}: ${err.message}`);
      }
    }

    await sleep(500);
  }

  console.log(`[Epic Catalog] Resolved ${resolved} codename titles across ${namespaces.length} namespaces`);
}

module.exports = { nestDLC, resolveCodenames };
