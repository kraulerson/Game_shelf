import { describe, it, expect } from 'vitest';
import { formatMeasuredAge } from './measuredAge';

// #309: the operator can see that a game is Cached but not whether that was
// verified an hour ago or three weeks ago. Karl, UAT 15 scenario 1:
// "Shows cached. No time on when the measurement was done."

const NOW = new Date('2026-09-14T12:00:00Z');

describe('formatMeasuredAge', () => {
  it('parses the orchestrator timestamp as UTC, not local time', () => {
    // The orchestrator emits "YYYY-MM-DD HH:MM:SS" with NO timezone marker.
    // Date() treats that as LOCAL time in most engines, which would shift the
    // age by the viewer's offset — 6 hours here, enough to render "6h ago" for
    // a measurement taken seconds ago, or a negative age for a future-looking one.
    expect(formatMeasuredAge('2026-09-14 12:00:00', NOW)).toBe('just now');
  });

  it('reports hours for a measurement earlier today', () => {
    expect(formatMeasuredAge('2026-09-14 09:00:00', NOW)).toBe('3h ago');
  });

  it('reports days once it is a day old', () => {
    expect(formatMeasuredAge('2026-09-12 12:00:00', NOW)).toBe('2d ago');
  });

  it('reports minutes under an hour', () => {
    expect(formatMeasuredAge('2026-09-14 11:25:00', NOW)).toBe('35m ago');
  });

  it('returns null when never measured, so the card renders nothing at all', () => {
    // A never-measured game must not display a fabricated or empty age.
    expect(formatMeasuredAge(null, NOW)).toBeNull();
    expect(formatMeasuredAge(undefined, NOW)).toBeNull();
    expect(formatMeasuredAge('', NOW)).toBeNull();
  });

  it('returns null for an unparseable timestamp rather than NaN', () => {
    expect(formatMeasuredAge('not a date', NOW)).toBeNull();
  });

  it('clamps a future timestamp to "just now" rather than showing a negative age', () => {
    // Clock skew between the orchestrator host and the viewer is real.
    expect(formatMeasuredAge('2026-09-14 12:05:00', NOW)).toBe('just now');
  });
});
