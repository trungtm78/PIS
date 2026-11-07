import { vi } from 'vitest';
import type { ApiClient } from '@machvon/api-client';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export { mount, routeOf } from '../test-support';

export const CONTRACT_A = '00000000-0000-4000-8000-001000000001';
export const CONTRACT_B = '00000000-0000-4000-8000-001000000002';

export const context = (over: Record<string, unknown> = {}) => ({
  scope: 'PROVINCE',
  as_of: '2026-11-08',
  cutoff_date: null,
  currency_unit: 'VND',
  freshness: { kind: 'LIVE', stale: false, snapshot: null, latest_snapshot: null },
  rows: 2,
  ledger_rows: 2,
  ...over,
});

export const snapshot = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  period_snapshot_id: '00000000-0000-4000-8000-0000000000b1',
  period_code: '2026-09',
  revision: 1,
  latest_revision: 1,
  stale: false,
  supersedes_id: null,
  cutoff_date: '2026-09-30',
  as_of_date: '2026-09-30',
  contract_count: 2,
  row_count: 2,
  payload_sha256: 'a'.repeat(64),
  built_at: '2026-10-01T00:00:00.000Z',
  ...over,
});

const column = (key: string, kind: string, extra: Record<string, unknown> = {}) => ({ key, kind, ledger: false, indicator: null, total: null, ...extra });

export const PORTFOLIO_COLUMNS = [
  column('code', 'TEXT'),
  column('title', 'TEXT'),
  column('project_code', 'TEXT'),
  column('contractor_name', 'TEXT'),
  column('unit_name', 'TEXT'),
  column('contract_status', 'TEXT'),
  column('contract_value_vnd', 'MONEY', { total: 'SUM' }),
  column('original_value_vnd', 'MONEY', { total: 'SUM' }),
  column('approved_change_delta_vnd', 'MONEY', { total: 'SUM' }),
  column('change_growth_pct', 'PERCENT', { total: 'RATIO', indicator: 'CHANGE_GROWTH' }),
  column('accepted_vnd', 'MONEY', { total: 'SUM', ledger: true }),
  column('paid_vnd', 'MONEY', { total: 'SUM', ledger: true }),
  column('paid_to_accepted_pct', 'PERCENT', { total: 'RATIO', indicator: 'PAID_TO_ACCEPTED', ledger: true }),
  column('days_late', 'DAYS', { total: 'MAX', indicator: 'DAYS_LATE' }),
  column('health', 'RAG'),
];

export const DEFINITIONS = [
  { code: 'CHANGE_GROWTH', name: 'Contract value growth through changes', formula: 'sum(approved change deltas) / original contract value x 100', numerator: 'sum(delta of approved changes, signed)', denominator: 'sum(original contract value)', unit: 'PERCENT', source_tables: ['contract', 'change_request'], null_policy: 'NOT_APPLICABLE when the denominator is zero' },
  { code: 'PAID_TO_ACCEPTED', name: 'Paid against accepted', formula: 'paid / accepted x 100', numerator: 'sum(paid)', denominator: 'sum(accepted)', unit: 'PERCENT', source_tables: ['contract'], null_policy: 'NOT_APPLICABLE when the denominator is zero' },
];

export const row = (id: string, code: string, over: Record<string, unknown> = {}, na: Record<string, string> = {}) => ({
  contract_id: id,
  cells: {
    code,
    title: `Hợp đồng ${code}`,
    project_code: 'DA-2026-001',
    contractor_name: 'Công ty Xây dựng An Phát',
    unit_name: 'Ban QLDA 1',
    contract_status: 'ACTIVE',
    contract_value_vnd: '10200000000',
    original_value_vnd: '10000000000',
    approved_change_delta_vnd: '200000000',
    change_growth_pct: '2.00',
    accepted_vnd: '4000000000',
    paid_vnd: '3000000000',
    paid_to_accepted_pct: '75.00',
    days_late: 12,
    health: 'AMBER',
    ...over,
  },
  na,
  health: { level: 'AMBER', drivers: ['DAYS_LATE'] },
});

/** The answer of the portfolio, with a total that is NOT the sum of its two rows (the screen must show the server's total, not add up the page). */
export const portfolioBody = (over: Record<string, unknown> = {}) => ({
  code: 'portfolio-status',
  ref: 'R2',
  as_of: '2026-11-08T01:00:00.000Z',
  context: context(),
  columns: PORTFOLIO_COLUMNS,
  items: [row(CONTRACT_A, 'HD-A-001'), row(CONTRACT_B, 'HD-A-002', { contract_value_vnd: '25000000000', title: null }, { title: 'NO_ROWS' })],
  totals: {
    rows: 2,
    ledger_rows: 2,
    cells: { contract_value_vnd: '77777777777', original_value_vnd: '70000000000', approved_change_delta_vnd: '1000000000', change_growth_pct: '1.43', accepted_vnd: '9000000000', paid_vnd: '7000000000', paid_to_accepted_pct: '77.78', days_late: 30 },
    na: {},
    indicators: [
      { code: 'CHANGE_GROWTH', value: '1.43', status: 'OK', reason: null, numerator: '1000000000', denominator: '70000000000' },
      { code: 'PAID_TO_ACCEPTED', value: '77.78', status: 'OK', reason: null, numerator: '7000000000', denominator: '9000000000' },
    ],
  },
  breakdown: {
    dimension: 'contract_status',
    groups: [
      { key: 'DRAFT', totals: { rows: 1, ledger_rows: 1, cells: { contract_value_vnd: '500000000' }, na: {}, indicators: [] } },
      { key: 'ACTIVE', totals: { rows: 1, ledger_rows: 1, cells: { contract_value_vnd: '77277777777' }, na: {}, indicators: [] } },
    ],
  },
  definitions: DEFINITIONS,
  next_cursor: null,
  ...over,
});

export const concentrationBody = (over: Record<string, unknown> = {}) => ({
  code: 'contractor-concentration',
  ref: 'R14',
  as_of: '2026-11-08T01:00:00.000Z',
  context: context({ rows: null, ledger_rows: null }),
  rule: { type: 'CONTRACT_CONCENTRATION', version: 0, source: 'DEFAULT', params: { basis: 'CONTRACT_VALUE', top_n: 5, top_share_amber_pct: 50, top_share_red_pct: 70, hhi_amber: 1000, hhi_red: 1800, single_bidder_amber_pct: 20, single_bidder_red_pct: 40, min_contracts: 10 } },
  active_contracts: 12,
  active_value_vnd: '9000000000',
  dimensions: [
    {
      dimension: 'contractor',
      top_n: 5,
      total_vnd: '9000000000',
      level: 'RED',
      top_share: { value: '88.89', status: 'OK', reason: null, numerator: '8000000000', denominator: '9000000000' },
      hhi: { value: '4321.00', status: 'OK', reason: null, numerator: null, denominator: null },
      share_anomalies: ['00000000-0000-4000-8000-001000000009'],
      groups: [
        { key: 'k1', name: 'Công ty An Phát', value_vnd: '6000000000', share_pct: '66.67' },
        { key: 'k2', name: null, value_vnd: '3000000000', share_pct: '33.33' },
      ],
    },
    {
      dimension: 'unit',
      top_n: 5,
      total_vnd: '9000000000',
      level: 'NOT_ENOUGH_DATA',
      top_share: { value: null, status: 'NOT_APPLICABLE', reason: 'NO_ACTIVE_CONTRACT', numerator: null, denominator: null },
      hhi: { value: null, status: 'NOT_APPLICABLE', reason: 'NO_ACTIVE_CONTRACT', numerator: null, denominator: null },
      share_anomalies: [],
      groups: [],
    },
  ],
  single_bidder: { value: '33.33', status: 'OK', reason: null, numerator: '1', denominator: '3', level: 'AMBER' },
  contractors: [
    { contractor_id: 'k1', name: 'Công ty An Phát', active_contracts: 2, active_value_vnd: '6000000000', share_pct: '66.67', pending_award_vnd: '0' },
    { contractor_id: 'k3', name: null, active_contracts: 0, active_value_vnd: '0', share_pct: '0.00', pending_award_vnd: '400000000' },
  ],
  definitions: [
    ...DEFINITIONS,
    { code: 'TOP_N_SHARE', name: 'Share of the largest groups', formula: 'top share', numerator: 'a', denominator: 'b', unit: 'PERCENT', source_tables: ['contract'], null_policy: 'n' },
    { code: 'HHI', name: 'HHI', formula: 'hhi', numerator: 'a', denominator: 'b', unit: 'INDEX', source_tables: ['contract'], null_policy: 'n' },
    { code: 'SINGLE_BIDDER_RATE', name: 'Single bidder', formula: 'sb', numerator: 'a', denominator: 'b', unit: 'PERCENT', source_tables: ['contract'], null_policy: 'n' },
  ],
  next_cursor: null,
  ...over,
});

export interface Answers {
  portfolio?: (query: Record<string, string> | undefined) => unknown;
  report?: (code: string, query: Record<string, string> | undefined) => unknown;
  exportFile?: (code: string, query: Record<string, string> | undefined) => unknown;
  snapshots?: () => unknown;
  /** The lists read for the filters. */
  lists?: Record<string, unknown[]>;
  /** The register of the member's own contracts (readAll). */
  contracts?: unknown[] | Error;
}

/** A client whose reads of the analytics are answered from `answers`; a function that returns an Error is a failed read, a promise that never settles is a read in progress. */
export function analyticsClient(answers: Answers): Harness {
  const h = harness((operation, input) => {
    const typed = input as { path?: { code?: string }; query?: Record<string, string> } | undefined;
    switch (operation) {
      case 'getContractPortfolio':
        return answers.portfolio === undefined ? portfolioBody() : answers.portfolio(typed?.query);
      case 'getContractReport':
        return answers.report === undefined ? portfolioBody() : answers.report(typed?.path?.code ?? '', typed?.query);
      case 'exportContractReport':
        return answers.exportFile === undefined ? new Error('no export') : answers.exportFile(typed?.path?.code ?? '', typed?.query);
      case 'listContractFactSnapshots':
        return answers.snapshots === undefined ? { items: [], as_of: '2026-11-08T00:00:00.000Z' } : answers.snapshots();
      default:
        return new Error(`unexpected read ${operation}`);
    }
  });
  (h.client as unknown as { readAll: ApiClient['readAll'] }).readAll = vi.fn((operation: string) => {
    if (operation === 'get_resources_contract') return answers.contracts instanceof Error ? Promise.reject(answers.contracts) : Promise.resolve(answers.contracts ?? []);
    const list = answers.lists?.[operation];
    return list === undefined ? Promise.resolve([]) : Promise.resolve(list);
  }) as never;
  return h;
}
