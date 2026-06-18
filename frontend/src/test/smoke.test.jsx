import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('vitest + RTL', () => {
  it('renders', () => {
    render(<div>hello</div>);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });
});
