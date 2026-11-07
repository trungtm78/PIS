import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TablePager } from './TablePager';

describe('TablePager', () => {
  it('shows the range, the page size and the page buttons, and reports changes', async () => {
    const onPage = vi.fn();
    const onSize = vi.fn();
    render(<TablePager from={1} to={20} total={45} size={20} index={0} onPage={onPage} onSize={onSize} />);
    expect(screen.getByText('Hiển thị 1 đến 20 của 45')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Trang \d$/ })).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Trang 2' }));
    expect(onPage).toHaveBeenCalledWith(1);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Số dòng mỗi trang' }), '100');
    expect(onSize).toHaveBeenCalledWith(100);
  });

  it('has one page when the total fits', () => {
    render(<TablePager from={1} to={3} total={3} size={20} index={0} onPage={vi.fn()} onSize={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /^Trang \d$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Trang trước' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Trang sau' })).toBeDisabled();
  });
});
