import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CacheBadge from './CacheBadge';

describe('CacheBadge', () => {
  it('renders the label text (colorblind-safe: text always present)', () => {
    render(<CacheBadge status="up_to_date" tracked />);
    expect(screen.getByText('Cached')).toBeInTheDocument();
  });

  it('renders Blocked when blocked overlays a status', () => {
    render(<CacheBadge status="up_to_date" blocked tracked />);
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('renders a neutral dash for an untracked launcher', () => {
    render(<CacheBadge tracked={false} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
