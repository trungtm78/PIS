import { ApiError } from '@machvon/api-client';
import { harness, mount as baseMount, routeOf as baseRoute } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import type { ReactElement } from 'react';

export type { Harness };

export const READER = ['funding.read'];
export const PREPARER = ['funding.read', 'funding.figure.prepare'];
export const CHECKER = ['funding.read', 'funding.figure.accept'];

export const routeOf = (id: string, req: string) => ({ ...baseRoute(id, req), module: 'DIS', path: `/dis/${id.toLowerCase()}` });

export const PROJECT = '00000000-0000-4000-8000-0005000000b1';
export const BATCH = '00000000-0000-4000-8000-0006000000c1';

export const taxonomy = (over: Record<string, unknown> = {}) => ({
  pack_code: 'ENTERPRISE',
  pack_label: 'Doanh nghiệp',
  version: 0,
  rule_id: null,
  unverified: true,
  entry_mode: 'PERIOD_ENTRY',
  phasing_must_sum: true,
  actuals_precedence: 'REPORTED_UNTIL_RECONCILED',
  variance_tolerance: { pct: 1, abs_vnd: '1000000' },
  measures: ['EXECUTED', 'DISBURSED'],
  period_grains: ['MONTH', 'QUARTER', 'YEAR'],
  classes: [
    { code: 'EQUITY', label: 'Vốn chủ sở hữu', additive: true, source: 'ERP' },
    { code: 'LOAN', label: 'Vốn vay', additive: true, source: 'ERP' },
    { code: 'OTHER', label: 'Vốn khác', additive: true, source: 'ERP' },
  ],
  tiers: [{ code: 'ALL', label: 'Toàn bộ' }],
  subsets: [],
  tags: [],
  ratios: [{ code: 'RATE_YEAR_IN_FORCE', numerator: 'CUMULATIVE_YTD', denominator: 'PLAN_IN_FORCE', basis: 'OFFICIAL', class_filter: [], formula_code: 'RATE_YEAR_IN_FORCE' }],
  provenance: { formula: 'f', source: 's', as_of: '2026-11-08', legal_status: 'UNVERIFIED' },
  actions: { prepare: true, accept: false },
  as_of: '2026-11-08',
  ...over,
});

const cell = (classCode: string, over: Record<string, unknown> = {}) => ({
  class_code: classCode,
  tier_code: 'ALL',
  measure: 'DISBURSED',
  plan_year_vnd: null,
  plan_adjusted_vnd: null,
  plan_in_force_vnd: null,
  plan_period_vnd: null,
  plan_to_date_vnd: null,
  estimate_vnd: null,
  estimate_as_reported_vnd: null,
  actual_vnd: null,
  cumulative_ytd_vnd: null,
  cumulative_since_start_vnd: null,
  estimate_year_vnd: null,
  estimate_year_reason: 'ESTIMATE_GAP',
  gap_months: [],
  actual_bases: [],
  actual_flash: false,
  source_ids: {},
  ...over,
});

export const rate = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  class_code: null,
  measure: 'DISBURSED',
  numerator_term: 'CUMULATIVE_YTD',
  denominator_term: 'PLAN_IN_FORCE',
  basis: 'OFFICIAL',
  numerator_vnd: '125000000',
  denominator_vnd: '1000000000',
  rate_pct: '12.5000',
  null_reason: null,
  projects: 1,
  formula_code: code,
  as_of: '2026-03-31',
  pack_code: 'ENTERPRISE',
  ...over,
});

export const board = (over: Record<string, unknown> = {}) => ({
  pack_code: 'ENTERPRISE',
  version: 0,
  unverified: true,
  plan_year: 2026,
  period: { grain: 'MONTH', plan_year: 2026, ordinal: 3, start: '2026-03-01', end: '2026-03-31' },
  as_of: '2026-03-31',
  measure: 'DISBURSED',
  view: 'AS_REPORTED',
  totals: {
    money: [
      { code: 'PLAN_IN_FORCE', class_code: null, value_vnd: '1000000000', additive: true },
      { code: 'CUMULATIVE_YTD', class_code: null, value_vnd: '125000000', additive: true },
      { code: 'REMAINING_YEAR', class_code: null, value_vnd: '875000000', additive: true },
      { code: 'CONVERSION_DELTA', class_code: null, value_vnd: null, additive: true },
      { code: 'ACTUAL', class_code: null, value_vnd: '125000000', additive: true },
    ],
    rates: [rate('RATE_YEAR_IN_FORCE'), rate('RATE_PERIOD', { rate_pct: null, numerator_vnd: '125000000', denominator_vnd: '0', null_reason: 'ZERO_DENOMINATOR', numerator_term: 'ACTUAL', denominator_term: 'PLAN_PERIOD' }), rate('STRUCTURE_SHARE', { class_code: 'EQUITY', rate_pct: '100.0000', numerator_vnd: '125000000', denominator_vnd: '125000000' })],
  },
  projects: [
    {
      project_id: PROJECT,
      project_code: 'DA-2026-001',
      project_name: 'Nhà máy A',
      tmdt_in_force_vnd: null,
      cells: [
        cell('EQUITY', { plan_year_vnd: '1000000000', plan_in_force_vnd: '1000000000', actual_vnd: '125000000', cumulative_ytd_vnd: '125000000', gap_months: [1], actual_flash: true }),
        cell('LOAN'),
      ],
      money: [],
      rates: [rate('RATE_YEAR_IN_FORCE')],
    },
  ],
  truncated: false,
  actions: { prepare: true, accept: false },
  ...over,
});

export const batch = (over: Record<string, unknown> = {}) => ({
  batch_id: BATCH,
  project_id: PROJECT,
  project_code: 'DA-2026-001',
  taxonomy_pack: 'ENTERPRISE',
  class_code: 'EQUITY',
  tier_code: 'ALL',
  measure: 'DISBURSED',
  figure_kind: 'ESTIMATE',
  period_grain: 'MONTH',
  plan_year: 2026,
  basis: 'OWNER_ESTIMATE',
  status: 'DRAFT',
  as_of_date: '2026-03-10',
  explanation: null,
  decision_document_id: null,
  prepared_by_me: true,
  approved_at: null,
  created_at: '2026-03-10T03:00:00.000Z',
  version: 1,
  entries: [{ id: '00000000-0000-4000-8000-0007000000d1', period_ordinal: 3, amount_vnd: '100000000', revision: 1, status: 'DRAFT', supersedes_id: null }],
  actions: { submit: true, withdraw: true, accept: false, return: false },
  ...over,
});

export const history = (over: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  project_code: 'DA-2026-001',
  class_code: 'EQUITY',
  tier_code: 'ALL',
  measure: 'DISBURSED',
  period_grain: 'MONTH',
  plan_year: 2026,
  period_ordinal: 3,
  history: [
    { id: 'h1', figure_kind: 'ESTIMATE', basis: 'OWNER_ESTIMATE', revision: 1, as_of_date: '2026-03-10', status: 'SUPERSEDED', amount_vnd: '100000000', change_vnd: null, converted_from_id: null, estimate_amount_vnd: null, conversion_reason: null, conversion_delta_vnd: null },
    { id: 'h2', figure_kind: 'ESTIMATE', basis: 'OWNER_ESTIMATE', revision: 2, as_of_date: '2026-03-25', status: 'SUPERSEDED', amount_vnd: '120000000', change_vnd: '20000000', converted_from_id: null, estimate_amount_vnd: null, conversion_reason: null, conversion_delta_vnd: null },
    { id: 'h3', figure_kind: 'ACTUAL', basis: 'REPORTED', revision: 1, as_of_date: '2026-04-05', status: 'ACCEPTED', amount_vnd: '125000000', change_vnd: null, converted_from_id: 'h2', estimate_amount_vnd: '120000000', conversion_reason: 'PERIOD_ACTUAL_IN', conversion_delta_vnd: '5000000' },
  ],
  pending: [],
  as_of: '2026-04-10T03:00:00.000Z',
  ...over,
});

export const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });

export interface World {
  taxonomy?: unknown;
  board?: unknown;
  batches?: unknown;
  batch?: unknown;
  history?: unknown;
}

/** A client answering the reads of the funding screens from the world; an `Error` value is a refusal. */
export function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 2, resource_id: BATCH })): Harness {
  const made = harness((operation) => {
    switch (operation) {
      case 'getFundingTaxonomy':
        return 'taxonomy' in world ? world.taxonomy : taxonomy();
      case 'getFundingFigureBoard':
        return 'board' in world ? world.board : board();
      case 'listFundingFigureBatches':
        return 'batches' in world ? world.batches : { items: [batch()], truncated: false, as_of: '2026-03-10T03:00:00.000Z' };
      case 'getFundingFigureBatch':
        return 'batch' in world ? world.batch : batch();
      case 'getFundingFigureHistory':
        return 'history' in world ? world.history : history();
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  // The list of projects the form offers is read page by page.
  (made.client as unknown as { readAll: unknown }).readAll = () => Promise.resolve([{ id: PROJECT, code: 'DA-2026-001', name: 'Nhà máy A' }]);
  return made;
}

export const mount: typeof baseMount = (screen: ReactElement, h: Harness, permissions: readonly string[] | undefined = READER, path = '/') => baseMount(screen, h, permissions, path);
