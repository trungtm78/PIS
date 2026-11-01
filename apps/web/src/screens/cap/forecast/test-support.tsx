import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import vi_ from '../../../i18n/vi.json';
import { PROJECT_A, planClient, planWorld } from '../plan-test-support';
import type { Harness } from '../plan-test-support';

export { PROJECT_A, PROJECT_B, mount, routeOf } from '../plan-test-support';
export type { Harness };

export const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
export const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
export const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

export const YEAR = String(new Date().getFullYear());
export const MILLION = 1_000_000;
export const millions = (n: number): string => String(n * MILLION);

/** The failures a read can end in, with the title of the standard card each must show. */
export const FAILURES: Array<[string, Error, string]> = [
  ['denied', problem(403, 'SCOPE_DENIED'), word('states.denied.title')],
  ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), word('states.offline.title')],
  ['error', problem(500, 'INTERNAL_ERROR'), word('states.error.title')],
  ['signed out', problem(401, 'SESSION_EXPIRED'), word('states.signedOut.title')],
];

/** A current monthly line as `listDisbursementSchedules` answers it. */
export const lineRow = (month: number, kind: string, bucket: string, amount: string, overrides: Record<string, unknown> = {}) => ({
  id: `row-${kind}-${month}-${bucket}-${overrides.budget_level ?? 'CENTRAL'}`,
  project: { id: PROJECT_A, code: 'DA-01', name: 'Đường vành đai 3' },
  plan_year: Number(YEAR),
  granularity: 'MONTH',
  month,
  period: null,
  bucket,
  budget_level: 'CENTRAL',
  kind,
  amount_vnd: amount,
  ctmtqg_subset_vnd: null,
  assumption: kind === 'FORECAST' ? 'Nghiệm thu khối lượng đợt 3' : null,
  revision: 1,
  is_current: true,
  supersedes_id: null,
  achievement: kind === 'REGISTERED' ? { disbursed_vnd: '0', rate: null } : null,
  ...overrides,
});

/** The year-end estimate of one project as DIS answers it. */
export const estimateAnswer = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: '00000000-0000-4000-8000-000000000501',
  as_of_date: '2026-10-31',
  treasury_cutoff_date: '2026-10-31',
  plan_year: 2026,
  cutoff_month: 10,
  definition_status: 'SIGNED',
  reallocation_threshold_pct: 80,
  project_id: PROJECT_A,
  disbursed_vnd: millions(400),
  months: [],
  eac_vnd: millions(650),
  plan_total_vnd: millions(1000),
  gap_vnd: millions(-350),
  ratio_pct: '65.0',
  coverage: 'COMPLETE',
  reallocation_candidate: false,
  method: 'FORECAST_OR_REGISTERED',
  curve: [],
  projects: [],
  next_cursor: null,
  ...overrides,
});

export interface Served {
  lines?: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>);
  /** The answer of the year-end estimate, or the error to fail with; may be a function so it can move with a command. */
  estimate?: unknown;
  /** The projects of the register. */
  projects?: Array<Record<string, unknown>>;
  failing?: Record<string, unknown>;
}

/** A client whose schedules and year-end estimate are answered from `served`; the commands are answered by `command`. */
export function open(served: Served, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const rows = served.lines ?? [];
  const failing = new Map(Object.entries(served.failing ?? {}));
  const h = planClient(planWorld({ failing, ...(served.projects === undefined ? {} : { projects: served.projects }), schedules: () => (typeof rows === 'function' ? rows() : rows) }), command);
  const previous = h.read.getMockImplementation();
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'getDisbursementForecast') {
      const answer = typeof served.estimate === 'function' ? (served.estimate as () => unknown)() : served.estimate;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
  });
  return h;
}

/** The reads of the operation that were asked of the client. */
export const readsOf = (h: Harness, operation: string): unknown[][] => h.read.mock.calls.filter(([name]) => name === operation);
export const allReadsOf = (h: Harness, operation: string): unknown[][] => (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([name]) => name === operation);
