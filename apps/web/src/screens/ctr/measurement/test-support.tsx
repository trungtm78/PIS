import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { PROJECT, boqLine, contractId, detail, revision } from '../test-support';

export { mount, routeOf } from '../test-support';
export { PROJECT, contractId };
export type { Harness };

export const UUID_A = '00000000-0000-4000-8000-0000000000a1';
export const UUID_B = '00000000-0000-4000-8000-0000000000b2';
export const PERIOD_1 = '00000000-0000-4000-8000-000300000001';
export const PERIOD_2 = '00000000-0000-4000-8000-000300000002';
export const REVISION = '00000000-0000-4000-8000-001100000001';

export const measurementId = (n: number): string => `00000000-0000-4000-8000-0040${String(n).padStart(8, '0')}`;
export const itemId = (n: number): string => `00000000-0000-4000-8000-0014${String(n).padStart(8, '0')}`;

/** A measurement of B01 in the first period, as the server answers it. */
export const measurement = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: measurementId(n),
  contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE' },
  project_id: PROJECT,
  contract_revision_id: REVISION,
  contract_revision_no: 1,
  boq_line_id: '00000000-0000-4000-8000-001300000001',
  boq_item: { id: itemId(1), business_key: 'B01', description: 'Hạng mục 1', unit_code: 'M3' },
  boq_quantity: '8000.000000',
  remaining_quantity: '4500.000000',
  party_id: null,
  period: { id: PERIOD_1, code: '2026-01' },
  quantity_period: '3500.000000',
  quantity_cumulative: '3500.000000',
  revision: 1,
  status: 'APPROVED',
  evidence_refs: [{ document_version_id: UUID_A }],
  reference_no: 'NK-001',
  duplicate_override_reason: null,
  correction_of_id: null,
  correction_reason: null,
  inspection_id: null,
  created_by: UUID_B,
  created_at: `2026-10-2${n}T01:00:00.000Z`,
  submitted_by: UUID_B,
  submitted_at: '2026-10-24T02:00:00.000Z',
  decided_by: UUID_A,
  decided_at: '2026-10-24T03:00:00.000Z',
  actions: { submit: false, decide: false, correct: false },
  version: 3,
  ...overrides,
});

export const period = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: n === 1 ? PERIOD_1 : PERIOD_2,
  code: `2026-0${n}`,
  calendar_code: 'CAL-M',
  fiscal_year: 2026,
  start_date: `2026-0${n}-01`,
  end_date: `2026-0${n}-28`,
  deadline_at: `2026-0${n}-29T00:00:00.000Z`,
  calendar_version: 1,
  status: 'OPEN',
  version: 1,
  ...overrides,
});

/** An active contract with the revision in force that the quantities are recorded under. */
export const active = (overrides: Record<string, unknown> = {}) => ({
  ...detail(1, { status: 'ACTIVE', revisions: [revision(1, { status: 'EFFECTIVE', revision: 1 })] }),
  ...overrides,
});

export interface World {
  details: Array<Record<string, unknown>>;
  /** The lines of the BOQs of the contract, as the register answers them. */
  boqLines: Array<Record<string, unknown>>;
  measurements: Array<Record<string, unknown>>;
  periods: Array<Record<string, unknown>>;
  failing: Set<string>;
}

/** The lines of the revision in force: B01 (8,000 m3) and B02 (500 m3), each with its stable item. */
export const lines = (): Array<Record<string, unknown>> => [
  boqLine(1, { revision_status: 'EFFECTIVE', quantity: '8000', contract_revision_id: REVISION }),
  boqLine(2, { revision_status: 'EFFECTIVE', quantity: '500', contract_revision_id: REVISION }),
];

export function world(overrides: Partial<World> = {}): World {
  return {
    details: [active()],
    boqLines: lines(),
    measurements: [],
    periods: [period(1), period(2)],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the contract, the BOQ, the measurements and the periods are answered from it, and `command(operation, input)` answers the commands. */
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
      case 'get_resources_boq_line':
        return Promise.resolve(state.boqLines);
      case 'get_resources_measurement':
        return Promise.resolve(state.measurements);
      case 'get_resources_reporting_period':
        return Promise.resolve(state.periods);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
