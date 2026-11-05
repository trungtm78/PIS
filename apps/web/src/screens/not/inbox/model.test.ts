import { describe, expect, it } from 'vitest';
import {
  UNAVAILABLE_TITLE_KEY,
  filterNotifications,
  isUnavailable,
  isUnread,
  needsAction,
  resolveDeepLink,
  toNotifications,
  unreadCount,
} from './model';
import type { NotificationItem } from './model';

const ROUTES = [{ path: '/pay/pay-03' }, { path: '/prj/prj-01' }];

function item(id: string, extra: Partial<NotificationItem> = {}): NotificationItem {
  return { id, title: 'notification.event.pay.request.submitted.title', priority: 'NORMAL', status: 'Delivered', ackRequired: false, ...extra };
}

describe('toNotifications', () => {
  it('reads the API view with its optional members', () => {
    const [first, second] = toNotifications([
      { id: 'a', title: 'k1', priority: 'HIGH', status: 'Delivered', ack_required: true, read_at: '2026-10-22T09:00:00Z', resource_ref: '/pay/pay-03/1' },
      { id: 'b', title: 'k2', priority: 'LOW', status: 'Delivered', ack_required: false },
    ]);
    expect(first).toEqual({ id: 'a', title: 'k1', priority: 'HIGH', status: 'Delivered', ackRequired: true, readAt: '2026-10-22T09:00:00Z', resourceRef: '/pay/pay-03/1' });
    expect(second).toEqual({ id: 'b', title: 'k2', priority: 'LOW', status: 'Delivered', ackRequired: false });
  });

  it('keeps a notification whose optional members are missing and treats a missing ack flag as not required', () => {
    expect(toNotifications([{ id: 'c', title: 'k', priority: 'NORMAL', status: 'Delivered' }])[0]?.ackRequired).toBe(false);
  });
});

describe('what a notification is', () => {
  it('is unread until it has a read time, and needs action while it requires an acknowledgement it has not got', () => {
    expect(isUnread(item('a'))).toBe(true);
    expect(isUnread(item('a', { readAt: '2026-10-22T09:00:00Z' }))).toBe(false);
    expect(needsAction(item('a', { ackRequired: true }))).toBe(true);
    expect(needsAction(item('a', { ackRequired: true, acknowledgedAt: '2026-10-22T10:00:00Z' }))).toBe(false);
    expect(needsAction(item('a'))).toBe(false);
  });

  it('is unavailable exactly when its title is the unavailable key', () => {
    expect(isUnavailable(item('a', { title: UNAVAILABLE_TITLE_KEY }))).toBe(true);
    expect(isUnavailable(item('a'))).toBe(false);
  });
});

describe('filterNotifications and unreadCount', () => {
  const items = [item('a'), item('b', { readAt: '2026-10-22T09:00:00Z' }), item('c', { ackRequired: true })];

  it('filters all, unread and needs-action, and counts the unread ones', () => {
    expect(filterNotifications(items, 'all').map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(filterNotifications(items, 'unread').map((n) => n.id)).toEqual(['a', 'c']);
    expect(filterNotifications(items, 'action').map((n) => n.id)).toEqual(['c']);
    expect(unreadCount(items)).toBe(2);
  });

  it('matches the search text without caring for case or diacritics', () => {
    const titles = new Map([['a', 'Hồ sơ thanh toán'], ['b', 'Báo cáo tuần'], ['c', 'Ngân sách']]);
    expect(filterNotifications(items, 'all', 'HO SO', (n) => titles.get(n.id) ?? '').map((n) => n.id)).toEqual(['a']);
    expect(filterNotifications(items, 'all', 'đ', (n) => titles.get(n.id) ?? '')).toEqual([]);
    expect(filterNotifications(items, 'all', '  ', () => '').length).toBe(3);
  });
});

describe('resolveDeepLink', () => {
  it('resolves an opaque reference that starts with a known screen path to the registered route of that screen, never to a record path the router does not know', () => {
    expect(resolveDeepLink('/pay/pay-03/00000000-0000-4000-8000-000000000001', ROUTES)).toBe('/pay/pay-03');
    expect(resolveDeepLink('/prj/prj-01', ROUTES)).toBe('/prj/prj-01');
  });

  it('takes the longest registered path when one screen path starts with another', () => {
    expect(resolveDeepLink('/prj/prj-01/sub/9', [{ path: '/prj/prj-01' }, { path: '/prj/prj-01/sub' }])).toBe('/prj/prj-01/sub');
  });

  it('follows a reference whose screen is followed by a query string, as the emitters of the jobs write them, and keeps the query for the screen to read', () => {
    expect(resolveDeepLink('/pay/pay-03?id=00000000-0000-4000-8000-000000000001', ROUTES)).toBe('/pay/pay-03?id=00000000-0000-4000-8000-000000000001');
    expect(resolveDeepLink('/prj/prj-01/sub/9?plan=1&year=2027', ROUTES)).toBe('/prj/prj-01?plan=1&year=2027');
    expect(resolveDeepLink('/pay/pay-03?', ROUTES)).toBe('/pay/pay-03');
  });

  it('does not take a query string for a path: a screen that only shares a prefix, or an address that hides another one after the query, is refused', () => {
    expect(resolveDeepLink('/pay/pay-0399?id=1', ROUTES)).toBeUndefined();
    expect(resolveDeepLink('/xyz/xyz-99?next=/pay/pay-03', ROUTES)).toBeUndefined();
    expect(resolveDeepLink('/pay/pay-03?next=https://example.org', ROUTES)).toBe('/pay/pay-03?next=https://example.org');
  });

  it.each([
    ['nothing', undefined],
    ['an external URL', 'https://example.org/pay/pay-03'],
    ['a protocol-relative URL', '//example.org/pay/pay-03'],
    ['a script URL', 'javascript:alert(1)'],
    ['an unknown screen', '/xyz/xyz-99'],
    ['a path that only shares a prefix', '/pay/pay-0399'],
    ['a relative path', 'pay/pay-03'],
  ])('refuses %s', (_label, ref) => {
    expect(resolveDeepLink(ref, ROUTES)).toBeUndefined();
  });
});
