import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import vi_ from '../../../i18n/vi.json';
import part from '../../../i18n/vi.json';

export { mount } from '../../sas/test-support';
export type { Harness };

const catalogue = { ...(vi_ as Record<string, string>), ...(part as Record<string, string>) };
/** The Vietnamese text of a key, as the screen shows it (parameters filled), so a test compares with the catalogue and never with a copy of its words. */
export const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), catalogue[key] ?? key);

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const REQUEST = uuid(1);
export const CONTRACT = uuid(2);
export const EXCEPTION = uuid(3);

export const routeOf = (id: string, module: string) => ({
  id,
  path: `/${module.toLowerCase()}/${id.toLowerCase()}`,
  title: id,
  kind: 'table' as const,
  area: 'investment' as const,
  module,
  group: 'Kiểm soát tiền',
  role: 'workspace' as const,
  parent: null,
  req: `FR-${id}`,
});

export const finding = (code: string, kind: 'INVARIANT' | 'SIGNAL', params: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => ({
  id: uuid(100 + code.length + Object.keys(params).length),
  code,
  kind,
  severity: kind === 'INVARIANT' ? 'BLOCK' : 'WARN',
  excused: false,
  exception_id: null,
  subject: {},
  params,
  ...overrides,
});

export const run = (overrides: Record<string, unknown> = {}) => ({
  id: uuid(50),
  trigger: 'SUBMIT',
  outcome: 'BLOCKED',
  rule: { type: 'PAYMENT_INTEGRITY', code: 'DEFAULT', version: 0, source: 'DEFAULT', unverified: true, params: {}, formula: 'Chặn khi vượt trần', origin: 'G4-2 của lộ trình', as_of: '2026-11-08' },
  as_of: '2026-11-08',
  invariant_count: 1,
  signal_count: 0,
  excused_count: 0,
  unavailable: [],
  figures: {},
  created_by: uuid(9),
  created_at: '2026-11-08T03:00:00.000000Z',
  findings: [finding('EXCEEDS_PLAN', 'INVARIANT', { allocated_vnd: '1000', disbursed_vnd: '0', in_flight_vnd: '0', net_vnd: '2100000000', available_vnd: '1000000000', over_by_vnd: '1100000000' })],
  ...overrides,
});

export const exception = (overrides: Record<string, unknown> = {}) => ({
  id: EXCEPTION,
  payment_request_id: REQUEST,
  request_no: 'DNTT-001',
  contract_id: CONTRACT,
  contract_code: 'HD-001',
  ceiling: 'EXCEEDS_PLAN',
  allowed_amount_vnd: '1100000000',
  valid_to: '2026-11-20',
  reason: 'Chờ điều chỉnh kế hoạch vốn',
  status: 'REQUESTED',
  stored_status: 'REQUESTED',
  requested_by: uuid(9),
  requested_at: '2026-11-08T03:00:00.000000Z',
  decided_by: null,
  decided_at: null,
  decision_note: null,
  used_at: null,
  days_left: 12,
  version: 1,
  ...overrides,
});

export const checks = (overrides: Record<string, unknown> = {}) => ({ payment_request_id: REQUEST, request_status: 'DRAFT', run: run(), exceptions: [], as_of: '2026-11-08T03:05:00.000Z', ...overrides });

export interface World {
  checks: unknown;
  exceptions: unknown[];
  /** The pages of findings in the order they are asked for (the first has no cursor). */
  findingPages: Array<{ items: unknown[]; next_cursor: string | null }>;
  failing: Set<string>;
}
export const world = (overrides: Partial<World> = {}): World => ({ checks: checks(), exceptions: [exception()], findingPages: [{ items: [], next_cursor: null }], failing: new Set(), ...overrides });

/** A client over `state`: the checks, the register and the pages of findings are answered from it; `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: uuid(7), status: 'OK', resource_version: 2, resource_id: EXCEPTION })): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return state.failing.has('403') ? Object.assign(new Error('forbidden'), {}) : new Error(`${operation} failed`);
    if (operation === 'getPaymentIntegrityChecks') return state.checks;
    if (operation === 'listPaymentIntegrityFindings') {
      const cursor = (input as { query?: { cursor?: string } } | undefined)?.query?.cursor;
      const page = cursor === undefined ? 0 : Number(cursor);
      return { ...(state.findingPages[page] ?? { items: [], next_cursor: null }), as_of: '2026-11-08T03:05:00.000Z' };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: unknown) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation !== 'listDisbursementExceptions') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    const status = (input as { query?: { status?: string } } | undefined)?.query?.status;
    return Promise.resolve(state.exceptions.filter((item) => status === undefined || (item as { status: string }).status === status));
  });
  return h;
}

export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
