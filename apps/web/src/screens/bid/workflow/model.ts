import { ApiError } from '@machvon/api-client';
import type { ProcessTreeEdge, ProcessTreeHealth, ProcessTreeNode } from '../../../ui';

/** The permissions of PRC-1 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the project, and tells the screen which commands the caller may press (`actions`). */
export const READ_PERMISSION = 'bid.read';
export const GOVERNANCE_READ = 'adm.governance.read';
export const GOVERNANCE_MANAGE = 'adm.governance.manage';
export const GOVERNANCE_APPROVE = 'adm.governance.approve';
export const RULE_TYPE = 'PROCUREMENT_WORKFLOW';

export const METHODS = ['OPEN_BIDDING', 'LIMITED_BIDDING', 'DIRECT_APPOINTMENT', 'COMPETITIVE_QUOTATION', 'DIRECT_PURCHASE', 'SELF_EXECUTION', 'COMMUNITY_PARTICIPATION', 'SPECIAL_CASE'] as const;
export type Method = (typeof METHODS)[number];

/**
 * The share of the packages of a node that are late from which the card says "late" instead of "needs attention" (design spec, section 4: health comes from the share of late packages). The API does not publish this
 * threshold yet, so it is a starting value of the screen, shown in the help text; it is not a legal number.
 */
export const LATE_SHARE_FOR_LATE = 0.3;

// ---- the shapes the API returns (snake_case, as the other screens keep them) ------------------------------------------------------------------------------------------------

export type WorkflowStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type Substate = 'ON_HOLD' | 'LATE' | 'RETURNED' | 'ON_TRACK';

export interface Person {
  id: string;
  name: string | null;
}

export interface RowActions {
  start?: boolean;
  advance?: boolean;
  hold?: boolean;
  resume?: boolean;
  assign_owner?: boolean;
  return?: boolean;
  cancel?: boolean;
}

export interface WfRow {
  package_id: string;
  package_code: string;
  title: string | null;
  value_vnd: string;
  method: string;
  project: { id: string; code: string; name?: string };
  unit?: { id: string; name?: string };
  workflow_id: string | null;
  status: WorkflowStatus;
  step: { code: string; name: string | null; order: number; of: number } | null;
  visit: number | null;
  entered_on: string | null;
  days_in_step: { calendar_days: number; working_days: number | null } | null;
  due_on: string | null;
  countdown: { days_left: number; due_on: string } | null;
  late: boolean;
  late_days: number;
  hold_reason: string | null;
  owner: Person | null;
  last_activity_on: string | null;
  stalled: boolean | null;
  progress_percent: number | null;
  open_required_items: number;
  substate: Substate | null;
  sparkline: Array<{ step_code: string; days: number }>;
  version: number | null;
  actions: RowActions;
}

export interface RowPage {
  items: WfRow[];
  next_cursor: string | null;
  truncated: boolean;
  as_of: string;
}

export interface TreeNodeDto {
  id: string;
  parent_id: string | null;
  kind: 'ROOT' | 'METHOD' | 'STEP' | 'SUBSTATE' | 'TERMINAL';
  method: string | null;
  step_code: string | null;
  substate: Substate | null;
  terminal: 'NOT_STARTED' | 'COMPLETED' | 'CANCELLED' | null;
  label: string | null;
  order: number | null;
  count: number;
  value_vnd: string;
  share_count_bp: number;
  share_value_bp: number;
  median_days: number | null;
  median_basis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  late_count: number;
  path: string[];
  route: string[];
}

export interface TreeEdgeDto {
  from: string;
  to: string;
  kind: 'ADVANCE' | 'RETURN' | 'CANCEL' | 'COMPLETE' | 'HOLD';
  count: number;
}

export interface TreeDto {
  period: { from: string; to: string };
  total: { count: number; value_vnd: string };
  nodes: TreeNodeDto[];
  edges: TreeEdgeDto[];
  kpis: { running: number; late: number; stalled: number; on_hold: number; no_owner: number; median_days: number | null };
  truncated: boolean;
  as_of: string;
}

export interface NodeOverview {
  node_id: string;
  count: number;
  median_days: number | null;
  longest_days: number | null;
  shortest_days: number | null;
  basis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  late_count: number;
  stalled_count: number;
  held_count: number;
  no_owner_count: number;
  top_owners: Array<{ id: string | null; name: string | null; count: number }>;
  unfinished_items: Array<{ step_code: string; item_code: string; name: string; count: number }>;
  weeks: Array<{ week_of: string; arrivals: number; departures: number }>;
  truncated: boolean;
  as_of: string;
}

export interface EntryDto {
  id: string;
  kind: 'START' | 'STATE_CHANGE' | 'RETURN' | 'CORRECTION' | 'CHECKLIST_DONE' | 'HOLD' | 'RESUME' | 'EXCEPTION' | 'ASSIGNMENT' | 'MILESTONE' | 'IMPORT' | 'CLOCK_OVERDUE' | 'CANCEL' | 'COMPLETE';
  at: string;
  day: string;
  from_step: string | null;
  to_step: string | null;
  actor: Person | null;
  spent_calendar_days: number | null;
  spent_working_days: number | null;
  reason: string | null;
  evidence: Array<{ kind: string; document_id: string | null; milestone_kind: string | null; reference: string | null }>;
  subject: string | null;
  state_change: boolean;
}

export interface FeedDto {
  items: Array<{ package_id: string; package_code: string; entry: EntryDto }>;
  truncated: boolean;
  as_of: string;
}

export interface StepSummaryDto {
  step_code: string;
  order: number;
  days: number;
  basis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  standard_working_days: number;
  days_over: number;
  current?: boolean;
}

export interface GanttDto {
  step_code: string;
  order: number;
  planned: { start_on: string; end_on: string } | null;
  actual: { start_on: string; end_on: string; open: boolean } | null;
}

export interface TimelineDto {
  days: Array<{ day: string; entries: EntryDto[]; state_changes: number; checklist_done: number }>;
  summary: StepSummaryDto[];
  gantt: GanttDto[];
  empty: boolean;
  as_of: string;
}

export interface ChecklistItemDto {
  id: string;
  code: string;
  name: string;
  required: boolean;
  status: 'OPEN' | 'DONE' | 'WAIVED';
  due_on: string | null;
  completed_at: string | null;
  completed_by: Person | null;
  completed_via: string | null;
  owner: Person | null;
  evidence_required: boolean;
  allowed_kinds: string[];
  milestone_kind: string | null;
  evidence: Array<{ kind: string; document_id: string | null; milestone_kind: string | null; reference: string | null }>;
  version: number;
}

export interface ExceptionDto {
  id: string;
  kind: 'SKIP_ITEMS' | 'CORRECT_BACK';
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'USED';
  reason: string;
  requested_by: Person;
  requested_at: string;
  decided_by: Person | null;
  decided_at: string | null;
  decision_note: string | null;
  step_code: string;
}

export interface StepDefDto {
  code: string;
  name: string;
  order: number;
  standard_working_days: number;
  responsible_role: string;
  entry_condition: string;
  exit_condition: string;
  maker_checker: boolean;
  evidence_kinds: string[];
  milestone_kind: string | null;
}

export interface BlockerDto {
  reason: 'ON_HOLD' | 'REQUIRED_ITEMS_OPEN' | 'EVIDENCE_MISSING' | 'EXCEPTION_PENDING' | 'STEP_OVERDUE' | 'NO_OWNER' | 'CALENDAR_UNAVAILABLE';
  count: number | null;
  detail: string | null;
}

export interface WorkflowDto {
  id: string;
  status: Exclude<WorkflowStatus, 'NOT_STARTED'>;
  step: { code: string; name: string | null; visit: number; standard_working_days: number | null } | null;
  owner: Person | null;
  hold_reason: string | null;
  held_at: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  last_activity_on: string;
  definition: { rule_version: number; hash: string; unverified: boolean };
  entered_on: string | null;
  due_on: string | null;
  countdown: { days_left: number; due_on: string } | null;
  days_in_step: { calendar_days: number; working_days: number | null } | null;
  late: boolean;
  progress: { steps_total: number; steps_done: number; current_order: number | null; items_required: number; items_required_done: number; percent: number };
  blockers: BlockerDto[];
  steps: StepDefDto[];
  checklist: ChecklistItemDto[];
  exceptions: ExceptionDto[];
  history: Array<{ visit: number; step_code: string; entered_at: string; entered_by: Person | null; entry_kind: string; exited_at: string | null; exited_by: Person | null; exit_kind: string | null; due_on: string | null; note: string | null }>;
  links: {
    milestones: Array<{ id: string; kind: string; actual_at: string | null; planned_at: string | null; source: string }>;
    petitions: { total: number; open: number };
    result: { id: string; status: string } | null;
    contract: { id: string; code: string; status: string } | null;
  };
  timeline: TimelineDto;
  version: number;
}

export interface DetailActions {
  start?: boolean;
  advance?: boolean;
  hold?: boolean;
  resume?: boolean;
  assign_owner?: boolean;
  work?: boolean;
  return?: boolean;
  request_exception?: boolean;
  decide_exception?: boolean;
  cancel?: boolean;
}

export interface DetailDto {
  package: { id: string; code: string; title: string | null; value_vnd: string; method: string; status: string };
  project: { id: string; code: string; name: string };
  unit_name: string;
  workflow: WorkflowDto | null;
  startable?: boolean;
  definition_steps?: Array<{ code: string; name: string; order: number; standard_working_days: number }>;
  actions: DetailActions;
  as_of: string;
}

export interface BoardDto {
  method: string;
  method_name: string;
  methods: Array<{ method: string; count: number }>;
  columns: Array<{ code: string; name: string | null; order: number; kind: 'NOT_STARTED' | 'STEP' | 'OTHER' | 'COMPLETED' | 'CANCELLED'; standard_working_days: number | null; count: number; value_vnd: string; late_count: number; held_count: number; cards: WfRow[] }>;
  truncated: boolean;
  as_of: string;
}

export interface StatisticsDto {
  period: { from: string; to: string };
  steps: Array<{ method: string; step_code: string; step_name: string | null; completed_visits: number; median_days: number | null; basis: 'WORKING_DAYS' | 'CALENDAR_DAYS'; on_time_share: number | null; open_visits: number; over_standard: number }>;
  stuck: Array<{ package_id: string; package_code: string; title: string | null; method: string; step_code: string; step_name: string | null; days: number; basis: 'WORKING_DAYS' | 'CALENDAR_DAYS'; value_vnd: string; owner_name: string | null; late: boolean }>;
  kpis: { on_time_share: number | null; completed_visits: number; median_days: number | null; basis: 'WORKING_DAYS' | 'CALENDAR_DAYS' };
  truncated: boolean;
  as_of: string;
}

export interface SummaryDto {
  total: number;
  running: number;
  not_started: number;
  completed: number;
  late: number;
  stalled: number;
  on_hold: number;
  no_owner: number;
  top_steps: Array<{ node_id: string; method: string; code: string; name: string | null; count: number; late_count: number }>;
  truncated: boolean;
  as_of: string;
}

export interface ExportDto {
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  content_base64: string;
  as_of: string;
}

// ---- reading the answers: the top-level shape is checked, a wrong shape is an error of the read (never an empty board) ------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function expect<T>(raw: unknown, name: string, arrays: readonly string[]): T {
  const body = asRecord(raw);
  if (body === undefined || arrays.some((key) => !Array.isArray(body[key]))) throw new Error(`unexpected ${name}`);
  return body as T;
}

export const toRowPage = (raw: unknown): RowPage => expect<RowPage>(raw, 'rows', ['items']);
export const toTree = (raw: unknown): TreeDto => expect<TreeDto>(raw, 'tree', ['nodes', 'edges']);
export const toOverview = (raw: unknown): NodeOverview => expect<NodeOverview>(raw, 'node', ['top_owners', 'unfinished_items', 'weeks']);
export const toFeed = (raw: unknown): FeedDto => expect<FeedDto>(raw, 'feed', ['items']);
export const toTimeline = (raw: unknown): TimelineDto => expect<TimelineDto>(raw, 'timeline', ['days', 'summary', 'gantt']);
export const toBoard = (raw: unknown): BoardDto => expect<BoardDto>(raw, 'board', ['methods', 'columns']);
export const toStatistics = (raw: unknown): StatisticsDto => expect<StatisticsDto>(raw, 'statistics', ['steps', 'stuck']);
export const toSummary = (raw: unknown): SummaryDto => expect<SummaryDto>(raw, 'summary', ['top_steps']);
export const toExport = (raw: unknown): ExportDto => expect<ExportDto>(raw, 'export', []);

export function toDetail(raw: unknown): DetailDto {
  const detail = expect<DetailDto>(raw, 'detail', []);
  const workflow = asRecord(detail.workflow);
  if (workflow !== undefined && (!Array.isArray(workflow.steps) || !Array.isArray(workflow.checklist) || asRecord(workflow.timeline) === undefined)) throw new Error('unexpected detail');
  return detail;
}

// ---- money, days, filters ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Whole VND as billions with two decimals ("128,40"): the digits are counted with BigInt, so no figure is rounded by a float. */
export function billions(valueVnd: string, locale: string): string {
  if (!/^\d{1,24}$/.test(valueVnd)) return '';
  // A billion is 10^9 VND, so a hundredth of a billion is 10^7.
  const hundredths = (BigInt(valueVnd) + 5_000_000n) / 10_000_000n;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  const groups = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'en' ? ',' : '.');
  return `${groups}${locale === 'en' ? '.' : ','}${fraction}`;
}

/** One day as the people of the screen read it: day and month, and the year too when it is another year than today's. */
export const shortDay = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
export const fullDay = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** The Vietnam day of an instant. */
export const vietnamDay = (instant: string): string => new Date(Date.parse(instant) + 7 * 3_600_000).toISOString().slice(0, 10);
export const vietnamTime = (instant: string): string => new Date(Date.parse(instant) + 7 * 3_600_000).toISOString().slice(11, 16);

export interface Filters {
  unit_id?: string;
  project_id?: string;
  method?: string;
  owner_id?: string;
  late_only?: boolean;
  q?: string;
  from?: string;
  to?: string;
}

const FILTER_KEYS = ['unit_id', 'project_id', 'method', 'owner_id', 'q', 'from', 'to'] as const;

export function filtersOf(search: URLSearchParams): Filters {
  const filters: Filters = {};
  for (const key of FILTER_KEYS) {
    const value = search.get(key);
    if (value !== null && value !== '') filters[key] = value;
  }
  if (search.get('late_only') === 'true') filters.late_only = true;
  return filters;
}

/** The filters without the period (the board, the list and the node reads take no period). */
export function withoutPeriod(filters: Filters): Filters {
  const rest: Filters = { ...filters };
  delete rest.from;
  delete rest.to;
  return rest;
}

export const appliedCount = (filters: Filters): number => Object.keys(filters).filter((key) => key !== 'from' && key !== 'to').length;

export const queryOf = (filters: Filters): Record<string, string | boolean> => Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)) as Record<string, string | boolean>;

// ---- the tree as the kit draws it -----------------------------------------------------------------------------------------------------------------------------------------

export interface TreeWords {
  root: string;
  unit: string;
  notStarted: string;
  completed: string;
  cancelled: string;
  onHold: string;
  late: string;
  returned: string;
  onTrack: string;
  hold: string;
}

/** The health of a card: from what is late and held in it, never from colour. */
export function healthOf(node: TreeNodeDto, held: number): ProcessTreeHealth {
  if (node.count === 0) return 'none';
  if (node.kind === 'TERMINAL') return node.terminal === 'COMPLETED' ? 'ok' : 'none';
  if (node.substate === 'ON_HOLD') return 'hold';
  if (node.substate === 'LATE') return 'late';
  if (node.substate === 'RETURNED') return 'attention';
  if (node.substate === 'ON_TRACK') return 'ok';
  if (held === node.count) return 'hold';
  if (node.late_count === 0) return 'ok';
  return node.late_count / node.count >= LATE_SHARE_FOR_LATE ? 'late' : 'attention';
}

/**
 * The nodes and edges of the API as the generic ProcessTree wants them: a lane for each selection method, the steps in their columns, the packages that are held or came back under their step, the packages not started in
 * the first column and the ends of the process in the last. The sub-states that are the normal course (on track, late) stay in the outline and the table; late is already a badge on the card.
 */
export function treeToView(tree: TreeDto, words: TreeWords, locale: string): { nodes: ProcessTreeNode[]; edges: ProcessTreeEdge[] } {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const lastColumn = Math.max(0, ...tree.nodes.filter((node) => node.kind === 'STEP').map((node) => node.order ?? 0)) + 1;
  const laneOf = (node: TreeNodeDto): string | undefined => {
    if (node.method === null) return undefined;
    const method = byId.get(`M:${node.method}`);
    return method?.label ?? node.method;
  };
  const heldOf = (node: TreeNodeDto): number => tree.nodes.filter((child) => child.parent_id === node.id && child.substate === 'ON_HOLD').reduce((sum, child) => sum + child.count, 0);
  const nodes = tree.nodes.map((node): ProcessTreeNode => {
    const held = node.kind === 'STEP' ? heldOf(node) : 0;
    const label =
      node.kind === 'ROOT'
        ? words.root
        : node.kind === 'METHOD' || node.kind === 'STEP'
          ? (node.label ?? node.method ?? node.step_code ?? node.id)
          : node.kind === 'TERMINAL'
            ? node.terminal === 'NOT_STARTED'
              ? words.notStarted
              : node.terminal === 'COMPLETED'
                ? words.completed
                : words.cancelled
            : node.substate === 'ON_HOLD'
              ? words.onHold
              : node.substate === 'LATE'
                ? words.late
                : node.substate === 'RETURNED'
                  ? words.returned
                  : words.onTrack;
    const base: ProcessTreeNode = {
      id: node.id,
      label,
      count: node.count,
      value: billions(node.value_vnd, locale),
      unit: words.unit,
      share: node.share_count_bp / 10_000,
      health: healthOf(node, held),
      medianDays: node.median_days,
      lateCount: node.late_count,
      heldCount: held,
      parentId: node.parent_id,
      inFlow: false,
    };
    const lane = laneOf(node);
    if (node.kind === 'STEP') return { ...base, lane, column: node.order ?? 1, row: 'main', inFlow: true };
    if (node.kind === 'SUBSTATE') {
      const show = (node.substate === 'ON_HOLD' || node.substate === 'RETURNED') && node.count > 0;
      return { ...base, lane, column: node.order ?? 1, row: 'below', inFlow: show };
    }
    if (node.kind === 'TERMINAL') {
      if (node.terminal === 'NOT_STARTED') return { ...base, lane, column: 0, row: 'main', inFlow: true };
      return { ...base, lane, column: lastColumn, row: node.terminal === 'COMPLETED' ? 'main' : 'below', terminal: true, inFlow: true };
    }
    return base;
  });
  const shown = new Set(nodes.filter((node) => node.inFlow === true).map((node) => node.id));
  const edges = tree.edges
    .filter((edge) => shown.has(edge.from) && shown.has(edge.to))
    .map((edge): ProcessTreeEdge => {
      switch (edge.kind) {
        case 'ADVANCE':
        case 'COMPLETE':
          return { from: edge.from, to: edge.to, count: edge.count, kind: 'forward' };
        case 'RETURN':
          return { from: edge.from, to: edge.to, count: edge.count, kind: 'return' };
        case 'CANCEL':
          return { from: edge.from, to: edge.to, count: edge.count, kind: 'drop' };
        case 'HOLD':
          return { from: edge.from, to: edge.to, count: edge.count, kind: 'return', label: words.hold.replace('{count}', String(edge.count)) };
      }
    });
  return { nodes, edges };
}

/** Whether the tree has a package at all (an empty tree is the empty board, not a tree of zeros). */
export const treeIsEmpty = (tree: TreeDto): boolean => tree.total.count === 0;

// ---- failures ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The code of a failed command, when the server named one. */
export const failureCode = (error: unknown): string | undefined => (error instanceof ApiError ? error.code : undefined);

/** The blockers a refused advance names (extensions.blockers). */
export function blockersOf(error: unknown): Array<{ code: string; subject: string | null }> {
  if (!(error instanceof ApiError)) return [];
  const list = (error.extensions as { blockers?: unknown } | undefined)?.blockers;
  return Array.isArray(list) ? list.flatMap((item) => (asRecord(item) !== undefined && typeof (item as { code?: unknown }).code === 'string' ? [{ code: (item as { code: string }).code, subject: typeof (item as { subject?: unknown }).subject === 'string' ? (item as { subject: string }).subject : null }] : [])) : [];
}

/** The days between two Vietnam days, `to` minus `from`. */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
