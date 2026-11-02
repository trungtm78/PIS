import { ApiError } from '@machvon/api-client';
import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { TENANT } from '../test-support';

export { mount, routeOf } from '../test-support';
export type { Harness };

/** An evaluator who may ask for a run, read the runs and the evidence, cancel a run, read the OCR gate and the criteria. */
export const EVALUATOR = ['bid.read', 'bid.evaluate', 'ai.analyze', 'ai.cancel', 'analysis_run.read', 'bid.ocr.read', 'criteria_version.read'];
/** Someone who may read the runs and nothing else. */
export const RUN_READER = ['analysis_run.read'];
export const NOBODY = ['bid.read'];
export const ME = TENANT.membershipId;

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0030', 1);
export const packageId = (n: number): string => uuid('0020', n);
export const proposalId = (n: number): string => uuid('0080', n);
export const versionId = (n: number): string => uuid('0070', n);
export const criteriaId = (n: number): string => uuid('0060', n);
export const runId = (n: number): string => uuid('0050', n);
export const findingId = (n: number): string => uuid('0040', n);
export const evidenceId = (n: number): string => uuid('0045', n);
export const PROFILE = uuid('0099', 1);
export const POLICY = uuid('0098', 1);

export const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}): ApiError => new ApiError({ status, code, correlationId: 'c', extensions });

export const pack = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: packageId(n),
  code: `GT-${n}`,
  title: `Gói thầu xây lắp ${n}`,
  project: { id: PROJECT, code: 'PRJ-001', name: 'Cầu qua sông', status: 'IMPLEMENTATION' },
  status: 'APPROVED',
  version: 3,
  ...overrides,
});

/** A proposal the caller has in full. */
export const proposal = (n: number, packageNumber: number, overrides: Record<string, unknown> = {}) => ({
  id: proposalId(n),
  package: { id: packageId(packageNumber), code: `GT-${packageNumber}`, title: `Gói thầu xây lắp ${packageNumber}` },
  project: { id: PROJECT, code: 'PRJ-001' },
  contractor: { id: uuid('0090', n), legal_name: `Công ty nhà thầu ${n}` },
  revision: 1,
  status: 'RECEIVED',
  submitted_at: '2026-11-10T02:00:00.000Z',
  access_released_at: '2026-11-12T02:00:00.000Z',
  locked: false,
  file_count: 1,
  classification: 'CONFIDENTIAL',
  access: 'FULL',
  conflict_standing: 'CLEAR',
  bid_price_vnd: '17650000000',
  version: 1,
  ...overrides,
});

/** A version of the criteria of a package, approved unless the overrides say otherwise. */
export const criteria = (n: number, packageNumber: number, overrides: Record<string, unknown> = {}) => ({
  id: criteriaId(n),
  package: { id: packageId(packageNumber), code: `GT-${packageNumber}`, title: `Gói thầu xây lắp ${packageNumber}`, status: 'APPROVED', project: { code: 'PRJ-001', name: 'Cầu qua sông' } },
  revision: n,
  status: 'APPROVED',
  criteria: [{ code: 'C1', name: 'Kinh nghiệm', kind: 'PASS_FAIL', weight: null, max_score: null, threshold: null, mandatory: true, required_evidence: [] }],
  weights_sum: null,
  legal_basis: 'Luật Đấu thầu',
  approved_at: '2026-11-01T02:00:00.000Z',
  version: 2,
  ...overrides,
});

export const TIMELINE_DONE = [
  { step: 'EXTRACT', state: 'DONE' },
  { step: 'MATCH', state: 'DONE' },
  { step: 'VERIFY', state: 'DONE' },
  { step: 'COMPLETE', state: 'PENDING' },
];
export const TIMELINE_FAILED = [
  { step: 'EXTRACT', state: 'DONE' },
  { step: 'MATCH', state: 'FAILED' },
  { step: 'VERIFY', state: 'SKIPPED' },
  { step: 'COMPLETE', state: 'SKIPPED' },
];

/** A run that waits for the experts, of the first proposal, with five findings of which one lacks a source. */
export const run = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: runId(n),
  proposal_id: proposalId(1),
  package: { id: packageId(1), code: 'GT-1' },
  contractor: { id: uuid('0090', 1), legal_name: 'Công ty nhà thầu 1' },
  criteria_version_id: criteriaId(1),
  profile_version_id: PROFILE,
  status: 'AWAITING_REVIEW',
  data_classification: 'CONFIDENTIAL',
  route_class: 'DOMESTIC_HOSTED',
  policy_version_id: POLICY,
  failure_code: null,
  failed_step: null,
  timeline: TIMELINE_DONE,
  supersedes_run_id: null,
  requested_by: ME,
  started_at: '2026-12-05T03:00:00.000Z',
  finished_at: '2026-12-05T03:01:00.000Z',
  cancel_reason: null,
  cost_vnd: '1234567',
  finding_count: 5,
  missing_source_count: 1,
  reviewed_count: 0,
  created_at: '2026-12-05T03:00:00.000Z',
  version: 2,
  ...overrides,
});

/** A run that ended without an answer: every model it was allowed failed. */
export const failedRun = (n: number, overrides: Record<string, unknown> = {}) =>
  run(n, { status: 'FAILED', failure_code: 'AI_ROUTE_EXHAUSTED', failed_step: 'MATCH', timeline: TIMELINE_FAILED, route_class: 'SELF_HOSTED', finding_count: 0, missing_source_count: 0, ...overrides });

export const documentEvidence = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: evidenceId(n),
  kind: 'DOCUMENT',
  document_version_id: versionId(1),
  page_index: 11,
  quote_excerpt: 'đã hoàn thành ba cây cầu',
  calc_ref: null,
  verified_present: true,
  ...overrides,
});

export const calcEvidence = (n: number) => ({
  id: evidenceId(n),
  kind: 'DETERMINISTIC_CALC',
  document_version_id: null,
  page_index: null,
  quote_excerpt: null,
  calc_ref: { id: 'price-check', kind: 'PRICE_CHECK', bid_price_vnd: '17650000000', tables: 1, matching_tables: 1 },
  verified_present: true,
});

export const finding = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: findingId(n),
  run_id: runId(1),
  criterion_id: `C${n}`,
  status: 'SUPPORTED',
  finding: `Nhận xét của tiêu chí C${n}.`,
  confidence_type: 'HEURISTIC',
  evidence_count: 1,
  missing_source: false,
  final_status: null,
  reviewed_at: null,
  created_at: '2026-12-05T03:01:00.000Z',
  evidence: [documentEvidence(n)],
  ...overrides,
});

/** A finding that claimed without a source and was taken back to NEEDS_REVIEW. */
export const unsupported = (n: number) => finding(n, { status: 'NEEDS_REVIEW', evidence_count: 0, missing_source: true, evidence: [] });

export interface World {
  packages: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  criteria: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
  /** Pages of the OCR of the proposal that wait for a person. */
  blockedPages: number;
  /** Reads that fail, by operation, with the failure they answer. */
  failing: Map<string, Error>;
  pageSize: number;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    packages: [pack(1), pack(2), pack(3, { status: 'DRAFT' })],
    proposals: [proposal(1, 1), proposal(2, 1, { access: 'METADATA' })],
    criteria: [criteria(1, 1), criteria(2, 1, { status: 'DRAFT' }), criteria(3, 2)],
    runs: [],
    findings: [],
    blockedPages: 0,
    failing: new Map(),
    pageSize: 100,
    ...overrides,
  };
}

type Query = { proposal_id?: string; status?: string; missing_source?: string; cursor?: string };

const paged = <Item>(items: Item[], query: { cursor?: string } | undefined, size: number): { items: Item[]; next_cursor: string | null } => {
  const from = query?.cursor === undefined ? 0 : Number(query.cursor);
  return { items: items.slice(from, from + size), next_cursor: from + size < items.length ? String(from + size) : null };
};

/** A client over `state`: the reads are answered from it, `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    const query = (input as { query?: Query } | undefined)?.query;
    const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
    switch (operation) {
      case 'get_resources_analysis_run':
        return {
          ...paged(
            state.runs.filter((item) => (query?.proposal_id === undefined || item.proposal_id === query.proposal_id) && (query?.status === undefined || item.status === query.status)),
            query,
            state.pageSize,
          ),
          as_of: '2026-12-05T03:00:00.000Z',
        };
      case 'get_resources_analysis_run_id':
        return state.runs.find((item) => item.id === id) ?? problem('RESOURCE_NOT_FOUND', 404);
      case 'listAnalysisFindings': {
        const found = state.runs.find((item) => item.id === id);
        if (found === undefined) return problem('RESOURCE_NOT_FOUND', 404);
        const shown = state.findings.filter((item) => (query?.status === undefined || item.status === query.status) && (query?.missing_source === undefined || String(item.missing_source) === query.missing_source));
        return { run: found, ...paged(shown, query, state.pageSize), as_of: '2026-12-05T03:00:00.000Z' };
      }
      case 'listProposalOcrPages':
        return { items: [], next_cursor: null, as_of: '2026-12-05T03:00:00.000Z', financial_ready: state.blockedPages === 0, blocked_pages: state.blockedPages, threshold: '0.850', documents: [] };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: { query?: { package_id?: string } }) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return Promise.reject(failure);
    switch (operation) {
      case 'get_resources_procurement_package':
        return Promise.resolve(state.packages);
      case 'get_resources_proposal':
        return Promise.resolve(state.proposals.filter((item) => (item.package as { id: string }).id === input?.query?.package_id));
      case 'get_resources_criteria_version':
        return Promise.resolve(state.criteria.filter((item) => (item.package as { id: string }).id === input?.query?.package_id));
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}
