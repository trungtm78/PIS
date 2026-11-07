import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../test/axe';
import { Timeline } from './Timeline';
import type { TimelineGroup } from './Timeline';

afterEach(cleanup);

const LONG = 'Thiếu biên bản mở thầu có chữ ký của đại diện các nhà thầu tham dự; trả hồ sơ về bước trước để bổ sung trước khi chuyển tiếp lần nữa.';

/** Times are UTC; Vietnam is seven hours ahead (01:00Z is 08:00). */
const GROUPS: TimelineGroup[] = [
  {
    date: '2026-11-05',
    entries: [
      { id: 'e1', at: '2026-11-05T03:30:00.000Z', kind: 'transition', from: 'Mời thầu', to: 'Mở thầu', actor: { name: 'Nguyễn Văn An', initials: 'NA' }, after: 'sau 6 ngày ở bước trước' },
      { id: 'e2', at: '2026-11-05T02:00:00.000Z', kind: 'checklist', title: 'Hoàn thành mục: Biên bản mở thầu', actor: { name: 'Trần Thị Bình', initials: 'TB' }, evidence: [{ label: 'Biên bản mở thầu.pdf', href: '/doc/1' }] },
      { id: 'e3', at: '2026-11-05T01:00:00.000Z', kind: 'return', title: 'Trả lại bước Lập hồ sơ', actor: null, note: LONG },
    ],
  },
  { date: '2026-11-02', entries: [{ id: 'e4', at: '2026-11-02T01:00:00.000Z', kind: 'clock', title: 'Bước quá hạn', badge: 'Quá hạn', note: 'Gói thầu ở lại bước quá số ngày chuẩn.' }] },
];

describe('Timeline', () => {
  it('groups the entries by day with a header of weekday, date, relative day and the number of changes', () => {
    render(<Timeline groups={GROUPS} caption="Dòng thời gian" today="2026-11-07" />);
    const heads = screen.getAllByRole('heading', { level: 3 }).map((head) => head.textContent);
    expect(heads[0]).toContain('05/11/2026');
    expect(heads[0]).toContain('2 ngày trước');
    expect(heads[0]).toContain('3 thay đổi');
    expect(heads[1]).toContain('02/11/2026');
    expect(heads[1]).toContain('1 thay đổi');
  });

  it('says today and yesterday in words', () => {
    render(<Timeline groups={[{ date: '2026-11-07', entries: [GROUPS[0]!.entries[0]!] }, { date: '2026-11-06', entries: [GROUPS[1]!.entries[0]!] }]} caption="c" today="2026-11-07" />);
    expect(screen.getByText('Hôm nay')).toBeInTheDocument();
    expect(screen.getByText('Hôm qua')).toBeInTheDocument();
  });

  it('shows the time in Vietnam, the states as pills, the actor, the days spent before and the evidence as links', () => {
    render(<Timeline groups={GROUPS} caption="c" />);
    const move = document.querySelector('[data-entry-id="e1"]') as HTMLElement;
    expect(within(move).getByText('10:30')).toBeInTheDocument();
    expect(within(move).getByText('Chuyển từ', { exact: false })).toBeInTheDocument();
    expect(within(move).getByText('Mời thầu')).toBeInTheDocument();
    expect(within(move).getByText('Mở thầu')).toBeInTheDocument();
    expect(within(move).getByText('Nguyễn Văn An')).toBeInTheDocument();
    expect(within(move).getByText('sau 6 ngày ở bước trước')).toBeInTheDocument();
    const checked = document.querySelector('[data-entry-id="e2"]') as HTMLElement;
    expect(within(checked).getByRole('link', { name: 'Biên bản mở thầu.pdf' })).toHaveAttribute('href', '/doc/1');
  });

  it('labels an entry with no person as the system, and a clock event with its badge and consequence', () => {
    render(<Timeline groups={GROUPS} caption="c" />);
    expect(within(document.querySelector('[data-entry-id="e3"]') as HTMLElement).getByText('Hệ thống')).toBeInTheDocument();
    const clock = document.querySelector('[data-entry-id="e4"]') as HTMLElement;
    expect(within(clock).getByText('Quá hạn')).toBeInTheDocument();
    expect(within(clock).getByText('Gói thầu ở lại bước quá số ngày chuẩn.')).toBeInTheDocument();
  });

  it('clamps a long note and expands it on request', async () => {
    render(<Timeline groups={GROUPS} caption="c" />);
    const note = screen.getByText(LONG);
    expect(note).toHaveClass('is-clamped');
    const more = screen.getByRole('button', { name: 'Xem thêm' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(note).not.toHaveClass('is-clamped');
    expect(screen.getByRole('button', { name: 'Thu gọn' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses the quiet days between two days into one muted row that says what it waits for, and opens it on request', async () => {
    render(<Timeline groups={GROUPS} caption="c" waitingLabel="Đánh giá hồ sơ" />);
    const gap = screen.getByRole('button', { name: '2 ngày không có thay đổi · đang chờ Đánh giá hồ sơ' });
    expect(gap).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(gap);
    expect(gap).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText('không có thay đổi')).toHaveLength(2);
  });

  it('shows no gap row when gaps are off, and says the days with no change plainly when nothing is awaited', () => {
    const { rerender } = render(<Timeline groups={GROUPS} caption="c" gaps={false} />);
    expect(screen.queryByRole('button', { name: /không có thay đổi/ })).not.toBeInTheDocument();
    rerender(<Timeline groups={GROUPS} caption="c" />);
    expect(screen.getByRole('button', { name: '2 ngày không có thay đổi' })).toBeInTheDocument();
  });

  it('puts the newest day first and flips to the oldest first on request, telling the caller', async () => {
    const onOrder = vi.fn();
    render(<Timeline groups={GROUPS} caption="c" onOrder={onOrder} />);
    expect(screen.getAllByRole('heading', { level: 3 })[0]?.textContent).toContain('05/11/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Cũ nhất trước' }));
    expect(onOrder).toHaveBeenCalledWith('asc');
    expect(screen.getAllByRole('heading', { level: 3 })[0]?.textContent).toContain('02/11/2026');
    expect(screen.getByRole('button', { name: 'Mới nhất trước' })).toBeInTheDocument();
  });

  it('opens an entry when its title is a link to a record', async () => {
    const onSelectEntry = vi.fn();
    render(<Timeline groups={GROUPS} caption="c" onSelectEntry={onSelectEntry} />);
    await userEvent.click(screen.getByRole('button', { name: /Hoàn thành mục: Biên bản mở thầu/ }));
    expect(onSelectEntry).toHaveBeenCalledWith('e2');
  });

  it('marks an entry that is not confirmed yet as being recorded', () => {
    render(<Timeline groups={[{ date: '2026-11-05', entries: [{ id: 'p', at: '2026-11-05T01:00:00.000Z', kind: 'hold', title: 'Tạm dừng', pending: true }] }]} caption="c" />);
    expect(screen.getByText('đang ghi')).toBeInTheDocument();
  });

  it('loading is a skeleton with no number', () => {
    render(<Timeline groups={GROUPS} caption="c" state="loading" />);
    const status = screen.getByRole('status', { name: 'Đang tải dòng thời gian' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status.textContent).not.toMatch(/\d/);
  });

  it('error retries in place', async () => {
    const onRetry = vi.fn();
    render(<Timeline groups={GROUPS} caption="c" state="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Không tải được dòng thời gian');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each([
    ['none', 'Chưa có thay đổi nào'],
    ['filtered', 'Không có thay đổi nào khớp bộ lọc'],
  ] as const)('empty (%s) says which kind', (kind, text) => {
    render(<Timeline groups={[]} caption="c" emptyKind={kind} />);
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });

  it('shows the banners of a partial, stale or denied read over the entries that are there', () => {
    render(<Timeline groups={GROUPS} caption="c" notices={[{ kind: 'partial', text: 'Chưa đọc được: mốc muasamcong' }, { kind: 'denied', text: 'Một số thay đổi bị ẩn' }]} />);
    expect(screen.getByText('Chưa đọc được: mốc muasamcong')).toBeInTheDocument();
    expect(screen.getByText('Một số thay đổi bị ẩn')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
  });

  it('has no serious accessibility violation', async () => {
    const { container } = render(<Timeline groups={GROUPS} caption="Dòng thời gian" today="2026-11-07" waitingLabel="Đánh giá hồ sơ" />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
