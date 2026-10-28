import { CLASSIFICATIONS, ROUTES } from './llm-model';
import type { Classification, Route } from './llm-model';

export const AUDIT_READ = 'llm.audit.read';
export const REQUESTS_PATH = '/llm/llm-01';
export const ROUTING_PATH = '/llm/llm-05';
/** The route decision names a policy version; the nil identifier stands for the baseline, when no policy was in force. */
export const BASELINE_POLICY = '00000000-0000-0000-0000-000000000000';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => (typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined);

export const REQUEST_STATUSES = ['ADMITTED', 'REJECTED_POLICY', 'RESERVED', 'DISPATCHED', 'COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED_NO_CITATION', 'PENDING_RECONCILE'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const ATTEMPT_KINDS = ['PRIMARY', 'RETRY', 'FALLBACK'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export interface RequestEntry {
  id: string;
  taskType: string;
  subjectModule: string;
  classification: Classification;
  route: Route | null;
  providerCode: string | null;
  modelId: string | null;
  status: RequestStatus;
  rejectCode: string | null;
  citations: number | null;
  costVnd: string | null;
  createdAt: string;
}

export function toRequest(raw: unknown): RequestEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const taskType = text(row?.task_type);
  const classification = oneOf(CLASSIFICATIONS, row?.data_classification);
  const status = oneOf(REQUEST_STATUSES, row?.status);
  const createdAt = text(row?.created_at);
  if (row === undefined || id === undefined || taskType === undefined || classification === undefined || status === undefined || createdAt === undefined) return undefined;
  return {
    id,
    taskType,
    subjectModule: text(row.subject_module) ?? '',
    classification,
    route: oneOf(ROUTES, row.route_class) ?? null,
    providerCode: nullableText(row.provider_code),
    modelId: nullableText(row.model_id),
    status,
    rejectCode: nullableText(row.reject_code),
    citations: whole(row.citations_count) ?? null,
    costVnd: nullableText(row.cost_vnd),
    createdAt,
  };
}

export interface RequestSummary {
  periodStart: string;
  total: number;
  byRoute: Record<string, number>;
  byStatus: Record<string, number>;
  blocked: number;
}

const counts = (value: unknown): Record<string, number> => Object.fromEntries(Object.entries(asRecord(value) ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));

export function toSummary(raw: unknown): RequestSummary | undefined {
  const row = asRecord(raw);
  const total = whole(row?.total);
  const blocked = whole(row?.blocked);
  if (row === undefined || total === undefined || blocked === undefined) return undefined;
  return { periodStart: text(row.period_start) ?? '', total, byRoute: counts(row.by_route), byStatus: counts(row.by_status), blocked };
}

export interface RequestPage {
  items: RequestEntry[];
  next: string | undefined;
  summary: RequestSummary | undefined;
}

export function toRequestPage(raw: unknown): RequestPage {
  const body = asRecord(raw);
  return { items: Array.isArray(body?.items) ? body.items.flatMap((entry) => toRequest(entry) ?? []) : [], next: text(body?.next_cursor), summary: toSummary(body?.summary) };
}

/** A share as a percentage with two places (50 of 1,000 is 5.00): whole numbers only, rounded half up, and none when there is nothing to divide. */
export function sharePercent(part: number, total: number): string {
  if (total <= 0) return '0.00';
  const hundredths = Math.floor((part * 20_000 + total) / (2 * total));
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

export interface AttemptEntry {
  id: string;
  no: number;
  kind: AttemptKind;
  route: Route;
  providerCode: string | null;
  modelId: string;
  outcome: string;
  latencyMs: number | null;
  costVnd: string | null;
}

export interface RouteDecision {
  requestId: string;
  classification: Classification;
  basis: Array<{ documentVersionId: string; classification: Classification }>;
  policyVersionId: string | null;
  route: Route | null;
  providerCode: string;
  modelId: string;
  status: RequestStatus;
  rejectCode: string | null;
  attempts: AttemptEntry[];
}

function toAttempt(raw: unknown): AttemptEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const no = whole(row?.attempt_no);
  const kind = oneOf(ATTEMPT_KINDS, row?.attempt_kind);
  const route = oneOf(ROUTES, row?.route_class);
  const modelId = text(row?.model_id);
  if (row === undefined || id === undefined || no === undefined || kind === undefined || route === undefined || modelId === undefined) return undefined;
  return { id, no, kind, route, providerCode: nullableText(row.provider_code), modelId, outcome: text(row.outcome) ?? '', latencyMs: whole(row.latency_ms) ?? null, costVnd: nullableText(row.cost_vnd) };
}

export function toRouteDecision(raw: unknown): RouteDecision | undefined {
  const row = asRecord(raw);
  const requestId = text(row?.ai_request_id);
  const classification = oneOf(CLASSIFICATIONS, row?.data_classification);
  const status = oneOf(REQUEST_STATUSES, row?.status);
  if (row === undefined || requestId === undefined || classification === undefined || status === undefined) return undefined;
  const basis = Array.isArray(row.classification_basis)
    ? row.classification_basis.flatMap((entry) => {
        const item = asRecord(entry);
        const id = text(item?.document_version_id);
        const level = oneOf(CLASSIFICATIONS, item?.classification);
        return id === undefined || level === undefined ? [] : [{ documentVersionId: id, classification: level }];
      })
    : [];
  const policy = text(row.policy_version_id);
  return {
    requestId,
    classification,
    basis,
    policyVersionId: policy === undefined || policy === BASELINE_POLICY ? null : policy,
    route: oneOf(ROUTES, row.route_class) ?? null,
    providerCode: text(row.provider_code) ?? '',
    modelId: text(row.model_id) ?? '',
    status,
    rejectCode: nullableText(row.reject_code),
    attempts: Array.isArray(row.attempts) ? row.attempts.flatMap((entry) => toAttempt(entry) ?? []) : [],
  };
}

export interface RequestFilter {
  status: string;
  route: string;
  classification: string;
  task: string;
}
export const NO_FILTER: RequestFilter = { status: '', route: '', classification: '', task: '' };

/** What the filter asks the server for: only what was chosen. */
export function filterQuery(filter: RequestFilter): Record<string, string> {
  return {
    ...(filter.status === '' ? {} : { status: filter.status }),
    ...(filter.route === '' ? {} : { route_class: filter.route }),
    ...(filter.classification === '' ? {} : { data_classification: filter.classification }),
    ...(filter.task.trim() === '' ? {} : { task_type: filter.task.trim() }),
  };
}
