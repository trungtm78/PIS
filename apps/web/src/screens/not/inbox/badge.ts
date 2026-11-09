import { useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../../session/SessionContext';
import { itemsOf, notificationsKey } from './hooks';
import type { InboxPage } from './hooks';
import { unreadCount } from './model';
import type { NotificationItem } from './model';

/**
 * The number on the notifications link of the sidebar. Once the inbox has been loaded and holds notifications, the list is the
 * truth and the badge follows it (reading one lowers it); before that, and for an empty inbox, the session's own figure stands
 * (the development session reports 3, as the mockup shows). The count covers the pages loaded so far: the API has no count.
 */
export function badgeCount(sessionCount: number | undefined, items: readonly NotificationItem[] | undefined): number | undefined {
  if (items === undefined || items.length === 0) return sessionCount;
  return unreadCount(items);
}

/** The badge of the sidebar: it reads the inbox from the query cache and re-renders when the cache changes. */
export function useUnreadBadge(sessionCount: number | undefined): number | undefined {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const key = useMemo(() => notificationsKey(tenant?.id), [tenant?.id]);
  const [items, setItems] = useState<NotificationItem[] | undefined>(() => itemsOf(queryClient.getQueryData<InfiniteData<InboxPage>>(key)));

  useEffect(() => {
    let live = true;
    const read = (): void => setItems(itemsOf(queryClient.getQueryData<InfiniteData<InboxPage>>(key)));
    read();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      // The cache also tells about a query that a screen builds while it renders (the inbox screen does): a state of this component set at that moment is
      // "Cannot update a component while rendering a different component". The change is read in a microtask, after the render that caused it.
      if (event.query.queryKey[0] === key[0] && event.query.queryKey[1] === key[1])
        queueMicrotask(() => {
          if (live) read();
        });
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [queryClient, key]);

  return badgeCount(sessionCount, items);
}
