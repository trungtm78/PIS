import { normalizeSearch } from '../../../navigation/model';

/** The title key the API sends instead of any content once the member lost access to what the notification is about (NOT-02). */
export const UNAVAILABLE_TITLE_KEY = 'notification.content.unavailable.title';

/** One item of `GET /me/notifications` (openapi.json NotificationPage), as the screens use it. */
export interface NotificationItem {
  id: string;
  /** A message key (`notification.event.<type>.title`) or the unavailable key; never free text. */
  title: string;
  priority: string;
  status: string;
  readAt?: string;
  ackRequired: boolean;
  acknowledgedAt?: string;
  /** An opaque reference to the source screen; only usable through `resolveDeepLink`. */
  resourceRef?: string;
}

/** The raw item of the API view. */
export interface NotificationView {
  id: string;
  title: string;
  priority: string;
  status: string;
  read_at?: string;
  ack_required?: boolean;
  acknowledged_at?: string;
  resource_ref?: string;
}

export type InboxFilter = 'all' | 'unread' | 'action';

export function toNotifications(views: readonly NotificationView[]): NotificationItem[] {
  return views.map((view) => ({
    id: view.id,
    title: view.title,
    priority: view.priority,
    status: view.status,
    ackRequired: view.ack_required === true,
    ...(view.read_at === undefined ? {} : { readAt: view.read_at }),
    ...(view.acknowledged_at === undefined ? {} : { acknowledgedAt: view.acknowledged_at }),
    ...(view.resource_ref === undefined ? {} : { resourceRef: view.resource_ref }),
  }));
}

/** Read is not acknowledged (BR-NOT-05): unread means the recipient has not opened it. */
export const isUnread = (item: NotificationItem): boolean => item.readAt === undefined;

/** It still waits for the recipient's acknowledgement. */
export const needsAction = (item: NotificationItem): boolean => item.ackRequired && item.acknowledgedAt === undefined;

export const isUnavailable = (item: NotificationItem): boolean => item.title === UNAVAILABLE_TITLE_KEY;

export const unreadCount = (items: readonly NotificationItem[]): number => items.filter(isUnread).length;

/**
 * The items a filter and a search text leave. `textOf` gives the text the search runs on (the translated title); the
 * search ignores case and diacritics and an empty search keeps everything.
 */
export function filterNotifications(
  items: readonly NotificationItem[],
  filter: InboxFilter,
  query = '',
  textOf: (item: NotificationItem) => string = () => '',
): NotificationItem[] {
  const needle = normalizeSearch(query);
  return items.filter((item) => {
    if (filter === 'unread' && !isUnread(item)) return false;
    if (filter === 'action' && !needsAction(item)) return false;
    return needle === '' || normalizeSearch(textOf(item)).includes(needle);
  });
}

/**
 * A deep link is an opaque reference: it is followed only when it is a path of this application that starts with the path
 * of a known screen (whole segments), so an external URL, a script URL or an unknown screen is never opened. It resolves to
 * the registered route of that screen (the longest match), because the router knows screens and not record paths; the
 * target screen checks the member's access again.
 */
export function resolveDeepLink(reference: string | undefined, routes: readonly { path: string }[]): string | undefined {
  if (reference === undefined || !reference.startsWith('/') || reference.startsWith('//')) return undefined;
  // The emitters of the jobs write the screen followed by the record in a query (`/ctr/ctr-05?id=…`): the path is matched alone, whole segments only, and the query goes
  // with the route so that the screen can read its record (it is the screen's to check the query and the access of the member).
  const split = reference.indexOf('?');
  const address = split < 0 ? reference : reference.slice(0, split);
  const query = split < 0 ? '' : reference.slice(split + 1);
  const matches = routes.filter(({ path }) => address === path || address.startsWith(`${path}/`));
  if (matches.length === 0) return undefined;
  const route = matches.reduce((best, candidate) => (candidate.path.length > best.path.length ? candidate : best)).path;
  return query === '' ? route : `${route}?${query}`;
}
