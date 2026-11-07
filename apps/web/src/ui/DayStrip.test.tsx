import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { DayStrip } from './DayStrip';
import type { DayStripBar } from './DayStrip';

afterEach(cleanup);

/** 2026-11-02 is a Monday; the strip runs Monday to the Thursday 12 November. */
const BARS: DayStripBar[] = [
  { code: 'A', label: 'Lập hồ sơ', planned: { from: '2026-11-02', to: '2026-11-04' }, actual: { from: '2026-11-02', to: '2026-11-04' } },
  { code: 'B', label: 'Đánh giá', planned: { from: '2026-11-04', to: '2026-11-06' }, actual: { from: '2026-11-04', to: '2026-11-10', open: true } },
  { code: 'C', label: 'Ký hợp đồng', planned: null, actual: null },
];
const props = { from: '2026-11-02', to: '2026-11-12', changes: ['2026-11-04', '2026-11-10'], deadlines: ['2026-11-06'], today: '2026-11-12', onSelectDay: () => undefined };

describe('DayStrip', () => {
  it('has one cell for every day from the start to today, in rows of a week starting on Monday', () => {
    const { container } = render(<DayStrip {...props} />);
    expect(container.querySelectorAll('[data-day]')).toHaveLength(11);
    expect(container.querySelectorAll('.ui-day-strip__week')).toHaveLength(2);
  });

  it('marks the days that changed, the weekend, the deadline and today, each with a word for screen readers', () => {
    render(<DayStrip {...props} />);
    const cell = (day: string): HTMLElement => document.querySelector(`[data-day="${day}"]`) as HTMLElement;
    expect(cell('2026-11-04').getAttribute('aria-label')).toContain('có thay đổi');
    expect(cell('2026-11-04')).toHaveClass('is-changed');
    expect(cell('2026-11-03').getAttribute('aria-label')).toContain('không có thay đổi');
    expect(cell('2026-11-07')).toHaveClass('is-weekend');
    expect(cell('2026-11-06').getAttribute('aria-label')).toContain('hạn của bước');
    expect(cell('2026-11-12')).toHaveClass('is-today');
    expect(within(cell('2026-11-12')).getByText('Nay')).toBeInTheDocument();
  });

  it('hands the chosen day to the timeline and marks it', async () => {
    const onSelectDay = vi.fn();
    render(<DayStrip {...props} onSelectDay={onSelectDay} selectedDay="2026-11-10" />);
    await userEvent.click(document.querySelector('[data-day="2026-11-04"]') as HTMLElement);
    expect(onSelectDay).toHaveBeenCalledWith('2026-11-04');
    expect(document.querySelector('[data-day="2026-11-10"]')).toHaveAttribute('aria-pressed', 'true');
  });

  it('draws the standard dashed and what happened solid, with the overrun labelled', () => {
    const { container } = render(<DayStrip {...props} bars={BARS} />);
    expect(screen.getByRole('img', { name: 'Thời gian chuẩn và thực tế của từng bước' })).toBeInTheDocument();
    expect(container.querySelectorAll('.ui-day-strip__bar--plan')).toHaveLength(2);
    expect(container.querySelectorAll('.ui-day-strip__bar--actual')).toHaveLength(2);
    // B was planned to end on the 6th and ended on the 10th: four days over.
    expect(container.querySelectorAll('.ui-day-strip__bar--over')).toHaveLength(1);
    expect(screen.getByText('+4 ngày')).toBeInTheDocument();
  });

  it('gives the bars as a table on request, saying when a plan cannot be counted and when a step was not reached', async () => {
    render(<DayStrip {...props} bars={BARS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Xem dạng bảng' }));
    const table = screen.getByRole('table', { name: 'Thời gian chuẩn và thực tế của từng bước' });
    const row = (label: string): HTMLElement => within(table).getByRole('rowheader', { name: label }).closest('tr') as HTMLElement;
    expect(within(row('Đánh giá')).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['04/11 đến 06/11', '04/11 đến 10/11', '+4 ngày']);
    expect(within(row('Ký hợp đồng')).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Chưa tính được (thiếu lịch làm việc)', 'Chưa tới', '']);
    await userEvent.click(screen.getByRole('button', { name: 'Xem dạng dải' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('loading is a skeleton, error retries, empty says there are no days', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<DayStrip {...props} state="loading" />);
    expect(screen.getByRole('status', { name: 'Đang tải dải ngày' })).toHaveAttribute('aria-busy', 'true');
    rerender(<DayStrip {...props} state="error" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<DayStrip {...props} state="empty" />);
    expect(screen.getByRole('status')).toHaveTextContent('Chưa có ngày nào để hiển thị');
    rerender(<DayStrip {...props} from="2026-11-12" to="2026-11-02" />);
    expect(screen.getByRole('status')).toHaveTextContent('Chưa có ngày nào để hiển thị');
  });

  it('scrolls inside its own region (the page never scrolls sideways)', () => {
    render(<DayStrip {...props} />);
    expect(screen.getByRole('group', { name: 'Dải ngày từ lúc bắt đầu đến hôm nay' })).toHaveAttribute('tabindex', '0');
  });

  it('has no serious accessibility violation', async () => {
    const { container } = render(<DayStrip {...props} bars={BARS} />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
