import { ApiError } from '@machvon/api-client';
import type { QueryClient } from '@tanstack/react-query';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import catalogue from '../../../i18n/vi.json';
import type { WebRoute } from '../../../routes/types';
import { mount as baseMount } from '../../bid/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export type { Harness };

/** A text of the Vietnamese catalogue (the strings of the part files are in it once the translator has read them), with its {placeholders} filled. */
export const word = (key: string, params: Record<string, string | number> = {}): string => {
  const text = (catalogue as Record<string, string>)[key];
  if (text === undefined) throw new Error(`no text for ${key}`);
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => (name in params ? String(params[name]) : placeholder));
};

export const routeOf = (id: string): WebRoute => ({ id, path: `/feed/${id.toLowerCase()}`, title: id, kind: 'table', area: 'insights', module: 'FEED', group: 'Số liệu từ Sở Tài chính', role: 'workspace', parent: null, req: `FR-${id}` });

export const problem = (code: string, status: number, detail?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions });

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const runId = (n: number): string => uuid('0070', n);
export const mappingId = (n: number): string => uuid('0080', n);
export const differenceId = (n: number): string => uuid('0090', n);
/** The membership of the signed-in person of the test session (the same the test harness gives the session). */
export const ME = '00000000-0000-4000-8000-000000000001';
export const OTHER = '00000000-0000-4000-8000-0000000000e1';
export const SHA = 'b'.repeat(64);
export const KEY = 'tenants/00000000-0000-4000-8000-00000000000a/import/00000000-0000-4000-8000-0000000000aa';
export const AS_OF = '2026-11-08T03:00:00.000Z';
export const LAYOUT = 'WORKING-ASSUMPTION-FIN-2026.1';

// ---- the connection ----------------------------------------------------------------------------------------------------------------------------------------------------

const column = (name: string, kind: string, required: boolean, values?: string[]) => ({ name, kind, required, ...(values === undefined ? {} : { values }) });

export const LAYOUTS = [
  { kind: 'PROJECT', connector_code: 'FIN_PROJECT_FILE', columns: [column('feed_project_code', 'code', true), column('project_name', 'text', true), column('project_status', 'enum', false, ['ACTIVE', 'SUSPENDED'])] },
  { kind: 'PLAN', connector_code: 'FIN_PLAN_FILE', columns: [column('feed_project_code', 'code', true), column('fund_code', 'enum', true, ['NSTW', 'NSDP'])] },
  { kind: 'DISBURSEMENT', connector_code: 'FIN_DISBURSEMENT_FILE', columns: [column('feed_project_code', 'code', true), column('disbursed_month', 'money', true)] },
  { kind: 'MILESTONE', connector_code: 'FIN_MILESTONE_FILE', columns: [column('feed_project_code', 'code', true), column('milestone_kind', 'enum', true)] },
];

export const PENDING = [
  ...(['PROJECT', 'PLAN', 'DISBURSEMENT', 'MILESTONE'] as const).map((kind) => ({ code: `FEED_SAMPLE_${kind}`, what: `Official sample of ${kind}`, owner: 'Finance Department', working_assumption: `Layout ${kind}`, switches_when_it_arrives: `The ${kind} layout` })),
  { code: 'FEED_API_SPECIFICATION', what: 'Push interface', owner: 'Finance Department', working_assumption: 'None', switches_when_it_arrives: 'Adapter is written' },
  { code: 'FEED_MACHINE_ACCOUNT', what: 'Machine account', owner: 'Integration lane', working_assumption: 'None', switches_when_it_arrives: 'Push works' },
  { code: 'FEED_LEGAL_THRESHOLDS', what: 'Thresholds', owner: 'Customer finance staff', working_assumption: 'Defaults', switches_when_it_arrives: 'Own rule' },
];

export const rule = (over: Record<string, unknown> = {}) => ({
  source: 'DEFAULT',
  version: 0,
  unverified: true,
  legal_status: 'UNVERIFIED',
  formula: 'Độ tuổi = bây giờ − lúc áp dụng lần nhận gần nhất',
  source_text: 'Dòng nhận gần nhất của sổ các lần nhận',
  as_of: '2026-11-08',
  warn_after_hours: 48,
  max_age_hours: 96,
  stale_severity: 'WATCH',
  figures_blocked_when_stale: false,
  ...over,
});

export const policy = (over: Record<string, unknown> = {}) => ({
  source: 'DEFAULT',
  version: 0,
  unverified: true,
  legal_status: 'UNVERIFIED',
  formula: 'Ngưỡng của quy tắc đối chiếu',
  source_text: 'Quy tắc FINANCE_FEED_POLICY mặc định',
  as_of: '2026-11-08',
  tolerance_pct: 0.5,
  large_discrepancy_pct: 5,
  report_due_days: 5,
  difference_due_days: 7,
  ...over,
});

export const health = (over: Record<string, unknown> = {}) => ({
  status: 'FRESH',
  age_hours: 12.5,
  last_run_at: '2026-11-07T14:30:00.000Z',
  last_run_channel: 'FILE',
  alert: null,
  figures_blocked: false,
  rule: rule(),
  policy: policy(),
  ...over,
});

export const staleHealth = (over: Record<string, unknown> = {}) => health({ status: 'STALE', age_hours: 130, last_run_at: '2026-11-02T14:30:00.000Z', alert: { code: 'FEED_STALE', severity: 'WATCH' }, ...over });
export const neverHealth = (over: Record<string, unknown> = {}) => health({ status: 'NEVER_RECEIVED', age_hours: null, last_run_at: null, last_run_channel: null, alert: null, ...over });

export const indicator = (code: string, pct: string | null, numerator: number, denominator: number) => ({ code, pct, numerator, denominator, as_of: '2026-11-08' });

const unit = (code: string, status: string, over: Record<string, unknown> = {}) => ({ investor_code: code, investor_name: `Chủ đầu tư ${code}`, status, reported_on: null, due_on: '2026-11-05', projects: 4, ...over });

export const quality = (over: Record<string, unknown> = {}) => ({
  fiscal_year: 2026,
  month: 10,
  due_on: '2026-11-05',
  indicators: [indicator('FEED_COMPLETENESS', '90', 18, 20), indicator('FEED_TIMELINESS', '77.78', 14, 18), indicator('FEED_DISCREPANCY_RATE', '2.5', 3, 120)],
  units: [unit('CDT-1', 'REPORTED_ON_TIME'), unit('CDT-2', 'LATE'), unit('CDT-3', 'LATE')],
  late_units: [unit('CDT-2', 'LATE'), unit('CDT-3', 'LATE')],
  findings: [{ code: 'OVER_PLAN', channel: 'FILE', feed_project_code: 'FIN-0001', fund_code: 'NSTW', month: 9, expected: '1000', actual: '1200', message: 'Vượt kế hoạch' }],
  findings_total: 1,
  as_of: AS_OF,
  ...over,
});

export const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: runId(n),
  channel: 'FILE',
  kind: 'DISBURSEMENT',
  action: 'APPLY',
  layout_version: LAYOUT,
  acceptance: 'PENDING_EXTERNAL',
  file_sha256: String(n).repeat(64).slice(0, 64),
  file_import_id: uuid('0071', n),
  seed: null,
  epoch: null,
  parameters: null,
  counts: { total: 40, written: 30, skipped: 8, rejected: 2 },
  as_of_latest: '2026-10-31',
  digest: null,
  imported_by: OTHER,
  imported_by_name: 'Lê Thị Hoa',
  created_at: '2026-11-07T01:00:00.000Z',
  ...over,
});

export const generatorRun = (n: number, over: Record<string, unknown> = {}) =>
  run(n, { channel: 'GENERATOR', kind: null, action: 'GENERATOR_START', file_sha256: null, file_import_id: null, seed: 57, epoch: 2, parameters: { seed: 57 }, digest: 'd'.repeat(64), counts: { total: 600, written: 600, skipped: 0, rejected: 0 }, ...over });

export const GENERATOR_PARAMS = { seed: 57, fiscal_year: 2026, current_month: 10, project_count: 120, late_units: 3, delayed_pct: 22, ahead_pct: 12, discrepancies: 6, anchor_count: 0 };

export function connection(over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) {
  return {
    connector_code: 'fin.sotaichinh',
    registered: true,
    enabled: true,
    state_reason: 'Bắt đầu nhận số liệu thử',
    state_changed_at: '2026-11-05T02:30:00.000Z',
    state_changed_by_name: 'Nguyễn Văn An',
    layout_version: LAYOUT,
    supported_layouts: [LAYOUT],
    acceptance: 'PENDING_EXTERNAL',
    version: 7,
    channels: [
      { channel: 'FILE', adapter_status: 'PROPOSED', opens_network: false },
      { channel: 'API_PUSH', adapter_status: 'MISSING', opens_network: false, reason: 'MACHINE_ACCOUNT_PENDING' },
      { channel: 'GENERATOR', adapter_status: 'MOCK', opens_network: false },
    ],
    health: health(),
    pending_external: PENDING,
    positions: ['PROJECT', 'PLAN', 'DISBURSEMENT', 'MILESTONE'].map((kind) => ({ kind, connector_code: `FIN_${kind}_FILE`, cursor_status: kind === 'PLAN' ? 'FAILED' : kind === 'MILESTONE' ? null : 'ACTIVE', last_success_at: kind === 'PROJECT' ? '2026-11-07T01:00:00.000Z' : null, last_error_code: kind === 'PLAN' ? 'IMPORT_SCHEMA_INVALID' : null, last_file_sha256: null })),
    layouts: LAYOUTS,
    generator: { state: 'STOPPED', epoch: 0, parameters: null },
    last_runs: [run(1), generatorRun(2)],
    record_counts: { PROJECT: 120, PLAN: 240, DISBURSEMENT: 900, MILESTONE: 35 },
    mapping_counts: { PROPOSED: 2, ACTIVE: 40, REJECTED: 1, RETIRED: 0 },
    difference_counts: { open: 3, open_large: 1, resolved: 5 },
    quality: quality(),
    alerts: [
      { code: 'FEED_UNIT_LATE', severity: 'WATCH', subject: 'CDT-2' },
      { code: 'FEED_DISCREPANCY_LARGE', severity: 'ACTION', subject: 'FIN-0001|2026|DISBURSED_VS_DIS' },
    ],
    history: [
      { id: uuid('0050', 1), action: 'GENERATOR_STARTED', reason: 'Khởi động để kiểm tra luồng', detail: null, actor_name: 'Nguyễn Văn An', version: 7, occurred_at: '2026-11-05T02:30:00.000Z' },
      { id: uuid('0050', 2), action: 'ENABLED', reason: 'Bắt đầu nhận số liệu thử', detail: null, actor_name: 'Nguyễn Văn An', version: 6, occurred_at: '2026-11-05T02:00:00.000Z' },
      { id: uuid('0050', 3), action: 'CREATED', reason: null, detail: null, actor_name: null, version: 1, occurred_at: '2026-10-01T02:30:00.000Z' },
    ],
    actions: { set_state: true, control_generator: true, preview: true, apply: true, propose_mapping: true, decide_mapping: true, reconcile: true, resolve: true, ...actions },
    as_of: AS_OF,
    ...over,
  };
}

/** A tenant that never used the connection: nothing is registered, the health says never received. */
export const unusedConnection = (over: Record<string, unknown> = {}) =>
  connection(
    {
      registered: false,
      enabled: false,
      state_reason: null,
      state_changed_at: null,
      state_changed_by_name: null,
      version: 0,
      health: neverHealth(),
      positions: ['PROJECT', 'PLAN', 'DISBURSEMENT', 'MILESTONE'].map((kind) => ({ kind, connector_code: `FIN_${kind}_FILE`, cursor_status: null, last_success_at: null, last_error_code: null, last_file_sha256: null })),
      last_runs: [],
      record_counts: { PROJECT: 0, PLAN: 0, DISBURSEMENT: 0, MILESTONE: 0 },
      mapping_counts: { PROPOSED: 0, ACTIVE: 0, REJECTED: 0, RETIRED: 0 },
      difference_counts: { open: 0, open_large: 0, resolved: 0 },
      quality: quality({ indicators: [indicator('FEED_COMPLETENESS', null, 0, 0), indicator('FEED_TIMELINESS', null, 0, 0), indicator('FEED_DISCREPANCY_RATE', null, 0, 0)], units: [], late_units: [], findings: [], findings_total: 0 }),
      alerts: [],
      history: [],
      ...over,
    },
    {},
  );

// ---- mappings, unmapped codes, differences -----------------------------------------------------------------------------------------------------------------------------

export const mapping = (n: number, over: Record<string, unknown> = {}) => ({
  id: mappingId(n),
  our_code: `DA-${n}`,
  our_name: `Dự án số ${n}`,
  external_code: `FIN-${String(n).padStart(4, '0')}`,
  match_method: 'MANUAL',
  valid_from: '2026-01-01',
  valid_until: null,
  status: 'PROPOSED',
  proposed_by: OTHER,
  proposed_by_name: 'Lê Thị Hoa',
  proposal_reason: 'Trùng tên và vốn',
  import_id: null,
  approved_by_name: null,
  approved_at: null,
  decision_reason: null,
  retired_by_name: null,
  retired_at: null,
  retire_reason: null,
  version: 3,
  created_at: '2026-11-06T02:00:00.000Z',
  can_decide: true,
  can_retire: false,
  ...over,
});

export const activeMapping = (n: number, over: Record<string, unknown> = {}) => mapping(n, { status: 'ACTIVE', approved_by_name: 'Nguyễn Văn An', approved_at: '2026-11-07T02:00:00.000Z', decision_reason: 'Đã đối chiếu hồ sơ', can_decide: false, can_retire: true, ...over });

export const unmapped = (n: number, over: Record<string, unknown> = {}) => ({ feed_project_code: `FIN-90${n}`, project_name: `Dự án mới ${n}`, investor_code: 'CDT-1', our_code_hint: n === 1 ? 'DA-HINT' : null, as_of_statement: '2026-10-31', ...over });

export const difference = (n: number, over: Record<string, unknown> = {}) => ({
  id: differenceId(n),
  feed_project_code: `FIN-${String(n).padStart(4, '0')}`,
  our_code: `DA-${n}`,
  fiscal_year: 2026,
  field: 'DISBURSED_VS_DIS',
  kind: 'VALUE_MISMATCH',
  feed_value: '1500000000',
  our_value: '1200000000',
  delta: '300000000',
  delta_pct: '25',
  large: true,
  state: 'OPEN',
  owner_id: OTHER,
  owner_name: 'Lê Thị Hoa',
  opened_at: '2026-11-06T02:00:00.000Z',
  due_at: '2026-11-13T02:00:00.000Z',
  resolution: null,
  version: 2,
  can_resolve: true,
  ...over,
});

export const resolvedDifference = (n: number, over: Record<string, unknown> = {}) =>
  difference(n, { state: 'RESOLVED', can_resolve: false, large: false, resolution: { kind: 'DISPUTE', resolved_by_name: 'Nguyễn Văn An', resolved_at: '2026-11-07T03:00:00.000Z', reason: 'Số của Sở chưa tính đợt hai', evidence_ref: 'CV-123/STC', review_on: null }, ...over });

// ---- files ------------------------------------------------------------------------------------------------------------------------------------------------------------

export const UPLOADED = { file_object_key: KEY, file_sha256: SHA, size_bytes: 2048, format: 'CSV', columns: ['feed_project_code', 'disbursed_month'], row_count: 6, matching_kinds: ['DISBURSEMENT'] };

export const previewRow = (line: number, over: Record<string, unknown> = {}) => ({ line, business_key: `FIN-000${line}`, status: 'VALID', code: null, field: null, outcome: 'RECORD', preview: null, ...over });

export const PREVIEW = {
  operation_id: 'o',
  status: 'DRY_RUN',
  resource_version: 0,
  mode: 'DRY_RUN',
  kind: 'DISBURSEMENT',
  layout_version: LAYOUT,
  acceptance: 'PENDING_EXTERNAL',
  file_sha256: SHA,
  already_applied: false,
  connection_enabled: true,
  counts: { total: 6, valid: 3, errors: 1, duplicate: 1, conflict: 1 },
  rows: [
    previewRow(1),
    previewRow(2, { outcome: 'RECORD_AND_DIFFERENCE' }),
    previewRow(3, { outcome: 'RECORD_AND_PROPOSE' }),
    previewRow(4, { status: 'ERROR', code: 'MONEY_INVALID', field: 'disbursed_month', outcome: null, preview: { feed_project_code: 'FIN-0004', disbursed_month: '12x' } }),
    previewRow(5, { status: 'DUPLICATE', code: null, outcome: null }),
    previewRow(6, { status: 'CONFLICT', code: 'WEIRD_CODE', outcome: null }),
  ],
  rows_truncated: false,
};

export const rowError = (line: number, over: Record<string, unknown> = {}) => ({ line, business_key: `FIN-000${line}`, code: 'MONEY_INVALID', field: 'disbursed_month', preview: { feed_project_code: `FIN-000${line}`, disbursed_month: '12x' }, ...over });

export const APPLIED = {
  operation_id: 'o',
  status: 'APPLIED',
  resource_version: 1,
  resource_id: runId(9),
  mode: 'APPLY',
  kind: 'DISBURSEMENT',
  layout_version: LAYOUT,
  acceptance: 'PENDING_EXTERNAL',
  file_sha256: SHA,
  counts: { total: 6, applied: 3, duplicate: 1, conflict: 1, quarantined: 1, differences_opened: 2 },
  mappings_proposed: 2,
  errors: [rowError(4)],
  errors_truncated: false,
};

export const detail = (n: number, over: Record<string, unknown> = {}) => ({ run: run(n), errors: [rowError(4), rowError(7, { code: null })], errors_truncated: false, as_of: AS_OF, ...over });

// ---- the world and the client -----------------------------------------------------------------------------------------------------------------------------------------

export interface World {
  connection: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  details: Record<string, Record<string, unknown>>;
  mappings: Array<Record<string, unknown>>;
  unmapped: { items: Array<Record<string, unknown>>; total?: number };
  differences: Array<Record<string, unknown>>;
  /** Items per page of every list. */
  pageSize: number;
  /** Reads that fail, by operation. */
  failing: Map<string, Error>;
  /** Reads that never answer, by operation. */
  hanging: Set<string>;
}

export function world(over: Partial<World> = {}): World {
  return {
    connection: connection(),
    runs: [run(1), generatorRun(2), run(3, { kind: 'PLAN' })],
    details: { [runId(1)]: detail(1), [runId(2)]: detail(2, { errors: [], run: generatorRun(2) }), [runId(3)]: detail(3, { run: run(3, { kind: 'PLAN' }) }) },
    mappings: [mapping(1), activeMapping(2), mapping(3, { status: 'REJECTED', can_decide: false, approved_by_name: 'Nguyễn Văn An', approved_at: '2026-11-07T02:00:00.000Z', decision_reason: 'Sai dự án' })],
    unmapped: { items: [unmapped(1), unmapped(2)] },
    differences: [difference(1), difference(2, { large: false, delta: '-5000', delta_pct: '0.6', due_at: '2026-11-01T02:00:00.000Z' }), resolvedDifference(3)],
    pageSize: 20,
    failing: new Map(),
    hanging: new Set(),
    ...over,
  };
}

const queryOf = (input: unknown): Record<string, string | number | undefined> => (input as { query?: Record<string, string | number | undefined> } | undefined)?.query ?? {};

const page = <T,>(all: T[], query: Record<string, string | number | undefined>, size: number): { items: T[]; next_cursor: string | null } => {
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  return { items: all.slice(start, start + size), next_cursor: start + size < all.length ? String(start + size) : null };
};

/** A client over `state`: every read is answered from it (filtered and paged the way the server does), `command` answers the commands, `upload` the file upload. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    const query = queryOf(input);
    switch (operation) {
      case 'getFinanceFeedConnection':
        return state.connection;
      case 'listFinanceFeedRuns': {
        const all = state.runs.filter((one) => (query.channel === undefined || one.channel === query.channel) && (query.kind === undefined || one.kind === query.kind));
        return { ...page(all, query, state.pageSize), as_of: AS_OF };
      }
      case 'getFinanceFeedRun': {
        const id = (input as { path?: { id?: string } } | undefined)?.path?.id ?? '';
        return state.details[id] ?? problem('RESOURCE_NOT_FOUND', 404);
      }
      case 'listFinanceFeedMappings': {
        const all = state.mappings.filter((one) => (query.status === undefined || one.status === query.status) && (query.q === undefined || String(one.external_code).includes(String(query.q)) || String(one.our_code).includes(String(query.q))));
        const counts = { PROPOSED: 0, ACTIVE: 0, REJECTED: 0, RETIRED: 0 } as Record<string, number>;
        for (const one of state.mappings) counts[String(one.status)] = (counts[String(one.status)] ?? 0) + 1;
        return { ...page(all, query, state.pageSize), counts, source_system: 'FIN_SOTAICHINH', as_of: AS_OF };
      }
      case 'listFinanceFeedUnmapped':
        return { items: state.unmapped.items, total: state.unmapped.total ?? state.unmapped.items.length, as_of: AS_OF };
      case 'listFinanceFeedDifferences': {
        const all = state.differences.filter(
          (one) =>
            (query.state === undefined || one.state === query.state) &&
            (query.large === undefined || String(one.large) === String(query.large)) &&
            (query.fiscal_year === undefined || one.fiscal_year === Number(query.fiscal_year)) &&
            (query.q === undefined || String(one.feed_project_code).includes(String(query.q))),
        );
        const open = state.differences.filter((one) => one.state === 'OPEN');
        return { ...page(all, query, state.pageSize), counts: { open: open.length, open_large: open.filter((one) => one.large === true).length, resolved: state.differences.length - open.length, figures_compared: 120 }, as_of: AS_OF };
      }
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  const read = h.client.read as unknown as (operation: string, input?: unknown) => Promise<unknown>;
  const answered = vi.fn((operation: string, input?: unknown) => (state.hanging.has(operation) ? new Promise<unknown>(() => undefined) : read(operation, input)));
  (h.client as unknown as { read: unknown }).read = answered;
  return { ...h, client: h.client, read: answered };
}

export interface MountOptions {
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
  upload?: () => unknown;
}

/** Mounts a screen in a session; the upload of the client answers `options.upload` (a value, or an Error to throw). The rights of the person come from the connection (`actions`), as on the real screens. */
export function mountScreen(screenElement: ReactElement, h: Harness, options: MountOptions = {}): RenderResult & { queries: QueryClient; upload: ReturnType<typeof vi.fn> } {
  const upload = vi.fn(async () => {
    const result = options.upload?.() ?? UPLOADED;
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = upload;
  const mounted = baseMount(screenElement, h, { permissions: ['fin.feed.read'], ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.path === undefined ? {} : { path: options.path }) });
  return { ...mounted, upload };
}
