import { ApiError } from '@machvon/api-client';
import type { ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
import { harness as baseHarness } from '../../../sas/test-support';
import type { Harness } from '../../../sas/test-support';
import { TENANT, mount as bidMount, routeOf } from '../../test-support';
import type { SessionOptions } from '../../test-support';

export type { Harness };

export const READER = ['bid.read'];
export const RECONCILER = ['bid.read', 'bid.egp.reconcile'];
export const ME = TENANT.membershipId;
export const AS_OF = '2026-11-12T03:00:00.000Z';
export const route = routeOf('BID-33', 'FR-BID-33');

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const itemId = (n: number): string => uuid('00f0', n);
export const subjectId = (n: number): string => uuid('0030', n);
export const OTHER = uuid('00b0', 7);

export const problem = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

/** An open difference of the price of a package, owned by the caller, that the caller may settle. */
export const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: itemId(n),
  subject_type: 'PACKAGE',
  subject_id: subjectId(n),
  subject_code: `GT-${n}`,
  external_code: `IB2600${n}`,
  field: 'estimated_price',
  difference_kind: 'VALUE_MISMATCH',
  ours: '1000000000',
  theirs: '1200000000',
  delta: '200000000',
  state: 'OPEN',
  owner_id: ME,
  owner_name: 'Lê Văn Cường',
  opened_at: '2026-11-02T03:00:00.000Z',
  due_at: '2026-11-20T10:00:00.000Z',
  overdue: false,
  source_import_id: null,
  resolution: null,
  version: 1,
  is_maker: false,
  actions: { resolve: true },
  ...over,
});

/** A difference that the caller made the record of: the person who made it never settles it. */
export const madeByMe = (n: number, over: Record<string, unknown> = {}) => item(n, { is_maker: true, actions: { resolve: false }, ...over });

export const overdueItem = (n: number, over: Record<string, unknown> = {}) => item(n, { overdue: true, due_at: '2026-11-05T10:00:00.000Z', ...over });

/** A settled difference: disputed with a letter, by someone else. */
export const settled = (n: number, over: Record<string, unknown> = {}) =>
  item(n, {
    state: 'RESOLVED',
    version: 2,
    actions: { resolve: false },
    resolution: { kind: 'DISPUTE', resolved_by_name: 'Nguyễn Văn An', resolved_at: '2026-11-04T03:00:00.000Z', reason: 'Số trên mạng sai so với quyết định phê duyệt', evidence_ref: 'CV-77/SKHDT', review_on: null, follow_up: 'ESCALATE_TO_OPERATOR' },
    ...over,
  });

export const noticeItem = (n: number, over: Record<string, unknown> = {}) =>
  item(n, { subject_type: 'NOTICE', field: 'bid_closing_at', ours: '2026-10-23T08:00:00.000Z', theirs: '2026-10-25T03:00:00.000Z', delta: null, ...over });

export interface DueRule {
  days: number;
  version: number;
  source: string;
  unverified: boolean;
  legal_status: string;
  formula: string;
  source_text: string;
  as_of: string;
}

export interface World {
  items: Array<Record<string, unknown>>;
  /** The server cuts a page here whatever the limit asked for (the screen asks for 50). */
  pageSize?: number;
  dueRule: DueRule;
  canRun: boolean;
  /** Reads that fail, by operation, with the error they fail with. */
  failing: Map<string, Error>;
  /** The list never answers (the loading state). */
  hold?: boolean;
}

export const dueRule = (over: Partial<DueRule> = {}): DueRule => ({
  days: 10,
  version: 0,
  source: 'DEFAULT',
  unverified: true,
  legal_status: 'UNVERIFIED',
  formula: 'Ngày mở cộng 10 ngày làm việc theo lịch đã công bố',
  source_text: 'Quy tắc EGP_RECONCILIATION_POLICY của hệ thống',
  as_of: '2026-11-08',
  ...over,
});

export function world(over: Partial<World> = {}): World {
  return { items: [item(1), settled(2)], dueRule: dueRule(), canRun: true, failing: new Map(), ...over };
}

/** A client over `state`: the list is filtered, counted and cut into pages as the server does it; `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    if (state.hold === true) return new Promise(() => undefined);
    if (operation !== 'listEgpReconciliationItems') return new Error(`unexpected read ${operation}`);
    const query = ((input as { query?: Record<string, string | number> } | undefined)?.query ?? {}) as Record<string, string | number>;
    const scoped = state.items.filter((row) => query.subject_type === undefined || row.subject_type === query.subject_type);
    const shown = scoped.filter((row) => (query.state === undefined || row.state === query.state) && (query.mine !== 'true' || row.owner_id === ME) && (query.overdue !== 'true' || (row.state === 'OPEN' && row.overdue === true)));
    const from = query.cursor === undefined ? 0 : Number(query.cursor);
    const size = Math.min(state.pageSize ?? Number(query.limit ?? 50), Number(query.limit ?? 50));
    const items = shown.slice(from, from + size);
    return {
      items,
      next_cursor: from + size < shown.length ? String(from + size) : null,
      counts: {
        open: scoped.filter((row) => row.state === 'OPEN').length,
        resolved: scoped.filter((row) => row.state === 'RESOLVED').length,
        overdue: scoped.filter((row) => row.state === 'OPEN' && row.overdue === true).length,
        by_resolution: { ACCEPT_EXTERNAL: 0, CORRECT_OURS: 0, DISPUTE: scoped.filter((row) => (row.resolution as { kind?: string } | null)?.kind === 'DISPUTE').length, WAIVE: 0 },
        waivers_due: 0,
      },
      due_rule: state.dueRule,
      formula: 'Chênh lệch = số trên mạng trừ số của đơn vị',
      source: 'Bản ghi egp_record của tệp đã nhập',
      acceptance: 'PENDING_EXTERNAL',
      actions: { run: state.canRun, resolve: true },
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
