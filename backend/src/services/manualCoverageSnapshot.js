const orchestrator = require('./orchestrator');

const DEFAULT_TTL_MS = 60_000;

// In-memory snapshot of each manual launcher's downloaded-folder listing from the
// orchestrator (GET /api/v1/manual-downloads/<launcher>). Returns
// { present, entries, stale }. Serves last-good on error; coalesces concurrent
// refreshes per launcher. Mirrors services/cacheSnapshot.js.
function makeManualDownloadsSnapshot({ client = orchestrator, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const cache = new Map(); // launcher -> { present, entries, fetchedAt }
  const inflight = new Map(); // launcher -> Promise

  async function get(launcher, { includeFiles = false } = {}) {
    // Key by (launcher, includeFiles) so a dir-mode and a file-mode read of the
    // same folder don't share a cache entry (Humble/Itch pass includeFiles).
    const key = `${launcher}|${includeFiles ? 1 : 0}`;
    const cached = cache.get(key);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return { present: cached.present, entries: cached.entries, stale: false };
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const qs = includeFiles ? '?include_files=true' : '';
        const { status, data } = await client.callOrchestrator(
          'GET',
          `/api/v1/manual-downloads/${encodeURIComponent(launcher)}${qs}`
        );
        if (status !== 200) throw Object.assign(new Error('manual-downloads fetch failed'), { status });
        const entry = {
          present: Boolean(data.present),
          entries: Array.isArray(data.entries) ? data.entries : [],
          fetchedAt: now(),
        };
        cache.set(key, entry);
        return { present: entry.present, entries: entry.entries, stale: false };
      } catch {
        const last = cache.get(key);
        if (last) return { present: last.present, entries: last.entries, stale: true };
        return { present: false, entries: [], stale: true };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  return { get };
}

const defaultSnapshot = makeManualDownloadsSnapshot();

module.exports = {
  makeManualDownloadsSnapshot,
  getManualDownloadsSnapshot: (launcher, opts) => defaultSnapshot.get(launcher, opts),
};
