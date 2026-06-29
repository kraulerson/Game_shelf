import { describe, it, expect } from 'vitest';
import { launcherToPlatform, cacheBadgeFor } from './cacheBadge';

describe('launcherToPlatform', () => {
  it('maps steam/epic, others null', () => {
    expect(launcherToPlatform('steam')).toBe('steam');
    expect(launcherToPlatform('Steam')).toBe('steam');
    expect(launcherToPlatform('epic')).toBe('epic');
    expect(launcherToPlatform('gog')).toBe(null);
    expect(launcherToPlatform(undefined)).toBe(null);
  });
});

describe('cacheBadgeFor', () => {
  const cases = [
    [{ status: 'up_to_date', tracked: true }, 'CheckCircle', 'green', 'Cached'],
    [{ status: 'downloading', tracked: true }, 'Download', 'blue', 'Downloading'],
    [{ status: 'pending_update', tracked: true }, 'ArrowUpCircle', 'amber', 'Update ready'],
    [{ status: 'not_downloaded', tracked: true }, 'Circle', 'gray', 'Not cached'],
    [{ status: 'validation_failed', tracked: true }, 'AlertTriangle', 'amber', 'Partial'],
    [{ status: 'failed', tracked: true }, 'XCircle', 'red', 'Failed'],
    [{ status: 'unknown', tracked: true }, 'HelpCircle', 'gray', 'Unknown'],
  ];
  for (const [input, icon, tone, label] of cases) {
    it(`maps ${input.status}`, () => {
      expect(cacheBadgeFor(input)).toEqual({ icon, tone, label });
    });
  }
  it('blocked overlays any status', () => {
    expect(cacheBadgeFor({ status: 'up_to_date', blocked: true, tracked: true })).toEqual({
      icon: 'Ban',
      tone: 'slate',
      label: 'Blocked',
    });
  });
  it('untracked launcher -> neutral dash', () => {
    expect(cacheBadgeFor({ tracked: false })).toEqual({ icon: 'Minus', tone: 'neutral', label: '—' });
  });
  it('offline -> neutral cloud-off', () => {
    expect(cacheBadgeFor({ status: 'up_to_date', tracked: true, offline: true })).toEqual({
      icon: 'CloudOff',
      tone: 'neutral',
      label: '—',
    });
  });
  it('unknown status string falls back to Unknown', () => {
    expect(cacheBadgeFor({ status: 'wat', tracked: true }).label).toBe('Unknown');
  });
});

describe('cacheBadgeFor — validation_failed renders amber "Partial · N%"', () => {
  it('computes the cached percentage from chunk counts', () => {
    expect(
      cacheBadgeFor({ status: 'validation_failed', tracked: true, chunksCached: 90, chunksTotal: 100 })
    ).toEqual({ icon: 'AlertTriangle', tone: 'amber', label: 'Partial · 90%' });
  });

  it('rounds to the nearest percent', () => {
    // 39780 / 45415 = 0.8759… -> 88%
    expect(
      cacheBadgeFor({ status: 'validation_failed', tracked: true, chunksCached: 39780, chunksTotal: 45415 }).label
    ).toBe('Partial · 88%');
  });

  it('falls back to bare "Partial" when counts are absent (orchestrator not yet upgraded)', () => {
    expect(cacheBadgeFor({ status: 'validation_failed', tracked: true }).label).toBe('Partial');
  });

  it('falls back to bare "Partial" when total is zero (no divide-by-zero)', () => {
    expect(
      cacheBadgeFor({ status: 'validation_failed', tracked: true, chunksCached: 0, chunksTotal: 0 }).label
    ).toBe('Partial');
  });

  it('clamps a nonsensical >100% to 100', () => {
    expect(
      cacheBadgeFor({ status: 'validation_failed', tracked: true, chunksCached: 120, chunksTotal: 100 }).label
    ).toBe('Partial · 100%');
  });

  it('blocked still overlays validation_failed even with chunk counts', () => {
    expect(
      cacheBadgeFor({
        status: 'validation_failed',
        blocked: true,
        tracked: true,
        chunksCached: 90,
        chunksTotal: 100,
      }).label
    ).toBe('Blocked');
  });
});

import { cacheCounts } from './cacheBadge';

describe('cacheCounts', () => {
  it('tallies by status + blocked + total', () => {
    const games = [
      { status: 'up_to_date', blocked: false },
      { status: 'up_to_date', blocked: true },
      { status: 'pending_update', blocked: false },
      { status: 'not_downloaded', blocked: false },
      { status: 'failed', blocked: false },
    ];
    expect(cacheCounts(games)).toEqual({
      total: 5, cached: 2, update_ready: 1, not_cached: 1, failed: 1, blocked: 1,
    });
  });
  it('empty -> zeros', () => {
    expect(cacheCounts([])).toEqual({ total: 0, cached: 0, update_ready: 0, not_cached: 0, failed: 0, blocked: 0 });
  });
});

describe('cacheBadgeFor — schema-skew tolerance (F17)', () => {
  it('a tracked game missing the `blocked` field renders its status, not Blocked', () => {
    expect(cacheBadgeFor({ status: 'up_to_date', tracked: true }).label).toBe('Cached');
  });

  it('an unknown status value falls through to Unknown (never throws)', () => {
    expect(cacheBadgeFor({ status: 'teleporting', tracked: true }).label).toBe('Unknown');
  });

  it('a missing status falls through to Unknown', () => {
    expect(cacheBadgeFor({ tracked: true }).label).toBe('Unknown');
  });
});

describe('cacheCounts — malformed-entry tolerance (F17)', () => {
  it('skips null/non-object entries without crashing', () => {
    const c = cacheCounts([null, undefined, 42, { status: 'up_to_date' }]);
    expect(c.total).toBe(1);
    expect(c.cached).toBe(1);
  });

  it('a game missing `blocked` does not count as blocked', () => {
    const c = cacheCounts([{ status: 'up_to_date' }]);
    expect(c.blocked).toBe(0);
  });

  it('an unknown status is counted only toward total', () => {
    const c = cacheCounts([{ status: 'teleporting' }]);
    expect(c.total).toBe(1);
    expect(c.cached).toBe(0);
    expect(c.update_ready).toBe(0);
    expect(c.not_cached).toBe(0);
    expect(c.failed).toBe(0);
  });

  it('a non-array argument yields zeros', () => {
    expect(cacheCounts(null)).toEqual({ total: 0, cached: 0, update_ready: 0, not_cached: 0, failed: 0, blocked: 0 });
  });
});
