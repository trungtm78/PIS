import { ApiError } from '@machvon/api-client';
import { vi } from 'vitest';
import { harness as baseHarness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';
import { routeOf as dgvRoute } from './test-support';
import type { World } from './test-support';

export { ME, dataset, mount } from './test-support';
export type { Harness } from './test-support';

export const routeOf = dgvRoute;

export const DASHBOARD_READER = ['data.catalog.read', 'data.quality.read'];
export const STEWARD = ['data.catalog.read', 'data.quality.read', 'quality_rule_version.read', 'data.quality.manage', 'data.quality.run'];
export const APPROVER = ['data.catalog.read', 'data.quality.read', 'quality_rule_version.read', 'data.quality.approve'];
export const RULE_READER = ['data.catalog.read', 'data.quality.read', 'quality_rule_version.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const OTHER_PERSON = uuid('0003', 1);
export const SNAPSHOT = uuid('0004', 1);
export const CONTRACT = uuid('0005', 1);

export const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

export const summary = (overrides: Record<string, unknown> = {}) => ({
  total: 0,
  not_assessed: 0,
  passed: 0,
  warning: 0,
  failed: 0,
  stale: 0,
  hard_fail: 0,
  open_incidents: 0,
  overdue_incidents: 0,
  average_score: null,
  ...overrides,
});

export const ruleRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0006', n),
  contract_id: CONTRACT,
  dataset_id: uuid('0002', 1),
  dataset_code: 'DS-1',
  code: `R-${n}`,
  revision: 1,
  dimension: 'COMPLETENESS',
  field_path: 'project_id',
  expression_ast: { op: 'not_null', field: 'project_id' },
  severity: 'MEDIUM',
  threshold_json: { min_pass_rate_pct: '99.500000' },
  action_on_fail: 'QUARANTINE',
  criticality_weight: 3,
  status: 'DRAFT',
  created_by: OTHER_PERSON,
  created_by_name: 'Tran Thi Binh',
  approved_by: null,
  approved_by_name: null,
  approved_at: null,
  created_at: '2026-10-24T00:00:00.000000Z',
  version: 1,
  ...overrides,
});

export const scoredRule = (n: number, overrides: Record<string, unknown> = {}) => ({
  rule_version_id: uuid('0007', n),
  code: `R-${n}`,
  revision: 1,
  dimension: 'COMPLETENESS',
  severity: 'MEDIUM',
  action_on_fail: 'QUARANTINE',
  criticality_weight: 1,
  field_path: 'project_id',
  evaluated_count: 4,
  passed_count: 4,
  failed_count: 0,
  quarantined_count: 0,
  measured_value: '100.000000',
  threshold: { min_pass_rate_pct: '100.000000' },
  result: 'PASS',
  error_code: null,
  incident_id: null,
  ...overrides,
});

export const dimensionRow = (dimension: string, overrides: Record<string, unknown> = {}) => ({ dimension, assessed: false, score: null, rules_total: 0, rules_failed: 0, ...overrides });
const ALL_DIMENSIONS = ['COMPLETENESS', 'UNIQUENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS', 'ACCURACY', 'INTEGRITY'];

export const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: uuid('0008', 1),
  dataset_id: uuid('0002', 1),
  dataset_code: 'DS-1',
  dataset_contract_id: CONTRACT,
  snapshot_id: SNAPSHOT,
  trigger: 'SNAPSHOT_FROZEN',
  status: 'COMPLETED',
  overall_result: 'PASSED',
  score: '100.00',
  hard_fail: false,
  certified_blocked: false,
  failure_code: null,
  rule_count: 1,
  passed_count: 1,
  failed_count: 0,
  quarantined_count: 0,
  started_at: '2026-10-24T01:00:00.000000Z',
  finished_at: '2026-10-24T01:00:05.000000Z',
  ...overrides,
});

/** The scorecard of a dataset that was never assessed: no run, no score, no dimension measured. */
export const unassessedCard = (overrides: Record<string, unknown> = {}) => ({
  dataset_id: uuid('0002', 1),
  dataset_code: 'DS-1',
  title: 'Dataset 1',
  domain: 'TREASURY',
  producer_module: 'DIS',
  is_critical: true,
  badge: 'NOT_ASSESSED',
  assessed: false,
  score: null,
  hard_fail: null,
  certified_blocked: null,
  freshness: { slo_seconds: 86_400, age_seconds: null },
  snapshot_id: null,
  snapshot_as_of: null,
  definition_status: null,
  as_of: '2026-10-24T08:30:00.000Z',
  latest_run: null,
  pending_attempt: null,
  dimensions: ALL_DIMENSIONS.map((dimension) => dimensionRow(dimension)),
  rules: [],
  open_incidents: 0,
  overdue_incidents: 0,
  ...overrides,
});

export interface QualityWorld extends World {
  summary: Record<string, unknown> | undefined;
  rules: Array<Record<string, unknown>>;
  cards: Record<string, Record<string, unknown>>;
}

export function qualityWorld(overrides: Partial<QualityWorld> = {}): QualityWorld {
  return { datasets: [], members: [], failing: new Set(), summary: summary(), rules: [], cards: {}, ...overrides };
}

type Query = Record<string, string | number | undefined>;

/**
 * A client over `state`: the catalogue (with its summary), the rule versions and the scorecards are answered from it, and
 * `command(operation, input)` answers the commands. `calls` lists the reads in order.
 */
export function qualityClient(state: QualityWorld, command: (operation: string, input: unknown) => unknown = () => ({})): Harness & { readAll: ReturnType<typeof vi.fn> } {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const args = (input ?? {}) as { path?: { id?: string }; query?: Query };
    if (operation === 'searchCatalog') return { items: state.datasets.slice(0, Number(args.query?.limit ?? state.datasets.length)), total: state.datasets.length, summary: state.summary, next_cursor: null };
    if (operation === 'getQualityScorecard') return state.cards[args.path?.id ?? ''] ?? problem('RESOURCE_NOT_FOUND', 404);
    return new Error(`unexpected read ${operation}`);
  }, command);
  const readAll = vi.fn((operation: string, input?: { query?: Query }) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    const query = input?.query ?? {};
    switch (operation) {
      case 'searchCatalog':
        return Promise.resolve(state.datasets.filter((item) => query.domain === undefined || item.domain === query.domain));
      case 'get_resources_quality_rule_version':
        return Promise.resolve(state.rules.filter((item) => query.dataset_id === undefined || item.dataset_id === query.dataset_id));
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  (h.client as unknown as { readAll: unknown }).readAll = readAll;
  return Object.assign(h, { readAll });
}
