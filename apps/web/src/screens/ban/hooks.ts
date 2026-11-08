import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { ATTENTION_LIMIT, AUDIT_PAGE, DirectiveFlowError, decisionBody, directiveBody, filterQuery, meetingBody } from './model';
import type { Alert, AlertList, AlertStatusFilter, AttentionList, AuditList, DecisionInput, DirectiveInput, Filters, Pack, Roster, Schemas, Tracker, Workspace } from './model';

/** What these screens show depends on the membership as well as the tenant (the right is over the whole tenant): both are part of every key. */
export function useScopeKey(): readonly ['ban', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ban', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | boolean | undefined>): never => value as never;
const path = (id: string): never => ({ id }) as never;

/**
 * Every view of these screens is written to the audit of views by the server, in the transaction of the read. So a read is made when a person opens the screen or asks for another view, never in the background:
 * no refetch on focus or reconnect, no interval, and a cached answer is not shown as a new view.
 */
const READ = { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: 0 } as const;

export function useWorkspace(filters: Filters, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Workspace>({ queryKey: [...key, 'workspace', filters], queryFn: () => client.read('getCommitteeWorkspace', { query: q(filterQuery(filters)) }) as Promise<Workspace>, enabled: enabled && key[1] !== undefined, ...READ });
}

export interface AttentionQuery {
  reason: string;
  includeDeferred: boolean;
}

export function useAttention(filter: AttentionQuery) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AttentionList>({
    queryKey: [...key, 'attention', filter],
    queryFn: () => client.read('listCommitteeAttention', { query: q({ ...(filter.reason === '' ? {} : { reason: filter.reason }), include_deferred: filter.includeDeferred, limit: ATTENTION_LIMIT }) }) as Promise<AttentionList>,
    enabled: key[1] !== undefined,
    ...READ,
  });
}

export function useTracker() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Tracker>({ queryKey: [...key, 'tracker'], queryFn: () => client.read('getCommitteeDirectiveTracker') as Promise<Tracker>, enabled: key[1] !== undefined, ...READ });
}

export function usePack(asOf: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Pack>({ queryKey: [...key, 'pack', asOf], queryFn: () => client.read('getCommitteeMeetingPack', { query: q(asOf === '' ? {} : { as_of: asOf }) }) as Promise<Pack>, enabled: key[1] !== undefined, ...READ });
}

export function useAlerts(status: AlertStatusFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AlertList>({ queryKey: [...key, 'alerts', status], queryFn: () => client.read('listCommitteeAlerts', { query: q({ status }) }) as Promise<AlertList>, enabled: key[1] !== undefined, ...READ });
}

export function useRoster() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Roster>({ queryKey: [...key, 'roster'], queryFn: () => client.read('getCommitteeRoster') as Promise<Roster>, enabled: key[1] !== undefined, ...READ });
}

export interface AuditQuery {
  screen: string;
  from: string;
  to: string;
}

/** The audit of views, newest first, a page after a page: the cursor of the next page is the `next` of the page before, sent as `before`. */
export function useViewAudit(filter: AuditQuery) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<AuditList, Error, { pages: AuditList[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'audit', filter],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      client.read('listCommitteeViewAudit', {
        query: q({ limit: AUDIT_PAGE, ...(filter.screen === '' ? {} : { screen: filter.screen }), ...(filter.from === '' ? {} : { from: filter.from }), ...(filter.to === '' ? {} : { to: filter.to }), ...(pageParam === undefined ? {} : { before: pageParam }) }),
      }) as Promise<AuditList>,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: key[1] !== undefined,
    ...READ,
  });
}

/** One command, one idempotency attempt per intention: the key is kept while the same request is retried and dropped when it ends; every cached read is refreshed on success. */
function useBanCommand<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Output, Error, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useDecide() {
  const client = useApiClient();
  return useBanCommand<DecisionInput>((input, attempt) => client.command('recordAttentionDecision', { body: decisionBody(input), attempt }));
}

export interface DirectedResult {
  meetingId: string;
  directiveId: string;
}

const resourceId = (answer: unknown): string => {
  const id = (answer as { resource_id?: unknown } | null)?.resource_id;
  return typeof id === 'string' ? id : '';
};

/**
 * "Issue a directive from this project row": a meeting is chosen or opened (`createSteeringMeeting`), the directive is given in it (`addDirective`), and then the Committee records that it DIRECTED (`recordAttentionDecision`
 * with the directive id). Each step has its own idempotency attempt that is kept until all three are done, so a retry after a failure answers the steps already done again instead of making a second meeting or directive.
 */
export function useIssueDirective() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const meetings = useRef(new AttemptRegistry());
  const directives = useRef(new AttemptRegistry());
  const decisions = useRef(new AttemptRegistry());
  return useMutation<DirectedResult, Error, DirectiveInput>({
    mutationFn: async (input) => {
      let meetingId = input.meeting.kind === 'existing' ? input.meeting.meetingId : '';
      if (input.meeting.kind === 'new') {
        const body = meetingBody({ project: input.project, today: input.today, title: input.meeting.title });
        try {
          meetingId = resourceId(await client.command('createSteeringMeeting', { body, attempt: meetings.current.forPayload(body) } as never));
        } catch (failure) {
          meetings.current.ended(failure);
          throw new DirectiveFlowError('meeting', failure);
        }
      }
      const added = directiveBody(input);
      let directiveId = '';
      try {
        directiveId = resourceId(await client.command('addDirective', { path: path(meetingId), body: added, attempt: directives.current.forPayload({ meetingId, added }) } as never));
      } catch (failure) {
        directives.current.ended(failure);
        throw new DirectiveFlowError('directive', failure);
      }
      const decided = { project_id: input.project.project_id, decision: 'DIRECTED' as const, directive_id: directiveId };
      try {
        await client.command('recordAttentionDecision', { body: decided, attempt: decisions.current.forPayload(decided) } as never);
      } catch (failure) {
        decisions.current.ended(failure);
        throw new DirectiveFlowError('decision', failure);
      }
      return { meetingId, directiveId };
    },
    onSuccess: async () => {
      meetings.current.done();
      directives.current.done();
      decisions.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useEvaluateAlerts() {
  const client = useApiClient();
  return useBanCommand<null>((_input, attempt) => client.command('evaluateCommitteeAlerts', { attempt } as never));
}

export interface AcknowledgeInput {
  alert: Pick<Alert, 'id' | 'version'>;
  note: string;
}

export function useAcknowledge() {
  const client = useApiClient();
  return useBanCommand<AcknowledgeInput>((input, attempt) => client.command('acknowledgeCommitteeAlert', { path: path(input.alert.id), body: { note: input.note.trim() }, ifMatchVersion: input.alert.version, attempt } as never));
}

export function useRegister() {
  const client = useApiClient();
  return useBanCommand<{ code: string; name: string; legalBasis: string }>((input, attempt) =>
    client.command('registerCommittee', { body: { code: input.code.trim(), name: input.name.trim(), ...(input.legalBasis.trim() === '' ? {} : { legal_basis: input.legalBasis.trim() }) }, attempt } as never),
  );
}

export function useAppoint() {
  const client = useApiClient();
  return useBanCommand<{ body: Schemas['CommitteeAppoint'] }>((input, attempt) => client.command('appointCommitteeMember', { body: input.body, attempt } as never));
}

export interface EndInput {
  memberId: string;
  version: number;
  reason: string;
}

export function useEndMember() {
  const client = useApiClient();
  return useBanCommand<EndInput>((input, attempt) => client.command('endCommitteeMember', { path: path(input.memberId), body: { reason: input.reason.trim() }, ifMatchVersion: input.version, attempt } as never));
}
