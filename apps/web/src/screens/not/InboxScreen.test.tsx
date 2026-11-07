import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, inbox, mount, NOTIFICATION_IDS, problem } from '../../test/notifications';
import type { Harness, RawNotification } from '../../test/notifications';
import InboxScreen from './InboxScreen';
import type { WebRoute } from '../../routes/types';

const ROUTE: WebRoute = { id: 'NOT-01', path: '/not/not-01', title: 'Hộp thông báo cá nhân', kind: 'list', area: 'overview', module: 'NOT', group: 'Hộp thư', role: 'workspace', parent: null, req: 'FR-NOT-01' };

// The event types that a module registers bring their own titles; these three stand in for them.
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

function open(h: Harness) {
  return mount(h, { path: '/not/not-01', routes: { '/not/not-01': <InboxScreen route={ROUTE} />, '/not/not-02': <p>detail page</p> } });
}

async function loaded(h: Harness = harness()) {
  const user = userEvent.setup();
  const view = open(h);
  await screen.findByRole('group', { name: 'Lọc hộp thông báo' });
  return { user, h, ...view };
}

const row = (title: RegExp) => screen.getByRole('button', { name: title });

describe('NOT-01 personal inbox: the preview on a narrow screen', () => {
  // At 720 px and below the prototype stylesheet shows the preview only while the desk has .preview-open, and hides the list then.
  it('opens the preview by marking the desk when a notification is selected, and offers the way back to the list', async () => {
    const { user } = await loaded();
    const desk = document.querySelector('.notification-desk') as HTMLElement;
    expect(desk.classList.contains('preview-open')).toBe(false);
    await user.click(row(/Hồ sơ thanh toán đang chờ phê duyệt/));
    expect(desk.classList.contains('preview-open')).toBe(true);
    const back = screen.getByRole('button', { name: 'Danh sách thông báo' });
    expect(back.classList.contains('inbox-mobile-back')).toBe(true);
    await user.click(back);
    expect(desk.classList.contains('preview-open')).toBe(false);
    expect(row(/Hồ sơ thanh toán đang chờ phê duyệt/)).toBeInTheDocument();
  });
});

describe('NOT-01 personal inbox: the list', () => {
  it('shows the page frame and one row per notification with its title, category and read state', async () => {
    await loaded();
    expect(screen.getByRole('heading', { level: 1, name: 'Hộp thông báo cá nhân' })).toBeInTheDocument();
    const approval = row(/Hồ sơ thanh toán đang chờ phê duyệt/);
    expect(within(approval).getByText('Cần xử lý')).toBeInTheDocument();
    expect(within(approval).getByRole('img', { name: 'Chưa đọc' })).toBeInTheDocument();
    expect(within(row(/Báo cáo giải ngân tuần/)).getByRole('img', { name: 'Đã đọc' })).toBeInTheDocument();
    expect(within(row(/Báo cáo giải ngân tuần/)).getByText('Thông thường')).toBeInTheDocument();
    expect(within(row(/Ngân sách AI/)).getByText('Cần xử lý')).toBeInTheDocument();
  });

  it('tells apart the badges: needs action, unread and read have their own accessible names (AC-ST-NOT-001-5)', async () => {
    await loaded();
    const names = screen.getAllByRole('img').map((image) => image.getAttribute('aria-label'));
    expect(names.filter((name) => name === 'Chưa đọc').length).toBe(3);
    expect(names.filter((name) => name === 'Đã đọc').length).toBe(1);
    expect(screen.getAllByText('Cần xử lý', { selector: '.notification-category .ui-pill span' }).length).toBe(2);
  });

  it('tells the category and the priority on a pill with its words: an act due is a warning, a plain notification is neutral, and the preview repeats the priority', async () => {
    const { user } = await loaded();
    const pillOf = (name: RegExp, text: string): HTMLElement => within(row(name)).getByText(text).closest('.ui-pill') as HTMLElement;
    expect(pillOf(/Hồ sơ thanh toán đang chờ phê duyệt/, 'Cần xử lý').className).toContain('ui-tone-warning');
    expect(pillOf(/Báo cáo giải ngân tuần/, 'Thông thường').className).toContain('ui-tone-neutral');
    await user.click(row(/Báo cáo giải ngân tuần/));
    const preview = screen.getByRole('complementary');
    expect(within(preview).getAllByText('Thông thường').length).toBe(2);
    expect(within(preview).getByRole('link', { name: /Mở chi tiết thông báo/ })).toBeInTheDocument();
  });

  it('shows the unavailable title and nothing of the record for a notification whose content is gone (AC-ST-NOT-001-4)', async () => {
    await loaded();
    const gone = row(/Nội dung không còn khả dụng/);
    expect(gone).toBeInTheDocument();
    expect(within(gone).queryByText(/Hồ sơ|Báo cáo|Ngân sách/)).not.toBeInTheDocument();
  });

  it('shows a neutral title for an event type whose title the catalogue does not have, never the raw key', async () => {
    const page = inbox();
    page[1] = { ...page[1]!, title: 'notification.event.xyz.unknown.title' };
    await loaded(harness([{ items: page, next_cursor: null }]));
    expect(screen.getAllByText('Thông báo mới').length).toBe(1);
    expect(screen.queryByText(/notification\.event\.xyz/)).not.toBeInTheDocument();
  });

  it('counts the tabs and filters unread and needs-action', async () => {
    const { user } = await loaded();
    expect(screen.getByRole('button', { name: 'Tất cả 4' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chưa đọc 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cần xử lý 2' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Chưa đọc 3' }));
    expect(screen.queryByRole('button', { name: /Báo cáo giải ngân tuần/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chưa đọc 3' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Cần xử lý 2' }));
    expect(screen.getAllByRole('button', { name: /Hồ sơ thanh toán|Ngân sách AI/ }).length).toBe(2);
    expect(screen.queryByRole('button', { name: /Nội dung không còn khả dụng/ })).not.toBeInTheDocument();
  });

  it('searches the title without caring for case or diacritics and says so when nothing matches', async () => {
    const { user } = await loaded();
    await user.type(screen.getByRole('searchbox', { name: 'Tìm thông báo' }), 'ngan SACH');
    expect(screen.getByRole('button', { name: /Ngân sách AI/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Báo cáo giải ngân/ })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Tìm thông báo' }));
    await user.type(screen.getByRole('searchbox', { name: 'Tìm thông báo' }), 'khong co gi');
    expect(screen.getByText('Không có thông báo phù hợp')).toBeInTheDocument();
  });

  it('moves between the rows with the arrow keys, Home and End', async () => {
    const { user } = await loaded();
    const rows = screen.getAllByRole('button', { name: /Hồ sơ thanh toán|Báo cáo giải ngân|Ngân sách AI|Nội dung không còn/ });
    rows[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(rows[3]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(rows[2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(rows[0]).toHaveFocus();
  });
});

describe('NOT-01 personal inbox: paging', () => {
  it('loads the next page with the cursor when asked and appends it', async () => {
    const first = inbox().slice(0, 2);
    const second: RawNotification[] = [{ id: '00000000-0000-4000-8000-0000000000b1', title: 'notification.event.llm.budget.warning.title', priority: 'LOW', status: 'Delivered' }];
    const h = harness([
      { items: first, next_cursor: 'cursor-2' },
      { items: second, next_cursor: null },
    ]);
    const { user } = await loaded(h);
    expect(screen.getByText('Đang hiển thị 2 thông báo')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tải thêm thông báo' }));
    await waitFor(() => expect(screen.getByText('Đang hiển thị 3 thông báo')).toBeInTheDocument());
    expect(h.read).toHaveBeenLastCalledWith('listMyNotifications', { query: { limit: 25, cursor: 'cursor-2' } });
    expect(screen.queryByRole('button', { name: 'Tải thêm thông báo' })).not.toBeInTheDocument();
  });

  it('asks for the first page without a cursor', async () => {
    const { h } = await loaded();
    expect(h.read).toHaveBeenCalledWith('listMyNotifications', { query: { limit: 25 } });
  });
});

describe('NOT-01 personal inbox: the preview', () => {
  it('shows the selected notification with a link to its details and does not mark it read by selecting it', async () => {
    const { user, h } = await loaded();
    await user.click(row(/Hồ sơ thanh toán đang chờ phê duyệt/));
    const preview = screen.getByRole('complementary', { name: 'Nội dung thông báo' });
    expect(within(preview).getByRole('heading', { level: 2, name: 'Hồ sơ thanh toán đang chờ phê duyệt' })).toBeInTheDocument();
    expect(within(preview).getByText('Ưu tiên cao')).toBeInTheDocument();
    expect(within(preview).getByRole('link', { name: /Mở chi tiết thông báo/ })).toHaveAttribute('href', `/not/not-02?id=${NOTIFICATION_IDS.approval}`);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('marks the selected unread notification read once, however often the button is pressed, and refreshes the list', async () => {
    const readAfter = inbox();
    readAfter[0] = { ...readAfter[0]!, read_at: '2026-10-22T03:00:00Z' };
    const h = harness([
      { items: inbox(), next_cursor: null },
      { items: readAfter, next_cursor: null },
    ]);
    const { user } = await loaded(h);
    await user.click(row(/Hồ sơ thanh toán đang chờ phê duyệt/));
    const button = screen.getByRole('button', { name: 'Đánh dấu thông báo này đã đọc' });
    await user.dblClick(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Chưa đọc 2' })).toBeInTheDocument());
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command).toHaveBeenCalledWith('markNotificationRead', expect.objectContaining({ path: { notificationId: NOTIFICATION_IDS.approval }, body: { opened_via: 'IN_APP' } }));
    expect(screen.queryByRole('button', { name: 'Đánh dấu thông báo này đã đọc' })).not.toBeInTheDocument();
  });

  it('offers no mark-read button for a notification that is already read', async () => {
    const { user } = await loaded();
    await user.click(row(/Báo cáo giải ngân tuần/));
    expect(screen.queryByRole('button', { name: 'Đánh dấu thông báo này đã đọc' })).not.toBeInTheDocument();
  });

  it('shows the unavailable content without a link for a notification the member lost access to', async () => {
    const { user } = await loaded();
    await user.click(row(/Nội dung không còn khả dụng/));
    const preview = screen.getByRole('complementary', { name: 'Nội dung thông báo' });
    expect(within(preview).getByRole('heading', { level: 2, name: 'Nội dung không còn khả dụng' })).toBeInTheDocument();
  });

  it('says that nothing is selected until the member selects a row', async () => {
    await loaded();
    expect(screen.getByText('Chưa có thông báo được chọn')).toBeInTheDocument();
  });

  it('keeps a failure to mark read visible and lets the member try again with the same key', async () => {
    const h = harness();
    h.command.mockRejectedValueOnce(problem('INTERNAL_ERROR', 500)).mockResolvedValueOnce({ operation_id: 'op-2', status: 'READ', resource_version: 3 });
    const { user } = await loaded(h);
    await user.click(row(/Hồ sơ thanh toán đang chờ phê duyệt/));
    await user.click(screen.getByRole('button', { name: 'Đánh dấu thông báo này đã đọc' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể đánh dấu đã đọc. Hãy thử lại.');
    await user.click(screen.getByRole('button', { name: 'Đánh dấu thông báo này đã đọc' }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    const [first, second] = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
    expect(second).toBe(first);
  });
});

describe('NOT-01 personal inbox: the seven states (AC-ST-NOT-001-5)', () => {
  it('shows the loading state while the first page is on its way', async () => {
    const h = harness();
    h.read.mockImplementation(() => new Promise(() => undefined));
    open(h);
    expect(await screen.findByRole('status', { name: 'Đang tải' })).toHaveAttribute('aria-busy', 'true');
  });

  it('shows the empty state for an inbox without notifications', async () => {
    open(harness([{ items: [], next_cursor: null }]));
    expect(await screen.findByText('Chưa có dữ liệu')).toBeInTheDocument();
  });

  it.each([
    ['an error', problem('INTERNAL_ERROR', 500), /Chưa thể tải dữ liệu/],
    ['a refusal', problem('SCOPE_DENIED', 403), /Bạn chưa có quyền truy cập/],
    ['a lapsed session', problem('SESSION_EXPIRED', 401), /Phiên làm việc đã hết hạn/],
    ['a failed network', problem(NETWORK_ERROR_CODE, 0), /Bạn đang ngoại tuyến/],
  ])('shows its own state for %s', async (_label, error, wording) => {
    open(harness(error));
    expect(await screen.findByText(wording)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Lọc hộp thông báo' })).not.toBeInTheDocument();
  });

  it('keeps the rows when only the next page cannot be loaded and says so', async () => {
    const h = harness([{ items: inbox().slice(0, 2), next_cursor: 'c2' }]);
    const { user } = await loaded(h);
    h.read.mockRejectedValueOnce(problem('INTERNAL_ERROR', 500));
    await user.click(screen.getByRole('button', { name: 'Tải thêm thông báo' }));
    expect(await screen.findByText('Không tải được các thông báo tiếp theo.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hồ sơ thanh toán/ })).toBeInTheDocument();
    await act(async () => undefined);
  });
});
