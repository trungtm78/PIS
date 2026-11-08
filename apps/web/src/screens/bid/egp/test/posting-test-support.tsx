import { ApiError } from '@machvon/api-client';
import type { ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
import { harness as baseHarness } from '../../../sas/test-support';
import type { Harness } from '../../../sas/test-support';
import { TENANT, mount as bidMount, routeOf } from '../../test-support';
import type { SessionOptions } from '../../test-support';

export type { Harness };

export const READER = ['bid.read'];
export const PREPARER = ['bid.read', 'bid.egp.post.prepare'];
export const SUBMITTER = ['bid.read', 'bid.egp.post.submit'];
export const BOTH = ['bid.read', 'bid.egp.post.prepare', 'bid.egp.post.submit'];
export const ME = TENANT.membershipId;
export const AS_OF = '2026-11-12T03:00:00.000Z';
export const route = routeOf('BID-32', 'FR-BID-32');

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const postingId = (n: number): string => uuid('00e5', n);
export const subjectId = (n: number): string => uuid('0040', n);
export const BATCH = uuid('00e6', 1);

export const problem = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

const ACTIONS_OFF = { prepare: false, submit: false, receipt: false, reject: false, cancel: false };

/** A duty of posting a notice that nothing was done for: the caller may prepare and cancel it. */
export const posting = (n: number, over: Record<string, unknown> = {}) => ({
  id: postingId(n),
  kind: 'NOTICE',
  obligation: 'Đăng thông báo mời thầu',
  subject_type: 'NOTICE',
  subject_id: subjectId(n),
  subject_code: `GT-${n}`,
  trigger_event: 'DECISION_APPROVED',
  triggered_at: '2026-11-04T17:00:00.000Z',
  due_at: '2026-11-19T10:00:00.000Z',
  remind_before_days: 2,
  rule_code: 'NOTICE',
  rule_version: 0,
  rule_source: 'DEFAULT',
  legal_status: 'UNVERIFIED',
  state: 'DUE',
  clock: { status: 'ON_TIME', ms_to_due: 400_000_000 },
  alert: null,
  severity: null,
  owner_id: ME,
  owner_name: 'Lê Văn Cường',
  prepared_by_name: null,
  prepared_at: null,
  submitted_by_name: null,
  submitted_at: null,
  rejected_at: null,
  rejection_reason: null,
  cancel_reason: null,
  receipt_ref: null,
  receipted_at: null,
  receipt_recorded_by_name: null,
  packet_sha256: null,
  packet: null,
  export_batch_id: null,
  export_batch_status: null,
  version: 1,
  created_at: '2026-11-05T02:00:00.000Z',
  actions: { ...ACTIONS_OFF, prepare: true, cancel: true },
  ...over,
});

const HASH = 'a'.repeat(64);

/** Prepared by someone else: the caller may post it (submit) or cancel it. */
export const prepared = (n: number, over: Record<string, unknown> = {}) =>
  posting(n, { state: 'PREPARED', prepared_by_name: 'Nguyễn Văn An', prepared_at: '2026-11-06T03:00:00.000Z', packet_sha256: HASH, version: 2, actions: { ...ACTIONS_OFF, submit: true, cancel: true }, ...over });

/** Posted, waiting for the receipt of the network. */
export const submitted = (n: number, over: Record<string, unknown> = {}) =>
  prepared(n, { state: 'SUBMITTED', submitted_by_name: 'Trần Thị Bình', submitted_at: '2025-11-07T03:00:00.000Z', clock: { status: 'MET', ms_to_due: null }, version: 3, actions: { ...ACTIONS_OFF, receipt: true, reject: true }, ...over });

export const receipted = (n: number, over: Record<string, unknown> = {}) =>
  submitted(n, { state: 'RECEIPTED', receipt_ref: `BN-2026-000${n}`, receipted_at: '2025-11-08T03:00:00.000Z', receipt_recorded_by_name: 'Trần Thị Bình', version: 4, actions: ACTIONS_OFF, ...over });

export const overdue = (n: number, over: Record<string, unknown> = {}) =>
  posting(n, { due_at: '2026-11-10T10:00:00.000Z', clock: { status: 'OVERDUE', ms_to_due: -90_000_000 }, alert: 'EGP_POSTING_OVERDUE', severity: 'URGENT', ...over });

export const dueSoon = (n: number, over: Record<string, unknown> = {}) =>
  posting(n, { due_at: '2026-11-13T10:00:00.000Z', clock: { status: 'DUE_SOON', ms_to_due: 80_000_000 }, alert: 'EGP_POSTING_DUE', severity: 'ACTION', ...over });

export const rejected = (n: number, over: Record<string, unknown> = {}) =>
  prepared(n, { state: 'REJECTED', rejection_reason: 'Thiếu ngày đóng thầu', rejected_at: '2026-11-07T05:00:00.000Z', packet_sha256: HASH, version: 4, actions: { ...ACTIONS_OFF, prepare: true, cancel: true }, ...over });

export interface Provenance {
  version: number;
  source: string;
  unverified: boolean;
  legal_status: string;
  formula: string;
  source_text: string;
  as_of: string;
}

export const severityRule = (over: Record<string, unknown> = {}) => ({
  urgent_within_hours: 24,
  version: 0,
  source: 'DEFAULT',
  unverified: true,
  legal_status: 'UNVERIFIED',
  formula: 'Khẩn khi còn không quá urgent_within_hours giờ',
  source_text: 'Quy tắc EGP_POSTING_SEVERITY của hệ thống',
  as_of: '2026-11-08',
  ...over,
});

export interface World {
  items: Array<Record<string, unknown>>;
  /** The server cuts a page here whatever the limit asked for (the screen asks for 50). */
  pageSize?: number;
  severity: Record<string, unknown>;
  actions: { sweep: boolean; open: boolean; prepare: boolean; submit: boolean };
  /** The detail the server gives for an id. */
  details: Map<string, Record<string, unknown>>;
  /** Reads that fail, by operation, with the error they fail with. */
  failing: Map<string, Error>;
  /** The list never answers (the loading state). */
  hold?: boolean;
}

export const detail = (row: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  obligation: row,
  history: [{ id: 'h1', action: 'OPENED', actor_name: 'Lê Văn Cường', reason: null, state_after: 'DUE', version: 1, occurred_at: '2026-11-05T02:00:00.000Z' }],
  required_fields: ['package_code', 'published_at', 'bid_closing_at'],
  suggested_fields: { package_code: 'GT-1' },
  deadline_rule: { version: 0, source: 'DEFAULT', unverified: true, legal_status: 'UNVERIFIED', formula: 'Ngày phát sinh cộng 5 ngày làm việc', source_text: 'Quy tắc EGP_POSTING_DEADLINES', as_of: '2026-11-08', params: { due_in: 5, due_unit: 'WORKING_DAYS' } },
  as_of: AS_OF,
  ...over,
});

export function world(over: Partial<World> = {}): World {
  const items = over.items ?? [posting(1), prepared(2)];
  return {
    items,
    severity: severityRule(),
    actions: { sweep: true, open: true, prepare: true, submit: true },
    details: new Map(items.map((row) => [row.id as string, detail(row)])),
    failing: new Map(),
    ...over,
  };
}

const STATES = ['DUE', 'PREPARED', 'SUBMITTED', 'RECEIPTED', 'REJECTED', 'CANCELLED'] as const;
const OPEN = ['DUE', 'PREPARED', 'REJECTED'];

/** A client over `state`: the list is filtered, counted and cut into pages as the server does it; `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    if (state.hold === true) return new Promise(() => undefined);
    if (operation === 'getEgpObligation') {
      const id = (input as { path: { id: string } }).path.id;
      return state.details.get(id) ?? problem('RESOURCE_NOT_FOUND', 404);
    }
    if (operation !== 'listEgpObligations') return new Error(`unexpected read ${operation}`);
    const query = ((input as { query?: Record<string, string | number> } | undefined)?.query ?? {}) as Record<string, string | number>;
    const group = query.group;
    const shown = state.items.filter((row) => {
      const rowState = row.state as string;
      const clock = (row.clock as { status: string }).status;
      if (group === 'OPEN' && !OPEN.includes(rowState)) return false;
      if (group === 'SUBMITTED' && rowState !== 'SUBMITTED') return false;
      if (group === 'CLOSED' && !['RECEIPTED', 'CANCELLED'].includes(rowState)) return false;
      if (query.kind !== undefined && row.kind !== query.kind) return false;
      if (query.clock === 'OVERDUE' && !(OPEN.includes(rowState) && clock === 'OVERDUE')) return false;
      if (query.clock === 'DUE_SOON' && !(OPEN.includes(rowState) && clock === 'DUE_SOON')) return false;
      return query.mine !== 'true' || row.owner_id === ME;
    });
    const from = query.cursor === undefined ? 0 : Number(query.cursor);
    const size = Math.min(state.pageSize ?? Number(query.limit ?? 50), Number(query.limit ?? 50));
    const byState = Object.fromEntries(STATES.map((one) => [one, state.items.filter((row) => row.state === one).length]));
    const clockOf = (row: Record<string, unknown>): string => (row.clock as { status: string }).status;
    const met = state.items.filter((row) => clockOf(row) === 'MET').length;
    const metLate = state.items.filter((row) => clockOf(row) === 'MET_LATE').length;
    const late = state.items.filter((row) => OPEN.includes(row.state as string) && clockOf(row) === 'OVERDUE').length;
    const judged = met + metLate + late;
    return {
      items: shown.slice(from, from + size),
      next_cursor: from + size < shown.length ? String(from + size) : null,
      counts: { total: state.items.length, by_state: byState, overdue: late, due_soon: state.items.filter((row) => OPEN.includes(row.state as string) && clockOf(row) === 'DUE_SOON').length, met, met_late: metLate },
      on_time: { met, met_late: metLate, overdue: late, rate_bp: judged === 0 ? null : Math.floor((met * 10_000) / judged), formula: 'Tỷ lệ = đúng hạn / (đúng hạn + muộn + quá hạn)', source: 'Bảng egp_posting_obligation' },
      severity_rule: state.severity,
      acceptance: 'PENDING_EXTERNAL',
      adapter_status: 'PROPOSED',
      actions: state.actions,
      as_of: AS_OF,
    };
  }, command);
}

/** Shows the address, so that a test can read what the screen put in it. */
export function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.search}</output>;
}

export function mount(screen: ReactElement, h: Harness, options: SessionOptions): ReturnType<typeof bidMount> {
  return bidMount(
    <>
      {screen}
      <Where />
    </>,
    h,
    options,
  );
}
