import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FilterPanel, UnitChip } from './FilterPanel';

describe('FilterPanel', () => {
  it('shows the controls, the unit chip, the time of the data and the actions', () => {
    render(
      <FilterPanel unitLabel="Triệu đồng" updatedAt="11:15 30/09/2026" actions={<button type="button">Xuất Excel</button>}>
        <label>
          Năm
          <input defaultValue="2026" />
        </label>
      </FilterPanel>,
    );
    expect(screen.getByRole('region', { name: 'Bộ lọc' })).toBeInTheDocument();
    expect(screen.getByLabelText('Năm')).toHaveValue('2026');
    expect(screen.getByText('ĐVT: Triệu đồng')).toBeInTheDocument();
    expect(screen.getByText('Cập nhật 11:15 30/09/2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xuất Excel' })).toBeInTheDocument();
  });

  it('the collapse button counts the applied filters', () => {
    render(
      <FilterPanel applied={3}>
        <input aria-label="Tìm" />
      </FilterPanel>,
    );
    expect(screen.getByRole('button', { name: 'Bộ lọc (3 điều kiện đang áp dụng)' })).toBeInTheDocument();
  });

  it('writes no count when nothing is applied', () => {
    render(
      <FilterPanel applied={0}>
        <input aria-label="Tìm" />
      </FilterPanel>,
    );
    expect(screen.getByRole('button', { name: 'Bộ lọc' })).toBeInTheDocument();
  });

  it('the button opens and closes the body and says so with aria-expanded', async () => {
    const { container } = render(
      <FilterPanel applied={1}>
        <input aria-label="Tìm" />
      </FilterPanel>,
    );
    const button = screen.getByRole('button', { name: /Bộ lọc/ });
    const section = container.querySelector('.ui-filter');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(section).toHaveAttribute('data-open', 'false');
    expect(button.getAttribute('aria-controls')).toBe(container.querySelector('.ui-filter__body')?.id);
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(section).toHaveAttribute('data-open', 'true');
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('UnitChip', () => {
  it('writes "ĐVT:" before the unit', () => {
    render(<UnitChip unit="Tỷ đồng" />);
    expect(screen.getByText('ĐVT: Tỷ đồng')).toBeInTheDocument();
  });

  it('shows its children as they are', () => {
    render(<UnitChip>ĐVT: tùy chọn</UnitChip>);
    expect(screen.getByText('ĐVT: tùy chọn')).toBeInTheDocument();
  });
});
