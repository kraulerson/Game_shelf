const axios = require('axios');
const { isLikelyCodename } = require('../../utils/codenameDetector');

const CATALOG_URL = 'https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace';

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
  const candidates = db.prepare(`
    SELECT DISTINCT epic_namespace FROM game_editions
    WHERE launcher_id = ? AND epic_namespace IS NOT NULL AND epic_catalog_id IS NOT NULL
  `).all(launcherId);

  const namespacesToResolve = candidates.map(c => c.epic_namespace);
  if (namespacesToResolve.length === 0) return;

  const authHeader = `${session.token_type || 'bearer'} ${session.access_token}`;
  let resolved = 0;

  for (const ns of namespacesToResolve) {
    try {
      const res = await axios.get(`${CATALOG_URL}/${ns}/bulk/items`, {
        headers: { Authorization: authHeader },
        params: { includeMainGameDetails: true, country: 'US', locale: 'en-US' },
      });

      const items = res.data || {};
      const updateTitle = db.prepare('UPDATE game_editions SET title = ? WHERE epic_catalog_id = ? AND launcher_id = ?');
      const updateGameTitle = db.prepare(`
        UPDATE games SET title = ? WHERE id = (
          SELECT game_id FROM game_editions WHERE epic_catalog_id = ? AND launcher_id = ?
        )
      `);

      for (const [catalogId, item] of Object.entries(items)) {
        if (!item.title) continue;
        const edition = db.prepare(
          'SELECT id, title, launcher_game_id FROM game_editions WHERE epic_catalog_id = ? AND launcher_id = ?'
        ).get(catalogId, launcherId);
        if (!edition) continue;
        if (!isLikelyCodename(edition.title, edition.launcher_game_id)) continue;

        updateTitle.run(item.title, catalogId, launcherId);
        updateGameTitle.run(item.title, catalogId, launcherId);
        resolved++;
      }
    } catch (err) {
      console.warn(`[Epic Catalog] Failed to resolve namespace ${ns}: ${err.message}`);
    }

    await sleep(500);
  }

  console.log(`[Epic Catalog] Resolved ${resolved} codename titles across ${namespacesToResolve.length} namespaces`);
}

module.exports = { nestDLC, resolveCodenames };
