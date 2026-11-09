import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import { AppRoutes } from '../../../App';
import vi_ from '../../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionValue } from '../../../session/SessionContext';
import { harness, inbox, NOTIFICATION_IDS } from '../../../test/notifications';
import type { Harness } from '../../../test/notifications';
import { TENANT_A } from '../../../test/render';
import { badgeCount } from './badge';
import type { NotificationItem } from './model';

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

const item = (id: string, readAt?: string): NotificationItem => ({ id, title: 'k', priority: 'NORMAL', status: 'Delivered', ackRequired: false, ...(readAt === undefined ? {} : { readAt }) });

describe('badgeCount', () => {
  it('keeps the session figure until the inbox has been loaded, and for an empty inbox', () => {
    expect(badgeCount(3, undefined)).toBe(3);
    expect(badgeCount(3, [])).toBe(3);
    expect(badgeCount(undefined, undefined)).toBeUndefined();
  });

  it('follows the list once it holds notifications, down to nothing', () => {
    expect(badgeCount(3, [item('a'), item('b', '2026-10-22T02:00:00Z')])).toBe(1);
    expect(badgeCount(3, [item('a', '2026-10-22T02:00:00Z')])).toBe(0);
    expect(badgeCount(undefined, [item('a')])).toBe(1);
  });
});

function app(h: Harness, path: string, unreadNotifications = 3) {
  const session: SessionValue = {
    tenant: TENANT_A,
    tenants: [TENANT_A],
    user: { displayName: 'Nguyễn An', initials: 'AN', unreadNotifications },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queries}>
        <ApiClientProvider client={h.client}>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes screenModules={{ 'NOT-01': () => import('../InboxScreen'), 'NOT-02': () => import('../NotificationDetailScreen') }} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
}

const badge = (container: HTMLElement): string | null => container.querySelector('.nav-count')?.textContent ?? null;

describe('the unread badge of the sidebar follows the inbox', () => {
  it('shows the session figure before the inbox is opened and the list count after reading one notification', async () => {
    const readAfter = inbox().map((n) => (n.id === NOTIFICATION_IDS.approval ? { ...n, read_at: '2026-10-22T03:00:00Z' } : n));
    const h = harness([
      { items: inbox(), next_cursor: null },
      { items: readAfter, next_cursor: null },
    ]);
    const user = userEvent.setup();
    const { container } = app(h, '/not/not-01');
    // The inbox holds three unread notifications; the session said 3 as well, so look for the change after reading one.
    await screen.findByRole('group', { name: 'Lọc hộp thông báo' });
    await waitFor(() => expect(badge(container)).toBe('3'));
    await user.click(screen.getByRole('button', { name: /Hồ sơ thanh toán đang chờ phê duyệt/ }));
    await user.click(screen.getByRole('button', { name: 'Đánh dấu thông báo này đã đọc' }));
    await waitFor(() => expect(badge(container)).toBe('2'));
  });

  it('follows the list when the session figure differs from it', async () => {
    const { container } = app(harness(), '/not/not-01', 9);
    expect(badge(container)).toBe('9');
    await screen.findByRole('group', { name: 'Lọc hộp thông báo' });
    await waitFor(() => expect(badge(container)).toBe('3'));
  });

  it('hides the badge when the member has read everything', async () => {
    const allRead = inbox().map((n) => ({ ...n, read_at: '2026-10-22T03:00:00Z' }));
    const { container } = app(harness([{ items: allRead, next_cursor: null }]), '/not/not-01');
    await screen.findByRole('group', { name: 'Lọc hộp thông báo' });
    await waitFor(() => expect(badge(container)).toBeNull());
  });

  it('keeps the session figure when the inbox is empty', async () => {
    const { container } = app(harness([{ items: [], next_cursor: null }]), '/not/not-01');
    await screen.findByText('Chưa có dữ liệu');
    expect(badge(container)).toBe('3');
  });

  it('never sets the state of the shell while the inbox screen renders (no "Cannot update a component" warning)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const user = userEvent.setup();
      const { container } = app(harness([{ items: inbox(), next_cursor: null }, { items: inbox(), next_cursor: null }]), '/not/not-01');
      await screen.findByRole('group', { name: 'Lọc hộp thông báo' });
      await waitFor(() => expect(badge(container)).toBe('3'));
      // A second look at an inbox that is already in the cache: the screen builds and reads the same query while it renders.
      await user.click(screen.getByRole('button', { name: /Hồ sơ thanh toán đang chờ phê duyệt/ }));
      expect(errors.mock.calls.filter((call) => String(call[0]).includes('Cannot update a component'))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
