import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { TENANT } from '../test-support';

export { mount } from '../test-support';
export type { Harness };

export const READER = ['bid.read'];
export const ME = TENANT.membershipId;
export const route = (id: string, req: string) => ({ id, path: `/bid/${id.toLowerCase()}`, title: id, kind: 'list', area: 'investment', module: 'BID', group: 'Đấu thầu', role: 'workspace', parent: null, req });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const pkgId = (n: number): string => uuid('0020', n);
export const wfId = (n: number): string => uuid('00f0', n);
export const itemId = (n: number): string => uuid('00c0', n);
export const SOMEONE = uuid('00b0', 7);
export const AS_OF = '2026-11-12T03:00:00.000Z';

export const person = (id: string, name: string) => ({ id, name });

export const node = (id: string, over: Record<string, unknown>) => ({
  id,
  parent_id: null,
  kind: 'STEP',
  method: 'OPEN_BIDDING',
  step_code: null,
  substate: null,
  terminal: null,
  label: null,
  order: null,
  count: 0,
  value_vnd: '0',
  share_count_bp: 0,
  share_value_bp: 0,
  median_days: null,
  median_basis: 'WORKING_DAYS',
  late_count: 0,
  path: ['ROOT'],
  route: [],
  ...over,
});

/** A tree of four packages: one not started, two preparing the documents (one late), one in the evaluation (on hold). */
export function treeDto(over: Record<string, unknown> = {}) {
  const m = 'M:OPEN_BIDDING';
  const prep = 'S:OPEN_BIDDING:DOC_PREPARE';
  const evalu = 'S:OPEN_BIDDING:EVALUATE';
  return {
    period: { from: '2026-10-13', to: '2026-11-12' },
    total: { count: 4, value_vnd: '400000000000' },
    nodes: [
      node('ROOT', { kind: 'ROOT', method: null, count: 4, value_vnd: '400000000000', share_count_bp: 10000, share_value_bp: 10000, late_count: 1 }),
      node(m, { parent_id: 'ROOT', kind: 'METHOD', label: 'Quy trình đấu thầu rộng rãi', count: 4, value_vnd: '400000000000', share_count_bp: 10000, late_count: 1 }),
      node('T:OPEN_BIDDING:NOT_STARTED', { parent_id: m, kind: 'TERMINAL', terminal: 'NOT_STARTED', count: 1, value_vnd: '100000000000', share_count_bp: 2500 }),
      node(prep, { parent_id: m, kind: 'STEP', step_code: 'DOC_PREPARE', label: 'Lập hồ sơ mời thầu', order: 1, count: 2, value_vnd: '200000000000', share_count_bp: 5000, median_days: 6, late_count: 1 }),
      node(`${prep}:ON_HOLD`, { parent_id: prep, kind: 'SUBSTATE', step_code: 'DOC_PREPARE', substate: 'ON_HOLD', order: 1 }),
      node(`${prep}:LATE`, { parent_id: prep, kind: 'SUBSTATE', step_code: 'DOC_PREPARE', substate: 'LATE', order: 1, count: 1, value_vnd: '100000000000', late_count: 1 }),
      node(`${prep}:RETURNED`, { parent_id: prep, kind: 'SUBSTATE', step_code: 'DOC_PREPARE', substate: 'RETURNED', order: 1 }),
      node(`${prep}:ON_TRACK`, { parent_id: prep, kind: 'SUBSTATE', step_code: 'DOC_PREPARE', substate: 'ON_TRACK', order: 1, count: 1, value_vnd: '100000000000' }),
      node(evalu, { parent_id: m, kind: 'STEP', step_code: 'EVALUATE', label: 'Đánh giá hồ sơ dự thầu', order: 2, count: 1, value_vnd: '100000000000', share_count_bp: 2500, median_days: 11 }),
      node(`${evalu}:ON_HOLD`, { parent_id: evalu, kind: 'SUBSTATE', step_code: 'EVALUATE', substate: 'ON_HOLD', order: 2, count: 1, value_vnd: '100000000000' }),
      node('T:OPEN_BIDDING:COMPLETED', { parent_id: m, kind: 'TERMINAL', terminal: 'COMPLETED' }),
      node('T:OPEN_BIDDING:CANCELLED', { parent_id: m, kind: 'TERMINAL', terminal: 'CANCELLED' }),
    ],
    edges: [
      { from: 'T:OPEN_BIDDING:NOT_STARTED', to: prep, kind: 'ADVANCE', count: 3 },
      { from: prep, to: evalu, kind: 'ADVANCE', count: 2 },
    ],
    kpis: { running: 3, late: 1, stalled: 1, on_hold: 1, no_owner: 1, median_days: 6 },
    truncated: false,
    as_of: AS_OF,
    ...over,
  };
}

export const row = (n: number, over: Record<string, unknown> = {}) => ({
  package_id: pkgId(n),
  package_code: `GT-${n}`,
  title: `Gói thầu xây lắp ${n}`,
  value_vnd: '100000000000',
  method: 'OPEN_BIDDING',
  project: { id: uuid('0030', 1), code: 'PRJ-001', name: 'Cầu qua sông' },
  unit: { id: uuid('0040', 1), name: 'Ban QLDA' },
  workflow_id: wfId(n),
  status: 'IN_PROGRESS',
  step: { code: 'DOC_PREPARE', name: 'Lập hồ sơ mời thầu', order: 1, of: 16 },
  visit: 1,
  entered_on: '2026-11-02',
  days_in_step: { calendar_days: 10, working_days: 8 },
  due_on: '2026-11-09',
  countdown: { days_left: -3, due_on: '2026-11-09' },
  late: true,
  late_days: 3,
  hold_reason: null,
  owner: person(SOMEONE, 'Nguyễn Văn An'),
  last_activity_on: '2026-11-10',
  stalled: false,
  progress_percent: 12,
  open_required_items: 1,
  substate: 'LATE',
  sparkline: [{ step_code: 'PLAN_SELECTION', days: 4 }],
  version: 3,
  actions: { start: false, advance: true, hold: true, resume: false, assign_owner: true, return: false, cancel: true },
  ...over,
});

export const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'STATE_CHANGE',
  at: '2026-11-04T03:00:00.000Z',
  day: '2026-11-04',
  from_step: 'PLAN_SELECTION',
  to_step: 'DOC_PREPARE',
  actor: person(SOMEONE, 'Nguyễn Văn An'),
  spent_calendar_days: 2,
  spent_working_days: 2,
  reason: null,
  evidence: [],
  subject: null,
  state_change: true,
  ...over,
});

export const stepsDef = [
  { code: 'PLAN_SELECTION', name: 'Lập kế hoạch lựa chọn nhà thầu', order: 1, standard_working_days: 10, responsible_role: 'PROCUREMENT_OFFICER', entry_condition: 'Có quyết định đầu tư', exit_condition: 'Kế hoạch được duyệt', maker_checker: true, evidence_kinds: ['DECISION_DOCUMENT'], milestone_kind: null },
  { code: 'DOC_PREPARE', name: 'Lập hồ sơ mời thầu', order: 2, standard_working_days: 15, responsible_role: 'PROCUREMENT_OFFICER', entry_condition: 'Kế hoạch đã được duyệt', exit_condition: 'Hồ sơ đủ nội dung', maker_checker: false, evidence_kinds: ['DOCUMENT'], milestone_kind: null },
  { code: 'DOC_APPRAISE', name: 'Thẩm định hồ sơ mời thầu', order: 3, standard_working_days: 20, responsible_role: 'APPRAISER', entry_condition: 'Hồ sơ đã lập', exit_condition: 'Có báo cáo thẩm định', maker_checker: true, evidence_kinds: ['DOCUMENT'], milestone_kind: null },
];

export const timelineDto = (over: Record<string, unknown> = {}) => ({
  days: [
    { day: '2026-11-04', entries: [entry('e2', { kind: 'CHECKLIST_DONE', from_step: 'DOC_PREPARE', to_step: 'DOC_PREPARE', state_change: false, subject: 'DOC_DRAFTED', evidence: [{ kind: 'DOCUMENT', document_id: uuid('00e0', 1), milestone_kind: null, reference: null }] }), entry('e1')], state_changes: 1, checklist_done: 1 },
    { day: '2026-11-02', entries: [entry('e0', { kind: 'START', at: '2026-11-02T01:00:00.000Z', day: '2026-11-02', from_step: null, to_step: 'PLAN_SELECTION', spent_calendar_days: null, spent_working_days: null })], state_changes: 1, checklist_done: 0 },
  ],
  summary: [
    { step_code: 'PLAN_SELECTION', order: 1, days: 2, basis: 'WORKING_DAYS', standard_working_days: 10, days_over: 0 },
    { step_code: 'DOC_PREPARE', order: 2, days: 8, basis: 'WORKING_DAYS', standard_working_days: 4, days_over: 4, current: true },
  ],
  gantt: [
    { step_code: 'PLAN_SELECTION', order: 1, planned: { start_on: '2026-11-02', end_on: '2026-11-04' }, actual: { start_on: '2026-11-02', end_on: '2026-11-04', open: false } },
    { step_code: 'DOC_PREPARE', order: 2, planned: { start_on: '2026-11-04', end_on: '2026-11-06' }, actual: { start_on: '2026-11-04', end_on: '2026-11-12', open: true } },
    { step_code: 'DOC_APPRAISE', order: 3, planned: null, actual: null },
  ],
  empty: false,
  as_of: AS_OF,
  ...over,
});

export const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: itemId(n),
  code: `ITEM_${n}`,
  name: `Mục kiểm ${n}`,
  required: true,
  status: 'OPEN',
  due_on: '2026-11-09',
  completed_at: null,
  completed_by: null,
  completed_via: null,
  owner: null,
  evidence_required: true,
  allowed_kinds: ['DOCUMENT'],
  milestone_kind: null,
  evidence: [],
  version: 1,
  ...over,
});

export function detailDto(over: Record<string, unknown> = {}, workflowOver: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) {
  return {
    package: { id: pkgId(1), code: 'GT-1', title: 'Gói thầu xây lắp 1', value_vnd: '128400000000', method: 'OPEN_BIDDING', status: 'APPROVED' },
    project: { id: uuid('0030', 1), code: 'PRJ-001', name: 'Cầu qua sông' },
    unit_name: 'Ban QLDA',
    workflow: {
      id: wfId(1),
      status: 'IN_PROGRESS',
      step: { code: 'DOC_PREPARE', name: 'Lập hồ sơ mời thầu', visit: 2, standard_working_days: 4 },
      owner: person(SOMEONE, 'Nguyễn Văn An'),
      hold_reason: null,
      held_at: null,
      started_at: '2026-11-02T01:00:00.000Z',
      ended_at: null,
      end_reason: null,
      last_activity_on: '2026-11-10',
      definition: { rule_version: 0, hash: 'a'.repeat(64), unverified: true },
      entered_on: '2026-11-04',
      due_on: '2026-11-09',
      countdown: { days_left: -3, due_on: '2026-11-09' },
      days_in_step: { calendar_days: 8, working_days: 6 },
      late: true,
      progress: { steps_total: 3, steps_done: 1, current_order: 2, items_required: 2, items_required_done: 1, percent: 40 },
      blockers: [{ reason: 'REQUIRED_ITEMS_OPEN', count: 1, detail: null }, { reason: 'STEP_OVERDUE', count: 3, detail: '2026-11-09' }],
      steps: stepsDef,
      checklist: [item(1, { status: 'DONE', completed_via: 'PERSON', completed_by: person(SOMEONE, 'Nguyễn Văn An'), evidence: [{ kind: 'DOCUMENT', document_id: uuid('00e0', 1), milestone_kind: null, reference: null }] }), item(2)],
      exceptions: [],
      history: [
        { visit: 1, step_code: 'PLAN_SELECTION', entered_at: '2026-11-02T01:00:00.000Z', entered_by: person(SOMEONE, 'Nguyễn Văn An'), entry_kind: 'START', exited_at: '2026-11-04T03:00:00.000Z', exited_by: person(SOMEONE, 'Nguyễn Văn An'), exit_kind: 'ADVANCE', due_on: '2026-11-04', note: null },
        { visit: 2, step_code: 'DOC_PREPARE', entered_at: '2026-11-04T03:00:00.000Z', entered_by: person(SOMEONE, 'Nguyễn Văn An'), entry_kind: 'ADVANCE', exited_at: null, exited_by: null, exit_kind: null, due_on: '2026-11-09', note: null },
      ],
      links: { milestones: [{ id: uuid('0050', 1), kind: 'INVITATION_PUBLISHED', actual_at: '2026-11-05T02:00:00.000Z', planned_at: null, source: 'IMPORT' }], petitions: { total: 2, open: 1 }, result: null, contract: null },
      timeline: timelineDto(),
      version: 5,
      ...workflowOver,
    },
    actions: { start: false, advance: true, hold: true, resume: false, assign_owner: true, work: true, return: true, request_exception: true, decide_exception: false, cancel: true, ...actions },
    as_of: AS_OF,
    ...over,
  };
}

export interface World {
  tree: ReturnType<typeof treeDto>;
  detail: ReturnType<typeof detailDto>;
  board: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  overview: Record<string, unknown>;
  statistics: Record<string, unknown>;
  rule: Record<string, unknown>;
  versions: Array<Record<string, unknown>>;
  /** Reads that fail, by operation, and how many times (Infinity: always). */
  failing: Map<string, { error: Error; times: number }>;
}

export function world(over: Partial<World> = {}): World {
  return {
    tree: treeDto(),
    detail: detailDto(),
    board: {
      method: 'OPEN_BIDDING',
      method_name: 'Quy trình đấu thầu rộng rãi',
      methods: [{ method: 'OPEN_BIDDING', count: 3 }],
      columns: [
        { code: 'NOT_STARTED', name: null, order: 0, kind: 'NOT_STARTED', standard_working_days: null, count: 1, value_vnd: '100000000000', late_count: 0, held_count: 0, cards: [row(9, { status: 'NOT_STARTED', step: null, workflow_id: null, late: false, countdown: null, days_in_step: null, due_on: null })] },
        { code: 'DOC_PREPARE', name: 'Lập hồ sơ mời thầu', order: 1, kind: 'STEP', standard_working_days: 15, count: 3, value_vnd: '300000000000', late_count: 1, held_count: 0, cards: [row(1), row(2, { late: false, countdown: { days_left: 2, due_on: '2026-11-14' }, days_in_step: { calendar_days: 2, working_days: 2 } })] },
        { code: 'EVALUATE', name: 'Đánh giá hồ sơ dự thầu', order: 2, kind: 'STEP', standard_working_days: 45, count: 0, value_vnd: '0', late_count: 0, held_count: 0, cards: [] },
      ],
      truncated: false,
      as_of: AS_OF,
    },
    rows: [row(1), row(2, { late: false, countdown: { days_left: 2, due_on: '2026-11-14' } })],
    overview: {
      node_id: 'S:OPEN_BIDDING:DOC_PREPARE',
      count: 2,
      median_days: 6,
      longest_days: 10,
      shortest_days: 2,
      basis: 'WORKING_DAYS',
      late_count: 1,
      stalled_count: 0,
      held_count: 0,
      no_owner_count: 1,
      top_owners: [{ id: SOMEONE, name: 'Nguyễn Văn An', count: 2 }],
      unfinished_items: [{ step_code: 'DOC_PREPARE', item_code: 'CRITERIA_SET', name: 'Tiêu chí đánh giá đã chốt', count: 2 }],
      weeks: [{ week_of: '2026-11-09', arrivals: 3, departures: 1 }],
      truncated: false,
      as_of: AS_OF,
    },
    statistics: {
      period: { from: '2026-10-13', to: '2026-11-12' },
      steps: [
        { method: 'OPEN_BIDDING', step_code: 'DOC_PREPARE', step_name: 'Lập hồ sơ mời thầu', completed_visits: 3, median_days: 9, basis: 'WORKING_DAYS', on_time_share: 0.6667, open_visits: 2, over_standard: 1 },
        { method: 'OPEN_BIDDING', step_code: 'EVALUATE', step_name: 'Đánh giá hồ sơ dự thầu', completed_visits: 0, median_days: null, basis: 'WORKING_DAYS', on_time_share: null, open_visits: 1, over_standard: 0 },
      ],
      stuck: [{ package_id: pkgId(1), package_code: 'GT-1', title: 'Gói thầu xây lắp 1', method: 'OPEN_BIDDING', step_code: 'DOC_PREPARE', step_name: 'Lập hồ sơ mời thầu', days: 12, basis: 'WORKING_DAYS', value_vnd: '100000000000', owner_name: 'Nguyễn Văn An', late: true }],
      kpis: { on_time_share: 0.6667, completed_visits: 3, median_days: 9, basis: 'WORKING_DAYS' },
      truncated: false,
      as_of: AS_OF,
    },
    rule: {
      rule_type: 'PROCUREMENT_WORKFLOW',
      code: 'OPEN_BIDDING',
      as_of: '2026-11-12',
      version: 0,
      source: 'DEFAULT',
      rule_id: null,
      unit_id: null,
      unverified: true,
      params: { method: 'OPEN_BIDDING', name: 'Quy trình đấu thầu rộng rãi', stalled_after_working_days: 10, checklist_warn_days: 2, steps: stepsDef.map((step) => ({ code: step.code, name: step.name, entry_condition: step.entry_condition, exit_condition: step.exit_condition, responsible_role: step.responsible_role, standard_working_days: step.standard_working_days, evidence_kinds: step.evidence_kinds, maker_checker: step.maker_checker, checklist: [{ code: 'ITEM_A', name: 'Mục A', required: true, owner_role: 'PROCUREMENT_OFFICER', due_offset_working_days: 3, evidence_kinds: ['DOCUMENT'], evidence_required: true }] })) },
      provenance: { formula: 'Một gói đi qua các bước theo thứ tự', source: 'Luật Đấu thầu 22/2023/QH15', as_of: '2026-11-08', legal_status: 'UNVERIFIED' },
    },
    versions: [],
    failing: new Map(),
    ...over,
  };
}

/** A client over `state`: every read is answered from it (a failing one for as many times as the test says) and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'IN_PROGRESS', resource_version: 6 })): Harness {
  const h = baseHarness((operation, input) => {
    const failing = state.failing.get(operation);
    if (failing !== undefined && failing.times > 0) {
      failing.times -= 1;
      return failing.error;
    }
    const query = (input as { query?: Record<string, unknown> } | undefined)?.query ?? {};
    switch (operation) {
      case 'getPackageProcessTree':
        return state.tree;
      case 'getPackageProcessTreeNode':
        return { ...state.overview, node_id: query.node_id };
      case 'listPackageProcessTreeNodePackages':
        return { items: state.rows, next_cursor: null, truncated: false, as_of: AS_OF };
      case 'getPackageProcessTreeNodeFeed':
        return { items: [{ package_id: pkgId(1), package_code: 'GT-1', entry: entry('f1') }], truncated: false, as_of: AS_OF };
      case 'getPackageWorkflowBoard':
        return state.board;
      case 'listPackageWorkflows':
        return { items: state.rows, next_cursor: null, truncated: false, as_of: AS_OF };
      case 'getPackageWorkflow':
        return state.detail;
      case 'getPackageWorkflowTimeline':
        return state.detail.workflow === null ? { days: [], summary: [], gantt: [], empty: true, as_of: AS_OF } : state.detail.workflow.timeline;
      case 'getPackageWorkflowStatistics':
        return state.statistics;
      case 'getPackageWorkflowSummary':
        return { total: 4, running: 3, not_started: 1, completed: 0, late: 1, stalled: 1, on_hold: 1, no_owner: 1, top_steps: [{ node_id: 'S:OPEN_BIDDING:DOC_PREPARE', method: 'OPEN_BIDDING', code: 'DOC_PREPARE', name: 'Lập hồ sơ mời thầu', count: 2, late_count: 1 }], truncated: false, as_of: AS_OF };
      case 'exportPackageWorkflowReport':
        return { file_name: 'bao-cao.xlsx', content_type: 'application/octet-stream', size_bytes: 3, sha256: 'x', content_base64: 'AAEC', as_of: AS_OF };
      case 'getEffectiveGovernanceRule':
        return state.rule;
      case 'listGovernanceRuleVersions':
        return { items: state.versions };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    switch (operation) {
      case 'get_resources_organization_unit':
        return Promise.resolve([{ id: uuid('0040', 1), name: 'Ban QLDA' }]);
      case 'get_resources_project':
        return Promise.resolve([{ id: uuid('0030', 1), code: 'PRJ-001', name: 'Cầu qua sông' }]);
      case 'get_resources_membership':
        return Promise.resolve([{ id: SOMEONE, display_name: 'Nguyễn Văn An' }, { id: uuid('00b0', 8), display_name: 'Trần Thị Bình' }]);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
