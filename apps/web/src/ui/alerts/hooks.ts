import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toMember } from '../../screens/dgv/model';
import type { MemberOption } from '../../screens/dgv/model';
import { toCountsAnswer, toListAnswer, toPolicies, toSnoozedAnswer } from './types';
import type { AlertCountsAnswer, AlertItem, AlertListAnswer, AlertView, Pause, SnoozedAnswer, WorkClockPolicies, WorkSource } from './types';

/** The bell asks again once a minute (design.md: bell counts refresh every 60 s, on window focus and on a new notification). */
export const COUNTS_REFRESH_MS = 60_000;
/** The drawer shows the first page of the list; the whole queue is HOME-02. */
export const DRAWER_PAGE_SIZE = 50;
/** Where a notification arrives: the key the inbox of NOT-01 keeps in the query cache. */
const NOTIFICATIONS_ROOT = 'my-notifications';

const alertsRoot = (tenantId: string | undefined, membershipId: string | undefined) => ['alerts', tenantId, membershipId] as const;
export const countsKey = (tenantId: string | undefined, membershipId: string | undefined, view: AlertView) => [...alertsRoot(tenantId, membershipId), 'counts', view] as const;
export const itemsKey = (tenantId: string | undefined, membershipId: string | undefined, view: AlertView) => [...alertsRoot(tenantId, membershipId), 'items', view] as const;

/** The server refused the view to this role (403): the tab of that view is not offered. */
export const isDenied = (failure: unknown): boolean => failure instanceof ApiError && failure.status === 403;

export interface AlertQueryOptions {
  enabled?: boolean;
  /** Milliseconds between refreshes; false stops the polling. Default one minute for the counts, none for the list. */
  refreshMs?: number | false;
}

/** The counts of a view (urgent / action / watch), refreshed every minute and when the window gets focus again. A failure after a good answer keeps the last answer (the caller shows it as old). */
export function useAlertCounts(view: AlertView = 'mine', options: AlertQueryOptions = {}) {
  const client = useApiClient();
  const { tenant } = useSession();
  const query = useQuery<AlertCountsAnswer>({
    queryKey: countsKey(tenant?.id, tenant?.membershipId, view),
    queryFn: async () => {
      const answer = toCountsAnswer(await client.read('getMyWorkCounts', { query: { view } }), view);
      if (answer === undefined) throw new Error('the counts of the alert centre could not be read');
      return answer;
    },
    enabled: tenant !== undefined && (options.enabled ?? true),
    refetchInterval: options.refreshMs ?? COUNTS_REFRESH_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });
  return Object.assign(query, { denied: isDenied(query.error) });
}

/** The items of a view; the full list is read only while `enabled` (the drawer is open, or the band is on the page). */
export function useAlertItems(view: AlertView = 'mine', options: AlertQueryOptions = {}) {
  const client = useApiClient();
  const { tenant } = useSession();
  const query = useQuery<AlertListAnswer>({
    queryKey: itemsKey(tenant?.id, tenant?.membershipId, view),
    queryFn: async () => toListAnswer(await client.read('getMyWork', { query: { view, limit: DRAWER_PAGE_SIZE } }), view),
    enabled: tenant !== undefined && (options.enabled ?? true),
    refetchInterval: options.refreshMs ?? false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });
  return Object.assign(query, { denied: isDenied(query.error) });
}

/** Keeps the counts fresh when a notification arrives: the inbox of the member changed in the cache, so the counts are asked again. */
export function useRefreshOnNotification(): void {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const tenantId = tenant?.id;
  const membershipId = tenant?.membershipId;
  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      if (event.query.queryKey[0] !== NOTIFICATIONS_ROOT) return;
      void queryClient.invalidateQueries({ queryKey: [...alertsRoot(tenantId, membershipId), 'counts'] });
    });
  }, [queryClient, tenantId, membershipId]);
}

/** The people an item can be given to: the active staff of the scope of the signed-in membership (the same lookup as the delegations of ADM). */
export function useAssignees(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<MemberOption[]>({
    queryKey: [...alertsRoot(tenant?.id, tenant?.membershipId), 'assignees'],
    queryFn: async () => (await client.readAll('get_resources_membership')).flatMap((raw) => toMember(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The policies of the snooze and of the clocks last long: they change by a published version, not by the minute. */
export const POLICIES_STALE_MS = 10 * 60_000;

/**
 * The reasons, the longest snooze of each level, the number of snoozes in a row and the longest pause, as the policy of the tenant publishes them. The dialogs read their lists and numbers from here and never carry their own.
 * A failure is a failure of the dialog (it says so and offers to retry), never a silent fallback to numbers of the screen.
 */
export function useWorkClockPolicies(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<WorkClockPolicies>({
    queryKey: ['alerts-policies', tenant?.id],
    queryFn: async () => {
      const answer = toPolicies(await client.read('getWorkClockPolicies'));
      if (answer === undefined) throw new Error('the snooze policy could not be read');
      return answer;
    },
    enabled: tenant !== undefined && enabled,
    staleTime: POLICIES_STALE_MS,
    retry: false,
  });
}

/** The work that is held by a snooze in the scope of the reader (HOME-12). A reader without a scope gets 403: `denied` says so. */
export function useSnoozedWork(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  const query = useQuery<SnoozedAnswer>({
    queryKey: [...alertsRoot(tenant?.id, tenant?.membershipId), 'snoozed'],
    queryFn: async () => toSnoozedAnswer(await client.read('getSnoozedWork')),
    enabled: tenant !== undefined && enabled,
    staleTime: 0,
    retry: false,
  });
  return Object.assign(query, { denied: isDenied(query.error) });
}

export interface WorkTarget {
  source: WorkSource;
  source_id: string;
}

/** What an item is to the commands: its source and the id of its record. */
export const targetOf = (item: Pick<AlertItem, 'source' | 'id'>): WorkTarget => ({ source: item.source as WorkSource, source_id: item.id });

export interface AssignInput {
  item: AlertItem;
  assignee: MemberOption;
  dueOn: string;
}

export interface SnoozeInput {
  item: AlertItem;
  until: string;
  /** One of the reasons of the snooze policy (required by the server). */
  reasonCode: string;
  /** The note; required by the server when the reason is OTHER (at least 5 characters). */
  note?: string;
}

export interface PauseInput {
  item: AlertItem;
  /** Another active member of a unit the person may read: the one who allowed the pause. */
  allowedBy: MemberOption;
  reasonCode: string;
  reason: string;
  until: string;
}

export interface ResumeInput {
  item: AlertItem;
  reason?: string;
}

function patchItems(queryClient: QueryClient, root: readonly unknown[], id: string, patch: (item: AlertItem) => AlertItem): void {
  queryClient.setQueriesData<AlertListAnswer>({ queryKey: [...root, 'items'] }, (answer) => (answer === undefined ? answer : { ...answer, items: answer.items.map((item) => (item.id === id ? patch(item) : item)) }));
}

/**
 * The five commands of an item (claim, assign, snooze, pause the clock, resume it). Each user intention keeps one idempotency attempt across retries; a success writes the new lifecycle into the list at once and asks the counts and the list again, so the server stays the truth.
 */
export function useAlertAction() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant, user } = useSession();
  const root = alertsRoot(tenant?.id, tenant?.membershipId);
  const claimAttempts = useRef(new AttemptRegistry());
  const assignAttempts = useRef(new AttemptRegistry());
  const snoozeAttempts = useRef(new AttemptRegistry());
  const pauseAttempts = useRef(new AttemptRegistry());
  const resumeAttempts = useRef(new AttemptRegistry());
  const me = { id: tenant?.membershipId ?? '', name: user?.displayName ?? '' };

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: root });
  }, [queryClient, root]);

  const claim = useMutation({
    mutationFn: (item: AlertItem) => {
      const body = targetOf(item);
      return client.command('claimWork', { body, attempt: claimAttempts.current.forPayload(body) });
    },
    onSuccess: async (_answer, item) => {
      claimAttempts.current.done();
      patchItems(queryClient, root, item.id, (current) => ({ ...current, lifecycle: 'CLAIMED', claimed_by: { id: me.id, name: me.name, at: new Date().toISOString() } }));
      await refresh();
    },
    onError: (error) => claimAttempts.current.ended(error),
  });
  const assign = useMutation({
    mutationFn: (input: AssignInput) => {
      const body = { ...targetOf(input.item), assignee_id: input.assignee.id, due_on: input.dueOn };
      return client.command('assignWork', { body, attempt: assignAttempts.current.forPayload(body) });
    },
    onSuccess: async (_answer, input) => {
      assignAttempts.current.done();
      patchItems(queryClient, root, input.item.id, (current) => ({ ...current, lifecycle: 'CLAIMED', assignee: { id: input.assignee.id, name: input.assignee.name, due_on: input.dueOn } }));
      await refresh();
    },
    onError: (error) => assignAttempts.current.ended(error),
  });
  const snooze = useMutation({
    mutationFn: (input: SnoozeInput) => {
      const note = input.note?.trim() ?? '';
      const body = { ...targetOf(input.item), snooze_until: input.until, reason_code: input.reasonCode, ...(note === '' ? {} : { reason: note }) };
      return client.command('snoozeWork', { body, attempt: snoozeAttempts.current.forPayload(body) });
    },
    onSuccess: async (_answer, input) => {
      snoozeAttempts.current.done();
      const note = input.note?.trim() ?? '';
      patchItems(queryClient, root, input.item.id, (current) => ({
        ...current,
        snoozed_until: input.until,
        snooze_count: current.snooze_count + 1,
        snooze: { id: '', by: me, until: input.until, at: new Date().toISOString(), reason_code: input.reasonCode, note: note === '' ? null : note, ordinal: current.snooze_count + 1, of: current.snooze?.of ?? null, final: false, policy_version: current.snooze?.policy_version ?? null },
      }));
      await refresh();
    },
    onError: (error) => snoozeAttempts.current.ended(error),
  });
  const pause = useMutation({
    mutationFn: (input: PauseInput) => {
      const body = { ...targetOf(input.item), reason_code: input.reasonCode, reason: input.reason.trim(), allowed_by_id: input.allowedBy.id, paused_until: input.until };
      return client.command('pauseWorkClock', { body, attempt: pauseAttempts.current.forPayload(body) });
    },
    onSuccess: async (_answer, input) => {
      pauseAttempts.current.done();
      const made: Pause = { from: new Date().toISOString(), until: input.until, resumed_at: null, reason_code: input.reasonCode, reason: input.reason.trim(), allowed_by: input.allowedBy, by: me };
      patchItems(queryClient, root, input.item.id, (current) => ({ ...current, pause: made, pauses: [...current.pauses, made], clocks: current.clocks === null ? null : { ...current.clocks, paused: made } }));
      await refresh();
    },
    onError: (error) => pauseAttempts.current.ended(error),
  });
  const resume = useMutation({
    mutationFn: (input: ResumeInput) => {
      const note = input.reason?.trim() ?? '';
      const body = { ...targetOf(input.item), ...(note === '' ? {} : { reason: note }) };
      return client.command('resumeWorkClock', { body, attempt: resumeAttempts.current.forPayload(body) });
    },
    onSuccess: async (_answer, input) => {
      resumeAttempts.current.done();
      patchItems(queryClient, root, input.item.id, (current) => ({ ...current, pause: null, clocks: current.clocks === null ? null : { ...current.clocks, paused: null } }));
      await refresh();
    },
    onError: (error) => resumeAttempts.current.ended(error),
  });

  return { claim, assign, snooze, pause, resume, me };
}
