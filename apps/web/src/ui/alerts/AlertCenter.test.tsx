import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import { AlertCenter, UNDO_MS } from './AlertCenter';
import { ME, OTHER, alertsBackend, countsAnswer, failure, harness, listAnswer, mount, rawItem } from './test-support';

const URGENT = rawItem('u1', {
  severity: 'URGENT',
  source: 'AUDIT_RECOMMENDATION',
  title: 'Kiến nghị quá hạn',
  subtitle: 'Thanh tra Q3',
  due_on: '2026-11-04',
  days_late: 3,
  overdue: true,
  consequence: 'Bị báo cáo cấp trên',
  escalation: { level: 2, of: 3, next_at: '2026-11-08T02:00:00Z', chain: ['Tổ trưởng', 'Trưởng phòng'] },
  target: { screen: 'HOME-03', id: 'u1' },
});
const ACTION = rawItem('a1', { severity: 'ACTION', source: 'ADVANCE', title: 'Tạm ứng chờ quyết toán', subtitle: 'HĐ 12', due_on: '2999-12-31', target: { screen: 'PRJ-19', id: 'a1' } });
const WATCH = rawItem('w1', { severity: 'WATCH', source: 'PERMIT', title: 'Giấy phép sắp hết hạn', due_on: null });
const ALL_ITEMS = [URGENT, ACTION, WATCH];
const mineView = { counts: countsAnswer(1, 1, 1), list: listAnswer(ALL_ITEMS, { counts: { urgent: 1, action: 1, watch: 1, total: 3 } }) };
const scopeView = { counts: countsAnswer(0, 5, 0, { view: 'scope' }), list: listAnswer([rawItem('s1', { title: 'Việc của đơn vị', severity: 'ACTION' })], { view: 'scope' }) };

function Host({ initial = true }: { initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Mở trung tâm
      </button>
      <AlertCenter open={open} onClose={() => setOpen(false)} />
    </>
  );
}

const rows = (): HTMLElement[] => within(screen.getByRole('list', { name: 'Danh sách việc cần xử lý' })).getAllByRole('listitem');
const row = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
  if (found === null) throw new Error(`no row ${id}`);
  return found;
};
const calls = (h: { read: { mock: { calls: unknown[][] } } }, operation: string) => h.read.mock.calls.filter(([name]) => name === operation);

afterEach(() => {
  vi.useRealTimers();
});

describe('AlertCenter: reading', () => {
  it('reads nothing while it is closed, and reads the list when it opens', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView, scope: scopeView }));
    mount(<Host initial={false} />, h);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.read).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Mở trung tâm' }));
    expect(await screen.findByRole('dialog', { name: 'Cần xử lý ngay' })).toBeInTheDocument();
    await waitFor(() => expect(calls(h, 'getMyWork')).toHaveLength(1));
    expect(calls(h, 'getMyWork')[0]?.[1]).toEqual({ query: { view: 'mine', limit: 50 } });
  });

  it('lists each item with its level, title, subtitle, source, deadline, owner, escalation and consequence', async () => {
    const h = harness(alertsBackend({ mine: mineView, scope: scopeView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    const urgent = row('u1');
    expect(within(urgent).getByText('Khẩn')).toBeInTheDocument();
    expect(within(urgent).getByRole('link', { name: 'Mở hồ sơ: Kiến nghị quá hạn' })).toHaveAttribute('href', '/home/home-03');
    expect(within(urgent).getByText('Thanh tra Q3')).toBeInTheDocument();
    expect(within(urgent).getByText('Kiến nghị kiểm toán')).toBeInTheDocument();
    expect(within(urgent).getByText('Quá hạn 3 ngày')).toBeInTheDocument();
    expect(within(urgent).getByText('Chưa có người nhận')).toBeInTheDocument();
    expect(within(urgent).getByText('Leo thang cấp 2/3')).toBeInTheDocument();
    expect(within(urgent).getByText('Nếu không xử lý: Bị báo cáo cấp trên')).toBeInTheDocument();
    expect(within(row('a1')).getByRole('link', { name: 'Mở hồ sơ: Tạm ứng chờ quyết toán' })).toHaveAttribute('href', '/prj/prj-19');
    expect(within(row('w1')).getByText('Chưa có hạn')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Xem tất cả' })).toHaveAttribute('href', '/home/home-02');
    expect(screen.getByText('Đã kiểm tra lúc 09:15')).toBeInTheDocument();
  });

  it('shows the owner of a claimed item and the assignee of an assigned one', async () => {
    const claimed = rawItem('c1', { lifecycle: 'CLAIMED', claimed_by: { id: OTHER, name: 'Trần Bình', at: '2026-11-07T03:30:00Z' } });
    const given = rawItem('g1', { lifecycle: 'CLAIMED', assignee: { id: OTHER, name: 'Lê Chi', due_on: '2026-11-12' } });
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(0, 2, 0), list: listAnswer([claimed, given]) } }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(row('c1')).getByText('Đã nhận bởi Trần Bình lúc 10:30')).toBeInTheDocument();
    expect(within(row('c1')).queryByRole('button', { name: 'Nhận xử lý' })).toBeNull();
    expect(within(row('g1')).getByText('Giao cho Lê Chi, hạn 12/11')).toBeInTheDocument();
  });

  it('filters by level and tells apart "nothing" from "nothing at this level"', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(0, 1, 0), list: listAnswer([ACTION]) } }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(1));
    const filter = screen.getByRole('group', { name: 'Lọc theo mức' });
    await user.click(within(filter).getByRole('button', { name: /Khẩn/ }));
    expect(within(filter).getByRole('button', { name: /Khẩn/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Không có việc nào ở mức này.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Bỏ lọc' }));
    expect(rows()).toHaveLength(1);
    await user.click(within(filter).getByRole('button', { name: /Theo dõi/ }));
    expect(screen.queryByRole('list', { name: 'Danh sách việc cần xử lý' })).toBeNull();
  });

  it('puts the counts of the view on the level filters', async () => {
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    const filter = await screen.findByRole('group', { name: 'Lọc theo mức' });
    await waitFor(() => expect(within(filter).getByRole('button', { name: /Cần xử lý/ })).toHaveTextContent('1'));
  });

  it('says there is nothing to do when the list is empty', async () => {
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(0, 0, 0), list: listAnswer([]) } }));
    mount(<Host />, h);
    expect(await screen.findByText('Không còn việc cần xử lý.')).toBeInTheDocument();
  });
});

describe('AlertCenter: views', () => {
  it('offers the scope view only once the server allows it, and switches the list with it', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView, scope: scopeView }));
    mount(<Host />, h);
    const mineTab = await screen.findByRole('tab', { name: 'Của tôi' });
    expect(mineTab).toHaveAttribute('aria-selected', 'true');
    const scopeTab = await screen.findByRole('tab', { name: 'Trong phạm vi' });
    await user.click(scopeTab);
    expect(scopeTab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Danh sách việc cần xử lý' })).getByText('Việc của đơn vị')).toBeInTheDocument());
    expect(calls(h, 'getMyWork').some(([, input]) => (input as { query: { view: string } }).query.view === 'scope')).toBe(true);
    await user.click(screen.getByRole('tab', { name: 'Của tôi' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it('hides the scope tab when the server answers 403', async () => {
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() => expect(calls(h, 'getMyWorkCounts').some(([, input]) => (input as { query: { view: string } }).query.view === 'scope')).toBe(true));
    expect(screen.queryByRole('tab', { name: 'Trong phạm vi' })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });
});

describe('AlertCenter: states', () => {
  it('shows a skeleton, never an empty list or a 0, while the list loads', async () => {
    const h = harness((operation, input) => (operation === 'getMyWork' ? new Promise(() => undefined) : alertsBackend({ mine: mineView })(operation, input)) as never);
    mount(<Host />, h);
    const skeleton = await screen.findByRole('status', { name: 'Đang tải danh sách việc cần xử lý' });
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Không còn việc cần xử lý.')).toBeNull();
  });

  it('says it could not read and retries in place', async () => {
    const user = userEvent.setup();
    let fail = true;
    const backend = alertsBackend({ mine: mineView });
    const h = harness((operation, input) => (operation === 'getMyWork' && fail ? failure(503) : backend(operation, input)));
    mount(<Host />, h);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Không đọc được danh sách việc cần xử lý.');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByText('Không đọc được danh sách việc cần xử lý.')).toBeNull();
  });

  it('names the sources that could not be read and keeps the list it has', async () => {
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(0, 1, 0), list: listAnswer([ACTION], { unavailable_sources: ['PERMIT', 'ADVANCE'] }) } }));
    mount(<Host />, h);
    const warning = await screen.findByTestId('alert-unavailable');
    expect(warning).toHaveTextContent('Chưa đọc được nguồn: Giấy phép, Tạm ứng. Danh sách có thể còn thiếu việc.');
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText('Không còn việc cần xử lý.')).toBeNull();
  });

  it('says the figures are old, with the last good time, when a refresh fails', async () => {
    let fail = false;
    const backend = alertsBackend({ mine: mineView });
    const h = harness((operation, input) => (fail && operation === 'getMyWork' ? failure(503) : backend(operation, input)));
    const view = mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    fail = true;
    await view.queries.refetchQueries({ queryKey: ['alerts'] });
    const stale = await screen.findByText(/Số liệu cũ, lần cuối lúc \d\d:\d\d\./);
    expect(stale).toBeInTheDocument();
    expect(rows()).toHaveLength(3);
  });

  it('says the scope is hidden for a denied view and leaks no names', async () => {
    const h = harness((operation, input) => (operation === 'getMyWork' ? failure(403, 'FORBIDDEN') : alertsBackend({ mine: mineView })(operation, input)));
    mount(<Host />, h);
    expect(await screen.findByText('Phạm vi này đang ẩn với bạn.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Danh sách việc cần xử lý' })).toBeNull();
  });
});

describe('AlertCenter: actions', () => {
  it('offers no snooze for an urgent item', async () => {
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(within(row('u1')).queryByRole('button', { name: 'Nhắc lại' })).toBeNull();
    expect(within(row('a1')).getByRole('button', { name: 'Nhắc lại' })).toBeInTheDocument();
  });

  it('shows the claim at once with an undo for five seconds, then sends it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(within(row('a1')).getByRole('button', { name: 'Nhận xử lý' }));
    expect(within(row('a1')).getByText(/^Đã nhận bởi Nguyễn An lúc \d\d:\d\d$/)).toBeInTheDocument();
    expect(within(row('a1')).getByRole('button', { name: 'Hoàn tác nhận xử lý (còn 5 giây)' })).toHaveFocus();
    expect(within(row('a1')).queryByRole('button', { name: 'Nhận xử lý' })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS + 50);
    });
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('claimWork');
    expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ source: 'ADVANCE', source_id: 'a1' });
    expect(await screen.findByRole('status', { name: 'Kết quả thao tác' })).toHaveTextContent(/Đã nhận bởi Nguyễn An lúc \d\d:\d\d/);
  });

  it('takes the claim back within five seconds: nothing is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(within(row('a1')).getByRole('button', { name: 'Nhận xử lý' }));
    await user.click(within(row('a1')).getByRole('button', { name: 'Hoàn tác nhận xử lý (còn 5 giây)' }));
    expect(within(row('a1')).getByRole('button', { name: 'Nhận xử lý' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS + 500);
    });
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends a claim that is still waiting when the drawer is closed', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(within(row('a1')).getByRole('button', { name: 'Nhận xử lý' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('claimWork');
  });

  it('gives an item to a person chosen from the staff, with a day, and says it did', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(within(row('a1')).getByRole('button', { name: 'Giao cho' }));
    const dialog = await screen.findByRole('dialog', { name: 'Giao việc' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Giao việc' }));
    expect(within(dialog).getByText('Hãy chọn người nhận.')).toBeInTheDocument();
    expect(h.command).not.toHaveBeenCalled();
    const select = within(dialog).getByLabelText('Người nhận');
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
    await user.selectOptions(select, 'Trần Bình');
    const due = within(dialog).getByLabelText('Hạn xử lý');
    await user.clear(due);
    await user.type(due, '2999-12-30');
    await user.click(within(dialog).getByRole('button', { name: 'Giao việc' }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('assignWork');
    expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ source: 'ADVANCE', source_id: 'a1', assignee_id: OTHER, due_on: '2999-12-30' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Giao việc' })).toBeNull());
    expect(screen.getByRole('status', { name: 'Kết quả thao tác' })).toHaveTextContent('Đã giao cho Trần Bình, hạn 30/12');
    expect(screen.getByRole('dialog', { name: 'Cần xử lý ngay' })).toBeInTheDocument();
  });

  it('closes only the dialog on Escape, and puts the focus back on the button that opened it', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    const open = within(row('a1')).getByRole('button', { name: 'Giao cho' });
    await user.click(open);
    await screen.findByRole('dialog', { name: 'Giao việc' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Giao việc' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Cần xử lý ngay' })).toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it('says the lookup failed when the people cannot be read', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView }), undefined, () => failure(503));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(within(row('a1')).getByRole('button', { name: 'Giao cho' }));
    expect(await screen.findByText('Không đọc được danh sách người nhận. Hãy thử lại.')).toBeInTheDocument();
  });

  it('says the server refused an assignment and keeps the dialog', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView }), (operation) => (operation === 'assignWork' ? failure(422, 'VALIDATION_FAILED') : {}));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(within(row('a1')).getByRole('button', { name: 'Giao cho' }));
    const dialog = await screen.findByRole('dialog', { name: 'Giao việc' });
    const select = within(dialog).getByLabelText('Người nhận');
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
    await user.selectOptions(select, 'Lê Chi');
    await user.click(within(dialog).getByRole('button', { name: 'Giao việc' }));
    expect(await within(dialog).findByText('Không giao được việc này.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Giao việc' })).toBeInTheDocument();
  });

  it('snoozes for an hour and says when it will come back', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    const before = Date.now();
    await user.click(within(row('a1')).getByRole('button', { name: 'Nhắc lại' }));
    await user.click(within(row('a1')).getByRole('button', { name: '1 giờ nữa' }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('snoozeWork');
    const body = (h.command.mock.calls[0]?.[1] as { body: { source: string; source_id: string; snooze_until: string } }).body;
    expect(body.source_id).toBe('a1');
    const until = Date.parse(body.snooze_until);
    expect(until - before).toBeGreaterThanOrEqual(3_599_000);
    expect(until - before).toBeLessThan(3_700_000);
    expect(await screen.findByText(/^Sẽ nhắc lại lúc \d\d:\d\d \d\d\/\d\d$/)).toBeInTheDocument();
  });

  it('says the action failed when the server refuses a snooze', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView }), () => failure(422, 'SNOOZE_NOT_ALLOWED'));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(within(row('a1')).getByRole('button', { name: 'Nhắc lại' }));
    await user.click(within(row('a1')).getByRole('button', { name: 'Sáng mai' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không thực hiện được thao tác. Hãy thử lại.');
  });

  it('shows the lifecycle the server answers after an action, without the buttons that no longer apply', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let claimed = false;
    const backend = alertsBackend({ mine: mineView });
    const h = harness(
      (operation, input) => {
        if (operation === 'getMyWork' && claimed) return listAnswer([rawItem('a1', { severity: 'ACTION', title: 'Tạm ứng chờ quyết toán', lifecycle: 'CLAIMED', claimed_by: { id: ME, name: 'Nguyễn An', at: '2026-11-07T03:00:00Z' } })]);
        return backend(operation, input);
      },
      () => {
        claimed = true;
        return {};
      },
    );
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(within(row('a1')).getByRole('button', { name: 'Nhận xử lý' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS + 50);
    });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(row('a1')).getByText('Đã nhận bởi Nguyễn An lúc 10:00')).toBeInTheDocument();
    expect(within(row('a1')).queryByRole('button', { name: 'Nhận xử lý' })).toBeNull();
  });
});

describe('AlertCenter: keyboard and accessibility', () => {
  it('moves the focus into the drawer, keeps Tab inside it and closes on Escape', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView, scope: scopeView }));
    mount(<Host />, h);
    const drawer = await screen.findByRole('dialog', { name: 'Cần xử lý ngay' });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(drawer.contains(document.activeElement)).toBe(true);
    const close = within(drawer).getByRole('button', { name: 'Đóng' });
    expect(close).toHaveFocus();
    // Shift+Tab from the first control goes to the last one, Tab from the last goes to the first.
    await user.tab({ shift: true });
    const last = within(drawer).getByRole('link', { name: 'Xem tất cả' });
    expect(last).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    for (let step = 0; step < 12; step += 1) {
      await user.tab();
      expect(drawer.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes by its button and by a click outside', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await screen.findByRole('dialog', { name: 'Cần xử lý ngay' });
    await user.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Mở trung tâm' }));
    await user.click(await screen.findByTestId('alert-overlay'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no serious accessibility violation with the list, the snooze menu and the dialog open', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: mineView }));
    mount(<Host />, h);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user.click(within(row('a1')).getByRole('button', { name: 'Nhắc lại' }));
    await user.click(within(row('a1')).getByRole('button', { name: 'Chọn ngày' }));
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    await user.click(within(row('w1')).getByRole('button', { name: 'Giao cho' }));
    await screen.findByRole('dialog', { name: 'Giao việc' });
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
