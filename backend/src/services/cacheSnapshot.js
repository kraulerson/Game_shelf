const orchestrator = require('./orchestrator');

const DEFAULT_TTL_MS = 60_000;

// In-memory snapshot of the orchestrator's (platform:app_id -> status) set.
// Returns { map, stale }. On a fetch error, serves the last-good map (stale:true),
// or { map:null, stale:true } if nothing was ever fetched. Concurrent refreshes
// are coalesced into one in-flight request.
function makeCacheSnapshot({ client = orchestrator, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  let cached = null;   // { map, fetchedAt }
  let inflight = null;

  async function get() {
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return { map: cached.map, stale: false };
    }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { games } = await client.fetchAllGames();
        const map = new Map();
        // A blocked game (excluded from prefill) reports 'blocked' rather than its
        // underlying cache status, so it never shows under "Failed" and can be
        // filtered on its own. `blocked` overrides everything else.
        for (const g of games) {
          map.set(`${g.platform}:${g.app_id}`, g.blocked ? 'blocked' : g.status);
        }
        cached = { map, fetchedAt: now() };
        return { map, stale: false };
      } catch {
        if (cached) return { map: cached.map, stale: true };
        return { map: null, stale: true };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return { get };
}

const defaultSnapshot = makeCacheSnapshot();

module.exports = {
  makeCacheSnapshot,
  getCacheStatusSnapshot: () => defaultSnapshot.get(),
};
