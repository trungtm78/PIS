import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MakerCheckerBadge } from './MakerCheckerBadge';

describe('MakerCheckerBadge', () => {
  it('shows the maker and the checker', () => {
    render(<MakerCheckerBadge maker="Nguyễn An" checker="Trần Bình" />);
    expect(screen.getByRole('group', { name: 'Lập và duyệt' })).toBeInTheDocument();
    expect(screen.getByText('Người lập: Nguyễn An')).toBeInTheDocument();
    expect(screen.getByText('Người duyệt: Trần Bình')).toBeInTheDocument();
    expect(screen.queryByText('Chờ người duyệt')).not.toBeInTheDocument();
  });

  it.each([[undefined], [null], ['']])('says it waits for a checker when the checker is %s', (checker) => {
    render(<MakerCheckerBadge maker="Nguyễn An" checker={checker} />);
    expect(screen.getByText('Chờ người duyệt')).toBeInTheDocument();
    expect(screen.queryByText(/Người duyệt:/)).not.toBeInTheDocument();
  });

  it('flags the same person in both roles', () => {
    render(<MakerCheckerBadge maker="Nguyễn An" checker="Nguyễn An" />);
    expect(screen.getByText('Người lập và người duyệt trùng nhau')).toBeInTheDocument();
  });
});
