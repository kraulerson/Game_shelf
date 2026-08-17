/**
 * Shared reading of GET /api/sync/status.
 *
 * The endpoint returns `{ jobs, otp_window_ms }`, but it previously returned a
 * bare array, and two consumers were never updated:
 *
 *   Nav.jsx      `syncStatus?.some?.(...)` is undefined on an object and
 *                `syncStatus?.[0]?.completed_at` is undefined, so hoursSinceSync
 *                was always Infinity and the freshness dot sat permanently
 *                yellow — the UI could not report a healthy sync.
 *   Library.jsx  `status.some(...)` throws TypeError on an object; the bare
 *                catch swallowed it and cleared the poll on its first tick, so
 *                the library never refreshed after a sync completed.
 *
 * Settings.jsx already carried the tolerant idiom inline. Centralising it here
 * means a future consumer cannot re-derive it incorrectly, and every reader
 * tolerates both shapes.
 */

/** Return the sync-job array from either response shape. Never throws. */
export function normalizeSyncJobs(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.jobs)) return data.jobs;
  return [];
}

/**
 * Is any launcher actively syncing?
 *
 * `awaiting_otp` is deliberately NOT running: that job is parked waiting for a
 * human to supply a 2FA code, so treating it as in-progress would spin a poller
 * or a spinner until the OTP window expired.
 */
export function isAnySyncRunning(data) {
  return normalizeSyncJobs(data).some(job => job && job.status === 'running');
}

/**
 * Most recent completion across all launchers, or null if none has completed.
 *
 * Max rather than first: the endpoint orders by launcher priority, not by time,
 * so element [0] is whichever launcher ranks first — not the newest sync.
 */
export function latestCompletedAt(data) {
  const stamps = normalizeSyncJobs(data)
    .map(job => job && job.completed_at)
    .filter(Boolean);
  if (stamps.length === 0) return null;
  return stamps.reduce((newest, s) =>
    new Date(s).getTime() > new Date(newest).getTime() ? s : newest
  );
}
