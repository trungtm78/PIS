import { ApiError } from '@machvon/api-client';
import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { PROJECT, mount } from '../payment/test-support';

export { PROJECT, mount };
export type { Harness };

export const RUNNER = ['treasury.daily_recon.read', 'treasury.daily_recon.run', 'treasury.daily_recon.assign', 'treasury.daily_recon.resolve', 'membership.read'];
export const RESOLVER = ['treasury.daily_recon.read', 'treasury.daily_recon.resolve'];
export const READER = ['treasury.daily_recon.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const runId = (n: number): string => uuid('0e10', n);
export const itemId = (n: number): string => uuid('0e20', n);
export const memberId = (n: number): string => uuid('0e30', n);
export const documentId = (n: number): string => uuid('0e40', n);
export const lineId = (n: number): string => uuid('0e50', n);

export const TODAY = '2026-11-09';

export const routeOf = (id: string, req: string) => ({
  id,
  path: `/pay/${id.toLowerCase()}`,
  title: id,
  kind: 'reconcile' as const,
  area: 'investment' as const,
  module: 'PAY',
  group: 'Đối soát & kiểm soát',
  role: 'workspace' as const,
  parent: null,
  req,
});

export const rule = (overrides: Record<string, unknown> = {}) => ({ version: 0, source: 'DEFAULT', unverified: true, threshold_vnd: '1000000', threshold_pct: null, due_days: 3, partial_after_days: 1, ...overrides });

/** A pass as the read answers it: complete, with the default thresholds. */
export const run = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: runId(n),
  recon_date: '2026-11-06',
  run_no: 1,
  status: 'COMPLETE',
  partial_reason: null,
  statement_imports: 1,
  transaction_count: 4,
  line_count: 3,
  difference_line_count: 2,
  opened_items: 2,
  cleared_items: 0,
  books_total_vnd: '19000000',
  treasury_total_vnd: '21000000',
  rule: rule(),
  calendar_basis: 'WORK_CALENDAR',
  origin: 'JOB',
  created_by: memberId(1),
  created_at: '2026-11-07T01:00:00.000000Z',
  ...overrides,
});

export const line = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: lineId(n),
  project_id: PROJECT,
  project_code: 'DA-A-001',
  fund_key: 'NSNN',
  fund_label: 'Ngân sách nhà nước',
  books_vnd: '5000000',
  treasury_vnd: '8000000',
  difference_vnd: '3000000',
  books_count: 1,
  treasury_count: 1,
  kind: 'AMOUNT',
  opens_item: true,
  ...overrides,
});

export const item = (n: number, overrides: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) => ({
  id: itemId(n),
  project_id: PROJECT,
  project_code: 'DA-A-001',
  fund_key: 'NSNN',
  fund_label: 'Ngân sách nhà nước',
  recon_date: '2026-11-06',
  kind: 'AMOUNT',
  status: 'OPEN',
  books_vnd: '5000000',
  treasury_vnd: '8000000',
  difference_vnd: '3000000',
  latest_difference_vnd: '3000000',
  owner_membership_id: memberId(1),
  owner_name: 'Kế toán trưởng',
  due_on: '2026-11-11',
  overdue: false,
  opened_run_id: runId(1),
  last_run_id: runId(1),
  cleared_run_id: null,
  explained_by: null,
  resolution_note: null,
  resolved_by: null,
  resolved_at: null,
  approval_document_version_id: null,
  issue_id: null,
  created_at: '2026-11-07T01:00:00.000000Z',
  version: 1,
  actions: { assign: true, explain: true, resolve: true, write_off: true, ...actions },
  ...overrides,
});

export const itemAnswer = (overrides: Record<string, unknown> = {}) => ({
  operation_id: uuid('0e60', 1),
  status: 'EXPLAINED',
  resource_version: 2,
  resource_id: itemId(1),
  owner_membership_id: memberId(1),
  due_on: '2026-11-11',
  difference_vnd: '3000000',
  ...overrides,
});

export const runAnswer = (overrides: Record<string, unknown> = {}) => ({
  operation_id: uuid('0e60', 2),
  status: 'COMPLETE',
  resource_version: 1,
  resource_id: runId(1),
  recon_date: '2026-11-06',
  run_no: 1,
  run_status: 'COMPLETE',
  partial_reason: null,
  reused: false,
  line_count: 3,
  opened_items: 2,
  cleared_items: 0,
  ...overrides,
});

export interface World {
  runs: Array<Record<string, unknown>>;
  days: Array<Record<string, unknown>>;
  details: Record<string, { lines: Array<Record<string, unknown>>; hidden?: number; run?: Record<string, unknown> }>;
  items: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
  ruleNow: Record<string, unknown>;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    runs: [run(1)],
    days: [{ recon_date: '2026-11-06', status: 'COMPLETE', partial_reason: null, run_no: 1, run_id: runId(1) }],
    details: { [runId(1)]: { lines: [line(1), line(2, { fund_key: 'ODA', fund_label: null, books_vnd: '0', treasury_vnd: '2000000', difference_vnd: '2000000', kind: 'MISSING_INTERNAL', opens_item: true }), line(3, { books_vnd: '10000000', treasury_vnd: '10000000', difference_vnd: '0', kind: null, opens_item: false })] } },
    items: [item(1)],
    members: [],
    summary: { waiting: 1, overdue: 0, waiting_difference_vnd: '3000000' },
    ruleNow: rule(),
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the passes, the days, the lines, the items and the members are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => itemAnswer()): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const typed = input as { path?: { id?: string }; query?: Record<string, string> } | undefined;
    if (operation === 'listTreasuryDailyReconRuns') {
      const ranged = typed?.query?.from !== undefined;
      return { items: state.runs, next_cursor: null, as_of: '2026-11-09T05:00:00.000Z', today: TODAY, rule: state.ruleNow, ...(ranged ? { days: state.days } : {}) };
    }
    if (operation === 'getTreasuryDailyReconRun') {
      const found = state.details[typed?.path?.id ?? ''];
      const base = state.runs.find((candidate) => candidate.id === typed?.path?.id);
      return found === undefined || base === undefined ? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) : { ...base, ...(found.run ?? {}), lines: found.lines, hidden_lines: found.hidden ?? 0, as_of: '2026-11-09T05:00:00.000Z' };
    }
    if (operation === 'listTreasuryDailyReconItems') {
      const status = typed?.query?.status;
      return { items: state.items.filter((row) => status === undefined || row.status === status), next_cursor: null, as_of: '2026-11-09T05:00:00.000Z', summary: state.summary };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    if (operation === 'get_resources_membership') return Promise.resolve(state.members);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}

export const member = (n: number, name: string) => ({ id: memberId(n), display_name: name, status: 'Active', membership_type: 'STAFF' });

export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
