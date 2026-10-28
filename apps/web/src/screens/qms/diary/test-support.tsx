import { vi } from 'vitest';
import { contractId, line as contractLine } from '../../ctr/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount } from '../../ctr/test-support';
export { routeOf } from '../inspection/test-support';
export type { Harness };

export const CONTRACTOR = ['site_diary.read', 'diary.write'];
export const SUPERVISOR = ['site_diary.read', 'diary.write'];
export const READER = ['site_diary.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const diaryId = (n: number): string => uuid('00d0', n);

export const signature = (role: string, name: string, overrides: Record<string, unknown> = {}) => ({
  role,
  signer_name: name,
  method: 'IN_APP_OTP',
  legal_effect: 'INTERNAL_RECORD',
  cert_serial: null,
  signed_at: '2026-10-25T02:30:00.000Z',
  valid: true,
  ...overrides,
});

const NONE = { revise: false, contractorSign: false, supervise: false, ownerConfirm: false, lock: false, correct: false };
export const actions = (on: Partial<Record<keyof typeof NONE, boolean>> = {}) => ({ ...NONE, ...on });

/** A diary as the list and the read by id answer it: a draft the caller may edit and sign, unless the test says otherwise. */
export const diary = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: diaryId(n),
  diary_no: `NK-HD-A-002-2026102${n}`,
  contract: { id: contractId(2), code: 'HD-A-002', status: 'ACTIVE' },
  record_date: `2026-10-2${n}`,
  status: 'DRAFT',
  content: { summary: `Đổ bê tông móng đợt ${n}`, weather_code: 'SUNNY', workforce_count: 12, notes: 'Không có sự cố' },
  weather_code: 'SUNNY',
  workforce_count: 12,
  supervisor_remark: null,
  owner_note: null,
  lock_reason: null,
  correction_of_id: null,
  correction_reason: null,
  author: { membership_id: uuid('00d1', 1), display_name: 'Nhà thầu An Phát' },
  signatures: [],
  signature_value: { cxn: 'CXN-EXE-05', awaiting_confirmation: true },
  signable_roles: ['CONTRACTOR'],
  actions: actions({ revise: true, contractorSign: true }),
  version: 2,
  ...overrides,
});

export interface World {
  contracts: Array<Record<string, unknown>>;
  diaries: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
  /** The size of a page of the list, to test paging. */
  page: number;
}

export function world(overrides: Partial<World> = {}): World {
  return { contracts: [contractLine(1), contractLine(2, { status: 'ACTIVE', title: null })], diaries: [], failing: new Set(), page: 50, ...overrides };
}

/** A client over `state`: the list and the read by id are answered from it, with the filter and the cursor applied, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_site_diary') {
      const query = (input as { query?: Record<string, string | number> } | undefined)?.query ?? {};
      const items = state.diaries.filter(
        (item) =>
          (query.contract_id === undefined || (item.contract as { id: string }).id === query.contract_id) &&
          (query.status === undefined || item.status === query.status) &&
          (query.from === undefined || (item.record_date as string) >= String(query.from)) &&
          (query.to === undefined || (item.record_date as string) <= String(query.to)),
      );
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const slice = items.slice(start, start + state.page);
      return { items: slice, ...(start + state.page < items.length ? { next_cursor: String(start + state.page) } : {}), as_of: '2026-10-25T03:00:00.000Z' };
    }
    if (operation === 'get_resources_site_diary_id') {
      const wanted = (input as { path: { id: string } }).path.id;
      return state.diaries.find((item) => item.id === wanted) ?? new Error('not found');
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_contract') return Promise.resolve(state.contracts);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}
