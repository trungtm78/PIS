import { vi } from 'vitest';
import { FUND_NSDP, FUND_NSTW, NSDP, line as appropriationLine, mount, routeOf, world as appropriationWorld } from './test-support';
import type { Harness, World as AppropriationWorld } from './test-support';
import { harness as baseHarness } from '../sas/test-support';

export { mount, routeOf };
export type { Harness };

export const PLAN_PLANNER = ['capital.read', 'plan_version.read', 'capital.plan.draft'];
export const PLAN_READER = ['capital.read', 'plan_version.read'];
export const BILLION = 1_000_000_000;

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT_A = uuid('0040', 1);
export const PROJECT_B = uuid('0040', 2);
export const UNIT_ROOT = uuid('0050', 1);
export const UNIT_BQL = uuid('0050', 2);
export const ANNUAL_ID = uuid('0060', 1);
export const MEDIUM_ID = uuid('0060', 2);
export const PUBLISHED_ID = uuid('0060', 3);
const vnd = (billions: number): string => String(billions * BILLION);

const total = (allocated: string, ctmtqg: string, ceiling: string, lineCount: number) => ({ line_count: lineCount, allocated_vnd: allocated, ctmtqg_subset_vnd: ctmtqg, ceiling_vnd: ceiling });

/** A plan revision as the API answers it (x-exposure dto). */
export const plan = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  plan_code: 'CP-2026',
  plan_kind: 'ANNUAL',
  plan_year: 2026,
  period_from_year: 2026,
  period_to_year: 2026,
  scope_unit: { id: UNIT_ROOT, name: 'Sở Tài chính' },
  revision: 1,
  status: 'DRAFT',
  decision_document: null,
  supersedes_id: null,
  effective_at: null,
  published_at: null,
  totals: total(vnd(3), '400000000', vnd(10), 2),
  fund_sources: [{ version_id: FUND_NSTW, business_key: 'NSTW-DTPT', label: 'Ngân sách trung ương' }],
  version: 4,
  ...overrides,
});

/** A line of a plan as `listCapitalPlanLines` answers it. */
export const planLine = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0070', n),
  capital_plan_id: ANNUAL_ID,
  plan_code: 'CP-2026',
  plan_status: 'DRAFT',
  project: { id: n === 2 ? PROJECT_B : PROJECT_A, code: n === 2 ? 'DA-02' : 'DA-01', name: n === 2 ? 'Cầu Thủ Thiêm 4' : 'Đường vành đai 3' },
  fund_source: { version_id: FUND_NSTW, business_key: 'NSTW-DTPT', label: 'Ngân sách trung ương', category: 'NSTW' },
  appropriation: { id: appropriationLine(1).id, plan_year: 2026, amount_vnd: vnd(10), allocated_total_vnd: vnd(6), remaining_vnd: vnd(4) },
  bucket: 'CURRENT_YEAR',
  source_year: 2026,
  amount_vnd: vnd(1),
  ctmtqg_subset_vnd: '0',
  budget_level: 'CENTRAL',
  origin: 'PM_ASSIGNED',
  is_extended: false,
  extended_to: null,
  extension_document: null,
  program: null,
  previous_line_id: null,
  committed_vnd: null,
  reserved_vnd: null,
  version: 1,
  ...overrides,
});

export interface PlanWorld {
  plans: Array<Record<string, unknown>>;
  /** The lines of each plan by its id. */
  lines: Record<string, Array<Record<string, unknown>>>;
  projects: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  appropriations: AppropriationWorld;
  failing: Map<string, unknown>;
}

export function planWorld(overrides: Partial<PlanWorld> = {}): PlanWorld {
  const annual = plan(ANNUAL_ID);
  return {
    plans: [
      annual,
      plan(MEDIUM_ID, { plan_code: 'TH-2026-2030', plan_kind: 'MEDIUM_TERM', plan_year: null, period_from_year: 2026, period_to_year: 2030, totals: total(vnd(5), '0', vnd(20), 3), version: 2 }),
      plan(PUBLISHED_ID, {
        plan_code: 'CP-2025',
        plan_year: 2025,
        period_from_year: 2025,
        period_to_year: 2025,
        status: 'PUBLISHED',
        decision_document: { id: uuid('0003', 1), symbol: '12/QD-UBND', issued_on: '2025-01-10' },
        totals: total(vnd(2), '0', vnd(2), 1),
        version: 9,
      }),
    ],
    lines: {
      [ANNUAL_ID]: [
        planLine(1, { ctmtqg_subset_vnd: '400000000', amount_vnd: vnd(1) }),
        planLine(2, {
          amount_vnd: vnd(2),
          bucket: 'CARRYOVER',
          source_year: 2025,
          is_extended: true,
          extended_to: '2026-12-31',
          extension_document: { id: uuid('0003', 2), symbol: '55/QD-UBND', issued_on: '2026-01-05' },
          appropriation: { id: appropriationLine(1).id, plan_year: 2026, amount_vnd: vnd(10), allocated_total_vnd: vnd(6), remaining_vnd: vnd(4) },
        }),
      ],
      [MEDIUM_ID]: [planLine(1, { capital_plan_id: MEDIUM_ID })],
      [PUBLISHED_ID]: [planLine(1, { capital_plan_id: PUBLISHED_ID, plan_status: 'PUBLISHED', committed_vnd: '500000000', reserved_vnd: '100000000' })],
    },
    projects: [
      { id: PROJECT_A, code: 'DA-01', name: 'Đường vành đai 3', status: 'PIPELINE' },
      { id: PROJECT_B, code: 'DA-02', name: 'Cầu Thủ Thiêm 4', status: 'BUDGETED' },
    ],
    units: [
      { id: UNIT_ROOT, code: 'STC', name: 'Sở Tài chính' },
      { id: UNIT_BQL, code: 'BQL1', name: 'Ban quản lý 1' },
    ],
    appropriations: appropriationWorld({ lines: [appropriationLine(1), appropriationLine(2, { fund_source: NSDP, budget_level: 'LOCAL', origin: 'LOCAL_ADDED', remaining_vnd: vnd(4), allocated_total_vnd: '0', amount_vnd: vnd(4) })] }),
    failing: new Map(),
    ...overrides,
  };
}

/** The totals of the lines of a plan, as the API adds them (CTMTQG is inside the lines, never added). */
export function totalsOfLines(lines: ReadonlyArray<Record<string, unknown>>): { line_count: number; allocated_vnd: string; ctmtqg_subset_vnd: string } {
  return {
    line_count: lines.length,
    allocated_vnd: lines.reduce((sum, item) => sum + BigInt(item.amount_vnd as string), 0n).toString(),
    ctmtqg_subset_vnd: lines.reduce((sum, item) => sum + BigInt(item.ctmtqg_subset_vnd as string), 0n).toString(),
  };
}

/** A client over `state`: the list reads and the lines of a plan are answered from it, and `command(operation, input)` answers the commands. */
export function planClient(state: PlanWorld, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return state.failing.get(operation);
    if (operation === 'listCapitalPlanLines') {
      const id = (input as { path: { id: string } }).path.id;
      const found = state.plans.find((candidate) => candidate.id === id);
      const lines = state.lines[id] ?? [];
      return found === undefined ? new Error('plan not found') : { plan: found, items: lines, totals: totalsOfLines(lines), next_cursor: null, as_of: '2026-10-24T00:00:00Z' };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(state.failing.get(operation));
    switch (operation) {
      case 'get_resources_plan_version':
        return Promise.resolve(state.plans);
      case 'get_resources_project':
        return Promise.resolve(state.projects);
      case 'get_resources_organization_unit':
        return Promise.resolve(state.units);
      case 'listAppropriations':
        return Promise.resolve(state.appropriations.lines);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

export { FUND_NSDP, FUND_NSTW, appropriationLine };
