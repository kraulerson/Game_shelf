// Pure cache-badge mapping — no React/lucide imports so it's trivially unit-testable.
// Returns string descriptors; CacheBadge.jsx maps icon -> lucide component + tone -> classes.

const TRACKED_LAUNCHERS = { steam: 'steam', epic: 'epic' };

export function launcherToPlatform(launcherName) {
  if (!launcherName) return null;
  return TRACKED_LAUNCHERS[String(launcherName).toLowerCase()] || null;
}

const STATUS_MAP = {
  up_to_date: { icon: 'CheckCircle', tone: 'green', label: 'Cached' },
  downloading: { icon: 'Download', tone: 'blue', label: 'Downloading' },
  pending_update: { icon: 'ArrowUpCircle', tone: 'amber', label: 'Update ready' },
  not_downloaded: { icon: 'Circle', tone: 'gray', label: 'Not cached' },
  // validation_failed is handled specially below (amber "Partial · N%"), not here.
  failed: { icon: 'XCircle', tone: 'red', label: 'Failed' },
  unknown: { icon: 'HelpCircle', tone: 'gray', label: 'Unknown' },
};

// "Partial · 90%" when the cached fraction is known, else bare "Partial".
// Guards against missing counts (older orchestrator) and total=0 (no divide).
function partialLabel(chunksCached, chunksTotal) {
  if (Number.isFinite(chunksCached) && Number.isFinite(chunksTotal) && chunksTotal > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((chunksCached / chunksTotal) * 100)));
    return `Partial · ${pct}%`;
  }
  return 'Partial';
}

// Precedence: offline > not-tracked > blocked > status (blocked overlays any status).
// A validation_failed game is "partially cached", not broken — render it amber with
// the cached percentage (from the latest validation) so the user sees how close it is.
export function cacheBadgeFor({ status, blocked, tracked, offline, chunksCached, chunksTotal } = {}) {
  if (offline) return { icon: 'CloudOff', tone: 'neutral', label: '—' };
  if (!tracked) return { icon: 'Minus', tone: 'neutral', label: '—' };
  if (blocked) return { icon: 'Ban', tone: 'slate', label: 'Blocked' };
  if (status === 'validation_failed') {
    return { icon: 'AlertTriangle', tone: 'amber', label: partialLabel(chunksCached, chunksTotal) };
  }
  return STATUS_MAP[status] || STATUS_MAP.unknown;
}

// Tally a games list into the user-facing buckets shown on the dashboard stats.
export function cacheCounts(games = []) {
  const list = Array.isArray(games) ? games : [];
  const c = { total: 0, cached: 0, update_ready: 0, not_cached: 0, failed: 0, blocked: 0 };
  for (const g of list) {
    if (!g || typeof g !== 'object') continue; // tolerate malformed rows
    c.total += 1;
    if (g.blocked) c.blocked += 1;
    if (g.status === 'up_to_date') c.cached += 1;
    else if (g.status === 'pending_update') c.update_ready += 1;
    else if (g.status === 'not_downloaded') c.not_cached += 1;
    else if (g.status === 'failed' || g.status === 'validation_failed') c.failed += 1;
  }
  return c;
}
