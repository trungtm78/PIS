import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import { AlertBand } from './AlertBand';
import type { AlertBandProps } from './AlertBand';
import { toAlertItem } from './types';
import type { AlertItem } from './types';
import { rawItem } from './test-support';

const item = (id: string, overrides: Record<string, unknown> = {}): AlertItem => {
  const parsed = toAlertItem(rawItem(id, overrides));
  if (parsed === undefined) throw new Error('fixture');
  return parsed;
};
const view = (props: Partial<AlertBandProps> & Pick<AlertBandProps, 'items' | 'counts'>) =>
  render(
    <MemoryRouter>
      <AlertBand {...props} />
    </MemoryRouter>,
  );

describe('AlertBand', () => {
  it('shows the counts by level and the rows, urgent first', () => {
    const items = [item('a', { severity: 'ACTION', title: 'Việc A' }), item('u', { severity: 'URGENT', title: 'Việc U', due_on: '2000-01-01', days_late: 4 }), item('w', { severity: 'WATCH', title: 'Việc W' })];
    view({ items, counts: { urgent: 1, action: 1, watch: 1, total: 3 }, asOf: '2026-11-07T02:15:00Z' });
    const counts = screen.getByRole('list', { name: 'Số việc theo mức' });
    expect(within(counts).getByText('Khẩn: 1')).toBeInTheDocument();
    expect(within(counts).getByText('Cần xử lý: 1')).toBeInTheDocument();
    expect(within(counts).getByText('Theo dõi: 1')).toBeInTheDocument();
    const rows = screen.getAllByRole('link', { name: /Mở hồ sơ/ });
    expect(rows.map((link) => link.textContent)).toEqual(['Việc U', 'Việc A', 'Việc W']);
    expect(screen.getByText('Quá hạn 4 ngày')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Xem tất cả' })).toHaveAttribute('href', '/home/home-02');
    expect(screen.queryByTestId('alert-band-calm')).toBeNull();
  });

  it('shows at most five rows by default and says how many more there are', () => {
    const items = Array.from({ length: 7 }, (_unused, index) => item(`r${index}`, { severity: 'URGENT', title: `Việc ${index}` }));
    view({ items, counts: { urgent: 7, action: 0, watch: 0, total: 7 } });
    expect(screen.getAllByRole('listitem').filter((entry) => entry.hasAttribute('data-item-id'))).toHaveLength(5);
    expect(screen.getByText('Còn 2 việc nữa')).toBeInTheDocument();
  });

  it('respects a smaller maximum', () => {
    const items = [item('a'), item('b'), item('c')];
    view({ items, counts: { urgent: 3, action: 0, watch: 0, total: 3 }, max: 2 });
    expect(screen.getAllByRole('listitem').filter((entry) => entry.hasAttribute('data-item-id'))).toHaveLength(2);
  });

  it('says in one line that nothing is urgent, with the time it was checked', () => {
    view({ items: [], counts: { urgent: 0, action: 0, watch: 0, total: 0 }, asOf: '2026-11-07T02:15:00Z' });
    expect(screen.getByTestId('alert-band-calm')).toHaveTextContent('Không còn việc khẩn · đã kiểm tra lúc 09:15');
    expect(screen.queryAllByRole('listitem').filter((entry) => entry.hasAttribute('data-item-id'))).toHaveLength(0);
  });

  it('keeps the one line, without a time, when it is not known; the empty state says the same', () => {
    const { rerender } = view({ items: [], counts: { urgent: 0, action: 2, watch: 0, total: 2 } });
    expect(screen.getByTestId('alert-band-calm')).toHaveTextContent('Không còn việc khẩn');
    expect(screen.getByText('Cần xử lý: 2')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <AlertBand items={[]} counts={{ urgent: 0, action: 0, watch: 0, total: 0 }} state="empty" asOf="2026-11-07T02:15:00Z" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('alert-band-calm')).toHaveTextContent('đã kiểm tra lúc 09:15');
  });

  it('shows a skeleton and never a 0 while loading', () => {
    view({ items: [], counts: { urgent: 0, action: 0, watch: 0, total: 0 }, state: 'loading' });
    expect(screen.getByRole('status', { name: 'Đang tải việc cần xử lý' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/Khẩn: 0/)).toBeNull();
    expect(screen.queryByTestId('alert-band-calm')).toBeNull();
  });

  it('names the failing sources and retries in place', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    view({ items: [], counts: { urgent: 0, action: 0, watch: 0, total: 0 }, state: 'error', unavailable: ['PERMIT', 'AUDIT_RECOMMENDATION'], onRetry });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Chưa đọc được nguồn: Giấy phép, Kiến nghị kiểm toán.');
    await user.click(within(alert).getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says it could not read when no source is named', () => {
    view({ items: [], counts: { urgent: 0, action: 0, watch: 0, total: 0 }, state: 'error' });
    expect(screen.getByRole('alert')).toHaveTextContent('Không đọc được việc cần xử lý.');
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
  });

  it('warns about a source that is missing while it shows the rest, and says when the figures are old', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    view({ items: [item('a', { severity: 'URGENT' })], counts: { urgent: 1, action: 0, watch: 0, total: 1 }, unavailable: ['ADVANCE'], stale: true, asOf: '2026-11-07T02:15:00Z', onRetry });
    expect(screen.getByTestId('alert-band-unavailable')).toHaveTextContent('Chưa đọc được nguồn: Tạm ứng.');
    expect(screen.getByText(/Số liệu cũ, lần cuối lúc 09:15\./)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Mở hồ sơ/ })).toHaveLength(1);
    await user.click(screen.getAllByRole('button', { name: 'Thử lại' })[0] as HTMLElement);
    expect(onRetry).toHaveBeenCalled();
  });

  it('has no serious accessibility violation', async () => {
    const { container } = view({ items: [item('a', { severity: 'URGENT', escalation: { level: 1, of: 3, chain: ['A'], next_at: null } })], counts: { urgent: 1, action: 0, watch: 0, total: 1 } });
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
