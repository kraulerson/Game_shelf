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
    [{ status: 'validation_failed', tracked: true }, 'AlertTriangle', 'red', 'Check failed'],
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
