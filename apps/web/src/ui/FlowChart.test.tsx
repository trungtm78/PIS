import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { FlowChart } from './FlowChart';
import type { FlowSeries } from './FlowChart';

const SERIES: FlowSeries[] = [
  { label: 'Thực hiện', style: 'actual', points: [{ x: 'T1', y: 10 }, { x: 'T2', y: 30 }, { x: 'T3', y: 45 }] },
  { label: 'Kế hoạch', style: 'plan', points: [{ x: 'T1', y: 15 }, { x: 'T2', y: 30 }, { x: 'T3', y: 60 }, { x: 'T4', y: 90 }] },
];

describe('FlowChart', () => {
  it('is an image named by the caption', () => {
    render(<FlowChart series={SERIES} unit="tỷ đồng" caption="Giải ngân lũy kế so với kế hoạch" />);
    expect(screen.getByRole('img', { name: 'Giải ngân lũy kế so với kế hoạch' })).toBeInTheDocument();
  });

  it('draws the actual line solid and the plan dashed', () => {
    const { container } = render(<FlowChart series={SERIES} unit="tỷ đồng" caption="c" />);
    expect(container.querySelector('.ui-flow__series--actual-0')).not.toBeNull();
    expect(container.querySelector('.ui-flow__series--plan')).not.toBeNull();
    expect(container.querySelectorAll('.ui-flow__series--plan .ui-flow__dot')).toHaveLength(0);
    expect(container.querySelectorAll('.ui-flow__series--actual-0 .ui-flow__dot')).toHaveLength(3);
  });

  it('labels both lines and the unit in the legend, naming the dashed one', () => {
    render(<FlowChart series={SERIES} unit="tỷ đồng" caption="c" />);
    expect(screen.getByText('Thực hiện (nét liền)')).toBeInTheDocument();
    expect(screen.getByText('Kế hoạch (nét đứt)')).toBeInTheDocument();
    expect(screen.getByText('Đơn vị: tỷ đồng')).toBeInTheDocument();
  });

  it('carries the same figures in a table for screen readers, one row per point', () => {
    render(<FlowChart series={SERIES} unit="tỷ đồng" caption="Giải ngân" />);
    const table = screen.getByRole('table', { name: 'Giải ngân (tỷ đồng)' });
    expect(within(table).getByRole('columnheader', { name: 'Thực hiện' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Kế hoạch' })).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 4);
    const t3 = within(table).getByRole('rowheader', { name: 'T3' }).closest('tr')!;
    expect(within(t3).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['45', '60']);
    const t4 = within(table).getByRole('rowheader', { name: 'T4' }).closest('tr')!;
    expect(within(t4).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['', '90']);
  });

  it('draws the other actual lines in other colour classes', () => {
    const { container } = render(
      <FlowChart
        series={[SERIES[0]!, { label: 'Năm trước', style: 'actual', points: [{ x: 'T1', y: 5 }] }]}
        unit="tỷ"
        caption="c"
      />,
    );
    expect(container.querySelector('.ui-flow__series--actual-1')).not.toBeNull();
  });

  it('draws a single point', () => {
    const { container } = render(<FlowChart series={[{ label: 'A', style: 'actual', points: [{ x: 'T1', y: 0 }] }]} unit="tỷ" caption="c" />);
    expect(container.querySelectorAll('.ui-flow__dot')).toHaveLength(1);
  });

  it('loading shows a skeleton and no figures', () => {
    render(<FlowChart series={SERIES} unit="tỷ" caption="c" state="loading" />);
    expect(screen.getByRole('status', { name: 'Đang tải biểu đồ' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('error retries in place', async () => {
    const onRetry = vi.fn();
    render(<FlowChart series={SERIES} unit="tỷ" caption="c" state="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Không tải được biểu đồ');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each([['state empty', SERIES, 'empty' as const], ['no points', [], 'ready' as const]])('empty (%s) says there are no figures', (_name, series, state) => {
    render(<FlowChart series={series} unit="tỷ" caption="c" state={state} />);
    expect(screen.getByRole('status')).toHaveTextContent('Chưa có số liệu cho biểu đồ');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('has no serious accessibility violation', async () => {
    const { container } = render(<FlowChart series={SERIES} unit="tỷ đồng" caption="Giải ngân" />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
