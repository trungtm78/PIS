import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { CV2, comparison } from '../compare/test-support';
import { packageId, proposalId, runId } from '../analysis/test-support';

export { mount, routeOf } from '../test-support';
export { CV2, comparison, packageId, proposalId, runId };
export type { Harness };

/** A member of the evaluation team, and a caller who holds neither that right nor any other. */
export const EVALUATOR = ['bid.evaluate'];
export const READER = ['bid.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const reportId = (n: number): string => uuid('00f0', n);
export const memberOf = (n: number): string => uuid('00b0', n);
export const DOCUMENT = uuid('00e0', 9);

const person = (n: number) => ({ membership_id: memberOf(n), display_name: `Chuyên gia ${n}` });

const contractor = (n: number) => ({ id: uuid('0090', n), legal_name: `Công ty nhà thầu ${n}` });

/** What the report froze for two proposals: the first met the mandatory criterion and was scored 8 on C2, the second lacks the licence (C1) and is not scored. */
export const summary = (overrides: Record<string, unknown> = {}) => ({
  conclusion: 'Hồ sơ của nhà thầu 1 đáp ứng tiêu chí bắt buộc; nhà thầu 2 thiếu giấy phép.',
  package: { id: packageId(1), code: 'GT-1' },
  criteria_version_id: CV2,
  decisions_sha256: 'a'.repeat(64),
  proposals: [
    { proposal_id: proposalId(1), contractor: contractor(1), run_id: runId(1), criteria_count: 2, decided_count: 2, mandatory_not_met: 0, weighted_score: '32.00' },
    { proposal_id: proposalId(2), contractor: contractor(2), run_id: runId(2), criteria_count: 2, decided_count: 2, mandatory_not_met: 1, weighted_score: null },
  ],
  rows: [
    {
      criterion: { code: 'C1', name: 'Giấy phép', kind: 'PASS_FAIL', weight: null, max_score: null, threshold: null, mandatory: true },
      cells: [
        { proposal_id: proposalId(1), finding_id: uuid('0040', 1), decided: { status: 'SUPPORTED', score: null, decision: 'ACCEPTED', decided_at: '2026-12-06T04:00:00.000Z' }, risk: 'NONE' },
        { proposal_id: proposalId(2), finding_id: uuid('0040', 2), decided: { status: 'MISSING', score: null, decision: 'ACCEPTED_WITH_CHANGE', decided_at: '2026-12-06T04:00:00.000Z' }, risk: 'MANDATORY_NOT_MET' },
      ],
    },
    {
      criterion: { code: 'C2', name: 'Kinh nghiệm', kind: 'SCORED', weight: 40, max_score: 10, threshold: 6, mandatory: false },
      cells: [
        { proposal_id: proposalId(1), finding_id: uuid('0040', 3), decided: { status: 'SUPPORTED', score: '8.00', decision: 'ACCEPTED_WITH_CHANGE', decided_at: '2026-12-06T05:00:00.000Z' }, risk: 'NONE' },
        { proposal_id: proposalId(2), finding_id: null, decided: null, risk: 'UNDECIDED' },
      ],
    },
  ],
  not_covered: [],
  excluded_criteria: [],
  excluded_attributes: ['GENDER', 'AGE'],
  ...overrides,
});

/** A report as the API answers it to a member who may sign it: a draft of two proposals, signed by the first expert, awaiting the second. Overrides change what a test needs. */
export const report = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: reportId(n),
  package: { id: packageId(1), code: 'GT-1' },
  project_id: uuid('0030', 1),
  criteria_version_id: CV2,
  run_ids: [runId(1), runId(2)],
  status: 'DRAFT',
  summary: summary(),
  signed_off_by: [{ ...person(1), signed_at: '2026-12-06T06:00:00.000Z', dissent: false }],
  awaiting: [{ ...person(2), standing: 'CLEAR' }],
  dissenting_opinions: [],
  payload_sha256: null,
  report_document_id: null,
  document_status: null,
  stale: false,
  actions: { sign_off: true },
  created_by: person(1),
  created_at: '2026-12-06T05:30:00.000Z',
  issue_requested_at: null,
  issued_at: null,
  recalled_at: null,
  version: 2,
  ...overrides,
});

export interface World {
  reports: Array<Record<string, unknown>>;
  comparison: Record<string, unknown>;
  /** Reads that fail, by operation. */
  failing: Map<string, Error>;
}

export function world(overrides: Partial<World> = {}): World {
  return { reports: [], comparison: comparison(), failing: new Map(), ...overrides };
}

/** A client over `state`: the reports and the comparison are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    if (operation === 'listEvaluationReports') return { items: state.reports, as_of: '2026-12-06T07:00:00.000Z' };
    if (operation === 'compareProposals') return state.comparison;
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.reject(new Error('unexpected readAll')));
  return h;
}
