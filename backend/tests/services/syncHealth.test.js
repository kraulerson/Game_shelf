const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyLauncher,
  summarizeSyncHealth,
  STALE_AFTER_HOURS,
} = require('../../src/services/syncHealth');

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const hoursAgo = h => new Date(NOW - h * 3600000).toISOString();

const configured = (over = {}) => ({
  name: 'epic',
  display_name: 'Epic',
  enabled: 1,
  credentials_json: 'encrypted',
  last_sync_at: hoursAgo(1),
  sync_locked: 0,
  ...over,
});

describe('classifyLauncher', () => {
  it('a recent successful sync is ok', () => {
    const r = classifyLauncher(configured(), { status: 'success' }, NOW);
    assert.equal(r.status, 'ok');
    assert.equal(r.healthy, true);
  });

  it('a failed latest job is failed, and carries the error through', () => {
    const r = classifyLauncher(
      configured(),
      { status: 'failed', error_message: 'Humble session expired' },
      NOW
    );
    assert.equal(r.status, 'failed');
    assert.equal(r.healthy, false);
    assert.match(r.detail, /Humble session expired/);
  });

  it('a launcher whose last success predates the threshold is stale EVEN IF its latest job looks fine', () => {
    // This is the Ubisoft case. syncAll treats awaiting_otp as neither success
    // nor failure and simply continues, so the latest job never reads as an
    // error while last_sync_at silently ages. Staleness must therefore be
    // derived from last_sync_at, never from job status alone — that gap is
    // exactly why a launcher sat four months stale with nothing reporting it.
    const r = classifyLauncher(
      configured({ last_sync_at: hoursAgo(STALE_AFTER_HOURS + 1) }),
      { status: 'success' },
      NOW
    );
    assert.equal(r.status, 'stale');
    assert.equal(r.healthy, false);
  });

  it('a job parked for a 2FA code reports as needing attention, not as a failure', () => {
    // Actionable by a human, but not a fault — it must be distinguishable from
    // a broken credential so the operator knows to go and type a code.
    const r = classifyLauncher(
      configured(),
      { status: 'awaiting_otp', error_message: 'Check your email for a verification code' },
      NOW
    );
    assert.equal(r.status, 'awaiting_otp');
    assert.equal(r.healthy, false);
    assert.match(r.detail, /email/i);
  });

  it('a configured launcher that has never synced is never_synced', () => {
    const r = classifyLauncher(configured({ last_sync_at: null }), null, NOW);
    assert.equal(r.status, 'never_synced');
    assert.equal(r.healthy, false);
  });

  it('a sync-locked launcher is reported as locked, not stale', () => {
    // sync_locked is deliberate operator state (set by the Ubisoft file import so
    // an API sync cannot unown the imported games). Reporting it as a fault would
    // train the operator to ignore the alert.
    const r = classifyLauncher(
      configured({ sync_locked: 1, last_sync_at: hoursAgo(STALE_AFTER_HOURS + 100) }),
      { status: 'success' },
      NOW
    );
    assert.equal(r.status, 'locked');
    assert.equal(r.healthy, true, 'deliberate operator state is not a health problem');
  });

  it('a launcher with no credentials is not configured and is skipped, not alerted on', () => {
    const r = classifyLauncher(
      configured({ credentials_json: null, last_sync_at: null }),
      null,
      NOW
    );
    assert.equal(r.status, 'not_configured');
    assert.equal(r.healthy, true, 'an unused launcher must never raise an alert');
  });

  it('a disabled launcher is skipped even if it has credentials', () => {
    const r = classifyLauncher(configured({ enabled: 0 }), { status: 'failed' }, NOW);
    assert.equal(r.status, 'not_configured');
    assert.equal(r.healthy, true);
  });
});

describe('summarizeSyncHealth', () => {
  const rows = [
    { launcher: configured({ name: 'steam' }), job: { status: 'success' } },
    {
      launcher: configured({ name: 'humble' }),
      job: { status: 'failed', error_message: 'cookie expired' },
    },
    {
      launcher: configured({ name: 'ubisoft', last_sync_at: hoursAgo(24 * 120) }),
      job: { status: 'success' },
    },
    { launcher: configured({ name: 'xbox', credentials_json: null }), job: null },
  ];

  it('is unhealthy when any configured launcher has a problem', () => {
    const s = summarizeSyncHealth(rows, NOW);
    assert.equal(s.healthy, false);
  });

  it('lists only the problems, so the caller can alert on exactly them', () => {
    const s = summarizeSyncHealth(rows, NOW);
    assert.deepEqual(s.problems.map(p => p.name).sort(), ['humble', 'ubisoft']);
    assert.equal(s.problems.find(p => p.name === 'humble').status, 'failed');
    assert.equal(s.problems.find(p => p.name === 'ubisoft').status, 'stale');
  });

  it('reports every launcher, so the UI can render full state', () => {
    const s = summarizeSyncHealth(rows, NOW);
    assert.equal(s.launchers.length, 4);
  });

  it('is healthy when nothing is configured at all', () => {
    const s = summarizeSyncHealth(
      [{ launcher: configured({ credentials_json: null }), job: null }],
      NOW
    );
    assert.equal(s.healthy, true);
    assert.equal(s.problems.length, 0);
  });
});
