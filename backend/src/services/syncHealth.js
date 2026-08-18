/**
 * Health classification for launcher syncs.
 *
 * The motivating failure: a launcher can stop syncing for months with nothing
 * reporting it. `syncAll` treats an `awaiting_otp` job as neither success nor
 * failure and simply continues (syncEngine.js), so the *latest job* keeps
 * looking unremarkable while `last_sync_at` quietly ages. Staleness is therefore
 * derived from `last_sync_at`, never from job status alone.
 *
 * Deliberately pure: it takes rows and a timestamp and returns a verdict, so the
 * decision logic is testable without a database, a clock, or a scheduler.
 */

// Syncs run every 6 hours (server.js cron '0 */6 * * *'). 24h is four missed
// ticks — comfortably past transient flakiness, and short enough that a broken
// credential surfaces the same day rather than the same quarter.
const STALE_AFTER_HOURS = 24;

/** Is this launcher something the operator actually uses? */
function isConfigured(launcher) {
  return Boolean(launcher && launcher.enabled && launcher.credentials_json);
}

/**
 * Classify one launcher.
 *
 * `healthy` answers "should this raise an alert?" — which is NOT the same as
 * "did it sync". A locked or unconfigured launcher is intentional operator
 * state; alerting on it would train the operator to ignore alerts, which is how
 * a real signal gets lost.
 */
function classifyLauncher(launcher, latestJob, nowMs = Date.now()) {
  const name = launcher && launcher.name;
  const base = { name, display_name: launcher && launcher.display_name };

  if (!isConfigured(launcher)) {
    return { ...base, status: 'not_configured', healthy: true, detail: 'no credentials configured' };
  }

  if (launcher.sync_locked) {
    // Set deliberately — e.g. the Ubisoft file import locks sync so an API pass
    // cannot unown the imported games.
    return { ...base, status: 'locked', healthy: true, detail: 'sync locked by operator' };
  }

  if (latestJob && latestJob.status === 'awaiting_otp') {
    return {
      ...base,
      status: 'awaiting_otp',
      healthy: false,
      detail: latestJob.error_message || 'waiting for a verification code',
    };
  }

  if (latestJob && latestJob.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      healthy: false,
      detail: latestJob.error_message || 'last sync failed',
    };
  }

  if (!launcher.last_sync_at) {
    return { ...base, status: 'never_synced', healthy: false, detail: 'has never completed a sync' };
  }

  const ageHours = (nowMs - Date.parse(launcher.last_sync_at)) / 3600000;
  if (ageHours > STALE_AFTER_HOURS) {
    return {
      ...base,
      status: 'stale',
      healthy: false,
      detail: `last successful sync was ${Math.floor(ageHours)}h ago`,
      age_hours: Math.floor(ageHours),
    };
  }

  return { ...base, status: 'ok', healthy: true, age_hours: Math.floor(ageHours) };
}

/**
 * Summarise across launchers.
 *
 * `rows` is `[{ launcher, job }]` — the caller supplies the latest job per
 * launcher, keeping the SQL at the edge and this logic pure.
 */
function summarizeSyncHealth(rows, nowMs = Date.now()) {
  const launchers = (rows || []).map(r => classifyLauncher(r.launcher, r.job, nowMs));
  const problems = launchers.filter(l => !l.healthy);
  return { healthy: problems.length === 0, launchers, problems };
}

module.exports = { classifyLauncher, summarizeSyncHealth, isConfigured, STALE_AFTER_HOURS };
