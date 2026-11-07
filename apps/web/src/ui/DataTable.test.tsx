import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { DataTable } from './DataTable';
import type { DataTableColumn, DataTablePage } from './DataTable';

interface Project {
  id: string;
  name: string;
  plan: number;
  done: number;
  level: 'URGENT' | 'ACTION' | 'WATCH' | null;
}

const ROWS: Project[] = [
  { id: 'a', name: 'Dự án A', plan: 100, done: 40, level: 'URGENT' },
  { id: 'b', name: 'Dự án B', plan: 200, done: 150, level: null },
  { id: 'c', name: 'Dự án C', plan: 50, done: 10, level: 'WATCH' },
];

const COLUMNS: DataTableColumn<Project>[] = [
  { key: 'name', header: 'Tên dự án', pinned: true, render: (row) => row.name },
  { key: 'plan', header: 'Kế hoạch', group: 'Vốn 2026', align: 'right', render: (row) => String(row.plan) },
  { key: 'done', header: 'Đã giải ngân', group: 'Vốn 2026', align: 'right', render: (row) => String(row.done) },
];

const sum = (key: 'plan' | 'done', rows: Project[]): number => rows.reduce((total, row) => total + row[key], 0);

const baseProps = { columns: COLUMNS, rows: ROWS, rowKey: (row: Project) => row.id, caption: 'Danh sách dự án' };

describe('DataTable', () => {
  it('renders a captioned table with column headers in scope and the rows', () => {
    render(<DataTable {...baseProps} />);
    const table = screen.getByRole('table', { name: 'Danh sách dự án' });
    expect(within(table).getByRole('columnheader', { name: 'Tên dự án' })).toHaveAttribute('scope', 'col');
    expect(within(table).getByRole('columnheader', { name: 'Kế hoạch' })).toHaveAttribute('scope', 'col');
    expect(within(table).getAllByRole('row')).toHaveLength(2 + ROWS.length);
    expect(within(table).getByText('Dự án B')).toBeInTheDocument();
  });

  it('draws a group row above: the group spans its columns and the ungrouped column spans both rows', () => {
    render(<DataTable {...baseProps} />);
    const group = screen.getByRole('columnheader', { name: 'Vốn 2026' });
    expect(group).toHaveAttribute('colspan', '2');
    expect(group).toHaveAttribute('scope', 'colgroup');
    expect(screen.getByRole('columnheader', { name: 'Tên dự án' })).toHaveAttribute('rowspan', '2');
  });

  it('has a single head row when no column has a group', () => {
    render(<DataTable {...baseProps} columns={COLUMNS.map((column) => ({ ...column, group: undefined }))} />);
    expect(screen.getAllByRole('row')).toHaveLength(1 + ROWS.length);
  });

  it('right-aligns the number columns and pins the pinned column', () => {
    render(<DataTable {...baseProps} />);
    expect(screen.getByRole('cell', { name: '100' })).toHaveClass('ui-table__cell--right');
    expect(screen.getByRole('columnheader', { name: 'Tên dự án' })).toHaveClass('ui-table__head--pinned');
    expect(screen.getByRole('cell', { name: /Dự án B/ })).toHaveClass('ui-table__cell--pinned');
    expect(screen.getByRole('cell', { name: '100' })).not.toHaveClass('ui-table__cell--pinned');
  });

  it('puts a severity stripe on a row and says the level in words', () => {
    render(<DataTable {...baseProps} severity={(row) => row.level} />);
    const rows = screen.getAllByRole('row');
    const urgent = rows.find((row) => row.getAttribute('data-severity') === 'URGENT');
    expect(urgent).toBeDefined();
    expect(urgent).toHaveTextContent('Mức độ: Khẩn');
    expect(rows.find((row) => row.getAttribute('data-severity') === 'WATCH')).toHaveTextContent('Mức độ: Theo dõi');
    expect(rows.filter((row) => row.hasAttribute('data-severity'))).toHaveLength(2);
    expect(screen.getByText('Dự án B').closest('tr')).not.toHaveTextContent('Mức độ');
  });

  it('says "Cần xử lý" for the ACTION level', () => {
    render(<DataTable {...baseProps} rows={[{ ...ROWS[0]!, level: 'ACTION' }]} severity={(row) => row.level} />);
    expect(screen.getByText('Dự án A').closest('tr')).toHaveTextContent('Mức độ: Cần xử lý');
  });

  it('shows the totals row that the caller summed over the shown rows, labelled', () => {
    const shown = ROWS.slice(0, 2);
    render(<DataTable {...baseProps} rows={shown} totals={{ plan: String(sum('plan', shown)), done: String(sum('done', shown)) }} />);
    const totals = screen.getByRole('rowheader', { name: 'Tổng cộng' }).closest('tr')!;
    expect(within(totals).getByText('300')).toBeInTheDocument();
    expect(within(totals).getByText('190')).toBeInTheDocument();
    expect(totals.closest('tfoot')).not.toBeNull();
  });

  it('uses the given label for the totals row', () => {
    render(<DataTable {...baseProps} totals={{ plan: '350' }} totalsLabel="TỔNG CỘNG TOÀN BỘ" />);
    expect(screen.getByRole('rowheader', { name: 'TỔNG CỘNG TOÀN BỘ' })).toBeInTheDocument();
  });

  it('shows no totals row without rows', () => {
    render(<DataTable {...baseProps} rows={[]} totals={{ plan: '0' }} />);
    expect(screen.queryByRole('rowheader', { name: 'Tổng cộng' })).not.toBeInTheDocument();
  });

  it('loading shows skeleton rows, marks the table busy and shows neither rows, totals nor a pager', () => {
    const page: DataTablePage = { from: 1, to: 3, total: 3, size: 20, index: 0, onPage: vi.fn(), onSize: vi.fn() };
    render(<DataTable {...baseProps} state="loading" totals={{ plan: '0' }} page={page} />);
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Dự án A')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: 'Tổng cộng' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('error says so in an alert and retries in place', async () => {
    const onRetry = vi.fn();
    render(<DataTable {...baseProps} state="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Không tải được dữ liệu bảng');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('empty "none" says there is no data', () => {
    render(<DataTable {...baseProps} rows={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Chưa có dữ liệu');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('empty "filtered" offers to clear the filters', async () => {
    const onClear = vi.fn();
    render(<DataTable {...baseProps} state="empty" emptyKind="filtered" onClearFilters={onClear} />);
    expect(screen.getByRole('status')).toHaveTextContent('Không có kết quả phù hợp với bộ lọc');
    await userEvent.click(screen.getByRole('button', { name: 'Xóa bộ lọc' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('empty "noPeriod" says there are no figures for the period', () => {
    render(<DataTable {...baseProps} rows={[]} emptyKind="noPeriod" />);
    expect(screen.getByRole('status')).toHaveTextContent('Chưa có số liệu cho kỳ này');
  });

  it('the scroll region is named and reachable by keyboard so the page never scrolls sideways', () => {
    render(<DataTable {...baseProps} />);
    const region = screen.getByRole('region', { name: 'Danh sách dự án' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('ui-table-scroll');
  });

  it('has no serious accessibility violation', async () => {
    const { container } = render(<DataTable {...baseProps} severity={(row) => row.level} totals={{ plan: '350' }} />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});

describe('DataTable pager', () => {
  const page = (over: Partial<DataTablePage> = {}): DataTablePage => ({ from: 21, to: 40, total: 95, size: 20, index: 1, onPage: vi.fn(), onSize: vi.fn(), ...over });

  it('writes "Hiển thị a đến b của n"', () => {
    render(<DataTable {...baseProps} page={page()} />);
    expect(screen.getByText('Hiển thị 21 đến 40 của 95')).toBeInTheDocument();
  });

  it('marks the current page and calls onPage with the zero-based index of the clicked page', async () => {
    const paging = page();
    render(<DataTable {...baseProps} page={paging} />);
    const nav = screen.getByRole('navigation', { name: 'Phân trang' });
    expect(within(nav).getByRole('button', { name: 'Trang 2' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Trang 1' })).not.toHaveAttribute('aria-current');
    await userEvent.click(within(nav).getByRole('button', { name: 'Trang 3' }));
    expect(paging.onPage).toHaveBeenLastCalledWith(2);
    await userEvent.click(within(nav).getByRole('button', { name: 'Trang sau' }));
    expect(paging.onPage).toHaveBeenLastCalledWith(2);
    await userEvent.click(within(nav).getByRole('button', { name: 'Trang trước' }));
    expect(paging.onPage).toHaveBeenLastCalledWith(0);
  });

  it('disables previous on the first page and next on the last', () => {
    const { unmount } = render(<DataTable {...baseProps} page={page({ index: 0 })} />);
    expect(screen.getByRole('button', { name: 'Trang trước' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Trang sau' })).toBeEnabled();
    unmount();
    render(<DataTable {...baseProps} page={page({ index: 4 })} />);
    expect(screen.getByRole('button', { name: 'Trang sau' })).toBeDisabled();
  });

  it('shows at most five page buttons around the current page', () => {
    render(<DataTable {...baseProps} page={page({ total: 1000, index: 10 })} />);
    const nav = screen.getByRole('navigation', { name: 'Phân trang' });
    const numbered = within(nav).getAllByRole('button', { name: /^Trang \d+$/ });
    expect(numbered).toHaveLength(5);
    expect(numbered.map((button) => button.textContent)).toEqual(['9', '10', '11', '12', '13']);
  });

  it('calls onSize with the chosen page size', async () => {
    const paging = page();
    render(<DataTable {...baseProps} page={paging} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Số dòng mỗi trang' }), '50');
    expect(paging.onSize).toHaveBeenCalledWith(50);
  });

  it('adds an unusual page size to the options', () => {
    render(<DataTable {...baseProps} page={page({ size: 25 })} />);
    expect(screen.getByRole('combobox', { name: 'Số dòng mỗi trang' })).toHaveValue('25');
  });
});
