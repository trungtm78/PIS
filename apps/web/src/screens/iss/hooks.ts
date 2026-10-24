import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { eventsPageOf, toIssueLine, toAssigneeOption, toIssueView, toProjectOption } from './issue-model';
import type { CreateBody, IssueEventView, IssueLine, AssigneeOption, IssueView, ProjectOption } from './issue-model';
import { ISSUE_CATEGORY_TYPE, toCategory, toPolicy, toUnit } from './model';
import type { CategoryOption, PolicyView, PublishPolicyBody, UnitOption } from './model';

/** Every read and every mutation of the issue screens lives under this key of the tenant, so one command refreshes them all. */
export const issRoot = (tenantId: string | undefined) => ['iss', tenantId] as const;

/** One mutation hook: one idempotency attempt per intention, the cached reads of the tenant refreshed on success. */
function useCommand<Input, Result = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Result>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: issRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Publishes a policy, or the next revision of the policy that has the same code. */
export function usePublishPolicy() {
  const client = useApiClient();
  return useCommand<PublishPolicyBody>((body, attempt) => client.command('upsertIssueSlaPolicy', { body, attempt }));
}

export interface RetirePolicyInput {
  id: string;
  validUntil: string;
}

/** Ends a policy from a date; the row stays, so the issues created under it keep their version. */
export function useRetirePolicy() {
  const client = useApiClient();
  return useCommand<RetirePolicyInput>((input, attempt) => client.command('retireIssueSlaPolicy', { path: { id: input.id }, body: { valid_until: input.validUntil }, attempt }));
}

/** The issue categories that are in force, for the choice of the category a policy is written for (MDM-17). */
export function useCategories() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<CategoryOption[]>({
    queryKey: [...issRoot(tenant?.id), 'categories'],
    queryFn: async () => (await client.readAll('searchMasterRecords', { query: { master_type: ISSUE_CATEGORY_TYPE } })).flatMap((raw) => toCategory(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The units of the tenant that the caller may read, for the choice of the unit a policy is written for. */
export function useUnits() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<UnitOption[]>({
    queryKey: [...issRoot(tenant?.id), 'units'],
    queryFn: async () => (await client.readAll('get_resources_organization_unit')).flatMap((raw) => toUnit(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Every version of every policy of the tenant, newest first; the screen groups them by category, severity and unit. */
export function usePolicies() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PolicyView[]>({
    queryKey: [...issRoot(tenant?.id), 'policies'],
    queryFn: async () => (await client.readAll('listIssueSlaPolicies')).flatMap((raw) => toPolicy(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

// What the issues show depends on the scope of the membership that is signed in, not only on the tenant: switching between two
// memberships of one tenant keeps the query client, so the membership is part of every key of an issue read.
function useIssueKey(): readonly [string, string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['iss', tenant?.id, tenant?.membershipId];
}

/** The most pages of the timeline of one issue the workspace walks; a timeline longer than this is cut and says so. */
const MAX_TIMELINE_PAGES = 20;

/** The issues in the scope of the caller, newest first (ISS-01). */
export function useIssues() {
  const client = useApiClient();
  const key = useIssueKey();
  return useQuery<IssueLine[]>({
    queryKey: [...key, 'issues'],
    queryFn: async () => (await client.readAll('get_resources_issue')).flatMap((raw) => toIssueLine(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One issue with its whole timeline; null when none is named, and the read of an issue outside the scope fails with 404. */
export function useIssue(issueId: string | undefined) {
  const client = useApiClient();
  const key = useIssueKey();
  return useQuery<IssueView | null>({
    queryKey: [...key, 'issue', issueId ?? ''],
    queryFn: async () => {
      const first = await client.read('get_resources_issue_id', { path: { id: issueId ?? '' }, query: { limit: 200 } });
      const view = toIssueView(first);
      if (view === undefined) return null;
      const events: IssueEventView[] = [...view.events];
      let cursor = eventsPageOf(first).nextCursor;
      for (let page = 1; cursor !== undefined && page < MAX_TIMELINE_PAGES; page += 1) {
        const next = eventsPageOf(await client.read('get_resources_issue_id', { path: { id: issueId ?? '' }, query: { limit: 200, cursor } }));
        events.push(...next.events);
        cursor = next.nextCursor;
      }
      return { ...view, events };
    },
    enabled: key[1] !== undefined && issueId !== undefined,
    retry: false,
  });
}

/** The projects the caller may read, for the project an issue is about. */
export function useProjects(enabled = true) {
  const client = useApiClient();
  const key = useIssueKey();
  return useQuery<ProjectOption[]>({
    queryKey: [...key, 'projects'],
    queryFn: async () => (await client.readAll('get_resources_project')).flatMap(toProjectOption),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The people the issue may be given to: the active members who can work it where it lies (CR-ISS-14), so the choice needs no read of the directory. */
export function useAssignees(issueId: string) {
  const client = useApiClient();
  const key = useIssueKey();
  return useQuery<AssigneeOption[]>({
    queryKey: [...key, 'assignees', issueId],
    queryFn: async () => (await client.readAll('listIssueAssignees', { path: { id: issueId } })).flatMap(toAssigneeOption),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Opens an issue; the operation id inside the body is what makes a retry of the same intention the same issue. */
export function useCreateIssue() {
  const client = useApiClient();
  return useCommand<CreateBody, { resource_id?: string }>((body, attempt) => client.command('createIssue', { body, attempt }));
}

export interface AssignInput {
  id: string;
  version: number;
  assigneeId: string;
  note?: string;
}

export function useAssignIssue() {
  const client = useApiClient();
  return useCommand<AssignInput>((input, attempt) =>
    client.command('assignIssue', { path: { id: input.id }, body: { assignee_id: input.assigneeId, ...(input.note === undefined ? {} : { note: input.note }) }, ifMatchVersion: input.version, attempt }),
  );
}

export interface StartInput {
  id: string;
  version: number;
  note?: string;
}

export function useStartIssue() {
  const client = useApiClient();
  return useCommand<StartInput>((input, attempt) =>
    client.command('startIssue', { path: { id: input.id }, body: input.note === undefined ? {} : { note: input.note }, ifMatchVersion: input.version, attempt }),
  );
}

export interface CommentInput {
  id: string;
  note: string;
}

export function useCommentIssue() {
  const client = useApiClient();
  return useCommand<CommentInput>((input, attempt) => client.command('commentIssue', { path: { id: input.id }, body: { note: input.note }, attempt }));
}

export interface TransferInput {
  id: string;
  version: number;
  targetUnitId: string;
  reason: string;
}

export function useTransferIssue() {
  const client = useApiClient();
  return useCommand<TransferInput>((input, attempt) =>
    client.command('transferIssueUnit', { path: { id: input.id }, body: { target_unit_id: input.targetUnitId, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}
