import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { contractId, detail } from '../test-support';

export { mount, routeOf } from '../test-support';
export { contractId };
export type { Harness };

export const UUID_A = '00000000-0000-4000-8000-0000000000a1';
export const UUID_B = '00000000-0000-4000-8000-0000000000b2';
export const TODAY = '2026-10-25';

export const noActions = { submit: false, return: false, sign: false, activate: false, complete: false, close: false, cancel: false };

export const readiness = (overrides: Record<string, unknown> = {}) => ({
  boq: { total_vnd: '10200000000', balanced: true },
  guarantee: { required: true, held: true },
  permit_gate: { required: true, status: 'PASSED', blocking: [] },
  capital: { allocation_line_id: UUID_A },
  project: { status: 'IMPLEMENTATION', in_implementation: true },
  ...overrides,
});

/** The way to completion the server shows for a contract that is being performed: one approved completion acceptance and nothing in the way. */
export const completion = (overrides: Record<string, unknown> = {}) => ({
  acceptances: [{ id: UUID_A, record_no: 'QA-C-001', approved_on: '2026-10-20' }],
  open_critical_ncr_ids: [],
  pending_measurement_ids: [],
  ...overrides,
});

/** What the server shows for a contract that was completed: one closed settlement that carries an exception, the advance owed and nothing unresolved of the retention, so only the retention stands in the way. */
export const closure = (overrides: Record<string, unknown> = {}) => ({
  settlements: [{ id: UUID_A, scope: 'CONTRACT', revision: 2, excepted: true }],
  advance_outstanding_vnd: '1250000000',
  retention: { holds: 0, unresolved_vnd: '0' },
  unmet: [],
  ...overrides,
});

export const change = (n: number, from: string, to: string, reason: string) => ({
  id: `00000000-0000-4000-8000-00000000c0${n}0`,
  from_status: from,
  to_status: to,
  reason,
  effective_on: '2026-10-20',
  command: 'x',
  created_at: '2026-10-20T01:00:00.000Z',
  created_by: UUID_A,
});

/** The summary the server answers: the detail of a contract and, for the staff, what stands before its activation and what the caller may do. */
export const summary = (status: string, overrides: Record<string, unknown> = {}) => ({
  ...detail(1),
  status,
  version: 3,
  submitted_by: null,
  signed_by: null,
  signed_document_version_id: null,
  conflict_decision_ref: null,
  activated_by: null,
  readiness: readiness(),
  actions: noActions,
  status_changes: [],
  ...overrides,
});

export interface World {
  summary: Record<string, unknown> | Error;
}

/** A client over `state`: the summary of the contract is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return baseHarness((operation) => {
    if (operation === 'getContractSummary') return state.summary;
    return new Error(`unexpected read ${operation}`);
  }, command);
}
