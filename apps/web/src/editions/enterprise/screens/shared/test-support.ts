import { vi } from 'vitest';
import { harness } from '../../../../screens/sas/test-support';
import type { Harness } from '../../../../screens/sas/test-support';

export { mount } from '../../../../screens/bid/test-support';
export type { Harness };

export const AS_OF = '2026-11-08T03:00:00.000Z';
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const hpmRoute = (id: string) => ({ id, path: `/hpm/${id.toLowerCase()}`, title: id, kind: 'table', area: 'data', module: 'HPM', group: 'HPM reports', role: 'workspace', parent: null, req: `FR-${id}` });
export const ebsRoute = (id: string) => ({ id, path: `/ebs/${id.toLowerCase()}`, title: id, kind: 'table', area: 'data', module: 'EBS', group: 'Oracle EBS data', role: 'workspace', parent: null, req: `FR-${id}` });

export const HPM_ADMIN = ['hpm.read', 'hpm.admin', 'hpm.push', 'hpm.receipt', 'hpm.correction.propose', 'hpm.correction.decide'];
export const HPM_READER = ['hpm.read'];
export const EBS_ADMIN = ['ebs.read', 'ebs.admin', 'ebs.import', 'ebs.import.preview', 'ebs.reconcile'];
export const EBS_READER = ['ebs.read'];

export const rule = (over: Record<string, unknown> = {}) => ({ source: 'DEFAULT', version: 0, unverified: true, legal_status: 'UNVERIFIED', formula: 'Age = now minus the last delivery', source_text: 'The push log', as_of: '2026-11-08', ...over });
const pending = (code: string) => [{ code, what: 'The interface of the other side', owner: 'The digital office', consequence: 'Nothing is accepted before it exists' }];

// ---- HPM ------------------------------------------------------------------------------------------------------------------------------------------------------------

export const hpmHealth = (over: Record<string, unknown> = {}) => ({
  status: 'FRESH',
  age_hours: 12.5,
  last_delivery_at: '2026-11-07T14:00:00.000Z',
  failed_pushes: 0,
  awaiting_receipt: 1,
  alert: null,
  push_blocked: false,
  rule: rule({ max_attempts: 5, warn_after_hours: 720, max_age_hours: 1080, stale_severity: 'ACTION' }),
  ...over,
});

export function hpmConnection(over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) {
  return {
    connector_code: 'hpm.reports',
    mode: 'FILE_EXPORT',
    adapter_status: 'PROPOSED',
    registry_status: 'Draft',
    registered: true,
    enabled: true,
    state_reason: 'The first pushes of the pilot',
    state_changed_at: '2026-11-05T02:30:00.000Z',
    state_changed_by_name: 'Nguyen Van An',
    package_format: 'HPM-FILE-WORKING-ASSUMPTION-2026.1',
    supported_formats: ['HPM-FILE-WORKING-ASSUMPTION-2026.1'],
    acceptance: 'PENDING_EXTERNAL',
    version: 3,
    api_adapter: { status: 'MISSING', reason: 'HPM_INTERFACE_PENDING' },
    health: hpmHealth(),
    pending_external: pending('HPM_INTERFACE'),
    accepted_series: [{ layout_code: 'HPM-MONTHLY', period: '2026-M09', revision: 1, accepted_at: '2026-10-05T03:00:00.000Z' }],
    counts: { pushes: 4, written: 1, accepted: 1, failed: 1, rejected: 1 },
    history: [
      { id: uuid(500), action: 'ENABLED', reason: 'The first pushes of the pilot', actor_name: 'Nguyen Van An', version: 3, occurred_at: '2026-11-05T02:30:00.000Z' },
      { id: uuid(501), action: 'CREATED', reason: null, actor_name: null, version: 1, occurred_at: '2026-10-01T02:30:00.000Z' },
    ],
    actions: { may_switch: true, may_push: true, may_record_receipt: true, may_propose_correction: true, may_decide_correction: true, ...actions },
    as_of: AS_OF,
    ...over,
  };
}

export const hpmNever = (over: Record<string, unknown> = {}) =>
  hpmConnection({ registered: false, state_reason: null, state_changed_at: null, state_changed_by_name: null, version: 1, health: hpmHealth({ status: 'NEVER_PUSHED', age_hours: null, last_delivery_at: null, awaiting_receipt: 0 }), accepted_series: [], counts: { pushes: 0, written: 0, accepted: 0, failed: 0, rejected: 0 }, history: [], ...over });

export function hpmPush(n: number, over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) {
  return {
    id: uuid(n),
    key: `${uuid(900)}|HPM-MONTHLY|2026-M10|r${n}`,
    org_unit_id: uuid(900),
    layout_code: 'HPM-MONTHLY',
    period: '2026-M10',
    revision: n,
    sha256: 'a'.repeat(64),
    snapshot: null,
    form_status: 'READY',
    demo_mark: null,
    package_format: 'HPM-FILE-WORKING-ASSUMPTION-2026.1',
    acceptance: 'PENDING_EXTERNAL',
    status: 'WRITTEN',
    attempts: 1,
    last_attempt_at: '2026-11-07T14:00:00.000Z',
    last_error_code: null,
    response: { mode: 'FILE', location: `${uuid(900)}/HPM-HPM-MONTHLY-2026-M10-r${n}.zip`, package_name: `HPM-HPM-MONTHLY-2026-M10-r${n}.zip`, package_sha256: 'b'.repeat(64), package_size: 2048, package_format: 'HPM-FILE-WORKING-ASSUMPTION-2026.1', receiver: 'AWAITING_RECEIPT', acceptance: 'PENDING_EXTERNAL' },
    correction_id: null,
    overwrites: false,
    pushed_by: uuid(901),
    pushed_by_name: 'Le Thi Hoa',
    receipt: null,
    version: 2,
    created_at: '2026-11-07T14:00:00.000Z',
    attempt_log: [{ attempt_no: 1, outcome: 'WRITTEN', error_code: null, package_sha256: 'b'.repeat(64), actor_name: 'Le Thi Hoa', attempted_at: '2026-11-07T14:00:00.000Z' }],
    actions: { may_retry: false, may_record_receipt: true, ...actions },
    ...over,
  };
}

export const hpmFailed = (n: number) =>
  hpmPush(n, { status: 'FAILED', response: null, last_error_code: 'HPM_DELIVERY_FAILED', attempt_log: [{ attempt_no: 1, outcome: 'FAILED', error_code: 'HPM_DELIVERY_FAILED', package_sha256: null, actor_name: 'Le Thi Hoa', attempted_at: '2026-11-07T14:00:00.000Z' }] }, { may_retry: true, may_record_receipt: false });

export const hpmCorrection = (n: number, over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) => ({
  id: uuid(300 + n),
  layout_code: 'HPM-MONTHLY',
  period: '2026-M09',
  from_revision: 1,
  period_reopen_id: uuid(700 + n),
  reason: 'A late invoice changed the executed value of the month',
  state: 'PROPOSED',
  proposed_by: uuid(902),
  proposed_by_name: 'Tran Van Binh',
  decided_by: null,
  decided_by_name: null,
  decided_at: null,
  decision_reason: null,
  consumed_by_push_id: null,
  consumed_at: null,
  version: 1,
  created_at: '2026-11-06T02:00:00.000Z',
  actions: { may_decide: true, ...actions },
  ...over,
});

export interface HpmWorld {
  connection: Record<string, unknown>;
  pushes: Array<Record<string, unknown>>;
  corrections: Array<Record<string, unknown>>;
  /** The reads that fail with this error for the first `times` answers, by operation. */
  failing?: Record<string, { error: Error; times: number }>;
}

const page = (items: unknown[]) => ({ items, next_cursor: null, as_of: AS_OF });

export function hpmClient(world: HpmWorld, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'OK', resource_version: 4 })): Harness {
  return harness((operation, input) => {
    const failing = world.failing?.[operation];
    if (failing !== undefined && failing.times > 0) {
      failing.times -= 1;
      return failing.error;
    }
    if (operation === 'getHpmConnection') return world.connection;
    if (operation === 'listHpmPushes') {
      const status = (input as { query?: { status?: string } } | undefined)?.query?.status;
      return page(status === undefined ? world.pushes : world.pushes.filter((row) => row.status === status));
    }
    if (operation === 'listHpmCorrections') {
      const state = (input as { query?: { state?: string } } | undefined)?.query?.state;
      return page(state === undefined ? world.corrections : world.corrections.filter((row) => row.state === state));
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
}

// ---- EBS ------------------------------------------------------------------------------------------------------------------------------------------------------------

export const ebsHealth = (over: Record<string, unknown> = {}) => ({
  status: 'FRESH',
  age_hours: 30,
  last_import_at: '2026-11-07T02:00:00.000Z',
  alert: null,
  figures_blocked: false,
  apply_blocked: false,
  rule: rule({ warn_after_hours: 120, max_age_hours: 168, stale_severity: 'WATCH', figures_blocked_when_stale: false }),
  ...over,
});

export const ebsRun = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  layout_version: 'WORKING-ASSUMPTION-2026.1',
  file_sha256: 'c'.repeat(64),
  status: 'APPLIED',
  error_code: null,
  counts: { total: 10, applied: 8, duplicate: 1, conflict: 0, quarantined: 1, differences_opened: 0 },
  imported_by_name: 'Le Thi Hoa',
  created_at: '2026-11-07T02:00:00.000Z',
  completed_at: '2026-11-07T02:01:00.000Z',
  ...over,
});

export function ebsConnection(over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) {
  return {
    connector_code: 'ebs.ledger',
    mode: 'FILE_IMPORT',
    adapter_status: 'PROPOSED',
    registry_status: 'Draft',
    registered: true,
    enabled: true,
    state_reason: 'The pilot of the ledger extract',
    state_changed_at: '2026-11-05T02:30:00.000Z',
    state_changed_by_name: 'Nguyen Van An',
    layout_version: 'WORKING-ASSUMPTION-2026.1',
    supported_layouts: ['WORKING-ASSUMPTION-2026.1'],
    acceptance: 'PENDING_EXTERNAL',
    version: 5,
    api_adapter: { status: 'MISSING', reason: 'EBS_ACCESS_PENDING' },
    health: ebsHealth(),
    pending_external: pending('EBS_EXTRACT'),
    columns: ['project_code', 'period', 'extract_date', 'disbursed_vnd', 'committed_vnd'],
    positions: [{ connector_code: 'EBS_LEDGER_FILE', cursor_status: 'ACTIVE', adapter_status: 'PROPOSED', last_success_at: '2026-11-07T02:01:00.000Z', last_error_code: null, last_file_sha256: 'c'.repeat(64) }],
    last_runs: [ebsRun(1), ebsRun(2, { status: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID', counts: { total: 0, applied: 0, duplicate: 0, conflict: 0, quarantined: 0, differences_opened: 0 } })],
    record_counts: { records: 40, projects: 8, periods: 5 },
    item_counts: { open: 2, resolved: 1, overdue: 1, reviews_due: 0, by_resolution: { OURS_WRONG: 1, EBS_WRONG: 0, TIMING: 0, WAIVED: 0 } },
    due_rule: { source: 'DEFAULT', version: 0, unverified: true, legal_status: 'UNVERIFIED', formula: 'Due in working days', source_text: 'The design of ENT-2', as_of: '2026-11-08', due_in_working_days: 5 },
    history: [{ id: uuid(510), action: 'CREATED', reason: null, actor_name: null, version: 1, occurred_at: '2026-10-01T02:30:00.000Z' }],
    actions: { may_switch: true, may_preview: true, may_import: true, may_reconcile: true, ...actions },
    as_of: AS_OF,
    ...over,
  };
}

export const ebsNever = (over: Record<string, unknown> = {}) =>
  ebsConnection({ registered: false, state_reason: null, state_changed_at: null, state_changed_by_name: null, version: 1, health: ebsHealth({ status: 'NEVER_IMPORTED', age_hours: null, last_import_at: null }), positions: [{ connector_code: 'EBS_LEDGER_FILE', cursor_status: null, adapter_status: null, last_success_at: null, last_error_code: null, last_file_sha256: null }], last_runs: [], record_counts: { records: 0, projects: 0, periods: 0 }, item_counts: { open: 0, resolved: 0, overdue: 0, reviews_due: 0, by_resolution: { OURS_WRONG: 0, EBS_WRONG: 0, TIMING: 0, WAIVED: 0 } }, history: [], ...over });

export function difference(n: number, over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) {
  return {
    id: uuid(400 + n),
    project_id: uuid(800 + n),
    project_code: `EBS-P00${n}`,
    period: '2026-10',
    measure: 'DISBURSED_VND',
    difference_kind: 'AMOUNT_MISMATCH',
    ours: '600',
    theirs: '700',
    delta: '100',
    state: 'OPEN',
    owner_id: uuid(7),
    owner_name: 'Pham Van Cuong',
    opened_at: '2026-11-06T02:00:00.000Z',
    due_at: '2026-11-13T16:59:59.999Z',
    overdue: false,
    resolution: null,
    acceptance: 'PENDING_EXTERNAL',
    version: 1,
    actions: { may_resolve: true, may_reassign: true, ...actions },
    ...over,
  };
}

export const upload = (over: Record<string, unknown> = {}) => ({ file_object_key: 'tenants/t/import/0001', file_sha256: 'd'.repeat(64), size_bytes: 2048, format: 'CSV', columns: ['project_code', 'period', 'extract_date', 'disbursed_vnd', 'committed_vnd'], row_count: 3, matches_layout: true, missing_columns: [], ...over });

export interface EbsWorld {
  connection: Record<string, unknown>;
  differences: Array<Record<string, unknown>>;
  /** The answer of the upload door (a value, or an Error to throw). */
  upload?: () => unknown;
  failing?: Record<string, { error: Error; times: number }>;
}

export function ebsClient(world: EbsWorld, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'OK', resource_version: 6 })): Harness & { upload: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => {
    const answer = world.upload?.() ?? upload();
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const made = harness((operation, input) => {
    const failing = world.failing?.[operation];
    if (failing !== undefined && failing.times > 0) {
      failing.times -= 1;
      return failing.error;
    }
    if (operation === 'getEbsConnection') return world.connection;
    if (operation === 'listEbsDifferences') {
      const state = (input as { query?: { state?: string } } | undefined)?.query?.state;
      const items = state === undefined ? world.differences : world.differences.filter((row) => row.state === state);
      return { items, next_cursor: null, counts: { open: world.differences.filter((row) => row.state === 'OPEN').length, resolved: world.differences.filter((row) => row.state === 'RESOLVED').length, overdue: 1, reviews_due: 0 }, as_of: AS_OF };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (made.client as unknown as { upload: unknown }).upload = send;
  return Object.assign(made, { upload: send });
}
