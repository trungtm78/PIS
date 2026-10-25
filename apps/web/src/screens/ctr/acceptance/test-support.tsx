import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { active, measurement, period, PERIOD_1, PERIOD_2, UUID_A, UUID_B, contractId, measurementId, itemId } from '../measurement/test-support';

export { mount, routeOf } from '../measurement/test-support';
export { PERIOD_1, PERIOD_2, UUID_A, UUID_B, contractId, measurement, measurementId };
export type { Harness };

export const DRAFTER = ['acceptance.read', 'acceptance.create', 'acceptance.submit', 'measurement.read', 'contract.read'];
export const APPROVER = ['acceptance.read', 'acceptance.approve', 'contract.read'];
export const REVOKER = ['acceptance.read', 'acceptance.revoke', 'contract.read'];
export const READER = ['acceptance.read', 'contract.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const acceptanceId = (n: number): string => uuid('0050', n);
export const PAPER = uuid('00c0', 1);
export const MINUTES = uuid('00d0', 1);

/** An acceptance as the list answers it: a draft of one line (200 m3 of B02 at 2,000,000), drafted by someone else, that the caller may send. */
export const acceptance = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: acceptanceId(n),
  acceptance_no: `NT-00${n}`,
  contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE', requires_quality_acceptance: true, contract_value_vnd: '10200000000', accepted_total_vnd: '0' },
  project_id: uuid('0001', 1),
  period: { id: PERIOD_1, code: '2026-01' },
  document_version_id: PAPER,
  accepted_on: '2026-07-25',
  status: 'DRAFT',
  accepted_amount_vnd: '400000000',
  lines: [
    {
      id: uuid('00e0', n),
      measurement_id: measurementId(n),
      boq_item: { id: itemId(2), business_key: 'B02', description: 'Hạng mục 2', unit_code: 'M3' },
      party_id: null,
      contract_revision_id: uuid('0011', 1),
      quantity: '200.000000',
      unit_price_snapshot: '2000000.000000',
      amount_vnd: '400000000',
      retention_pct_snapshot: '5.0000',
      active: false,
      reference_no: 'NK-001',
    },
  ],
  quality_acceptance: null,
  open_critical_ncr: 0,
  signer_refs: [],
  submitted_by: null,
  submitted_at: null,
  decided_by: null,
  approved_at: null,
  decision_reason: null,
  revoke_reason: null,
  revoked_at: null,
  created_by: UUID_B,
  created_at: '2026-07-25T01:00:00.000Z',
  actions: { submit: true, decide: false, revoke: false },
  version: 1,
  ...overrides,
});

export interface World {
  details: Array<Record<string, unknown>>;
  measurements: Array<Record<string, unknown>>;
  acceptances: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { details: [active()], measurements: [], acceptances: [], failing: new Set(), ...overrides };
}

/** An approved measurement of B02 in the first period, as the register answers it. */
export const approvedMeasurement = (n: number, overrides: Record<string, unknown> = {}) => measurement(n, { status: 'APPROVED', period: { id: PERIOD_1, code: '2026-01' }, quantity_period: '200.000000', ...overrides });

export { period };

/** A client over `state`: the contract, the measurements and the acceptances are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_contract_id') {
      const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
      return state.details.find((item) => item.id === id) ?? new Error('not found');
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_measurement':
        return Promise.resolve(state.measurements);
      case 'get_resources_acceptance':
        return Promise.resolve(state.acceptances);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
