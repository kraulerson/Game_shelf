import { describe, it, expect } from 'vitest';
import { normalizeSyncJobs, isAnySyncRunning, latestCompletedAt } from './syncStatus';

/**
 * GET /api/sync/status returns `{ jobs, otp_window_ms }`, but two consumers were
 * still written against the older bare-array shape:
 *
 *   Nav.jsx        `syncStatus?.some?.(...)` -> undefined on an object, and
 *                  `syncStatus?.[0]?.completed_at` -> undefined, so
 *                  hoursSinceSync was always Infinity and the freshness dot sat
 *                  permanently yellow.
 *   Library.jsx    `status.some(...)` throws TypeError on an object; the bare
 *                  catch swallowed it and cleared the poll on the first tick, so
 *                  the library never refreshed after a sync.
 *
 * Settings.jsx already had the tolerant idiom. Normalising in one tested place
 * stops a third consumer from re-deriving it wrongly.
 */
describe('normalizeSyncJobs', () => {
  it('unwraps the current { jobs } response shape', () => {
    const jobs = [{ status: 'success' }];
    expect(normalizeSyncJobs({ jobs, otp_window_ms: 300000 })).toEqual(jobs);
  });

  it('accepts a bare array (the older shape) unchanged', () => {
    const jobs = [{ status: 'running' }];
    expect(normalizeSyncJobs(jobs)).toEqual(jobs);
  });

  it('returns an empty array for null/undefined rather than throwing', () => {
    expect(normalizeSyncJobs(undefined)).toEqual([]);
    expect(normalizeSyncJobs(null)).toEqual([]);
  });

  it('returns an empty array for a malformed payload', () => {
    expect(normalizeSyncJobs({})).toEqual([]);
    expect(normalizeSyncJobs({ jobs: 'not-an-array' })).toEqual([]);
    expect(normalizeSyncJobs(42)).toEqual([]);
  });
});

describe('isAnySyncRunning', () => {
  it('detects a running job through the wrapped shape', () => {
    expect(isAnySyncRunning({ jobs: [{ status: 'success' }, { status: 'running' }] })).toBe(true);
  });

  it('is false when nothing is running', () => {
    expect(isAnySyncRunning({ jobs: [{ status: 'success' }] })).toBe(false);
  });

  it('is false — never throws — on a malformed or absent payload', () => {
    expect(isAnySyncRunning(undefined)).toBe(false);
    expect(isAnySyncRunning({})).toBe(false);
  });

  it('treats awaiting_otp as not running, so the spinner stops for a parked job', () => {
    // A job parked for a 2FA code is waiting on a human, not progressing. Left as
    // "running" the poll would spin until the OTP window expired.
    expect(isAnySyncRunning({ jobs: [{ status: 'awaiting_otp' }] })).toBe(false);
  });
});

describe('latestCompletedAt', () => {
  it('returns the most recent completed_at across launchers', () => {
    const data = { jobs: [
      { completed_at: '2026-08-01T00:00:00.000Z' },
      { completed_at: '2026-08-17T12:00:00.000Z' },
      { completed_at: '2026-08-10T00:00:00.000Z' },
    ]};
    expect(latestCompletedAt(data)).toBe('2026-08-17T12:00:00.000Z');
  });

  it('ignores jobs with no completed_at (running or parked)', () => {
    const data = { jobs: [{ completed_at: null }, { completed_at: '2026-08-05T00:00:00.000Z' }] };
    expect(latestCompletedAt(data)).toBe('2026-08-05T00:00:00.000Z');
  });

  it('returns null when nothing has ever completed', () => {
    expect(latestCompletedAt({ jobs: [{ completed_at: null }] })).toBe(null);
    expect(latestCompletedAt(undefined)).toBe(null);
  });
});
