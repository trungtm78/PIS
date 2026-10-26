import { ApiError } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionTenant, SessionValue } from '../../../session/SessionContext';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { routeOf as baseRoute } from '../test-support';

export type { Harness };

export const TENANT: SessionTenant = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'Cao Bang',
  monogram: 'CB',
  membershipId: '00000000-0000-4000-8000-000000000001',
  theme: { themeId: 'tenant', version: 1, overlay: {} },
};

export const MAKER = ['report.create', 'report.edit', 'report.read', 'report_revision.read'];
export const READER = ['report.read', 'report_revision.read'];
export const REVIEWER = ['report.review', 'report.read', 'report_revision.read'];
export const CORRECTOR = [...MAKER, 'report.correct'];
export const WITHDRAWER = [...MAKER, 'report.withdraw'];
export const IMPORTER = ['report.import', 'report.read', 'report_revision.read'];
export const SNAPSHOTTER = ['snapshot.build', 'snapshot.freeze', 'disbursement.read'];
export const SNAPSHOT_READER = ['disbursement.read'];
export const RATE_READER = ['disbursement.read'];
export const DEFINITION_READER = ['glossary.read'];
export const WARNING_MANAGER = ['warning.rule.manage', 'warning.read'];
export const WARNING_APPROVER = ['warning.rule.approve', 'warning.read'];
export const WARNING_HANDLER = ['warning.handle', 'warning.read'];
export const WARNING_READER = ['warning.read'];
export const routeOf = baseRoute;

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0041', 1);
export const PROJECT_TWO = uuid('0041', 2);
export const PERIOD = uuid('0042', 1);
export const PERIOD_LOCKED = uuid('0042', 2);
export const PLAN_VERSION = uuid('0043', 1);
export const PLAN = uuid('0044', 1);
export const REPORT = uuid('0045', 1);
export const FILE_ID = uuid('0047', 1);

/** The cells of FX-DIS-001: 100/200/30/70/0/20 million and the CTMTQG of 40 million in the year plan of the central budget. */
export const fxCells = (): Array<Record<string, unknown>> => [
  { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', allocated_vnd: '500000000', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000', next_month_vnd: '0', next_month_ctmtqg_subset_vnd: null, source_year: 2027, previous_cumulative_vnd: null, delta_vnd: null },
  { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', allocated_vnd: '300000000', cumulative_vnd: '200000000', ctmtqg_subset_vnd: null, next_month_vnd: '5000000', next_month_ctmtqg_subset_vnd: null, source_year: null, previous_cumulative_vnd: null, delta_vnd: null },
  { bucket: 'CARRYOVER', budget_level: 'CENTRAL', allocated_vnd: '0', cumulative_vnd: '30000000', ctmtqg_subset_vnd: null, next_month_vnd: '0', next_month_ctmtqg_subset_vnd: null, source_year: null, previous_cumulative_vnd: null, delta_vnd: null },
  { bucket: 'CARRYOVER', budget_level: 'LOCAL', allocated_vnd: '50000000', cumulative_vnd: '70000000', ctmtqg_subset_vnd: null, next_month_vnd: '0', next_month_ctmtqg_subset_vnd: null, source_year: null, previous_cumulative_vnd: null, delta_vnd: null },
  { bucket: 'OTHER', budget_level: 'CENTRAL', allocated_vnd: '0', cumulative_vnd: '0', ctmtqg_subset_vnd: null, next_month_vnd: '0', next_month_ctmtqg_subset_vnd: null, source_year: null, previous_cumulative_vnd: null, delta_vnd: null },
  { bucket: 'OTHER', budget_level: 'LOCAL', allocated_vnd: '0', cumulative_vnd: '20000000', ctmtqg_subset_vnd: null, next_month_vnd: '0', next_month_ctmtqg_subset_vnd: null, source_year: null, previous_cumulative_vnd: null, delta_vnd: null },
];

/** A report as `getReportRevision` answers it: the draft of FX-DIS-001 at version 3, 420,000,000 in the six cells and 40,000,000 of CTMTQG apart. */
export const reportRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: REPORT,
  revision: 1,
  status: 'DRAFT',
  is_current: false,
  version: 3,
  report_type: 'WEEKLY',
  measurement_basis: 'YTD',
  is_late: false,
  payload_hash: 'a'.repeat(64),
  negative_delta_explanation: null,
  submitted_at: null,
  submitted_by: null,
  accepted_at: null,
  accepted_by: null,
  returned_reason: null,
  supersedes_id: null,
  amendment_reason: null,
  decisions: [],
  deleted: false,
  deleted_at: null,
  deleted_reason: null,
  withdrawn_by: null,
  withdrawn_at: null,
  withdrawn_reason: null,
  created_at: '2027-01-04T03:00:00.000Z',
  created_by: TENANT.membershipId,
  updated_at: '2027-01-04T03:00:00.000Z',
  project: { id: PROJECT, code: 'DA-2027-001', name: 'Cầu qua sông', status: 'IMPLEMENTATION' },
  period: { id: PERIOD, code: '2027-W01', period_type: 'WEEK', fiscal_year: 2027, start_date: '2027-01-04', end_date: '2027-01-10', status: 'OPEN' },
  plan_version: { id: PLAN_VERSION, fiscal_year: 2027, revision: 2, status: 'PUBLISHED' },
  funding_lines: fxCells(),
  totals: { allocated_vnd: '850000000', cumulative_vnd: '420000000', ctmtqg_vnd: '40000000', next_month_vnd: '5000000', next_month_ctmtqg_vnd: '0' },
  needs_explanation: false,
  progress: null,
  narrative: null,
  attachments: [],
  review: { blocking: false, errors: [], warnings: [] },
  ...overrides,
});

/** The volumes of a report as the server answers them. */
export const progressRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  construction_vnd: '300000000',
  acceptance_vnd: '200000000',
  treasury_submitted_vnd: '150000000',
  preparing_dossier_vnd: '50000000',
  physical_progress_pct: '37.50',
  as_of_date: '2027-01-10',
  measurement_basis: 'YTD',
  ...overrides,
});

/** A file attached to a report as the server answers it. */
export const fileRecord = (n = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0048', n),
  file_object_id: uuid('0047', n),
  file_sha256: 'a'.repeat(64),
  file_name: `voucher-${n}.pdf`,
  content_type: 'application/pdf',
  size_bytes: 2048,
  position: n,
  created_at: '2027-01-05T03:00:00.000Z',
  ...overrides,
});

/** A report as the list answers it. */
export const lineRecord = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0045', n),
  project: { id: PROJECT, code: `DA-2027-00${n}`, name: `Cầu số ${n}` },
  period: { id: PERIOD, code: '2027-W01', end_date: '2027-01-10', fiscal_year: 2027, status: 'OPEN' },
  plan_version_id: PLAN_VERSION,
  revision: 1,
  status: 'DRAFT',
  report_type: 'WEEKLY',
  is_late: false,
  version: 1,
  cumulative_vnd: '420000000',
  ctmtqg_vnd: '40000000',
  created_at: '2027-01-04T03:00:00.000Z',
  updated_at: '2027-01-05T03:00:00.000Z',
  ...overrides,
});

export const kpiRecord = (reports: number, projects: number, cumulative: string, ctmtqg: string): Record<string, unknown> => ({ reports, projects, cumulative_vnd: cumulative, ctmtqg_vnd: ctmtqg });

export const pageRecord = (items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  items,
  next_cursor: null,
  summary: { filtered: kpiRecord(items.length, 1, '840000000', '80000000'), scope: kpiRecord(items.length, 1, '840000000', '80000000'), is_filtered: false, filters: {} },
  ...extra,
});

export const period = (id: string, code: string, status: string, year = 2027) => ({
  id,
  code,
  calendar_code: 'DEFAULT',
  period_type: 'WEEK',
  fiscal_year: year,
  start_date: `${year}-01-04`,
  end_date: `${year}-01-10`,
  deadline_at: '2099-01-09T03:00:00.000Z',
  calendar_version: 1,
  calendar_version_id: uuid('0046', 1),
  status,
  soft_closed_at: null,
  locked_at: null,
  locked_by: null,
  version: 1,
  reopens: [],
});

export interface World {
  /** The reports by id, as `getReportRevision` answers them. */
  details: Record<string, Record<string, unknown>>;
  /** The batches of the bulk import by id, as `getReportImport` answers them. */
  imports: Record<string, Record<string, unknown>>;
  /** The answer of `listPeriodSnapshots` for a period, by the id of the period. */
  snapshots: Record<string, Record<string, unknown>>;
  /** The pages of `listPeriodSnapshotLines` for a snapshot, by id and by cursor (`''` is the first page). */
  snapshotLines: Record<string, Record<string, Record<string, unknown>>>;
  /** The rules of `listEarlyWarningRules`, and the pages of `listEarlyWarnings` by query (a function of the query, or one answer for all). */
  rules: Array<Record<string, unknown>>;
  warnings: Record<string, unknown> | ((query: Record<string, unknown>) => unknown);
  /** The pages of `listWeeklyDisbursementPlans` by query (a function of the query, or one answer for all). */
  weekly: Record<string, unknown> | ((query: Record<string, unknown>) => unknown);
  /** The terms of the business glossary, as `listGlossaryTerms` answers them. */
  glossary: Array<Record<string, unknown>>;
  /** The answer of `getDisbursementRates`, or one for each query; none answers 404. */
  rates: Record<string, unknown> | ((query: Record<string, unknown>) => unknown) | undefined;
  /** The drafts that were deleted and can still be restored, as the list answers them for `deleted=true`. */
  deleted: Array<Record<string, unknown>>;
  /** The page the list answers for a query, or one for every query. */
  page: Record<string, unknown> | ((query: Record<string, unknown>) => Record<string, unknown>);
  periods: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  /** Reads that fail, by operation, with the error they fail with. */
  failing: Map<string, Error>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    details: {},
    imports: {},
    snapshots: {},
    snapshotLines: {},
    rates: undefined,
    glossary: [],
    rules: [],
    warnings: { items: [], next_cursor: null },
    weekly: { plan_year: 2027, items: [], next_cursor: null },
    deleted: [],
    page: pageRecord([]),
    periods: [period(PERIOD, '2027-W01', 'OPEN'), period(PERIOD_LOCKED, '2027-W02', 'LOCKED')],
    projects: [
      { id: PROJECT, code: 'DA-2027-001', name: 'Cầu qua sông', status: 'IMPLEMENTATION', version: 1 },
      { id: PROJECT_TWO, code: 'DA-2027-002', name: 'Đường tỉnh', status: 'IMPLEMENTATION', version: 1 },
    ],
    plans: [{ id: PLAN, plan_code: 'KH-2027', plan_kind: 'ANNUAL', plan_year: 2027, revision: 1 }],
    failing: new Map(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' })): Harness {
  const h = baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    if (operation === 'getReportRevision') {
      return state.details[(input as { path: { id: string } }).path.id] ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
    }
    if (operation === 'getReportImport') {
      return state.imports[(input as { path: { id: string } }).path.id] ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
    }
    if (operation === 'getDisbursementRates') {
      const query = (input as { query?: Record<string, unknown> }).query ?? {};
      const answer = typeof state.rates === 'function' ? state.rates(query) : state.rates;
      return answer ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
    }
    if (operation === 'listEarlyWarningRules') return { items: state.rules, next_cursor: null };
    if (operation === 'listEarlyWarnings') {
      const query = (input as { query?: Record<string, unknown> }).query ?? {};
      return typeof state.warnings === 'function' ? state.warnings(query) : state.warnings;
    }
    if (operation === 'listWeeklyDisbursementPlans') {
      const query = (input as { query?: Record<string, unknown> }).query ?? {};
      return typeof state.weekly === 'function' ? state.weekly(query) : state.weekly;
    }
    if (operation === 'listPeriodSnapshots') {
      const periodId = String((input as { query?: { period_id?: string } }).query?.period_id ?? '');
      return state.snapshots[periodId] ?? { items: [], next_cursor: null, pending_reports: [] };
    }
    if (operation === 'listPeriodSnapshotLines') {
      const request = input as { path: { id: string }; query?: { cursor?: string } };
      return state.snapshotLines[request.path.id]?.[request.query?.cursor ?? ''] ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
    }
    if (operation === 'get_resources_report_revision') {
      const query = (input as { query?: Record<string, unknown> }).query ?? {};
      return typeof state.page === 'function' ? state.page(query) : state.page;
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: { query?: Record<string, unknown> }) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return Promise.reject(failure);
    if (operation === 'get_resources_report_revision') {
      if (input?.query?.deleted === true) return Promise.resolve(state.deleted);
      const page = typeof state.page === 'function' ? state.page(input?.query ?? {}) : state.page;
      return Promise.resolve(Array.isArray(page.items) ? page.items : []);
    }
    if (operation === 'listGlossaryTerms') return Promise.resolve(state.glossary);
    if (operation === 'get_resources_reporting_period') return Promise.resolve(state.periods);
    if (operation === 'get_resources_project') return Promise.resolve(state.projects);
    if (operation === 'get_resources_plan_version') return Promise.resolve(state.plans);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}

export interface SessionOptions {
  permissions: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
}

/** Shows where the router is, so that a test can see a screen send the person on. */
function Where() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

export function mount(screen: ReactElement, h: Harness, options: SessionOptions): RenderResult & { queries: QueryClient } {
  const session: SessionValue = {
    tenant: TENANT,
    tenants: [TENANT],
    user: { displayName: 'Nguyễn Văn An', initials: 'NA' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions: options.permissions,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    queries,
    ...render(
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={[options.path ?? '/dis/dis-01']}>
              <Where />
              <Routes>
                <Route path="/dis/dis-01" element={screen} />
                <Route path="/dis/dis-02" element={screen} />
                <Route path="/dis/dis-03" element={screen} />
                <Route path="/dis/dis-04" element={screen} />
                <Route path="/dis/dis-05" element={screen} />
                <Route path="/dis/dis-06" element={screen} />
                <Route path="/dis/dis-07" element={screen} />
                <Route path="/dis/dis-08" element={screen} />
                <Route path="/dis/dis-09" element={screen} />
                <Route path="/dis/dis-10" element={screen} />
                <Route path="/dis/dis-11" element={screen} />
                <Route path="/dis/dis-18" element={screen} />
                <Route path="/dis/dis-12" element={screen} />
                <Route path="/dis/dis-16" element={screen} />
                <Route path="/dis/dis-19" element={screen} />
                <Route path="/dis/dis-20" element={screen} />
                <Route path="/dis/dis-21" element={screen} />
                <Route path="/dis/dis-24" element={screen} />
                <Route path="/dis/dis-25" element={screen} />
                <Route path="*" element={<p data-testid="elsewhere" />} />
              </Routes>
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    ),
  };
}
