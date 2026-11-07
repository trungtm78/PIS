import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { RULE_TYPE, queryOf, toBoard, toDetail, toExport, toFeed, toOverview, toRowPage, toStatistics, toSummary, toTimeline, toTree } from './model';
import type { BoardDto, DetailDto, ExportDto, FeedDto, Filters, NodeOverview, RowPage, StatisticsDto, SummaryDto, TimelineDto, TreeDto } from './model';

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-workflow', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-workflow', tenant?.id, tenant?.membershipId];
}

/** The board refreshes on a timer and when the window is focused again (60 s, as the alert centre does); a refresh never moves focus. */
const REFRESH_MS = 60_000;
const live = { refetchInterval: REFRESH_MS, refetchOnWindowFocus: true, retry: false } as const;

type Query = Record<string, string | boolean | number | undefined>;
const q = (value: Query): never => value as never;

export function useProcessTree(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<TreeDto>({ queryKey: [...key, 'tree', filters], queryFn: async () => toTree(await client.read('getPackageProcessTree', { query: q(queryOf(filters)) })), enabled: key[1] !== undefined, ...live });
}

export function useNodeOverview(nodeId: string | undefined, filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<NodeOverview>({
    queryKey: [...key, 'node', nodeId, filters],
    queryFn: async () => toOverview(await client.read('getPackageProcessTreeNode', { query: q({ node_id: nodeId, ...queryOf(filters) }) })),
    enabled: key[1] !== undefined && nodeId !== undefined,
    retry: false,
  });
}

export function useNodePackages(nodeId: string | undefined, filters: Filters, cursor: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RowPage>({
    queryKey: [...key, 'node-packages', nodeId, filters, cursor],
    queryFn: async () => toRowPage(await client.read('listPackageProcessTreeNodePackages', { query: q({ node_id: nodeId, ...queryOf(filters), ...(cursor === undefined ? {} : { cursor }), limit: '20' }) })),
    enabled: key[1] !== undefined && nodeId !== undefined,
    retry: false,
  });
}

export function useNodeFeed(nodeId: string | undefined, filters: Filters, range: { from?: string | undefined; to?: string | undefined }) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FeedDto>({
    queryKey: [...key, 'feed', nodeId, filters, range],
    queryFn: async () => toFeed(await client.read('getPackageProcessTreeNodeFeed', { query: q({ node_id: nodeId, ...queryOf({ ...filters, from: undefined, to: undefined }), ...(range.from === undefined ? {} : { from: range.from }), ...(range.to === undefined ? {} : { to: range.to }), limit: '30' }) })),
    enabled: key[1] !== undefined && nodeId !== undefined,
    retry: false,
  });
}

export function useBoard(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<BoardDto>({ queryKey: [...key, 'board', filters], queryFn: async () => toBoard(await client.read('getPackageWorkflowBoard', { query: q(queryOf(filters)) })), enabled: key[1] !== undefined, ...live });
}

export interface ListQuery {
  step?: string | undefined;
  on_hold?: boolean | undefined;
  no_owner?: boolean | undefined;
  cursor?: string | undefined;
}

export function usePackageList(filters: Filters, list: ListQuery) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RowPage>({
    queryKey: [...key, 'list', filters, list],
    queryFn: async () => toRowPage(await client.read('listPackageWorkflows', { query: q({ ...queryOf(filters), ...(list.step === undefined ? {} : { step: list.step }), ...(list.on_hold === true ? { on_hold: true } : {}), ...(list.no_owner === true ? { no_owner: true } : {}), ...(list.cursor === undefined ? {} : { cursor: list.cursor }), limit: '20' }) })),
    enabled: key[1] !== undefined,
    ...live,
  });
}

export function useDetail(packageId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<DetailDto>({ queryKey: [...key, 'detail', packageId], queryFn: async () => toDetail(await client.read('getPackageWorkflow', { path: { package_id: packageId } })), enabled: key[1] !== undefined && packageId !== '', retry: false });
}

export interface TimelineFilter {
  from?: string | undefined;
  to?: string | undefined;
  actor_id?: string | undefined;
  only_state_changes?: boolean | undefined;
  order?: 'newest' | 'oldest' | undefined;
}

export function useTimeline(packageId: string, filter: TimelineFilter, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<TimelineDto>({
    queryKey: [...key, 'timeline', packageId, filter],
    queryFn: async () => toTimeline(await client.read('getPackageWorkflowTimeline', { path: { package_id: packageId }, query: q(Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined)) as Query) })),
    enabled: key[1] !== undefined && packageId !== '' && enabled,
    retry: false,
  });
}

export function useStatistics(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<StatisticsDto>({ queryKey: [...key, 'statistics', filters], queryFn: async () => toStatistics(await client.read('getPackageWorkflowStatistics', { query: q(queryOf(filters)) })), enabled: key[1] !== undefined, retry: false });
}

export function useSummary(filters: Filters, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<SummaryDto>({ queryKey: [...key, 'summary', filters], queryFn: async () => toSummary(await client.read('getPackageWorkflowSummary', { query: q(queryOf(filters)) })), enabled: key[1] !== undefined && enabled, ...live });
}

/** The report as a file: the answer carries the bytes in base64, which the screen turns into a download. */
export function useExportReport() {
  const client = useApiClient();
  return useMutation<ExportDto, unknown, { filters: Filters; format: 'xlsx' | 'csv' }>({
    mutationFn: async (input) => toExport(await client.read('exportPackageWorkflowReport', { query: q({ ...queryOf(input.filters), format: input.format }) })),
  });
}

export interface Named {
  id: string;
  name: string;
}

function toNamed(raw: unknown): Named[] {
  const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = typeof row.id === 'string' ? row.id : undefined;
  const name = [row.display_name, row.name, row.code].find((value): value is string => typeof value === 'string' && value !== '');
  return id === undefined || name === undefined ? [] : [{ id, name }];
}

/** The units, projects and members the filters offer. A failed or refused read leaves the filter with "all" only: it is a convenience, not a source of figures. */
export function useFilterOptions(kind: 'units' | 'projects' | 'owners') {
  const client = useApiClient();
  const key = useScopeKey();
  const operation = kind === 'units' ? 'get_resources_organization_unit' : kind === 'projects' ? 'get_resources_project' : 'get_resources_membership';
  return useQuery<Named[]>({
    queryKey: [...key, 'options', kind],
    queryFn: async () => (await client.readAll(operation)).flatMap(toNamed),
    enabled: key[1] !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ---- commands -------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Every read of the bidding screens is refreshed when a package moves. */
function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('bid-') });
}

type Sent = (client: ReturnType<typeof useApiClient>, input: never, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>;

/** One command of the workflow: one idempotency attempt per intention, the reads refreshed after it. */
function useWorkflowCommand<Input>(send: Sent) {
  const client = useApiClient();
  const refresh = useRefresh();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, unknown, Input>({
    mutationFn: (input) => send(client, input as never, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: (error) => attempts.current.ended(error),
  });
}

const run = (operation: string, client: ReturnType<typeof useApiClient>, input: Record<string, unknown>, attempt: unknown): Promise<unknown> => (client.command as unknown as (operation: string, input: unknown) => Promise<unknown>)(operation, { ...input, attempt });

export interface StartInput {
  packageId: string;
  ownerId?: string | undefined;
}
export const useStartWorkflow = () => useWorkflowCommand<StartInput>((client, input, attempt) => run('startPackageWorkflow', client, { path: { package_id: (input as StartInput).packageId }, body: (input as StartInput).ownerId === undefined ? {} : { owner_id: (input as StartInput).ownerId } }, attempt));

export interface CompleteInput {
  itemId: string;
  evidence: Array<{ kind: string; document_id?: string; milestone_id?: string; external_ref?: string; note?: string }>;
  note?: string | undefined;
}
export const useCompleteItem = () => useWorkflowCommand<CompleteInput>((client, input, attempt) => run('completePackageChecklistItem', client, { path: { item_id: (input as CompleteInput).itemId }, body: { evidence: (input as CompleteInput).evidence, ...((input as CompleteInput).note === undefined ? {} : { note: (input as CompleteInput).note }) } }, attempt));

export interface AssignItemInput {
  itemId: string;
  ownerId: string;
}
export const useAssignItem = () => useWorkflowCommand<AssignItemInput>((client, input, attempt) => run('assignPackageChecklistItem', client, { path: { item_id: (input as AssignItemInput).itemId }, body: { owner_id: (input as AssignItemInput).ownerId } }, attempt));

export interface Versioned {
  workflowId: string;
  version: number;
}
export interface AdvanceInput extends Versioned {
  note?: string | undefined;
  exceptionId?: string | undefined;
}
export const useAdvance = () => useWorkflowCommand<AdvanceInput>((client, input, attempt) => run('advancePackageStep', client, { path: { workflow_id: (input as AdvanceInput).workflowId }, ifMatchVersion: (input as AdvanceInput).version, body: { ...((input as AdvanceInput).note === undefined ? {} : { note: (input as AdvanceInput).note }), ...((input as AdvanceInput).exceptionId === undefined ? {} : { exception_id: (input as AdvanceInput).exceptionId }) } }, attempt));

export interface ReturnInput extends Versioned {
  toStep: string;
  reason: string;
}
export const useReturnStep = () => useWorkflowCommand<ReturnInput>((client, input, attempt) => run('returnPackageStep', client, { path: { workflow_id: (input as ReturnInput).workflowId }, ifMatchVersion: (input as ReturnInput).version, body: { to_step: (input as ReturnInput).toStep, reason: (input as ReturnInput).reason } }, attempt));

export interface ReasonInput extends Versioned {
  reason: string;
}
export const useHold = () => useWorkflowCommand<ReasonInput>((client, input, attempt) => run('holdPackageWorkflow', client, { path: { workflow_id: (input as ReasonInput).workflowId }, ifMatchVersion: (input as ReasonInput).version, body: { reason: (input as ReasonInput).reason } }, attempt));
export const useCancel = () => useWorkflowCommand<ReasonInput>((client, input, attempt) => run('cancelPackageWorkflow', client, { path: { workflow_id: (input as ReasonInput).workflowId }, ifMatchVersion: (input as ReasonInput).version, body: { reason: (input as ReasonInput).reason } }, attempt));

export interface ResumeInput extends Versioned {
  note?: string | undefined;
}
export const useResume = () => useWorkflowCommand<ResumeInput>((client, input, attempt) => run('resumePackageWorkflow', client, { path: { workflow_id: (input as ResumeInput).workflowId }, ifMatchVersion: (input as ResumeInput).version, body: (input as ResumeInput).note === undefined ? {} : { note: (input as ResumeInput).note } }, attempt));

export interface OwnerInput extends Versioned {
  ownerId: string;
  reason?: string | undefined;
}
export const useAssignOwner = () => useWorkflowCommand<OwnerInput>((client, input, attempt) => run('assignPackageWorkflowOwner', client, { path: { workflow_id: (input as OwnerInput).workflowId }, ifMatchVersion: (input as OwnerInput).version, body: { owner_id: (input as OwnerInput).ownerId, ...((input as OwnerInput).reason === undefined ? {} : { reason: (input as OwnerInput).reason }) } }, attempt));

export interface RequestExceptionInput {
  workflowId: string;
  kind: 'SKIP_ITEMS' | 'CORRECT_BACK';
  reason: string;
}
export const useRequestException = () => useWorkflowCommand<RequestExceptionInput>((client, input, attempt) => run('requestPackageStepException', client, { path: { workflow_id: (input as RequestExceptionInput).workflowId }, body: { kind: (input as RequestExceptionInput).kind, reason: (input as RequestExceptionInput).reason } }, attempt));

export interface DecideExceptionInput {
  exceptionId: string;
  decision: 'APPROVE' | 'REJECT';
  note?: string | undefined;
}
export const useDecideException = () => useWorkflowCommand<DecideExceptionInput>((client, input, attempt) => run('decidePackageStepException', client, { path: { exception_id: (input as DecideExceptionInput).exceptionId }, body: { decision: (input as DecideExceptionInput).decision, ...((input as DecideExceptionInput).note === undefined ? {} : { note: (input as DecideExceptionInput).note }) } }, attempt));

// ---- the definitions (governance rules of the type PROCUREMENT_WORKFLOW) ---------------------------------------------------------------------------------------------------------

export interface EffectiveRule {
  rule_type: string;
  code: string;
  as_of: string;
  params: Record<string, unknown>;
  version: number;
  source: 'RULE' | 'DEFAULT';
  rule_id: string | null;
  unverified: boolean;
  provenance: { formula: string; source: string; as_of: string; legal_status: 'VERIFIED' | 'UNVERIFIED' } | null;
}

export interface RuleVersion {
  id: string;
  version: number;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'RETIRED';
  phase?: string;
  params: Record<string, unknown>;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  created_by: string;
  submitted_by: string | null;
  approved_by: string | null;
  resource_version: number;
}

export function useEffectiveRule(method: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<EffectiveRule>({
    queryKey: [...key, 'rule', method],
    queryFn: async () => {
      const body = (await client.read('getEffectiveGovernanceRule', { query: { rule_type: RULE_TYPE, code: method } as never })) as unknown as EffectiveRule;
      if (typeof body !== 'object' || body === null || typeof body.params !== 'object') throw new Error('unexpected rule');
      return body;
    },
    enabled: key[1] !== undefined && method !== '',
    retry: false,
  });
}

export function useRuleVersions(method: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RuleVersion[]>({
    queryKey: [...key, 'rule-versions', method],
    queryFn: async () => {
      const body = (await client.read('listGovernanceRuleVersions', { query: { rule_type: RULE_TYPE, code: method } as never })) as unknown as { items?: RuleVersion[] };
      if (!Array.isArray(body.items)) throw new Error('unexpected versions');
      return body.items;
    },
    enabled: key[1] !== undefined && method !== '',
    retry: false,
  });
}

export interface DraftInput {
  code: string;
  params: Record<string, unknown>;
  effectiveFrom: string;
  reason: string;
}
export const useCreateDraft = () => useWorkflowCommand<DraftInput>((client, input, attempt) => run('createGovernanceRuleDraft', client, { body: { rule_type: RULE_TYPE, code: (input as DraftInput).code, params: (input as DraftInput).params, effective_from: (input as DraftInput).effectiveFrom, reason: (input as DraftInput).reason } }, attempt));

export interface RuleMove {
  ruleId: string;
  version: number;
  move: 'submit' | 'approve' | 'withdraw';
  reason: string;
}
export const useMoveRule = () =>
  useWorkflowCommand<RuleMove>((client, input, attempt) => {
    const move = input as RuleMove;
    const operation = move.move === 'submit' ? 'submitGovernanceRule' : move.move === 'approve' ? 'approveGovernanceRule' : 'withdrawGovernanceRule';
    return run(operation, client, { path: { ruleId: move.ruleId }, ifMatchVersion: move.version, body: { reason: move.reason } }, attempt);
  });
