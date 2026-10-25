import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { PROJECT, contractId, detail, line, option, revision } from '../test-support';

export { mount, routeOf } from '../test-support';
export { PROJECT, contractId };
export type { Harness };

export const UUID_A = '00000000-0000-4000-8000-0000000000a1';
export const SECOND_PROJECT = '00000000-0000-4000-8000-000100000002';

export const requestId = (n: number): string => `00000000-0000-4000-8000-0020${String(n).padStart(8, '0')}`;

/** A request as the server answers it to the staff: the place in the chain, the assessment and what the caller may do. */
export const request = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: requestId(n),
  code: `CE-00${n}`,
  stage: 'EVENT',
  status: 'SUBMITTED',
  contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE' },
  project_id: PROJECT,
  parent_id: null,
  created_at: '2026-10-24T01:00:00.000Z',
  version: 1,
  event_kind: 'OWNER_INSTRUCTION',
  baseline_revision_id: UUID_A,
  reason: 'The owner instructed a wider footpath.',
  status_reason: null,
  estimated_delta_vnd: '400000000',
  evaluated_delta_vnd: null,
  approved_delta_vnd: null,
  schedule_impact_days: 10,
  funding_impact_note: null,
  scope_impact_note: null,
  allocation_line_id: null,
  effective_on: null,
  submitted_by: UUID_A,
  evaluated_by: null,
  decided_by: null,
  evaluated_at: null,
  decided_at: null,
  resulting_revision_id: null,
  actions: { promote: true, evaluate: false, withdraw: true, decide: false },
  ...overrides,
});

/** What a guest contractor reads of a request: the place in the chain and nothing of the assessment. */
export const guestRequest = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: requestId(n),
  code: `CE-00${n}`,
  stage: 'EVENT',
  status: 'SUBMITTED',
  contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE' },
  project_id: PROJECT,
  parent_id: null,
  created_at: '2026-10-24T01:00:00.000Z',
  version: 1,
  ...overrides,
});

export const config = (overrides: Record<string, unknown> = {}) => ({
  tier_count: 3,
  stages: ['EVENT', 'PCO', 'CO'],
  locked: false,
  locked_at: null,
  locked_by_change: null,
  set_by: UUID_A,
  version: 1,
  ...overrides,
});

export const chain = (overrides: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  config: config(),
  requests: [],
  actions: { configure: true, open: true },
  as_of: '2026-10-25T00:00:00.000Z',
  ...overrides,
});

/** An active contract with the revision in force that a change rests on. */
export const active = (overrides: Record<string, unknown> = {}) => ({
  ...detail(1, { status: 'ACTIVE', revisions: [revision(1, { status: 'EFFECTIVE', revision: 1 })] }),
  ...overrides,
});

export interface World {
  /** The answer of the read of the chain, or a function of its input. */
  chain: Record<string, unknown> | Error | ((input: unknown) => Record<string, unknown> | Error);
  contracts: Array<Record<string, unknown>>;
  details: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  /** The lines of the BOQs of the contract, as the register answers them. */
  boqLines: Array<Record<string, unknown>>;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    chain: chain(),
    contracts: [line(1, { status: 'ACTIVE' }), line(2, { status: 'SUSPENDED' }), line(3, { status: 'DRAFT' }), line(4, { status: 'TERMINATED' })],
    details: [active()],
    projects: [option(PROJECT, { code: 'DA-2026-001', name: 'Dự án cầu' }), option(SECOND_PROJECT, { code: 'DA-2026-002', name: 'Dự án đường' })],
    boqLines: [],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the chain, the contract and the options are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'getChangeChain') return typeof state.chain === 'function' ? state.chain(input) : state.chain;
    if (operation === 'get_resources_contract_id') {
      const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
      return state.details.find((item) => item.id === id) ?? new Error('not found');
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    switch (operation) {
      case 'get_resources_contract':
        return Promise.resolve(state.contracts);
      case 'get_resources_project':
        return Promise.resolve(state.projects);
      case 'get_resources_boq_line':
        return Promise.resolve(state.boqLines);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
