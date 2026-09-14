// How long ago the orchestrator last MEASURED a game's cache status (#309).
//
// Pure, no React, no Intl — trivially unit-testable and deterministic under a
// fixed `now`. Kept out of cacheBadge.js on purpose: the badge label feeds the
// per-store 34-char layout budget, and "Partial · 90% · 2d ago" would blow it.
// The age renders beside the badge as its own element instead.
//
// NOT interchangeable with last_validated_at. That is stamped by attempts too,
// including errored ones, so it answers "when did we last try" rather than
// "when did we last know".

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The orchestrator emits "YYYY-MM-DD HH:MM:SS" with no timezone marker, and
// `new Date()` reads that as LOCAL time — which would shift every age by the
// viewer's UTC offset. It is UTC; say so explicitly.
function parseUtc(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const iso = raw.includes('T') ? raw : raw.trim().replace(' ', 'T');
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : ms;
}

export function formatMeasuredAge(measuredAt, now = new Date()) {
  const then = parseUtc(measuredAt);
  if (then === null) return null;

  // Clock skew between the orchestrator host and the viewer is real; a future
  // timestamp must never render as a negative age.
  const delta = Math.max(0, now.getTime() - then);

  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}
