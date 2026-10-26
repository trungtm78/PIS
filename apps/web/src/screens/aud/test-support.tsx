import { ApiError } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import type { WebRoute } from '../../routes/types';
import { SessionContext } from '../../session/SessionContext';
import type { SessionTenant, SessionValue } from '../../session/SessionContext';
import { harness as baseHarness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export type { Harness };

export const TENANT: SessionTenant = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'Cao Bang',
  monogram: 'CB',
  membershipId: '00000000-0000-4000-8000-000000000001',
  theme: { themeId: 'tenant', version: 1, overlay: {} },
};

export const MANAGER = ['aud.engagement.manage', 'aud.read'];
export const RECORDER = ['aud.conclusion.record', 'aud.read'];
export const LEADER = ['aud.recommendation.assign', 'aud.read'];
export const OWNER_ROLE = ['aud.recommendation.execute', 'aud.read'];
export const VERIFIER_ROLE = ['aud.recommendation.verify', 'aud.read'];
export const ACCOUNTANT_ROLE = ['aud.recovery.record', 'aud.read'];
export const READER = ['aud.read'];

export const routeOf = (id: string, req: string): WebRoute => ({
  id,
  path: `/aud/${id.toLowerCase()}`,
  title: id,
  kind: id === 'AUD-03' ? 'detail' : id === 'AUD-04' ? 'form' : id === 'AUD-07' ? 'board' : id === 'AUD-01' ? 'dashboard' : id === 'AUD-08' ? 'reconcile' : id === 'AUD-10' ? 'approval' : 'table',
  area: 'insights',
  module: 'AUD',
  group: 'Cuộc thanh tra, kiểm toán',
  role: id === 'AUD-03' ? 'detail' : 'workspace',
  parent: id === 'AUD-03' ? 'AUD-02' : null,
  req,
});

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0001', 1);
export const CONTRACT = uuid('0002', 1);
export const UNIT = uuid('0003', 1);
export const DECISION = uuid('0004', 1);
export const SELF = TENANT.membershipId;
export const OTHER_PERSON = uuid('0005', 2);

/** An engagement as the list answers it. */
export const engagementRecord = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0010', n),
  engagement_code: `TTCP-2026-${String(n).padStart(3, '0')}`,
  engagement_type: 'ADMINISTRATIVE_INSPECTION',
  authority_kind: 'PROVINCIAL_INSPECTORATE',
  authority_name: 'Thanh tra tỉnh Cao Bằng',
  title: `Thanh tra đầu tư cầu số ${n}`,
  period_from: '2025-01-01',
  period_to: '2025-12-31',
  status: 'PLANNED',
  coordinator: { id: SELF, display_name: 'Nguyễn Văn An' },
  legal_hold: null,
  scope_count: 2,
  version: 1,
  ...overrides,
});

/** The file of an engagement: the line with its decision, days and scope. */
export const detailRecord = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...engagementRecord(n),
  decision: { document_id: DECISION, title: 'Quyết định thanh tra cầu', symbol: '12/QD-TTCP', issued_on: '2026-01-15', effect_status: 'EFFECTIVE' },
  started_on: null,
  fieldwork_ended_on: null,
  closed_on: null,
  cancel_reason: null,
  classification: 'CONFIDENTIAL',
  scope: [
    { kind: 'CONTRACT', id: CONTRACT, code: 'HD-A-001', name: 'Hợp đồng thi công cầu' },
    { kind: 'PROJECT', id: PROJECT, code: 'DA-2026-001', name: 'Cầu qua sông' },
  ],
  created_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

/** The conclusion of an engagement as the read answers it: the total, what the recommendations add up to and what is left. */
export const conclusionRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0020', 1),
  engagement_id: uuid('0010', 1),
  conclusion_kind: 'AUDIT_REPORT',
  document: { id: uuid('0021', 1), title: 'Báo cáo kiểm toán cầu', symbol: '88/BC-KTNN' },
  revision: 1,
  supersedes_id: null,
  issued_on: '2026-10-10',
  received_on: '2026-10-15',
  implementation_due_on: '2026-12-31',
  report_due_on: '2027-01-15',
  summary: 'Kiểm toán phát hiện thanh toán vượt khối lượng được duyệt.',
  total_financial_vnd: '1250000000',
  recommended_vnd: '1200000000',
  shortfall_vnd: '50000000',
  is_public: false,
  status: 'RECEIVED',
  finding_count: 1,
  recommendation_count: 2,
  version: 1,
  ...overrides,
});

export const findingRecord = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0022', n),
  conclusion_id: uuid('0020', 1),
  finding_code: `PH-${String(n).padStart(3, '0')}`,
  category: 'FINANCIAL',
  project: { id: PROJECT, code: 'DA-2026-001', name: 'Cầu qua sông' },
  contract: null,
  organization_unit: { id: UNIT, code: 'SXD', name: 'Sở Xây dựng' },
  description: 'Thanh toán vượt khối lượng nghiệm thu.',
  legal_basis_cited: 'Điều 12 Luật Đầu tư công',
  amount_vnd: '300000000',
  severity: 'HIGH',
  created_at: '2026-10-16T00:00:00Z',
  ...overrides,
});

export const recommendationRecord = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0023', n),
  conclusion_id: uuid('0020', 1),
  finding_id: null,
  rec_code: `KN-${String(n).padStart(3, '0')}`,
  rec_type: 'FINANCIAL_RECOVERY',
  description: 'Thu hồi khoản thanh toán vượt khối lượng.',
  amount_vnd: '800000000',
  recovered_vnd: '0',
  project_id: null,
  owner_unit_id: null,
  due_on: null,
  status: 'OPEN',
  is_overdue: false,
  created_at: '2026-10-16T00:00:00Z',
  ...overrides,
});

/** A recommendation as the board and the table read it: the owner, the day, the dispute and the actions with their evidence. */
export const boardRecord = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...recommendationRecord(n),
  engagement: { id: uuid('0010', 1), engagement_code: 'TTCP-2026-001' },
  owner_unit_id: UNIT,
  owner_unit: { id: UNIT, code: 'SXD', name: 'Sở Xây dựng' },
  owner_user: { id: SELF, display_name: 'Nguyễn Văn An' },
  due_on: '2026-12-01',
  implementation_due_on: '2026-12-31',
  dispute_reason: null,
  dispute_outcome: null,
  verification_note: null,
  submitted_by: null,
  disputed_by: null,
  actions: [],
  evidence_count: 0,
  version: 3,
  ...overrides,
});

export const actionRecord = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0024', n),
  action_code: `HD-${String(n).padStart(2, '0')}`,
  description: 'Chấn chỉnh quy trình thanh toán.',
  planned_on: '2026-11-15',
  completed_on: null,
  status: 'PLANNED',
  evidence_document_id: null,
  version: 1,
  ...overrides,
});

/** A rate with its numerator and its denominator. */
export const rateRecord = (numerator: string, denominator: string, percent: string | null): Record<string, unknown> => ({ numerator, denominator, percent });

/** The money of an engagement as the summary answers it: 800,000,000 recommended, 500,000,000 recovered. */
export const summaryRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  engagement_id: uuid('0010', 1),
  amount_vnd: '800000000',
  recovered_vnd: '500000000',
  remaining_vnd: '300000000',
  money_rate: rateRecord('500000000', '800000000', '62.50'),
  count_rate: rateRecord('0', '1', '0.00'),
  recommendations: [{ recommendation_id: uuid('0023', 1), rec_code: 'KN-001', status: 'IN_PROGRESS', amount_vnd: '800000000', recovered_vnd: '500000000', remaining_vnd: '300000000', line_count: 1, version: 6 }],
  exceptions: [],
  ...overrides,
});

/** A line of the ledger as the list answers it. */
export const linkRecord = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0025', n),
  recommendation_id: uuid('0023', 1),
  rec_code: 'KN-001',
  source_kind: 'PAY_RECOVERY',
  source_id: uuid('0026', n),
  amount_vnd: '500000000',
  recorded_on: '2026-10-20',
  evidence_document_id: null,
  reversal_of_id: null,
  reversed: false,
  note: null,
  recorded_by: SELF,
  recorded_at: '2026-10-20T03:00:00Z',
  cumulative_vnd: '500000000',
  remaining_vnd: '300000000',
  ...overrides,
});

export const overviewRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  engagements_ongoing: 2,
  engagements_follow_up: 3,
  recommendations_open: 7,
  recommendations_overdue: 2,
  amount_vnd: '1250000000',
  recovered_vnd: '500000000',
  remaining_vnd: '750000000',
  money_rate: rateRecord('500000000', '1250000000', '40.00'),
  count_rate: rateRecord('1', '8', '12.50'),
  exceptions_open: 0,
  engagements: [{ id: uuid('0010', 1), engagement_code: 'TTCP-2026-001', title: 'Thanh tra đầu tư cầu số 1', status: 'FOLLOW_UP', recommendations_open: 4, recommendations_overdue: 2, amount_vnd: '800000000', recovered_vnd: '500000000' }],
  ...overrides,
});

/** The figures frozen with a report: R1 and R3 closed, R2 in progress, 1,200,000,000 recommended and 1,100,000,000 recovered. */
export const reportTotalsRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  as_of_date: '2027-01-04',
  total: 3,
  closed: 2,
  in_progress: 1,
  open: 0,
  disputed: 0,
  amount: '1200000000',
  recovered: '1100000000',
  remaining: '100000000',
  money_rate: rateRecord('1100000000', '1200000000', '91.67'),
  count_rate: rateRecord('2', '3', '66.67'),
  ...overrides,
});

/** A report as the list answers it: asked of DOC and waiting for it. */
export const reportRecord = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid('0030', n),
  conclusion_id: uuid('0020', 1),
  conclusion_symbol: '88/BC-KTNN',
  as_of_date: '2027-01-04',
  revision: 1,
  status: 'ISSUE_REQUESTED',
  totals: reportTotalsRecord(),
  payload_sha256: `${String(n)}abcdef012345`.padEnd(64, 'f'),
  source_ref: `AUD:audit_follow_up_report:${uuid('0030', n)}:r1`,
  report_document_id: null,
  reject_code: null,
  requested_by: { id: SELF, display_name: 'Nguyễn Văn An' },
  approved_by: null,
  requested_at: '2027-01-04T03:00:00Z',
  issued_at: null,
  version: 1,
  ...overrides,
});

export interface World {
  /** The reports of an engagement, by its id. */
  reports: Record<string, Array<Record<string, unknown>>>;
  /** The money of an engagement, by its id. */
  summaries: Record<string, Record<string, unknown>>;
  /** The lines of the ledger of an engagement, by its id. */
  links: Record<string, Array<Record<string, unknown>>>;
  /** The overview, or none (the read answers 404). */
  overview: Record<string, unknown> | undefined;
  /** The recommendations as the board reads them (no conclusion named), by any engagement. */
  board: Array<Record<string, unknown>>;
  engagements: Array<Record<string, unknown>>;
  details: Record<string, Record<string, unknown>>;
  /** The conclusions of an engagement, by the id of the engagement. */
  conclusions: Record<string, Array<Record<string, unknown>>>;
  /** The findings of a conclusion, by the id of the conclusion. */
  findings: Record<string, Array<Record<string, unknown>>>;
  /** The recommendations of a conclusion, by the id of the conclusion. */
  recommendations: Record<string, Array<Record<string, unknown>>>;
  projects: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  /** Reads that fail, by operation, with the error they fail with. */
  failing: Map<string, Error>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    reports: {},
    summaries: {},
    links: {},
    overview: undefined,
    board: [],
    engagements: [],
    details: {},
    conclusions: {},
    findings: {},
    recommendations: {},
    projects: [{ id: PROJECT, code: 'DA-2026-001', name: 'Cầu qua sông' }],
    contracts: [{ id: CONTRACT, code: 'HD-A-001', title: 'Hợp đồng thi công cầu' }],
    units: [{ id: UNIT, code: 'SXD', name: 'Sở Xây dựng' }],
    members: [
      { id: SELF, display_name: 'Nguyễn Văn An', status: 'Active' },
      { id: OTHER_PERSON, display_name: 'Trần Thị Bình', status: 'Active' },
      { id: uuid('0005', 3), display_name: 'Người đã nghỉ', status: 'Ended' },
    ],
    failing: new Map(),
    ...overrides,
  };
}

/** A client over `state`: the list and the options come from it, a file is read by its id (404 when it is not there), and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    const missing = new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
    if (operation === 'getAuditOverview') return state.overview ?? missing;
    if (operation === 'getAuditRecoverySummary') return state.summaries[(input as { path: { id: string } }).path.id] ?? missing;
    if (operation !== 'getAuditEngagement') return new Error(`unexpected read ${operation}`);
    return state.details[(input as { path: { id: string } }).path.id] ?? missing;
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: { query?: Record<string, string>; path?: { id: string } }) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return Promise.reject(failure);
    switch (operation) {
      case 'listAuditEngagements':
        return Promise.resolve(state.engagements.filter((item) => (input?.query?.status ?? item.status) === item.status && (input?.query?.engagement_type ?? item.engagement_type) === item.engagement_type));
      case 'listAuditRecoveryLinks':
        return Promise.resolve(state.links[input?.path?.id ?? ''] ?? []);
      case 'listAuditFollowUpReports':
        return Promise.resolve(state.reports[input?.path?.id ?? ''] ?? []);
      case 'listAuditConclusions':
        return Promise.resolve(state.conclusions[input?.path?.id ?? ''] ?? []);
      case 'listAuditFindings':
        return Promise.resolve(state.findings[input?.path?.id ?? ''] ?? []);
      case 'listAuditRecommendations':
        if (input?.query?.conclusion_id !== undefined) return Promise.resolve(state.recommendations[input.query.conclusion_id] ?? []);
        return Promise.resolve(
          state.board.filter(
            (item) =>
              (input?.query?.engagement_id === undefined || (item.engagement as { id: string }).id === input.query.engagement_id) &&
              (input?.query?.status === undefined || item.status === input.query.status) &&
              (input?.query?.rec_type === undefined || item.rec_type === input.query.rec_type),
          ),
        );
      case 'get_resources_project':
        return Promise.resolve(state.projects);
      case 'get_resources_contract':
        return Promise.resolve(state.contracts);
      case 'get_resources_organization_unit':
        return Promise.resolve(state.units);
      case 'get_resources_membership':
        return Promise.resolve(state.members);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

export interface SessionOptions {
  permissions: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
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
            <MemoryRouter initialEntries={[options.path ?? '/aud/aud-02']}>
              <Routes>
                <Route path="*" element={screen} />
              </Routes>
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    ),
  };
}
