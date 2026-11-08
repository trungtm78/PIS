import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { compareDecimal, subtractDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';
import type { RuleParams } from './governance-rules.ts';

/**
 * The decision log of the leader (G3-6, BI, HOME and ADM): a decision about a figure of the command center (HOME-03) or about an urgent alert, written down with the reason and with the figures as they were at
 * the moment of the decision, taken by the server from what the leader sees and never from the client. A decision is never edited: what happened afterwards is a line of outcome that is added. The rules here are pure.
 */

export const DECISION_RULE_TYPE = 'DECISION_POLICY';
export const DECISION_RULE_CODE = 'DEFAULT';
export const DECISION_SUBJECT_KINDS = ['KPI_TILE', 'URGENT_ALERT', 'FREE'] as const;
export type DecisionSubjectKind = (typeof DECISION_SUBJECT_KINDS)[number];
export const DECISION_OUTCOMES = ['RESOLVED', 'STILL_OPEN', 'SUPERSEDED'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export interface DecisionPolicy {
  /** The closed list of kinds of decision (codes). */
  kinds: string[];
  reasonMin: number;
  reasonMax: number;
  /** The follow-up day is at most this many days after the day of the decision. */
  followUpMaxDays: number;
  outcomeNoteMin: number;
}

export const DECISION_DEFAULTS: Readonly<Record<string, unknown>> = {
  kinds: ['ACCEPT_RISK', 'DIRECT_ACTION', 'ESCALATE', 'REALLOCATE', 'DEFER', 'NO_ACTION'],
  reason_min: 10,
  reason_max: 1000,
  follow_up_max_days: 180,
  outcome_note_min: 5,
};

/** The policy from the params of the approved rule or the default; a rule that is not whole is refused rather than half applied. */
export function decisionPolicyOf(params: RuleParams): DecisionPolicy {
  const fail = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  const whole = (field: string): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw fail(field);
    return value;
  };
  const kinds = params.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((kind) => typeof kind === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(kind)) || new Set(kinds).size !== kinds.length) throw fail('kinds');
  const policy: DecisionPolicy = { kinds: kinds as string[], reasonMin: whole('reason_min'), reasonMax: whole('reason_max'), followUpMaxDays: whole('follow_up_max_days'), outcomeNoteMin: whole('outcome_note_min') };
  if (policy.reasonMin < 1 || policy.reasonMin > policy.reasonMax) throw fail('reason_min');
  return policy;
}

export interface DecisionSubject {
  kind: DecisionSubjectKind;
  /** KPI_TILE: the code of the figure. */
  metricCode: string | null;
  /** KPI_TILE and FREE: the unit the figure was read for, or the whole scope of the reader when null. */
  unitId: string | null;
  /** URGENT_ALERT: the work source and the id of the item in it. */
  source: string | null;
  sourceId: string | null;
  /** FREE: what the decision is about, in words. */
  title: string | null;
}

export interface DecisionDraft {
  subject: DecisionSubject;
  kind: string;
  reason: string;
  followUpOwnerId: string | null;
  followUpDue: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** A real calendar day written YYYY-MM-DD (local copy: this file must not import the rule registry, which imports it). */
function isRuleDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const dayAfter = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const words = (value: unknown): string => (typeof value === 'string' ? value.trim().normalize('NFC') : '');
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A decision as the person wrote it, checked against the policy: a subject that says what it is about, a kind from the closed list, a reason in words, a follow-up that is in the future and not too far. */
export function checkDecision(input: unknown, policy: DecisionPolicy, today: string): DecisionDraft {
  const body = record(input);
  const subjectBody = record(body.subject);
  const kind = (DECISION_SUBJECT_KINDS as readonly unknown[]).includes(subjectBody.kind) ? (subjectBody.kind as DecisionSubjectKind) : undefined;
  if (kind === undefined) throw invalid('subject.kind');
  const unitId = subjectBody.unit_id === undefined || subjectBody.unit_id === null ? null : typeof subjectBody.unit_id === 'string' && UUID.test(subjectBody.unit_id) ? subjectBody.unit_id : undefined;
  if (unitId === undefined) throw invalid('subject.unit_id');
  const subject: DecisionSubject = { kind, metricCode: null, unitId, source: null, sourceId: null, title: null };
  if (kind === 'KPI_TILE') {
    if (typeof subjectBody.metric_code !== 'string' || !CODE.test(subjectBody.metric_code)) throw invalid('subject.metric_code');
    subject.metricCode = subjectBody.metric_code;
  } else if (kind === 'URGENT_ALERT') {
    if (typeof subjectBody.source !== 'string' || !CODE.test(subjectBody.source)) throw invalid('subject.source');
    if (typeof subjectBody.source_id !== 'string' || subjectBody.source_id.length === 0 || subjectBody.source_id.length > 128 || subjectBody.source_id !== subjectBody.source_id.trim()) throw invalid('subject.source_id');
    if (unitId !== null) throw invalid('subject.unit_id');
    subject.source = subjectBody.source;
    subject.sourceId = subjectBody.source_id;
  } else {
    const title = words(subjectBody.title);
    if (title.length < 3 || title.length > 200) throw invalid('subject.title');
    subject.title = title;
  }
  if (typeof body.kind !== 'string' || !policy.kinds.includes(body.kind)) throw invalid('kind');
  const reason = words(body.reason);
  if (reason.length < policy.reasonMin || reason.length > policy.reasonMax) throw invalid('reason');
  const followUp = record(body.follow_up);
  let followUpOwnerId: string | null = null;
  let followUpDue: string | null = null;
  if (body.follow_up !== undefined && body.follow_up !== null) {
    if (typeof followUp.due_on !== 'string' || !isRuleDay(followUp.due_on) || followUp.due_on <= today || followUp.due_on > dayAfter(today, policy.followUpMaxDays)) throw invalid('follow_up.due_on');
    followUpDue = followUp.due_on;
    if (followUp.owner_id !== undefined && followUp.owner_id !== null) {
      if (typeof followUp.owner_id !== 'string' || !UUID.test(followUp.owner_id)) throw invalid('follow_up.owner_id');
      followUpOwnerId = followUp.owner_id;
    }
  }
  return { subject, kind: body.kind, reason, followUpOwnerId, followUpDue };
}

export interface OutcomeDraft {
  outcome: DecisionOutcome;
  note: string;
  supersededBy: string | null;
}

/** An outcome line: what became of the decision, with a note in words; SUPERSEDED names the decision that replaces it. */
export function checkOutcome(input: unknown, policy: DecisionPolicy): OutcomeDraft {
  const body = record(input);
  if (!(DECISION_OUTCOMES as readonly unknown[]).includes(body.outcome)) throw invalid('outcome');
  const outcome = body.outcome as DecisionOutcome;
  const note = words(body.note);
  if (note.length < policy.outcomeNoteMin || note.length > 1000) throw invalid('note');
  let supersededBy: string | null = null;
  if (outcome === 'SUPERSEDED') {
    if (typeof body.superseded_by !== 'string' || !UUID.test(body.superseded_by)) throw invalid('superseded_by');
    supersededBy = body.superseded_by;
  } else if (body.superseded_by !== undefined && body.superseded_by !== null) throw invalid('superseded_by');
  return { outcome, note, supersededBy };
}

/** The digest of the figures captured at the decision: the same facts always give the same digest, whatever the order of the keys, so the record can be shown to have been kept as it was. */
export const figuresDigest = (facts: unknown): string => sha256Hex(canonicalJson(facts));

export interface FigureFact {
  metric_code: string;
  value: string | null;
  display_value: string | null;
  unit: string;
  null_reason: string | null;
}

export type FigureCompareReason = 'NO_VALUE_THEN' | 'NO_VALUE_NOW' | 'NOT_READABLE_NOW';
export interface FigureComparison {
  metricCode: string;
  then: string | null;
  now: string | null;
  /** `now` less `then`, exact; null with a reason when one of the two is missing (never a delta against 0 that was not there). */
  delta: string | null;
  direction: 'UP' | 'DOWN' | 'SAME' | null;
  nullReason: FigureCompareReason | null;
}

/** The figure at the time of the decision against the figure today. */
export function compareFigure(then: Pick<FigureFact, 'metric_code' | 'value'>, now: Pick<FigureFact, 'value'> | null): FigureComparison {
  const base = { metricCode: then.metric_code, then: then.value, now: now === null ? null : now.value };
  if (now === null) return { ...base, delta: null, direction: null, nullReason: 'NOT_READABLE_NOW' };
  if (then.value === null) return { ...base, delta: null, direction: null, nullReason: 'NO_VALUE_THEN' };
  if (now.value === null) return { ...base, delta: null, direction: null, nullReason: 'NO_VALUE_NOW' };
  const order = compareDecimal(now.value, then.value);
  return { ...base, delta: subtractDecimal(now.value, then.value), direction: order === 0 ? 'SAME' : order > 0 ? 'UP' : 'DOWN', nullReason: null };
}

export type FollowUpState = 'NONE' | 'OPEN' | 'DUE_SOON' | 'OVERDUE' | 'RESOLVED' | 'SUPERSEDED';
/** Days before the follow-up day from which it is "due soon". */
export const FOLLOW_UP_SOON_DAYS = 3;

/** Where the follow-up of a decision stands: closed by its latest outcome, or open, due within three days, or past its day. A decision with no follow-up day has none. */
export function followUpState(followUpDue: string | null, latestOutcome: DecisionOutcome | null, today: string): FollowUpState {
  if (latestOutcome === 'RESOLVED') return 'RESOLVED';
  if (latestOutcome === 'SUPERSEDED') return 'SUPERSEDED';
  if (followUpDue === null) return 'NONE';
  if (followUpDue < today) return 'OVERDUE';
  return followUpDue <= dayAfter(today, FOLLOW_UP_SOON_DAYS) ? 'DUE_SOON' : 'OPEN';
}
