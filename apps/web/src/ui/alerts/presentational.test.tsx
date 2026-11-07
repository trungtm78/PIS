import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AlertActions } from './AlertActions';
import { DeadlineCountdown } from './DeadlineCountdown';
import { EscalationTrail } from './EscalationTrail';
import { SeverityBadge } from './SeverityBadge';
import { clock, clockAndDay, dayMonth, daysBetween, morningOf, nextDay, todayOf } from './format';
import { toAlertCounts, toAlertItem, toCountsAnswer, toListAnswer } from './types';
import type { AlertItem } from './types';
import { OTHER, rawItem } from './test-support';

const item = (overrides: Record<string, unknown> = {}): AlertItem => {
  const parsed = toAlertItem(rawItem('a1', overrides));
  if (parsed === undefined) throw new Error('the fixture is not an item');
  return parsed;
};
const ALL = { claim: true, assign: true, snooze: true };

describe('SeverityBadge', () => {
  it.each([
    ['URGENT', 'Khẩn'],
    ['ACTION', 'Cần xử lý'],
    ['WATCH', 'Theo dõi'],
  ] as const)('says %s in words with an icon that is hidden from readers', (severity, label) => {
    const { container } = render(<SeverityBadge severity={severity} label={label} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-severity', severity);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('DeadlineCountdown', () => {
  it('shows the days left with the absolute day, with no seconds and no live region', () => {
    const { container } = render(<DeadlineCountdown dueOn="2026-11-09" today="2026-11-07" />);
    expect(screen.getByText('Còn 2 ngày · 09/11')).toBeInTheDocument();
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.textContent).not.toMatch(/:\d\d/);
  });
  it('says "Hôm nay" on the day itself', () => {
    render(<DeadlineCountdown dueOn="2026-11-07" today="2026-11-07" />);
    expect(screen.getByText('Hôm nay')).toBeInTheDocument();
  });
  it('says how late it is, from the days the API counts or from the two days', () => {
    const { rerender } = render(<DeadlineCountdown dueOn="2026-11-04" today="2026-11-07" />);
    expect(screen.getByText('Quá hạn 3 ngày')).toHaveAttribute('data-tone', 'danger');
    rerender(<DeadlineCountdown dueOn="2026-11-07" today="2026-11-07" daysLate={5} />);
    expect(screen.getByText('Quá hạn 5 ngày')).toBeInTheDocument();
  });
  it('says there is no due day when there is none', () => {
    render(<DeadlineCountdown dueOn={null} today="2026-11-07" />);
    expect(screen.getByText('Chưa có hạn')).toBeInTheDocument();
  });
});

describe('EscalationTrail', () => {
  it('names the level, the chain and when the next level comes', () => {
    render(<EscalationTrail level={2} of={3} chain={['Tổ trưởng', 'Trưởng phòng', 'Giám đốc']} nextAt="2026-11-07T02:00:00Z" />);
    const group = screen.getByRole('group', { name: 'Tiến trình leo thang' });
    expect(within(group).getByText('Leo thang cấp 2/3')).toBeInTheDocument();
    expect(group.textContent).toContain('Tổ trưởng → Trưởng phòng → Giám đốc');
    expect(group.textContent).toContain('cấp kế tiếp lúc 09:00 07/11');
    expect(group.querySelectorAll('[data-reached="true"]')).toHaveLength(2);
    expect(group.querySelectorAll('[data-reached="false"]')).toHaveLength(1);
  });
  it('says nothing about a next level at the last one', () => {
    render(<EscalationTrail level={3} of={3} chain={[]} nextAt={null} />);
    expect(screen.queryByText(/kế tiếp/)).toBeNull();
  });
});

describe('AlertActions', () => {
  it('offers the three actions and calls them', async () => {
    const user = userEvent.setup();
    const onClaim = vi.fn();
    const onAssign = vi.fn();
    const onSnooze = vi.fn();
    render(<AlertActions item={item()} can={ALL} onClaim={onClaim} onAssign={onAssign} onSnooze={onSnooze} />);
    await user.click(screen.getByRole('button', { name: 'Nhận xử lý' }));
    await user.click(screen.getByRole('button', { name: 'Giao cho' }));
    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Nhắc lại' }));
    expect(onSnooze).toHaveBeenCalledTimes(1);
    // The snooze opens a dialog owned by the caller: there is no menu of choices here any more.
    expect(screen.queryByRole('button', { name: '1 giờ nữa' })).toBeNull();
  });
  it('reads "Nhận lại" for an item that went silent after it was taken up, and offers it although it is claimed', async () => {
    const user = userEvent.setup();
    const onClaim = vi.fn();
    render(<AlertActions item={item({ lifecycle: 'CLAIMED', needs_reclaim: true })} can={ALL} onClaim={onClaim} onAssign={vi.fn()} onSnooze={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Nhận xử lý' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Nhận lại' }));
    expect(onClaim).toHaveBeenCalledTimes(1);
  });
  it('offers to pause the clock of an open item that has clocks, and to run it again when it is paused', async () => {
    const user = userEvent.setup();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const clocks = { basis: 'WORKING_TIME', claim: null, resolve: { state: 'RUNNING', started_at: null, due_at: '2999-01-01T01:00:00Z', met_at: null }, paused: null, needs_reclaim: null };
    const can = { ...ALL, pause: true };
    const { rerender } = render(<AlertActions item={item({ clocks })} can={can} onClaim={vi.fn()} onAssign={vi.fn()} onSnooze={vi.fn()} onPause={onPause} onResume={onResume} />);
    await user.click(screen.getByRole('button', { name: 'Tạm dừng đồng hồ' }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Chạy lại đồng hồ' })).toBeNull();
    const pause = { from: '2026-11-07T01:00:00Z', until: '2999-01-01T01:00:00Z', resumed_at: null, reason_code: 'OTHER', reason: 'Chờ phản hồi', allowed_by: { id: OTHER, name: 'Trần Bình' }, by: null };
    rerender(<AlertActions item={item({ clocks: { ...clocks, paused: pause }, pause })} can={can} onClaim={vi.fn()} onAssign={vi.fn()} onSnooze={vi.fn()} onPause={onPause} onResume={onResume} />);
    expect(screen.queryByRole('button', { name: 'Tạm dừng đồng hồ' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Chạy lại đồng hồ' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('has no pause for an item without clocks, or when the person may not pause', () => {
    const clocks = { basis: 'WORKING_TIME', claim: null, resolve: { state: 'RUNNING', started_at: null, due_at: '2999-01-01T01:00:00Z', met_at: null }, paused: null, needs_reclaim: null };
    const { rerender } = render(<AlertActions item={item()} can={{ ...ALL, pause: true }} onClaim={vi.fn()} onAssign={vi.fn()} onSnooze={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Tạm dừng đồng hồ' })).toBeNull();
    rerender(<AlertActions item={item({ clocks })} can={ALL} onClaim={vi.fn()} onAssign={vi.fn()} onSnooze={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Tạm dừng đồng hồ' })).toBeNull();
  });
  it('has no snooze for an urgent item', () => {
    render(<AlertActions item={item({ severity: 'URGENT' })} can={ALL} onClaim={vi.fn()} onAssign={vi.fn()} onSnooze={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Nhắc lại' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Nhận xử lý' })).toBeInTheDocument();
  });
  it('does not offer to claim what is claimed, and nothing for what is done', () => {
    const { rerender, container } = render(<AlertActions item={item({ lifecycle: 'CLAIMED' })} can={ALL} onClaim={vi.fn()} onAssign={vi.fn()} onSnooze={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Nhận xử lý' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Giao cho' })).toBeInTheDocument();
    rerender(<AlertActions item={item({ lifecycle: 'RESOLVED' })} can={ALL} onClaim={vi.fn()} onAssign={vi.fn()} onSnooze={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('hides what the person may not do and locks everything while a command runs', () => {
    const { rerender } = render(<AlertActions item={item()} can={{ claim: false, assign: true, snooze: false }} onClaim={vi.fn()} onAssign={vi.fn()} onSnooze={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Nhận xử lý' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nhắc lại' })).toBeNull();
    rerender(<AlertActions item={item()} can={ALL} busy onClaim={vi.fn()} onAssign={vi.fn()} onSnooze={vi.fn()} />);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
});

describe('format and types', () => {
  it('reads the day and the time in Vietnam', () => {
    expect(todayOf(new Date('2026-11-06T18:30:00Z'))).toBe('2026-11-07');
    expect(dayMonth('2026-11-09')).toBe('09/11');
    expect(clock('2026-11-07T02:15:00Z')).toBe('09:15');
    expect(clock('not a date')).toBe('');
    expect(clockAndDay('2026-11-07T02:15:00Z')).toBe('09:15 07/11');
    expect(clockAndDay('x')).toBe('');
    expect(daysBetween('2026-11-07', '2026-11-10')).toBe(3);
    expect(morningOf('2026-11-08')).toBe('2026-11-08T01:00:00.000Z');
    expect(nextDay('2026-11-30')).toBe('2026-12-01');
  });
  it('drops a row that has not the shape of an item and defaults what is missing', () => {
    expect(toAlertItem({ id: '', title: 'x' })).toBeUndefined();
    expect(toAlertItem('x')).toBeUndefined();
    const bare = toAlertItem({ id: 'z', title: 'T' });
    expect(bare).toMatchObject({ severity: 'ACTION', lifecycle: 'NEW', claimed_by: null, escalation: null, due_on: null });
    expect(toAlertItem(rawItem('e', { escalation: { level: 0, of: 3 } }))?.escalation).toBeNull();
    expect(toAlertItem(rawItem('e', { escalation: { level: 2, of: 1, chain: ['A', 3] } }))?.escalation).toEqual({ level: 2, of: 2, next_at: null, chain: ['A'] });
  });
  it('reads the counts and the list answers', () => {
    expect(toAlertCounts({ urgent: 1, action: 2, watch: 3 })).toEqual({ urgent: 1, action: 2, watch: 3, total: 6 });
    expect(toAlertCounts(null)).toBeNull();
    expect(toCountsAnswer({ counts: { urgent: 1, action: 0, watch: 0, total: 1 }, unavailable_sources: ['PERMIT'], as_of: '2026-11-07T02:15:00Z' }, 'scope')).toMatchObject({ view: 'scope', unavailable_sources: ['PERMIT'] });
    expect(toCountsAnswer({}, 'mine')).toBeUndefined();
    expect(toListAnswer({ items: [rawItem('a'), { id: '' }], unavailable_sources: ['ADVANCE'] }, 'mine')).toMatchObject({ items: [{ id: 'a' }], unavailable_sources: ['ADVANCE'], counts: null });
    expect(toListAnswer(null, 'mine').items).toEqual([]);
  });
});
