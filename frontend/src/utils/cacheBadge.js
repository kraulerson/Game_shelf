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
  validation_failed: { icon: 'AlertTriangle', tone: 'red', label: 'Check failed' },
  failed: { icon: 'XCircle', tone: 'red', label: 'Failed' },
  unknown: { icon: 'HelpCircle', tone: 'gray', label: 'Unknown' },
};

// Precedence: offline > not-tracked > blocked > status (blocked overlays any status).
export function cacheBadgeFor({ status, blocked, tracked, offline } = {}) {
  if (offline) return { icon: 'CloudOff', tone: 'neutral', label: '—' };
  if (!tracked) return { icon: 'Minus', tone: 'neutral', label: '—' };
  if (blocked) return { icon: 'Ban', tone: 'slate', label: 'Blocked' };
  return STATUS_MAP[status] || STATUS_MAP.unknown;
}
