import { ApiError } from '@machvon/api-client';
import type { ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { TENANT, mount as bidMount, routeOf } from '../test-support';
import type { SessionOptions } from '../test-support';

export type { Harness };

export const READER = ['bid.read'];
export const MAPPER = ['bid.read', 'bid.egp.map'];
export const ME = TENANT.membershipId;
export const AS_OF = '2026-11-12T03:00:00.000Z';
export const route = routeOf('BID-23', 'FR-BID-23');

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const mappingId = (n: number): string => uuid('00e0', n);
export const packageId = (n: number): string => uuid('0020', n);
export const OTHER = uuid('00b0', 7);
export const IMPORT_ID = uuid('00d0', 1);

export const problem = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

/** An ACTIVE mapping of a package, typed by hand, by someone else, that the caller may retire. */
export const mapping = (n: number, over: Record<string, unknown> = {}) => ({
  id: mappingId(n),
  subject_type: 'PACKAGE',
  our_code: `GT-${n}`,
  project_code: null,
  external_type: 'EGP_PACKAGE',
  external_code: `IB2600${n}`,
  match_method: 'MANUAL',
  confidence: null,
  valid_from: '2026-10-01',
  valid_until: null,
  status: 'ACTIVE',
  proposed_by: OTHER,
  proposed_by_name: 'Nguyễn Văn An',
  proposal_reason: 'Khớp theo thông báo mời thầu',
  import_id: null,
  approved_by_name: 'Trần Thị Bình',
  approved_at: '2026-10-02T03:00:00.000Z',
  decision_reason: null,
  retired_by_name: null,
  retired_at: null,
  retire_reason: null,
  version: 3,
  created_at: '2026-10-01T02:00:00.000Z',
  can_decide: false,
  can_retire: true,
  ...over,
});

/** A mapping waiting for a decision, that the caller (not its proposer) may approve or reject. */
export const proposed = (n: number, over: Record<string, unknown> = {}) =>
  mapping(n, { status: 'PROPOSED', approved_by_name: null, approved_at: null, can_decide: true, can_retire: false, version: 1, ...over });

export interface Suggestions {
  items: Array<Record<string, unknown>>;
  threshold: number;
  formula: string;
  source: string;
  legal_status: string;
  as_of: string;
}

export const suggestions = (over: Partial<Suggestions> = {}): Suggestions => ({
  items: [
    {
      external_code: 'IB2600900',
      imported_name: 'Xây dựng cầu qua sông Gâm',
      imported_price_vnd: '128400000000',
      plan_code: 'PL2600001',
      import_id: IMPORT_ID,
      candidates: [{ package_id: packageId(1), code: 'GT-9', name: 'Xây dựng cầu qua sông Gâm giai đoạn 1', budget_vnd: '128400000000', confidence: 0.857 }],
    },
  ],
  threshold: 0.8,
  formula: 'Jaccard của các từ của hai tên',
  source: 'Tệp KHLCNT đã nhập và ngân sách gói thầu',
  legal_status: 'UNVERIFIED',
  as_of: AS_OF,
  ...over,
});

export interface World {
  mappings: Array<Record<string, unknown>>;
  /** The server cuts a page here whatever the limit asked for (the screen asks for 50). */
  pageSize?: number;
  suggestions: Suggestions;
  /** Reads that fail, by operation, with the error they fail with. */
  failing: Map<string, Error>;
  /** The list never answers (the loading state). */
  hold?: boolean;
}

export function world(over: Partial<World> = {}): World {
  return { mappings: [mapping(1), proposed(2)], suggestions: suggestions(), failing: new Map(), ...over };
}

const STATUSES = ['PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED'] as const;

/** A client over `state`: the list is filtered, counted and cut into pages as the server does it; `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    if (operation === 'listEgpMappingSuggestions') return state.suggestions;
    if (state.hold === true) return new Promise(() => undefined);
    if (operation !== 'listEgpMappings') return new Error(`unexpected read ${operation}`);
    const query = ((input as { query?: Record<string, string | number> } | undefined)?.query ?? {}) as Record<string, string | number>;
    const needle = typeof query.q === 'string' ? query.q.toLowerCase() : '';
    const scoped = state.mappings.filter((row) => (query.subject_type === undefined || row.subject_type === query.subject_type) && (needle === '' || `${String(row.our_code)} ${String(row.external_code)}`.toLowerCase().includes(needle)));
    const shown = scoped.filter((row) => query.status === undefined || row.status === query.status);
    const from = query.cursor === undefined ? 0 : Number(query.cursor);
    const size = Math.min(state.pageSize ?? Number(query.limit ?? 50), Number(query.limit ?? 50));
    const items = shown.slice(from, from + size);
    return {
      items,
      next_cursor: from + size < shown.length ? String(from + size) : null,
      counts: Object.fromEntries(STATUSES.map((status) => [status, scoped.filter((row) => row.status === status).length])),
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
