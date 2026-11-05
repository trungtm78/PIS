import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, inbox, mount, NOTIFICATION_IDS, problem } from '../../test/notifications';
import type { Harness, RawNotification } from '../../test/notifications';
import NotificationDetailScreen from './NotificationDetailScreen';
import type { WebRoute } from '../../routes/types';

const ROUTE: WebRoute = { id: 'NOT-02', path: '/not/not-02', title: 'Chi tiết thông báo', kind: 'detail', area: 'overview', module: 'NOT', group: 'Hộp thư', role: 'workspace', parent: 'NOT-01', req: 'FR-NOT-02' };

const EVENT_TITLES: Record<string, string> = {
  'notification.event.pay.request.submitted.title': 'Hồ sơ thanh toán đang chờ phê duyệt',
  'notification.event.dis.report.submitted.title': 'Báo cáo giải ngân tuần đã được nộp',
  'notification.event.llm.budget.warning.title': 'Ngân sách AI cần được rà soát',
};

beforeAll(() => {
  Object.assign(vi_, EVENT_TITLES);
});
afterAll(() => {
  for (const key of Object.keys(EVENT_TITLES)) delete (vi_ as Record<string, string>)[key];
});
afterEach(cleanup);

function open(h: Harness, id: string | undefined) {
  const query = id === undefined ? '' : `?id=${id}`;
  return mount(h, { path: `/not/not-02${query}`, routes: { '/not/not-02': <NotificationDetailScreen route={ROUTE} />, '/not/not-01': <p>inbox page</p> } });
}

const READ_AT = '2026-10-22T03:00:00Z';
const withRead = (items: RawNotification[], id: string): RawNotification[] => items.map((item) => (item.id === id ? { ...item, read_at: READ_AT } : item));

describe('NOT-02 notification detail: opening marks it read once', () => {
  it('marks an unread notification read when it is opened, once, not again when the page re-renders', async () => {
    const h = harness([
      { items: inbox(), next_cursor: null },
      { items: withRead(inbox(), NOTIFICATION_IDS.approval), next_cursor: null },
    ]);
    open(h, NOTIFICATION_IDS.approval);
    expect(await screen.findByRole('heading', { level: 2, name: 'Hồ sơ thanh toán đang chờ phê duyệt' })).toBeInTheDocument();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('markNotificationRead', expect.objectContaining({ path: { notificationId: NOTIFICATION_IDS.approval }, body: { opened_via: 'IN_APP' } }));
    await waitFor(() => expect(screen.getByText('Đã đọc')).toBeInTheDocument());
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('does not mark a notification read when its content is unavailable to the member: the deep link of a record they may not read changes nothing (UAT-NFR-PRIVACY NOT02)', async () => {
    const h = harness();
    open(h, NOTIFICATION_IDS.gone);
    expect(await screen.findByRole('heading', { level: 2, name: 'Nội dung không còn khả dụng' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: vi_['not.detail.link.open.action'] })).not.toBeInTheDocument();
    // Nothing is sent: the notification stays unread and no audit row of reading is written for a record the member could not see.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('does not mark a notification that is already read', async () => {
    const h = harness();
    open(h, NOTIFICATION_IDS.report);
    expect(await screen.findByRole('heading', { level: 2, name: 'Báo cáo giải ngân tuần đã được nộp' })).toBeInTheDocument();
    expect(screen.getByText('Đã đọc')).toBeInTheDocument();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the priority, when it was read and the way back to the inbox', async () => {
    open(harness(), NOTIFICATION_IDS.report);
    await screen.findByRole('heading', { level: 2, name: 'Báo cáo giải ngân tuần đã được nộp' });
    expect(screen.getByText('Mức ưu tiên')).toBeInTheDocument();
    expect(screen.getByText('Thông thường', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Đọc lúc')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Chi tiết thông báo' })).toBeInTheDocument();
    const back = screen.getAllByRole('link', { name: /Hộp thông báo cá nhân|Danh sách thông báo/ });
    expect(back.length).toBeGreaterThan(0);
    for (const link of back) expect(link).toHaveAttribute('href', '/not/not-01');
  });
});

describe('NOT-02 notification detail: finding the notification and failures of the commands', () => {
  it('stops after a failed page instead of asking for the same cursor forever, and offers a retry that asks once more', async () => {
    const h = harness();
    let calls = 0;
    h.read.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ items: inbox().slice(0, 1), next_cursor: 'c1' });
      if (calls === 2) return Promise.reject(problem(NETWORK_ERROR_CODE, 0));
      return Promise.resolve({ items: inbox().slice(1), next_cursor: null });
    });
    const user = userEvent.setup();
    open(h, NOTIFICATION_IDS.report);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(vi_['not.detail.search.error.title']);
    expect(screen.queryByText(vi_['not.detail.notFound.title'])).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(2);
    await user.click(screen.getByRole('button', { name: vi_['not.detail.retry.action'] }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Báo cáo giải ngân tuần đã được nộp' })).toBeInTheDocument();
    expect(calls).toBe(3);
  });

  it('calls the notification missing after the page limit instead of loading for ever', async () => {
    const h = harness();
    let calls = 0;
    h.read.mockImplementation(() => {
      calls += 1;
      return Promise.resolve({ items: [], next_cursor: `c${calls}` });
    });
    open(h, NOTIFICATION_IDS.report);
    expect(await screen.findByText(vi_['not.detail.notFound.title'], undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(calls).toBe(40);
  }, 15_000);

  it('shows that marking as read failed and retries it with the same idempotency attempt, keeping the acknowledgement locked until it works', async () => {
    const h = harness();
    h.command.mockRejectedValueOnce(problem(NETWORK_ERROR_CODE, 0));
    const user = userEvent.setup();
    open(h, NOTIFICATION_IDS.approval);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(vi_['not.inbox.markRead.error']);
    expect(screen.getByRole('button', { name: 'Xác nhận đã xử lý' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: vi_['not.detail.retry.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    const [first, second] = h.command.mock.calls as unknown as [[string, { attempt: unknown }], [string, { attempt: unknown }]];
    expect(second[1].attempt).toBe(first[1].attempt);
    await waitFor(() => expect(screen.queryByText(vi_['not.inbox.markRead.error'])).not.toBeInTheDocument());
  });
});

describe('NOT-02 notification detail: acknowledging', () => {
  it('has no acknowledge control for a notification that does not require one', async () => {
    open(harness(), NOTIFICATION_IDS.report);
    await screen.findByRole('heading', { level: 2, name: 'Báo cáo giải ngân tuần đã được nộp' });
    expect(screen.queryByRole('button', { name: 'Xác nhận đã xử lý' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Ghi chú xác nhận/)).not.toBeInTheDocument();
  });

  it('keeps the acknowledge button disabled until the notification is read, then sends the comment once', async () => {
    const acknowledged = withRead(inbox(), NOTIFICATION_IDS.approval).map((item) => (item.id === NOTIFICATION_IDS.approval ? { ...item, acknowledged_at: '2026-10-22T04:00:00Z' } : item));
    const h = harness([
      { items: inbox(), next_cursor: null },
      { items: withRead(inbox(), NOTIFICATION_IDS.approval), next_cursor: null },
      // After the acknowledgement the server answers the list with the notification acknowledged: the button is gone.
      { items: acknowledged, next_cursor: null },
    ]);
    const user = userEvent.setup();
    open(h, NOTIFICATION_IDS.approval);
    const button = await screen.findByRole('button', { name: 'Xác nhận đã xử lý' });
    // Once the read time arrives the button is enabled; before that the hint says why not.
    await waitFor(() => expect(button).toBeEnabled());
    await user.type(screen.getByLabelText(/Ghi chú xác nhận/), 'Đã kiểm tra chứng từ');
    await user.dblClick(button);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('acknowledgeNotification', expect.objectContaining({ path: { notificationId: NOTIFICATION_IDS.approval }, body: { comment: 'Đã kiểm tra chứng từ' } })));
    expect(h.command.mock.calls.filter((call) => call[0] === 'acknowledgeNotification').length).toBe(1);
  });

  it('shows why the button is disabled while the notification is still unread', async () => {
    const h = harness();
    // The read mark never lands, so the notification stays unread.
    h.command.mockImplementation(() => new Promise(() => undefined));
    open(h, NOTIFICATION_IDS.approval);
    const button = await screen.findByRole('button', { name: 'Xác nhận đã xử lý' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Mở thông báo để đánh dấu đã đọc trước khi xác nhận.')).toBeInTheDocument();
  });

  it('sends an acknowledgement without a comment as an empty body', async () => {
    const readFirst = withRead(inbox(), NOTIFICATION_IDS.approval);
    const h = harness([{ items: readFirst, next_cursor: null }]);
    const user = userEvent.setup();
    open(h, NOTIFICATION_IDS.approval);
    await user.click(await screen.findByRole('button', { name: 'Xác nhận đã xử lý' }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('acknowledgeNotification', expect.objectContaining({ body: {} })));
  });

  it('shows an acknowledged notification as acknowledged, with its time, and no button', async () => {
    const items = withRead(inbox(), NOTIFICATION_IDS.approval).map((item) => (item.id === NOTIFICATION_IDS.approval ? { ...item, acknowledged_at: '2026-10-22T04:00:00Z' } : item));
    open(harness([{ items, next_cursor: null }]), NOTIFICATION_IDS.approval);
    await screen.findByRole('heading', { level: 2, name: 'Hồ sơ thanh toán đang chờ phê duyệt' });
    expect(screen.getByText('Đã xác nhận')).toBeInTheDocument();
    expect(screen.getByText('Xác nhận lúc')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Xác nhận đã xử lý' })).not.toBeInTheDocument();
  });

  it.each([
    ['ACK_NOT_REQUIRED', 409, 'Thông báo này không cần xác nhận.'],
    ['NOTIFICATION_EXPIRED', 409, 'Thông báo đã hết hạn nên không thể xác nhận.'],
    ['INTERNAL_ERROR', 500, 'Không thể hoàn tất thao tác. Hãy thử lại.'],
  ])('answers %s with its own message and keeps the page', async (code, status, message) => {
    const h = harness([{ items: withRead(inbox(), NOTIFICATION_IDS.approval), next_cursor: null }]);
    h.command.mockRejectedValue(problem(code, status));
    const user = userEvent.setup();
    open(h, NOTIFICATION_IDS.approval);
    await user.click(await screen.findByRole('button', { name: 'Xác nhận đã xử lý' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('heading', { level: 2, name: 'Hồ sơ thanh toán đang chờ phê duyệt' })).toBeInTheDocument();
  });
});

describe('NOT-02 notification detail: what it may show', () => {
  it('shows nothing about the record when the content is no longer available, not even for a notification that needs action (AC-ST-NOT-001-4)', async () => {
    const items = inbox().map((item) => (item.id === NOTIFICATION_IDS.gone ? { ...item, ack_required: true, resource_ref: '/pay/pay-03/1' } : item));
    const h = harness([{ items, next_cursor: null }]);
    const { container } = open(h, NOTIFICATION_IDS.gone);
    expect(await screen.findByRole('heading', { level: 2, name: 'Nội dung không còn khả dụng' })).toBeInTheDocument();
    expect(screen.getByText('Bạn không còn quyền xem nội dung này.')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Hồ sơ thanh toán|Báo cáo giải ngân|Ngân sách AI|Thông báo mới/);
    expect(screen.queryByRole('link', { name: 'Mở hồ sơ liên quan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Xác nhận đã xử lý' })).not.toBeInTheDocument();
  });

  it('links to the related record only when the reference is a known screen path of this application', async () => {
    open(harness(), NOTIFICATION_IDS.approval);
    expect(await screen.findByRole('link', { name: 'Mở hồ sơ liên quan' })).toHaveAttribute('href', '/pay/pay-03');
    cleanup();
    open(harness(), NOTIFICATION_IDS.budget);
    await screen.findByRole('heading', { level: 2, name: 'Ngân sách AI cần được rà soát' });
    expect(screen.queryByRole('link', { name: 'Mở hồ sơ liên quan' })).not.toBeInTheDocument();
  });
});

describe('NOT-02 notification detail: finding the notification', () => {
  it('loads further pages until the notification is found', async () => {
    const h = harness([
      { items: [inbox()[0]!], next_cursor: 'c2' },
      { items: [inbox()[1]!], next_cursor: 'c3' },
      { items: [inbox()[2]!], next_cursor: null },
    ]);
    open(h, NOTIFICATION_IDS.budget);
    expect(await screen.findByRole('heading', { level: 2, name: 'Ngân sách AI cần được rà soát' })).toBeInTheDocument();
    expect(h.read).toHaveBeenCalledWith('listMyNotifications', { query: { limit: 25, cursor: 'c3' } });
  });

  it.each([
    ['an id that is not in any page', '00000000-0000-4000-8000-0000000000ff'],
    ['no id at all', undefined],
  ])('says the notification was not found for %s', async (_label, id) => {
    open(harness(), id);
    expect(await within(await screen.findByRole('status')).findByText('Không tìm thấy thông báo')).toBeInTheDocument();
  });
});

describe('NOT-02 notification detail: states (AC-ST-NOT-001-6)', () => {
  it('shows the loading state while the list is on its way', async () => {
    const h = harness();
    h.read.mockImplementation(() => new Promise(() => undefined));
    open(h, NOTIFICATION_IDS.approval);
    expect(await screen.findByRole('status', { name: 'Đang tải' })).toBeInTheDocument();
  });

  it.each([
    ['an error', problem('INTERNAL_ERROR', 500), /Chưa thể tải dữ liệu/],
    ['a refusal', problem('SCOPE_DENIED', 403), /Bạn chưa có quyền truy cập/],
    ['a lapsed session', problem('SESSION_EXPIRED', 401), /Phiên làm việc đã hết hạn/],
    ['a failed network', problem(NETWORK_ERROR_CODE, 0), /Bạn đang ngoại tuyến/],
  ])('shows its own state for %s', async (_label, error, wording) => {
    open(harness(error), NOTIFICATION_IDS.approval);
    expect(await screen.findByText(wording)).toBeInTheDocument();
  });
});
