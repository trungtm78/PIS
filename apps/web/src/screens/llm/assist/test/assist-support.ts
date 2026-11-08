import { ApiError } from '@machvon/api-client';
import { harness } from '../../../sas/test-support';
import type { Harness } from '../../../sas/test-support';
import type { WebRoute } from '../../../../routes/types';
import { vi } from 'vitest';

export { mount } from '../../../bid/test-support';
export type { Harness };

export const routeOf = (id: string): WebRoute => ({ id, path: `/llm/${id.toLowerCase()}`, title: id, kind: 'ai', area: 'admin', module: 'LLM', group: 'Assistant', role: 'workspace', parent: null, req: `FR-${id}` });

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const AS_OF = '2026-11-08T03:00:00.000Z';
export const WHEN = '2026-11-08T03:05:00.000Z';

export const error = (status: number, code: string, detail?: string): ApiError => new ApiError({ status, code, correlationId: 'c-1', ...(detail === undefined ? {} : { detail }) });
export const FORBIDDEN = error(403, 'SCOPE_DENIED');

// ---- fixtures of the assistant -----------------------------------------------------------------------------------------------------------------------------------------------

export const citation = (over: Record<string, unknown> = {}) => ({ kind: 'DOCUMENT_VERSION', id: uuid(101), locator: 'page:3', quote: 'the exact words of the page', excerpt: 'The beginning of the page', title: 'Feasibility report', ...over });

export const statement = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: `Statement ${id}`,
  claimed_basis: 'SOURCE',
  presented_as: 'SOURCE',
  verification: 'VERIFIED',
  citations: [citation()],
  depends_on: [],
  problems: [],
  section: null,
  item_code: null,
  criterion_code: null,
  result: null,
  score: null,
  ...over,
});

export const unsupportedStatement = (id: string, over: Record<string, unknown> = {}) =>
  statement(id, { text: `Claim without source ${id}`, claimed_basis: 'SOURCE', presented_as: 'UNSUPPORTED', verification: 'UNSUPPORTED', citations: [], problems: ['QUOTE_NOT_FOUND'], ...over });

export const assumption = (id: string) => statement(id, { text: `Assumption ${id}`, claimed_basis: 'ASSUMPTION', presented_as: 'ASSUMPTION', verification: 'ASSUMPTION_OPEN', citations: [] });
export const inference = (id: string, dependsOn: string[]) => statement(id, { text: `Inference ${id}`, claimed_basis: 'INFERENCE', presented_as: 'INFERENCE', verification: 'VERIFIED', citations: [], depends_on: dependsOn });

export function countsOf(given: unknown, over: Record<string, unknown> = {}) {
  const statements = Array.isArray(given) ? (given as ReadonlyArray<Record<string, unknown>>) : [];
  return {
    statements: statements.length,
    verified: statements.filter((entry) => entry.verification === 'VERIFIED').length,
    unsupported: statements.filter((entry) => entry.verification === 'UNSUPPORTED').length,
    assumptions: statements.filter((entry) => entry.presented_as === 'ASSUMPTION').length,
    withheld_citations: 0,
    injection_signals: 0,
    ...over,
  };
}

export const RESULT = { open_questions: [], signals: { count: 0, kinds: [] }, truncated: false, included_parts: 3 };

/** A run of the assistant as the API returns it; the statements give the counts unless the test says otherwise. */
export function run(n: number, over: Record<string, unknown> = {}) {
  const statements = (over.statements as Array<Record<string, unknown>> | undefined) ?? [statement('s1'), unsupportedStatement('s2')];
  return {
    id: uuid(n),
    kind: 'QA',
    status: 'COMPLETED',
    refusal_code: null,
    advisory: true,
    request_text: 'What is the total investment of the project?',
    subject_id: null,
    checklist_id: null,
    criteria_set_id: null,
    ai_request_id: uuid(900 + n),
    data_classification: 'CONFIDENTIAL',
    route_class: 'DOMESTIC_HOSTED',
    sources: [{ kind: 'PROJECT', id: uuid(201), title: 'Road project', classification: 'CONFIDENTIAL' }],
    statements,
    result: RESULT,
    counts: countsOf(statements),
    completeness: 'PARTIAL',
    decision: null,
    decision_status: null,
    asked_by: uuid(800),
    created_at: AS_OF,
    ...over,
  };
}

export const decisionView = (decision: string, over: Record<string, unknown> = {}) => ({
  id: uuid(700),
  decision,
  rationale: 'The figures agree with the report of the project.',
  items: [],
  accepted_result: { kept_statements: ['s1'] },
  decided_by: uuid(801),
  decided_at: WHEN,
  ...over,
});

export const reviewItem = (code: string, over: Record<string, unknown> = {}) => ({ item_code: code, label: `Check ${code}`, kind: 'REQUIRED_TERMS', severity: 'BLOCKER', result: 'PASS', by: 'COMPUTED', detail: null, statement_id: null, citations: [], ...over });

export function reviewRun(n: number, items: Array<Record<string, unknown>>, verdict: string, over: Record<string, unknown> = {}) {
  const statements = (over.statements as Array<Record<string, unknown>> | undefined) ?? [];
  return run(n, {
    kind: 'DOC_REVIEW',
    request_text: '',
    checklist_id: uuid(301),
    statements,
    result: {
      ...RESULT,
      review: {
        items,
        verdict,
        counts: { pass: items.filter((item) => item.result === 'PASS').length, fail: items.filter((item) => item.result === 'FAIL').length, unknown: items.filter((item) => item.result === 'UNKNOWN').length, blockers_open: items.filter((item) => item.severity === 'BLOCKER' && item.result !== 'PASS').length },
        advisory: true,
      },
    },
    counts: countsOf(statements),
    completeness: 'FULL',
    ...over,
  });
}

export const proposal = (code: string, weight: number, score: number | null, status = 'PROPOSED', over: Record<string, unknown> = {}) => ({
  criterion_code: code,
  label: `Criterion ${code}`,
  weight_bp: weight,
  proposed_score: score,
  status,
  statement_id: `s-${code}`,
  citations: score === null ? [] : [citation({ locator: `field:${code.toLowerCase()}` })],
  ...over,
});

export function evalRun(n: number, criteria: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  const statements = (over.statements as Array<Record<string, unknown>> | undefined) ?? criteria.map((entry) => statement(String(entry.statement_id), { criterion_code: entry.criterion_code, score: entry.proposed_score }));
  return run(n, {
    kind: 'CONTRACT_EVAL',
    request_text: '',
    criteria_set_id: uuid(401),
    statements,
    result: { ...RESULT, evaluation: { criteria_set: { id: uuid(401), code: 'PERF', revision: 1, title: 'Performance' }, scale_max: 100, criteria } },
    counts: countsOf(statements),
    completeness: 'FULL',
    ...over,
  });
}

export const checklist = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(300 + n),
  code: `CHK${n}`,
  revision: 1,
  title: `Checklist ${n}`,
  applies_to: 'PROJECT_DOSSIER',
  status: 'PUBLISHED',
  items: [
    { code: 'TERMS', label: 'Has the required terms', kind: 'REQUIRED_TERMS', severity: 'BLOCKER', params: { terms: ['budget', 'schedule'], match: 'ALL' } },
    { code: 'WORDS', label: 'Is long enough', kind: 'MIN_WORDS', severity: 'WARNING', params: { min: 200 } },
    { code: 'ASK', label: 'Names the owner', kind: 'AI_QUESTION', severity: 'INFO', params: { question: 'Who owns the project?' } },
  ],
  created_by: uuid(810),
  created_at: AS_OF,
  published_by: over.status === 'DRAFT' ? null : uuid(811),
  published_at: over.status === 'DRAFT' ? null : WHEN,
  version: 3,
  ...over,
});

export const criteriaSet = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(400 + n),
  code: `SET${n}`,
  revision: 1,
  title: `Criteria ${n}`,
  scale_max: 100,
  status: 'PUBLISHED',
  criteria: [
    { code: 'QUALITY', label: 'Quality', guidance: 'Look at the acceptance records', weight_bp: 6000, evidence_required: true },
    { code: 'TIME', label: 'Time', guidance: '', weight_bp: 4000, evidence_required: true },
  ],
  weights_total_bp: 10000,
  created_by: uuid(810),
  created_at: AS_OF,
  published_by: over.status === 'DRAFT' ? null : uuid(811),
  published_at: over.status === 'DRAFT' ? null : WHEN,
  version: 2,
  ...over,
});

export const provider = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(500 + n),
  provider_code: `PRV${n}`,
  name: `Provider ${n}`,
  region_country: 'SG',
  route_class: 'INTERNATIONAL',
  max_classification: 'PUBLIC',
  status: 'ACTIVE',
  data_location_country: null,
  data_location_detail: null,
  no_training_attested: null,
  attestation_ref: null,
  attested_by: null,
  attested_at: null,
  version: 4,
  ...over,
});

export const attestedProvider = (n: number, over: Record<string, unknown> = {}) =>
  provider(n, { data_location_country: 'SG', data_location_detail: 'Region ap-1', no_training_attested: true, attestation_ref: 'ATT-2026-01', attested_by: uuid(820), attested_at: WHEN, ...over });

export const exceptionUse = (n: number, over: Record<string, unknown> = {}) => ({ id: uuid(600 + n), ai_request_id: uuid(650 + n), task_type: 'AI_ASSIST_QA', data_classification: 'PUBLIC', route_class: 'INTERNATIONAL', used_at: WHEN, ...over });

export const exception = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(550 + n),
  provider_id: uuid(501),
  provider_code: 'PRV1',
  route_class: 'INTERNATIONAL',
  task_type: 'AI_ASSIST_QA',
  max_classification: 'PUBLIC',
  reason: 'Public statistics are summarised by the external model.',
  requested_by: uuid(830),
  requested_at: AS_OF,
  requested_valid_days: 30,
  status: 'REQUESTED',
  in_force: false,
  decided_by: null,
  decided_at: null,
  decision_note: null,
  approval_ref: null,
  valid_from: null,
  valid_until: null,
  revoked_by: null,
  revoked_at: null,
  revoke_reason: null,
  use_count: 0,
  uses: [],
  version: 1,
  ...over,
});

export const approvedException = (n: number, over: Record<string, unknown> = {}) =>
  exception(n, { status: 'APPROVED', in_force: true, decided_by: uuid(831), decided_at: WHEN, approval_ref: 'DEC-2026-77', valid_from: WHEN, valid_until: '2026-12-08T03:00:00.000Z', use_count: 2, uses: [exceptionUse(1), exceptionUse(2)], version: 2, ...over });

// ---- the world and its client -------------------------------------------------------------------------------------------------------------------------------------------------

export interface World {
  /** The runs of the history, newest first; a run is also read by its id from here. */
  runs: Array<Record<string, unknown>>;
  checklists: Array<Record<string, unknown>>;
  criteria: Array<Record<string, unknown>>;
  providers: Array<Record<string, unknown>>;
  exceptions: Array<Record<string, unknown>>;
  policy: Record<string, unknown>;
  /** Reads that fail, by operation name, with the error to reject with. */
  failing: Map<string, Error>;
  /** Reads that never answer (the loading state). */
  never: Set<string>;
}

export function world(over: Partial<World> = {}): World {
  return {
    runs: [],
    checklists: [checklist(1)],
    criteria: [criteriaSet(1)],
    providers: [provider(1)],
    exceptions: [],
    policy: { name: 'enterprise', external_routing: 'EXCEPTION_REQUIRED', attestation_required: true },
    failing: new Map(),
    never: new Set(),
    ...over,
  };
}

const page = (items: unknown[]) => ({ items, next_cursor: null, as_of: AS_OF });

function answer(state: World, operation: string, input: unknown): unknown {
  const failure = state.failing.get(operation);
  if (failure !== undefined) return failure;
  if (state.never.has(operation)) return new Promise(() => undefined);
  const query = (input as { query?: Record<string, unknown>; path?: { id?: string } } | undefined)?.query ?? {};
  const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
  switch (operation) {
    case 'listAiAssistRuns':
      return page(state.runs.filter((entry) => (query.kind === undefined || entry.kind === query.kind) && (query.status === undefined || entry.status === query.status)));
    case 'getAiAssistRun':
      return state.runs.find((entry) => entry.id === id) ?? error(404, 'RESOURCE_NOT_FOUND');
    case 'getAiEditionPolicy':
      return state.policy;
    case 'getAiExternalException':
      return state.exceptions.find((entry) => entry.id === id) ?? error(404, 'RESOURCE_NOT_FOUND');
    default:
      return new Error(`unexpected read ${operation}`);
  }
}

function answerAll(state: World, operation: string, input: unknown): unknown[] | Error {
  const failure = state.failing.get(operation);
  if (failure !== undefined) return failure;
  const query = (input as { query?: Record<string, unknown> } | undefined)?.query ?? {};
  const byStatus = (rows: Array<Record<string, unknown>>) => rows.filter((entry) => query.status === undefined || entry.status === query.status);
  switch (operation) {
    case 'listAiReviewChecklists':
      return byStatus(state.checklists);
    case 'listAiEvalCriteriaSets':
      return byStatus(state.criteria);
    case 'listAiProviders':
      return state.providers;
    case 'listAiExternalExceptions':
      return byStatus(state.exceptions);
    default:
      return new Error(`unexpected readAll ${operation}`);
  }
}

/** A client over `state`: reads and lists are answered from it, `command(operation, input)` answers the commands (a value, or an Error to reject with). */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'OK', resource_version: 5 })): Harness {
  const h = harness((operation, input) => answer(state, operation, input), command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: unknown) => {
    if (state.never.has(operation)) return new Promise(() => undefined);
    const rows = answerAll(state, operation, input);
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
  });
  return h;
}

export const readAllOf = (h: Harness): ReturnType<typeof vi.fn> => (h.client as unknown as { readAll: ReturnType<typeof vi.fn> }).readAll;
