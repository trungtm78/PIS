import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { PAGE_SIZE, toAttempt, toDetail } from './model';
import type { AttemptDetail, AttemptStatus, AttemptView } from './model';

/** The queries of the delivery screens begin with this key: a replay or a cancel refreshes all of them. */
export const deliveryKey = (tenantId: string | undefined) => ['not', 'delivery', tenantId] as const;

export interface AttemptQuery {
  /** Only these statuses (NOT-11 filter). */
  statuses?: readonly AttemptStatus[];
  /** Only the failed queue (NOT-13). */
  deadLetter?: boolean;
}

export interface AttemptPage {
  items: AttemptView[];
  /** The cursor of the next page; undefined on the last page. */
  next: string | undefined;
}

export const attemptsOf = (data: InfiniteData<AttemptPage> | undefined): AttemptView[] | undefined => data?.pages.flatMap((page) => page.items);

/** The send attempts of the tenant, newest first, one keyset page at a time; keyed by tenant and filter so a switch never shows another tenant's queue. */
export function useAttemptPages(query: AttemptQuery, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  const key = [...deliveryKey(tenant?.id), 'pages', query.statuses?.join(',') ?? '', query.deadLetter === true] as const;
  return useInfiniteQuery<AttemptPage, Error, InfiniteData<AttemptPage>, typeof key, string | undefined>({
    queryKey: key,
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      const page = (await client.read('get_resources_delivery_attempt', {
        query: {
          limit: PAGE_SIZE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
          ...(query.statuses === undefined || query.statuses.length === 0 ? {} : { status: query.statuses.join(',') }),
          ...(query.deadLetter === true ? { dlq: 'true' } : {}),
        },
      })) as { items?: unknown[]; next_cursor?: string | null };
      return { items: (page.items ?? []).flatMap((item) => toAttempt(item) ?? []), next: page.next_cursor ?? undefined };
    },
    getNextPageParam: (last) => last.next,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** One attempt with the journey of its notification and its history (NOT-12). */
export function useAttemptDetail(id: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<AttemptDetail>({
    queryKey: [...deliveryKey(tenant?.id), 'detail', id ?? ''],
    queryFn: async () => {
      const detail = toDetail(await client.read('get_resources_delivery_attempt_id', { path: { id: id ?? '' } }));
      if (detail === undefined) throw new Error('the delivery attempt answer is not readable');
      return detail;
    },
    enabled: enabled && tenant !== undefined && id !== undefined,
    retry: false,
  });
}

export interface ReplayInput {
  notificationId: string;
  version: number;
  reason: string;
}

/** Replays a failed notification (versioned on the notification); one idempotency attempt per intention. */
export function useReplayNotification() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ReplayInput) =>
      client.command('post_notifications_id_replay', {
        path: { id: input.notificationId },
        body: { decision: 'approve', reason: input.reason, evidence_ids: [] },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: deliveryKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Cancels what has not gone out of a notification. */
export function useCancelNotification() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ReplayInput) =>
      client.command('cancelNotification', {
        path: { notificationId: input.notificationId },
        body: { reason: input.reason },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: deliveryKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
