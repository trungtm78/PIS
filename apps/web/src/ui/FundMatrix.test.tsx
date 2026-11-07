import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FundMatrix } from './FundMatrix';

const GROUPS = [
  {
    title: 'Vốn năm 2026',
    total: '10.772,636',
    cells: [
      { label: 'Kế hoạch', control: <input defaultValue="100" /> },
      { label: 'Giải ngân', control: <input defaultValue="40" /> },
    ],
    programme: { title: 'Chương trình mục tiêu', cells: [{ label: 'Kế hoạch CTMT', control: <input defaultValue="5" /> }] },
  },
  { title: 'Vốn kéo dài', cells: [{ label: 'Kế hoạch', control: <input defaultValue="7" /> }], programme: 'na' as const },
  { title: 'Vốn khác', cells: [{ label: 'Kế hoạch', control: <input defaultValue="1" /> }] },
];

describe('FundMatrix', () => {
  it('shows one named block per source with its total and cells', () => {
    render(<FundMatrix groups={GROUPS} />);
    const year = screen.getByRole('region', { name: 'Vốn năm 2026' });
    expect(within(year).getByText('Tổng: 10.772,636')).toBeInTheDocument();
    expect(within(year).getByLabelText('Kế hoạch')).toHaveValue('100');
    expect(within(year).getByLabelText('Giải ngân')).toHaveValue('40');
  });

  it('shows the programme block under its source', () => {
    render(<FundMatrix groups={GROUPS} />);
    const year = screen.getByRole('region', { name: 'Vốn năm 2026' });
    expect(within(year).getByRole('heading', { level: 4, name: 'Chương trình mục tiêu' })).toBeInTheDocument();
    expect(within(year).getByLabelText('Kế hoạch CTMT')).toHaveValue('5');
  });

  it('says "Không áp dụng" for a source without a programme and shows nothing when it is absent', () => {
    render(<FundMatrix groups={GROUPS} />);
    expect(within(screen.getByRole('region', { name: 'Vốn kéo dài' })).getByText('Không áp dụng')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Vốn khác' })).queryByText('Không áp dụng')).not.toBeInTheDocument();
  });

  it('gives each source its own colour class, so it can stack per source at 360 px', () => {
    const { container } = render(<FundMatrix groups={GROUPS} />);
    const blocks = Array.from(container.querySelectorAll('.ui-fund'));
    expect(blocks.map((block) => Array.from(block.classList).find((name) => name.startsWith('ui-fund--')))).toEqual(['ui-fund--year', 'ui-fund--carry', 'ui-fund--other']);
    expect(container.querySelector('.ui-fund-matrix')).not.toBeNull();
  });
});
