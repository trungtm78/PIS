import { harness as baseHarness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';
import { detail } from './test-support';

export { mount, routeOf } from './test-support';
import fixtureText from './fixture-text.vi.json';
export type { Harness };

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const PROJECT_ID = detail(1).id as string;
export const SET_ID = uuid(700);
export const SHEET_ID = uuid(800);
export const OTHER_SHEET_ID = uuid(801);
export const DOCUMENT = uuid(900);
export const EVIDENCE = uuid(901);

export const CRITERIA = [
  { code: 'C1', name: fixtureText['criteria.planningFit'], weight: '30' },
  { code: 'C2', name: fixtureText['criteria.feasibility'], weight: '25' },
  { code: 'C3', name: fixtureText['criteria.economicEfficiency'], weight: '20' },
  { code: 'C4', name: fixtureText['criteria.capitalBalance'], weight: '15' },
  { code: 'C5', name: fixtureText['criteria.risk'], weight: '10' },
];

export const criteriaSet = (overrides: Record<string, unknown> = {}) => ({
  version_id: SET_ID,
  key: 'APPR-CRIT-2026r1',
  revision: 1,
  valid_from: '2026-01-01',
  legal_basis: fixtureText['criteria.legalBasis'],
  awaiting_confirmation: true,
  cxn: 'ASSUMPTION-APPRAISAL-60',
  pass_threshold: '60',
  criteria: CRITERIA,
  ...overrides,
});

export const sheet = (id: string, values: number[], overrides: Record<string, unknown> = {}) => ({
  id,
  version: 1,
  round: 1,
  status: 'SUBMITTED',
  mine: false,
  appraiser: { membership_id: uuid(50), display_name: fixtureText['appraiser.displayName'] },
  scores: CRITERIA.map((criterion, index) => ({ criterion_code: criterion.code, score: values[index], evidence_ids: [] })),
  total_score: '73.00',
  recommendation: 'ADMIT',
  note: null,
  decision: null,
  decided_at: null,
  updated_at: '2026-10-24T02:00:00.000Z',
  ...overrides,
});

export const appraisal = (overrides: Record<string, unknown> = {}) => ({
  round: 1,
  project_status: 'APPRAISAL',
  viewer_is_proposer: false,
  can_record: true,
  can_decide: false,
  criteria_set: criteriaSet(),
  sheets: [],
  summary: null,
  decision_target: null,
  ...overrides,
});

/** The lifecycle read of a project with the appraisal block the caller may see (null: none). */
export const lifecycle = (status: string, block: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) => ({
  project_id: PROJECT_ID,
  code: 'DA-2026-001',
  status,
  version: 2,
  project_group: null,
  national_project_code: null,
  status_changed_at: '2026-10-24T01:00:00.000Z',
  history: [],
  next: [],
  appraisal: block,
  as_of: '2026-10-24T02:00:00.000Z',
  ...overrides,
});

export interface World {
  lifecycle: unknown;
  detail: Record<string, unknown>;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { lifecycle: lifecycle('APPRAISAL', appraisal()), detail: detail(1), failing: new Set(), ...overrides };
}

/** A client over `state`: the lifecycle and the project are answered from it. */
export function appraisalClient(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return baseHarness((operation) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'getProjectLifecycle') return state.lifecycle;
    if (operation === 'get_resources_project_id') return state.detail;
    return new Error(`unexpected read ${operation}`);
  }, command);
}
