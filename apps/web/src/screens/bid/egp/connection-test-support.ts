import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount } from '../test-support';
export type { Harness };

export const ADMIN = ['bid.read', 'bid.egp.admin'];
export const READER = ['bid.read'];
export const route = { id: 'BID-22', path: '/bid/bid-22', title: 'BID-22', kind: 'detail', area: 'investment', module: 'BID', group: 'Đấu thầu', role: 'workspace', parent: null, req: 'FR-BID-22' };

export const AS_OF = '2026-11-08T03:00:00.000Z';
export const LAYOUT = 'WORKING-ASSUMPTION-2026.2';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const KINDS = ['KHLCNT', 'TBMT', 'RESULT', 'CONTRACTOR', 'RESTRICTION'] as const;

export const pendingItems = [
  ...KINDS.map((kind) => ({ code: `SAMPLE_${kind}`, what: `Official sample of ${kind}`, owner: 'Operator of the national network', working_assumption: `Layout ${kind} of ${LAYOUT}`, switches_when_it_arrives: `The ${kind} layout` })),
  { code: 'API_SPECIFICATION', what: 'API specification', owner: 'Operator of the national network', working_assumption: 'None', switches_when_it_arrives: 'EgpApiAdapter is implemented' },
  { code: 'POSTING_RECEIPT_FORMAT', what: 'The receipt', owner: 'Operator of the national network', working_assumption: 'A free reference', switches_when_it_arrives: 'Checked against the format' },
  { code: 'LEGAL_TEXT_DEADLINES', what: 'Official text of the deadlines', owner: 'Legal staff of the customer', working_assumption: 'UNVERIFIED default', switches_when_it_arrives: 'The tenant approves its own rule' },
];

export const position = (kind: (typeof KINDS)[number], over: Record<string, unknown> = {}) => ({
  kind,
  connector_code: `EGP_${kind}_FILE`,
  cursor_status: 'ACTIVE',
  adapter_status: 'PROPOSED',
  last_success_at: null,
  last_error_code: null,
  last_file_sha256: null,
  ...over,
});

export const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  kind: 'KHLCNT',
  connector_code: 'EGP_KHLCNT_FILE',
  layout_version: LAYOUT,
  acceptance: 'PENDING_EXTERNAL',
  file_sha256: 'a'.repeat(64),
  status: 'APPLIED',
  error_code: null,
  counts: { total: 12, applied: 9, duplicate: 1, conflict: 1, quarantined: 1, differences_opened: 2 },
  open_differences: 2,
  imported_by: uuid(900),
  imported_by_name: 'Lê Thị Hoa',
  created_at: '2026-11-07T01:00:00.000Z',
  completed_at: '2026-11-07T01:05:00.000Z',
  ...over,
});

export const rule = (over: Record<string, unknown> = {}) => ({
  source: 'DEFAULT',
  version: 0,
  unverified: true,
  legal_status: 'UNVERIFIED',
  formula: 'Độ tuổi = bây giờ − lúc áp dụng tệp gần nhất',
  source_text: 'Dòng file_import của tệp gần nhất',
  as_of: '2026-11-08',
  warn_after_hours: 120,
  max_age_hours: 168,
  stale_severity: 'WATCH',
  figures_blocked_when_stale: false,
  ...over,
});

export const health = (over: Record<string, unknown> = {}) => ({
  status: 'FRESH',
  age_hours: 26.5,
  last_import_at: '2026-11-07T01:05:00.000Z',
  last_import_kind: 'KHLCNT',
  alert: null,
  figures_blocked: false,
  apply_blocked: false,
  rule: rule(),
  ...over,
});

export const staleHealth = (over: Record<string, unknown> = {}) =>
  health({ status: 'STALE', age_hours: 200, last_import_at: '2026-10-30T01:05:00.000Z', alert: { code: 'CONNECTOR_STALE', severity: 'WATCH' }, ...over });

export const neverHealth = (over: Record<string, unknown> = {}) => health({ status: 'NEVER_IMPORTED', age_hours: null, last_import_at: null, last_import_kind: null, alert: null, ...over });

export const columns = (kind: string) => [
  { name: `${kind.toLowerCase()}_code`, kind: 'code', required: true, header_required: true },
  { name: 'selection_method', kind: 'enum', required: false, header_required: false, values: ['OPEN_BIDDING', 'LIMITED_BIDDING'] },
  { name: 'award_price', kind: 'money', required: false, header_required: true },
];

export function connection(over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) {
  return {
    connector_code: 'egp.muasamcong',
    mode: 'FILE_IMPORT',
    adapter_status: 'PROPOSED',
    registry_status: 'Draft',
    registered: true,
    enabled: true,
    state_reason: 'Bắt đầu nhập tệp thử nghiệm',
    state_changed_at: '2026-11-05T02:30:00.000Z',
    state_changed_by_name: 'Nguyễn Văn An',
    layout_version: LAYOUT,
    supported_layouts: [LAYOUT],
    acceptance: 'PENDING_EXTERNAL',
    version: 7,
    api_adapter: { status: 'MISSING', reason: 'OPERATOR_SPECIFICATION_PENDING' },
    health: health(),
    pending_external: pendingItems,
    positions: KINDS.map((kind) => position(kind, kind === 'KHLCNT' ? { last_success_at: '2026-11-07T01:05:00.000Z' } : kind === 'TBMT' ? { cursor_status: 'FAILED', last_error_code: 'IMPORT_SCHEMA_INVALID' } : {})),
    layouts: KINDS.slice(0, 2).map((kind) => ({ kind, connector_code: `EGP_${kind}_FILE`, columns: columns(kind) })),
    last_runs: [run(1), run(2, { kind: 'TBMT', connector_code: 'EGP_TBMT_FILE', status: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID', open_differences: 0, imported_by_name: null })],
    record_counts: { KHLCNT: 1200, TBMT: 35, RESULT: 0, CONTRACTOR: 4, RESTRICTION: 1 },
    open_differences: 3,
    mapping_counts: { PROPOSED: 2, ACTIVE: 40, REJECTED: 1, RETIRED: 0 },
    history: [
      { id: uuid(500), action: 'ENABLED', reason: 'Bắt đầu nhập tệp thử nghiệm', actor_name: 'Nguyễn Văn An', version: 7, occurred_at: '2026-11-05T02:30:00.000Z' },
      { id: uuid(501), action: 'CREATED', reason: null, actor_name: null, version: 1, occurred_at: '2026-10-01T02:30:00.000Z' },
    ],
    actions: { set_state: true, preview: true, apply: true, propose_mapping: true, decide_mapping: true, ...actions },
    as_of: AS_OF,
    ...over,
  };
}

/** A tenant that never used the connection: nothing is registered, the health says never imported. */
export const unusedConnection = (over: Record<string, unknown> = {}) =>
  connection(
    {
      registered: false,
      state_reason: null,
      state_changed_at: null,
      state_changed_by_name: null,
      version: 0,
      health: neverHealth(),
      positions: KINDS.map((kind) => position(kind, { cursor_status: null })),
      last_runs: [],
      record_counts: { KHLCNT: 0, TBMT: 0, RESULT: 0, CONTRACTOR: 0, RESTRICTION: 0 },
      open_differences: 0,
      mapping_counts: { PROPOSED: 0, ACTIVE: 0, REJECTED: 0, RETIRED: 0 },
      history: [],
      ...over,
    },
    {},
  );

export interface World {
  connection: Record<string, unknown>;
  /** The read fails with this (a value to reject with) for the first `times` reads. */
  failing?: { error: Error; times: number };
}

/** A client over `state`: the read of the connection is answered from it, `command(operation, input)` answers the command. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'OK', resource_version: 8 })): Harness {
  return harness((operation) => {
    if (operation !== 'getEgpConnection') return new Error(`unexpected read ${operation}`);
    if (state.failing !== undefined && state.failing.times > 0) {
      state.failing.times -= 1;
      return state.failing.error;
    }
    return state.connection;
  }, command);
}
