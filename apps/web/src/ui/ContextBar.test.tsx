import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContextBar } from './ContextBar';

const ITEMS = [
  { label: 'Phạm vi', value: 'Tỉnh Cao Bằng' },
  { label: 'Kỳ', value: 'Tuần 39' },
];

describe('ContextBar', () => {
  it('lists scope and period in a named group with the unit and the time of the data', () => {
    render(<ContextBar items={ITEMS} unit="Triệu đồng" asOf="11:15 30/09/2026" />);
    const group = screen.getByRole('group', { name: 'Phạm vi số liệu' });
    expect(group).toHaveTextContent('Phạm vi');
    expect(group).toHaveTextContent('Tỉnh Cao Bằng');
    expect(group).toHaveTextContent('Tuần 39');
    expect(group).toHaveTextContent('ĐVT: Triệu đồng');
    expect(group).toHaveTextContent('Cập nhật 11:15 30/09/2026');
  });

  it('says the numbers are stale, with the last good time, in words', () => {
    render(<ContextBar items={ITEMS} asOf="10:00 29/09/2026" stale />);
    expect(screen.getByText('Số liệu cũ, lần cập nhật cuối 10:00 29/09/2026')).toBeInTheDocument();
    expect(screen.queryByText(/^Cập nhật/)).not.toBeInTheDocument();
  });

  it('says only "Số liệu cũ" when stale without a time', () => {
    render(<ContextBar items={ITEMS} stale />);
    expect(screen.getByText('Số liệu cũ')).toBeInTheDocument();
  });

  it('shows neither unit nor freshness when they are not given', () => {
    render(<ContextBar items={ITEMS} />);
    expect(screen.queryByText(/ĐVT/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cập nhật/)).not.toBeInTheDocument();
  });
});
