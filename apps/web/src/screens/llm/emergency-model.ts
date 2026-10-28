export const EMERGENCY = 'llm.emergency';
export const DECIDE = 'ai.decide';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => (typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined);

export const KILL_SCOPES = ['TENANT', 'PROVIDER', 'MODEL', 'PROFILE', 'TASK_TYPE'] as const;
export type KillScope = (typeof KILL_SCOPES)[number];
export const KILL_STATES = ['ENGAGED', 'RELEASED'] as const;
export type KillState = (typeof KILL_STATES)[number];
export const MIN_REASON = 10;

export interface KillSwitchEntry {
  id: string;
  scope: KillScope;
  scopeRef: string | null;
  reason: string;
  state: KillState;
  engagedBy: string;
  engagedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  affected: number;
  version: number;
}

export function toKillSwitch(raw: unknown): KillSwitchEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const scope = oneOf(KILL_SCOPES, row?.scope_kind);
  const state = oneOf(KILL_STATES, row?.state);
  const version = whole(row?.version);
  const engagedAt = text(row?.engaged_at);
  const engagedBy = text(row?.engaged_by);
  if (row === undefined || id === undefined || scope === undefined || state === undefined || version === undefined || engagedAt === undefined || engagedBy === undefined) return undefined;
  return {
    id,
    scope,
    scopeRef: nullableText(row.scope_ref),
    reason: text(row.reason) ?? '',
    state,
    engagedBy,
    engagedAt,
    releasedBy: nullableText(row.release_approved_by),
    releasedAt: nullableText(row.released_at),
    releaseReason: nullableText(row.release_reason),
    affected: whole(row.affected_requests) ?? 0,
    version,
  };
}

export interface KillSwitchPage {
  items: KillSwitchEntry[];
  next: string | undefined;
}

export function toKillSwitchPage(raw: unknown): KillSwitchPage {
  const body = asRecord(raw);
  return { items: Array.isArray(body?.items) ? body.items.flatMap((entry) => toKillSwitch(entry) ?? []) : [], next: text(body?.next_cursor) };
}

export interface EngageValues {
  scope: KillScope;
  scopeRef: string;
  reason: string;
}
export const EMPTY_ENGAGE: EngageValues = { scope: 'TENANT', scopeRef: '', reason: '' };
export type EngageProblem = 'required' | 'invalidId' | 'shortReason' | 'noRef';
export type EngageErrors = Partial<Record<'scopeRef' | 'reason', EngageProblem>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the form checks before it asks for an emergency stop: the whole tenant has no reference, a provider or a model is named by its id, a task by its name; and a reason of ten characters. */
export function validateEngage(values: EngageValues): EngageErrors {
  const errors: EngageErrors = {};
  const ref = values.scopeRef.trim();
  if (values.scope === 'TENANT') {
    if (ref !== '') errors.scopeRef = 'noRef';
  } else if (values.scope === 'PROVIDER' || values.scope === 'MODEL') {
    if (!UUID.test(ref)) errors.scopeRef = ref === '' ? 'required' : 'invalidId';
  } else if (ref.length < 2 || ref.length > 60) {
    errors.scopeRef = 'required';
  }
  if (values.reason.trim().length < MIN_REASON) errors.reason = 'shortReason';
  return errors;
}

export function engageBody(values: EngageValues) {
  return { scope_kind: values.scope, ...(values.scope === 'TENANT' ? {} : { scope_ref: values.scopeRef.trim() }), reason: values.reason.trim() };
}

export const DECISIONS = ['ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED'] as const;
export type Decision = (typeof DECISIONS)[number];
export const ACTION_KINDS = ['WRITE', 'MONEY', 'DECISION', 'PUBLISH'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface DecisionEntry {
  id: string;
  requestId: string;
  module: string;
  kind: string;
  subjectId: string;
  outputSha256: string;
  action: ActionKind;
  decision: Decision;
  rationale: string;
  decidedBy: string;
  decidedAt: string;
  appliedOperation: string | null;
  appliedVersion: string | null;
}

export function toDecision(raw: unknown): DecisionEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const requestId = text(row?.ai_request_id);
  const action = oneOf(ACTION_KINDS, row?.action_kind);
  const decision = oneOf(DECISIONS, row?.decision);
  const decidedAt = text(row?.decided_at);
  if (row === undefined || id === undefined || requestId === undefined || action === undefined || decision === undefined || decidedAt === undefined) return undefined;
  return {
    id,
    requestId,
    module: text(row.subject_module) ?? '',
    kind: text(row.subject_kind) ?? '',
    subjectId: text(row.subject_id) ?? '',
    outputSha256: text(row.ai_output_sha256) ?? '',
    action,
    decision,
    rationale: text(row.rationale) ?? '',
    decidedBy: text(row.decided_by) ?? '',
    decidedAt,
    appliedOperation: nullableText(row.applied_operation_id),
    appliedVersion: nullableText(row.applied_resource_version),
  };
}

export interface DecisionPage {
  items: DecisionEntry[];
  next: string | undefined;
}

export function toDecisionPage(raw: unknown): DecisionPage {
  const body = asRecord(raw);
  return { items: Array.isArray(body?.items) ? body.items.flatMap((entry) => toDecision(entry) ?? []) : [], next: text(body?.next_cursor) };
}

export interface DecisionFilter {
  module: string;
  decision: string;
}
export const NO_DECISION_FILTER: DecisionFilter = { module: '', decision: '' };

export function decisionQuery(filter: DecisionFilter): Record<string, string> {
  return { ...(filter.module.trim() === '' ? {} : { subject_module: filter.module.trim().toUpperCase() }), ...(filter.decision === '' ? {} : { decision: filter.decision }) };
}
