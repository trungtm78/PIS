import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReadonlyStat } from './ReadonlyStat';

describe('ReadonlyStat', () => {
  it('shows label, value and sub line as a named group', () => {
    render(<ReadonlyStat label="Còn lại" value="22.572,934" sub="65,2% tổng nguồn vốn" tone="success" />);
    const group = screen.getByRole('group', { name: 'Còn lại' });
    expect(group).toHaveTextContent('22.572,934');
    expect(group).toHaveTextContent('65,2% tổng nguồn vốn');
    expect(group).toHaveClass('ui-tone-success');
  });

  it('works without a sub line or tone', () => {
    render(<ReadonlyStat label="Tổng" value="10" />);
    expect(screen.getByRole('group', { name: 'Tổng' })).toHaveClass('ui-tone-default');
  });
});
