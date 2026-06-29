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

  it('forwards chunk counts so validation_failed renders "Partial · N%"', () => {
    render(<CacheBadge status="validation_failed" tracked chunksCached={90} chunksTotal={100} />);
    expect(screen.getByText('Partial · 90%')).toBeInTheDocument();
  });

  it('renders bare "Partial" for validation_failed without chunk counts', () => {
    render(<CacheBadge status="validation_failed" tracked />);
    expect(screen.getByText('Partial')).toBeInTheDocument();
  });
});
