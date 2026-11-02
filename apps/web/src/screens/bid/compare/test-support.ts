import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { criteriaId, pack, packageId, proposalId, runId } from '../analysis/test-support';

export { EVALUATOR, NOBODY, mount, packageId, problem, proposalId, routeOf, runId } from '../analysis/test-support';
export type { Harness };

export const CV1 = criteriaId(1);
export const CV2 = criteriaId(2);

const contractor = (n: number) => ({ id: `00000000-0000-4000-8000-0090${String(n).padStart(8, '0')}`, legal_name: `Công ty nhà thầu ${n}` });

export const compared = (n: number, overrides: Record<string, unknown> = {}) => ({
  proposal_id: proposalId(n),
  contractor: contractor(n),
  run_id: runId(n),
  run_status: 'AWAITING_REVIEW',
  criteria_count: 3,
  decided_count: 2,
  mandatory_not_met: 0,
  weighted_score: null,
  ...overrides,
});

export const criterion = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  name: `Tiêu chí ${code}`,
  kind: 'SCORED',
  weight: 40,
  max_score: 10,
  threshold: 6,
  mandatory: false,
  ...overrides,
});

export const decided = (status: string, score: string | null, decision = 'ACCEPTED') => ({ status, score, decision, decided_at: '2026-12-06T04:00:00.000Z' });

export const cell = (n: number, overrides: Record<string, unknown> = {}) => ({ proposal_id: proposalId(n), finding_id: `00000000-0000-4000-8000-0040${String(n).padStart(8, '0')}`, decided: null, risk: 'UNDECIDED', ...overrides });

export const excluded = (n: number, overrides: Record<string, unknown> = {}) => ({
  proposal_id: proposalId(n),
  contractor: contractor(n),
  run_id: runId(n),
  criteria_version_id: CV1,
  reason: 'CRITERIA_VERSION_MISMATCH',
  ...overrides,
});

/** The comparison of the package on CV-2: proposal 1 is compared (C1 mandatory and met, C2 scored 7.5, C3 undecided), proposal 2 is compared with nothing decided, proposal 3 ran on CV-1. */
export const comparison = (overrides: Record<string, unknown> = {}) => ({
  package: { id: packageId(1), code: 'GT-1' },
  criteria_version_id: CV2,
  criteria_status: 'APPROVED',
  proposals: [compared(1, { decided_count: 2, mandatory_not_met: 0, weighted_score: null }), compared(2, { decided_count: 0, criteria_count: 3 })],
  rows: [
    { criterion: criterion('C1', { kind: 'PASS_FAIL', weight: null, max_score: null, threshold: null, mandatory: true }), cells: [cell(1, { decided: decided('SUPPORTED', null), risk: 'NONE' }), cell(2)] },
    { criterion: criterion('C2'), cells: [cell(1, { decided: decided('SUPPORTED', '7.50', 'ACCEPTED_WITH_CHANGE'), risk: 'NONE' }), cell(2)] },
    { criterion: criterion('C3', { max_score: 5, threshold: null }), cells: [cell(1), cell(2)] },
  ],
  excluded: [excluded(3)],
  excluded_criteria: [],
  excluded_attributes: ['GENDER', 'ETHNICITY', 'RELIGION', 'MARITAL_STATUS', 'AGE', 'ORIGIN', 'LOCAL_PRESENCE'],
  as_of: '2026-12-06T04:00:00.000Z',
  ...overrides,
});

export interface World {
  comparison: Record<string, unknown>;
  packages: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Map<string, Error>;
}

export function world(overrides: Partial<World> = {}): World {
  return { comparison: comparison(), packages: [pack(1), pack(2)], failing: new Map(), ...overrides };
}

/** A client over `state`: the comparison and the packages are answered from it. */
export function client(state: World): Harness {
  const h = baseHarness((operation) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    return operation === 'compareProposals' ? state.comparison : new Error(`unexpected read ${operation}`);
  });
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return Promise.reject(failure);
    return operation === 'get_resources_procurement_package' ? Promise.resolve(state.packages) : Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}
