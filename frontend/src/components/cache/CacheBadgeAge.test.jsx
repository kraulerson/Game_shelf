import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import CacheBadge from './CacheBadge';

// #309 / UAT 15 scenario 1. Karl: "Shows cached. No time on when the measurement
// was done." The badge must be datable.

afterEach(() => vi.useRealTimers());

function freeze(iso) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe('CacheBadge measured age', () => {
  it('shows how long ago the status was measured, beside the badge', () => {
    freeze('2026-09-14T12:00:00Z');
    render(<CacheBadge status="up_to_date" measuredAt="2026-09-12 12:00:00" />);

    expect(screen.getByText('Cached')).toBeInTheDocument();
    expect(screen.getByTestId('cache-measured-age')).toHaveTextContent('2d ago');
  });

  it('renders no age element at all when the game was never measured', () => {
    // Not an empty span, not a dash — nothing. A never-measured game must not
    // imply a measurement happened.
    freeze('2026-09-14T12:00:00Z');
    render(<CacheBadge status="unknown" measuredAt={null} />);

    expect(screen.queryByTestId('cache-measured-age')).toBeNull();
  });

  it('keeps the age out of the badge label so the per-store budget is unaffected', () => {
    // cacheBadgeFor's label feeds the 34-char per-store layout budget. If the age
    // were concatenated into it, "Partly cached · 90% · 2d ago" would overflow.
    freeze('2026-09-14T12:00:00Z');
    render(
      <CacheBadge
        status="validation_failed"
        chunksCached={90}
        chunksTotal={100}
        measuredAt="2026-09-12 12:00:00"
      />
    );

    // Label wording is master's ("Partly cached · N%"), asserted verbatim so this
    // test fails loudly if the label and the age are ever merged into one string.
    expect(screen.getByText('Partly cached · 90%')).toBeInTheDocument();
    expect(screen.getByTestId('cache-measured-age')).toHaveTextContent('2d ago');
  });

  it('gives the age an accessible label, not colour or position alone', () => {
    freeze('2026-09-14T12:00:00Z');
    render(<CacheBadge status="up_to_date" measuredAt="2026-09-14 09:00:00" />);

    expect(screen.getByTestId('cache-measured-age')).toHaveAttribute(
      'title',
      expect.stringContaining('measured')
    );
  });
});
