import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { contractId, line as contractLine, mount } from '../../ctr/test-support';

export { contractId, mount };
export type { Harness };

export const ACCOUNTANT = ['advance.read', 'advance.recover', 'advance.cancel', 'contract.read'];
export const READER = ['advance.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const advanceId = (n: number): string => uuid('00b0', n);
export const partyId = (n: number): string => uuid('00b1', n);
export const EVIDENCE = uuid('00c0', 1);

export const routeOf = (id: string, module: string, req: string) => ({
  id,
  path: `/${module.toLowerCase()}/${id.toLowerCase()}`,
  title: id,
  kind: 'table' as const,
  area: 'investment' as const,
  module,
  group: 'Tạm ứng',
  role: 'workspace' as const,
  parent: null,
  req,
});

/** An advance as the read answers it: a land clearance advance of 2bn paid to the sole member, 750m of it recovered, owed past its deadline. */
export const advance = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: advanceId(n),
  status: 'RECOVERING',
  contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE', value_vnd: '10000000000', advance_category: 'CONSTRUCTION' },
  project_id: uuid('0010', 1),
  party: { id: partyId(1), role: 'LEAD', name: 'Nhà thầu A', work_value_vnd: '6000000000' },
  tranche_no: n,
  kind: 'GPMB',
  amount_vnd: '2000000000',
  cap_vnd: '2000000000',
  cap_pct: '20',
  cap_rule_version_id: uuid('00d0', 1),
  cap_rule_awaiting_confirmation: true,
  cap_rule_cxn: 'CXN-02',
  guarantee_id: null,
  allocation_line_id: uuid('0040', 1),
  paid_vnd: '2000000000',
  recovered_vnd: '750000000',
  outstanding_vnd: '1250000000',
  paid_on: '2026-07-01',
  recovery_threshold_pct: '80',
  recovery_deadline: '2026-07-31',
  overdue_since: null,
  overdue_days: 12,
  last_alert_level: 0,
  created_at: '2026-10-25T01:00:00.000Z',
  updated_at: '2026-10-25T01:00:00.000Z',
  actions: { cancel: false, record_recovery: true },
  version: 4,
  ...overrides,
});

/** The plan of the recovery of an advance: the member has asked to be paid 2.4bn of an 80 percent threshold of 4.8bn. */
export const plan = (n: number, overrides: Record<string, unknown> = {}, advanceOverrides: Record<string, unknown> = {}) => ({
  advance: advance(n, advanceOverrides),
  threshold_value_vnd: '4800000000',
  gross_to_date_vnd: '2400000000',
  remaining_to_threshold_vnd: '2400000000',
  target_recovered_vnd: '1000000000',
  recovered_vnd: '750000000',
  outstanding_vnd: '1250000000',
  behind_vnd: '250000000',
  milestones: [
    { at_pct: 25, at_gross_vnd: '1200000000', recovered_vnd: '500000000' },
    { at_pct: 50, at_gross_vnd: '2400000000', recovered_vnd: '1000000000' },
    { at_pct: 75, at_gross_vnd: '3600000000', recovered_vnd: '1500000000' },
    { at_pct: 100, at_gross_vnd: '4800000000', recovered_vnd: '2000000000' },
  ],
  warnings: [{ code: 'RULE_AWAITING_CONFIRMATION', detail: { cxn: 'CXN-02' } }],
  ...overrides,
});

/** What a command answers. */
export const answer = (n: number, overrides: Record<string, unknown> = {}) => ({
  operation_id: uuid('00f0', 1),
  status: 'RECOVERING',
  resource_version: 5,
  resource_id: advanceId(n),
  amount_vnd: '2000000000',
  cap_vnd: '2000000000',
  cap_pct: '20',
  cap_rule_version_id: null,
  paid_vnd: '2000000000',
  recovered_vnd: '1000000000',
  outstanding_vnd: '1000000000',
  warnings: [],
  ...overrides,
});

export interface World {
  advances: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  /** The plans the read of a plan answers, by advance. */
  plans: Map<string, unknown>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    advances: [advance(1), advance(2, { status: 'PLANNED', kind: 'CONTRACT', paid_vnd: '0', recovered_vnd: '0', outstanding_vnd: '0', paid_on: null, recovery_deadline: null, overdue_days: null, actions: { cancel: true, record_recovery: false } })],
    contracts: [contractLine(1, { status: 'ACTIVE' })],
    plans: new Map([[advanceId(1), plan(1)]]),
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the advances and the contracts are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => answer(1)): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'getAdvanceRecoveryPlan') {
      const id = (input as { path?: { id?: string } } | undefined)?.path?.id ?? '';
      return state.plans.get(id) ?? new Error('not found');
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: unknown) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    const query = (input as { query?: Record<string, string> } | undefined)?.query ?? {};
    switch (operation) {
      case 'listAdvances':
        return Promise.resolve(state.advances.filter((item) => (query.contract_id === undefined || (item.contract as { id: string }).id === query.contract_id) && (query.status === undefined || item.status === query.status)));
      case 'get_resources_contract':
        return Promise.resolve(state.contracts);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

export const readsOf = (h: Harness, operation: string): unknown[] => h.read.mock.calls.filter((call) => call[0] === operation).map((call) => call[1]);
export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
