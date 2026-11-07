import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AlertRow } from './AlertRow';
import { ClockLines, durationText } from './ItemClocks';
import { rawItem } from './test-support';
import { toAlertItem } from './types';
import { t } from '../../i18n';

// Saturday 7 November 2026, 10:00 in Vietnam.
const NOW = new Date('2026-11-07T03:00:00Z');

const clock = (state: string, dueAt: string, extra: Record<string, unknown> = {}) => ({ state, started_at: '2026-11-06T02:00:00Z', due_at: dueAt, met_at: null, ...extra });
const withClocks = (clocks: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
  const parsed = toAlertItem(rawItem('c1', { source: 'CLOCK', due_on: null, clocks: { basis: 'WORKING_TIME', claim: null, resolve: null, paused: null, needs_reclaim: null, ...clocks }, ...overrides }));
  if (parsed === undefined) throw new Error('fixture');
  return parsed;
};
const plain = (overrides: Record<string, unknown> = {}) => {
  const parsed = toAlertItem(rawItem('p1', overrides));
  if (parsed === undefined) throw new Error('fixture');
  return parsed;
};

describe('durationText', () => {
  it.each([
    [2 * 86_400_000 + 3 * 3_600_000, '2 ngày 3 giờ'],
    [3 * 86_400_000, '3 ngày'],
    [4 * 3_600_000 + 30 * 60_000, '4 giờ 30 phút'],
    [2 * 3_600_000, '2 giờ'],
    [40 * 60_000, '40 phút'],
    [10_000, 'dưới 1 phút'],
    [-5, 'dưới 1 phút'],
  ])('says %d ms as "%s"', (milliseconds, words) => {
    expect(durationText(t, milliseconds)).toBe(words);
  });
});

describe('ClockLines', () => {
  it('shows a running clock with its state, its due moment in Vietnam time and about how long is left', () => {
    render(<ClockLines item={withClocks({ resolve: clock('RUNNING', '2026-11-07T07:30:00Z') })} now={NOW} />);
    const line = screen.getByText('Xử lý').closest('li') as HTMLElement;
    expect(line).toHaveAttribute('data-state', 'RUNNING');
    expect(within(line).getByText('Đang chạy')).toBeInTheDocument();
    expect(within(line).getByText('hạn 14:30 07/11 (giờ Việt Nam)')).toBeInTheDocument();
    expect(within(line).getByText('còn khoảng 4 giờ 30 phút')).toBeInTheDocument();
    expect(screen.queryByText('Nhận việc')).toBeNull();
  });

  it('shows both clocks, each with its own state', () => {
    render(<ClockLines item={withClocks({ claim: clock('MET', '2026-11-07T01:00:00Z', { met_at: '2026-11-07T00:30:00Z' }), resolve: clock('RUNNING', '2026-11-09T03:00:00Z') })} now={NOW} />);
    const claim = screen.getByText('Nhận việc').closest('li') as HTMLElement;
    const resolve = screen.getByText('Xử lý').closest('li') as HTMLElement;
    expect(within(claim).getByText('Đạt')).toBeInTheDocument();
    expect(within(claim).getByText('lúc 07:30 07/11')).toBeInTheDocument();
    expect(within(resolve).getByText('còn khoảng 2 ngày')).toBeInTheDocument();
  });

  it('shows a breached clock as overdue and a late one as met late', () => {
    render(<ClockLines item={withClocks({ claim: clock('BREACHED', '2026-11-07T01:00:00Z'), resolve: clock('MET_LATE', '2026-11-06T01:00:00Z', { met_at: '2026-11-06T05:00:00Z' }) })} now={NOW} />);
    const claim = screen.getByText('Nhận việc').closest('li') as HTMLElement;
    const resolve = screen.getByText('Xử lý').closest('li') as HTMLElement;
    expect(within(claim).getByText('Quá hạn')).toHaveAttribute('data-tone', 'danger');
    expect(within(claim).getByText('quá 2 giờ')).toBeInTheDocument();
    expect(within(resolve).getByText('Đạt muộn')).toBeInTheDocument();
    expect(within(resolve).queryByText(/^quá /)).toBeNull();
    expect(within(resolve).queryByText(/^còn khoảng/)).toBeNull();
  });

  it('shows the pause with its reason, the explanation, who allowed it and until when', () => {
    const paused = { from: '2026-11-07T01:00:00Z', until: '2026-11-10T01:00:00Z', resumed_at: null, reason_code: 'WAITING_EXTERNAL_PARTY', reason: 'Chờ chủ đầu tư', allowed_by: { id: 'u2', name: 'Trần Bình' }, by: { id: 'u1', name: 'Nguyễn An' } };
    render(<ClockLines item={withClocks({ resolve: clock('PAUSED', '2026-11-12T03:00:00Z'), paused })} now={NOW} />);
    expect(screen.getByText('Tạm dừng')).toBeInTheDocument();
    expect(screen.getByTestId('clock-paused')).toHaveTextContent('Tạm dừng đến 08:00 10/11 · Chờ bên ngoài: Chờ chủ đầu tư · người cho phép: Trần Bình');
    // A paused clock does not count down.
    expect(screen.queryByText(/còn khoảng/)).toBeNull();
  });

  it('says the working calendar is not published, never "no deadline"', () => {
    render(<ClockLines item={withClocks({ basis: 'CALENDAR_UNAVAILABLE' })} now={NOW} />);
    expect(screen.getByTestId('clock-calendar-unavailable')).toHaveTextContent('chưa có lịch làm việc đã công bố cho năm này');
    expect(screen.queryByText('Chưa có hạn')).toBeNull();
  });

  it('says the clock has not started when there is no start moment', () => {
    render(<ClockLines item={withClocks({ basis: 'NO_START' })} now={NOW} />);
    expect(screen.getByText('Đồng hồ chưa bắt đầu: chưa có mốc bắt đầu.')).toBeInTheDocument();
  });

  it('shows what happened to the item as chips, and the clock the module keeps', () => {
    const item = withClocks(
      { resolve: clock('RUNNING', '2026-11-08T03:00:00Z'), needs_reclaim: { since: '2026-11-07T00:00:00Z' } },
      {
        needs_reclaim: true,
        snooze: { id: 's1', by: { id: 'u1', name: 'Nguyễn An' }, until: '2026-11-08T01:00:00Z', at: '2026-11-07T01:00:00Z', reason_code: 'WAITING_INFORMATION', note: null, ordinal: 1, of: 2, final: false, policy_version: 'builtin' },
        snooze_count: 1,
        reminders: { sent: 2, last_at: '2026-11-07T01:00:00Z', next_at: null, due: false, exhausted: false, every_working_hours: 4 },
        notices: [{ kind: 'RECLAIM_NOTICE', at: '2026-11-07T02:00:00Z' }],
        existing_clock: { code: 'DIS-20', module: 'DIS', basis: 'CALENDAR_DAYS', starts: 'a', stops: 'b', pauses: 'c', migrated: false },
      },
    );
    render(<ClockLines item={item} now={NOW} detailed />);
    const chips = within(screen.getByRole('list', { name: 'Tình trạng của việc này' }));
    expect(chips.getByText('Cần nhận lại')).toBeInTheDocument();
    expect(chips.getByText('Hoãn lần 1/2 · Chờ bổ sung thông tin')).toBeInTheDocument();
    expect(chips.getByText('Đã nhắc 2 lần')).toBeInTheDocument();
    expect(chips.getByText('Đã báo lên cấp trên')).toBeInTheDocument();
    expect(screen.getByTestId('clock-existing')).toHaveTextContent('Đồng hồ riêng của phân hệ: DIS-20');
  });

  it('keeps the chips and the module clock out of the band (not detailed)', () => {
    render(<ClockLines item={withClocks({ resolve: clock('RUNNING', '2026-11-08T03:00:00Z') }, { needs_reclaim: true, existing_clock: { code: 'DIS-20', module: 'DIS', basis: 'CALENDAR_DAYS', starts: '', stops: '', pauses: '', migrated: false } })} now={NOW} />);
    expect(screen.queryByText('Cần nhận lại')).toBeNull();
    expect(screen.queryByTestId('clock-existing')).toBeNull();
    expect(screen.getByText('Xử lý')).toBeInTheDocument();
  });

  it('renders nothing for an item that has no clock and nothing to say', () => {
    const { container } = render(<ClockLines item={plain()} now={NOW} detailed />);
    expect(container).toBeEmptyDOMElement();
  });

  it('has no live region and no seconds', () => {
    const { container } = render(<ClockLines item={withClocks({ resolve: clock('RUNNING', '2026-11-07T07:30:00Z') })} now={NOW} />);
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.textContent).not.toMatch(/\d:\d\d:\d\d/);
  });
});

describe('AlertRow with clocks', () => {
  const row = (item: ReturnType<typeof plain>) =>
    render(
      <MemoryRouter>
        <ul>
          <AlertRow item={item} today="2026-11-07" now={NOW} detailed />
        </ul>
      </MemoryRouter>,
    );

  it('shows the clocks and the action expected instead of the day-based deadline', () => {
    row(withClocks({ resolve: clock('RUNNING', '2026-11-07T07:30:00Z') }, { expected_action: 'Gửi báo cáo tuần', clock_type: 'WEEKLY_REPORT', policy_version: 'builtin' }));
    expect(screen.getByText('Cần làm: Gửi báo cáo tuần')).toBeInTheDocument();
    expect(screen.getByText('còn khoảng 4 giờ 30 phút')).toBeInTheDocument();
    expect(screen.queryByText('Chưa có hạn')).toBeNull();
    expect(screen.getByText('Đồng hồ nghĩa vụ')).toBeInTheDocument();
  });

  it('keeps the day-based deadline for an item with a due day and no clocks', () => {
    row(plain({ due_on: '2026-11-09' }));
    expect(screen.getByText('Còn 2 ngày · 09/11')).toBeInTheDocument();
    expect(screen.queryByTestId('clock-lines')).toBeNull();
  });
});
