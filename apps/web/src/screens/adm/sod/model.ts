import { ApiError } from '@machvon/api-client';

/** ADM-24 (G4-1): the matrix of duties that one person may not hold together, and the register of the exceptions to it. */
export const READ_PERMISSION = 'adm.sod.read';
export const REQUEST_PERMISSION = 'adm.sod.exception.request';
export const APPROVE_PERMISSION = 'adm.sod.exception.approve';
export const REVOKE_PERMISSION = 'adm.sod.exception.revoke';
export const AUDIT_PERMISSION = 'aud.sod.read';
export const REASON_MIN = 10;
export const REASON_MAX = 500;
const DAY_MS = 86_400_000;

export const SCOPES = ['SAME_RECORD', 'SAME_PROJECT', 'SAME_CONTRACT', 'SAME_PACKAGE'] as const;
export type Scope = (typeof SCOPES)[number];
export const STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED'] as const;
export type Status = (typeof STATUSES)[number];
export const OUTCOMES = ['EXCEPTION_USED', 'WARNED', 'BLOCKED'] as const;
export type Outcome = (typeof OUTCOMES)[number];

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const nullable = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const scopeOf = (value: unknown): Scope | undefined => SCOPES.find((candidate) => candidate === value);

export interface ConflictView {
  actionA: string;
  actionB: string;
  scope: Scope;
  severity: 'BLOCK' | 'WARN';
  maxDays: number;
}

export interface MatrixView {
  asOf: string;
  ruleVersion: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  approvers: number;
  formula: string;
  sourceText: string;
  ruleAsOf: string;
  conflicts: ConflictView[];
  expiring: number;
}

export function toMatrix(raw: unknown): MatrixView | undefined {
  const row = record(raw);
  if (row === undefined || !Array.isArray(row.conflicts)) return undefined;
  const asOf = text(row.as_of);
  const ruleVersion = whole(row.rule_version);
  const approvers = whole(row.exception_approvers);
  if (asOf === undefined || ruleVersion === undefined || approvers === undefined) return undefined;
  const conflicts = row.conflicts.flatMap((entry): ConflictView[] => {
    const item = record(entry);
    const scope = scopeOf(item?.scope);
    const actionA = text(item?.action_a);
    const actionB = text(item?.action_b);
    const days = whole(item?.exception_max_days);
    if (item === undefined || scope === undefined || actionA === undefined || actionB === undefined || days === undefined || (item.severity !== 'BLOCK' && item.severity !== 'WARN')) return [];
    return [{ actionA, actionB, scope, severity: item.severity, maxDays: days }];
  });
  return {
    asOf,
    ruleVersion,
    source: row.source === 'RULE' ? 'RULE' : 'DEFAULT',
    unverified: row.unverified === true,
    approvers,
    formula: text(row.formula) ?? '',
    sourceText: text(row.source_text) ?? '',
    ruleAsOf: text(row.rule_as_of) ?? asOf,
    conflicts,
    expiring: whole(row.expiring_exceptions) ?? 0,
  };
}

export interface ExceptionView {
  id: string;
  actionA: string;
  actionB: string;
  scope: Scope;
  subjectId: string;
  memberId: string;
  memberName: string;
  requestedBy: string;
  requestedByName: string;
  reason: string;
  validFrom: string;
  validTo: string;
  ruleVersion: number;
  approversNeeded: number;
  approvals: number;
  status: Status;
  revokeReason: string | null;
  uses: number;
  version: number;
}

export function toException(raw: unknown): ExceptionView | undefined {
  const row = record(raw);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const scope = scopeOf(row?.scope);
  const id = text(row?.id);
  const actionA = text(row?.action_a);
  const actionB = text(row?.action_b);
  const subjectId = text(row?.subject_id);
  const memberId = text(row?.member_id);
  const requestedBy = text(row?.requested_by);
  const from = text(row?.valid_from);
  const to = text(row?.valid_to);
  const version = whole(row?.version);
  if (row === undefined || status === undefined || scope === undefined || id === undefined || actionA === undefined || actionB === undefined || subjectId === undefined || memberId === undefined || requestedBy === undefined || from === undefined || to === undefined || version === undefined) return undefined;
  return {
    id,
    actionA,
    actionB,
    scope,
    subjectId,
    memberId,
    memberName: text(row.member_name) ?? '',
    requestedBy,
    requestedByName: text(row.requested_by_name) ?? '',
    reason: text(row.reason) ?? '',
    validFrom: from,
    validTo: to,
    ruleVersion: whole(row.rule_version) ?? 0,
    approversNeeded: whole(row.approvers_needed) ?? 2,
    approvals: whole(row.approvals) ?? 0,
    status,
    revokeReason: nullable(row.revoke_reason),
    uses: whole(row.uses) ?? 0,
    version,
  };
}

export interface UseView {
  id: string;
  outcome: Outcome;
  exceptionId: string | null;
  actionA: string;
  actionB: string;
  scope: Scope;
  memberName: string;
  taking: string;
  command: string;
  recordId: string;
  ruleVersion: number;
  usedAt: string;
}

export function toUse(raw: unknown): UseView | undefined {
  const row = record(raw);
  const outcome = OUTCOMES.find((candidate) => candidate === row?.outcome);
  const scope = scopeOf(row?.scope);
  const id = text(row?.id);
  const actionA = text(row?.action_a);
  const actionB = text(row?.action_b);
  const usedAt = text(row?.used_at);
  if (row === undefined || outcome === undefined || scope === undefined || id === undefined || actionA === undefined || actionB === undefined || usedAt === undefined) return undefined;
  return {
    id,
    outcome,
    exceptionId: nullable(row.exception_id),
    actionA,
    actionB,
    scope,
    memberName: text(row.member_name) ?? '',
    taking: text(row.taking) ?? '',
    command: text(row.command) ?? '',
    recordId: text(row.record_id) ?? '',
    ruleVersion: whole(row.rule_version) ?? 0,
    usedAt,
  };
}

/** The statuses that are live: an exception that is asked or in force is still open to a decision. */
export const isLive = (status: Status): boolean => status === 'REQUESTED' || status === 'APPROVED';

/** The whole days from `today` to a day, both ends counted (a window of one day is 1). */
export function windowDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** The days left of an exception after `today` (0 on its last day), or null when it has ended. */
export function daysLeft(to: string, today: string): number | null {
  const left = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  return left < 0 ? null : left;
}

/** What each kind of scope is in plain terms, so a subject can be picked from the right list. */
export const SUBJECT_LIST: Readonly<Record<Scope, 'record' | 'project' | 'contract' | 'package'>> = { SAME_RECORD: 'record', SAME_PROJECT: 'project', SAME_CONTRACT: 'contract', SAME_PACKAGE: 'package' };

export interface Form {
  /** `action_a|action_b|scope` of the pair chosen in the matrix. */
  pair: string;
  subjectId: string;
  memberId: string;
  reason: string;
  validFrom: string;
  validTo: string;
}

export type FormProblem = 'pairRequired' | 'noException' | 'subjectRequired' | 'memberRequired' | 'reasonShort' | 'datesInvalid' | 'inThePast' | 'tooLong';

export const pairKeyOf = (conflict: Pick<ConflictView, 'actionA' | 'actionB' | 'scope'>): string => `${conflict.actionA}|${conflict.actionB}|${conflict.scope}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value.trim());

export function emptyForm(today: string): Form {
  const end = new Date(Date.parse(`${today}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10);
  return { pair: '', subjectId: '', memberId: '', reason: '', validFrom: today, validTo: end };
}

/** What stops the form before it is sent (the server judges the same things again and says why when it refuses). */
export function formProblems(form: Form, today: string, matrix: MatrixView | undefined): FormProblem[] {
  const problems: FormProblem[] = [];
  const conflict = matrix?.conflicts.find((entry) => pairKeyOf(entry) === form.pair);
  if (conflict === undefined) problems.push('pairRequired');
  else if (conflict.maxDays === 0) problems.push('noException');
  if (!isUuid(form.subjectId)) problems.push('subjectRequired');
  if (form.memberId === '') problems.push('memberRequired');
  const reason = form.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) problems.push('reasonShort');
  if (form.validFrom === '' || form.validTo === '' || form.validTo < form.validFrom) problems.push('datesInvalid');
  else {
    if (form.validFrom < today) problems.push('inThePast');
    if (conflict !== undefined && conflict.maxDays > 0 && windowDays(form.validFrom, form.validTo) > conflict.maxDays) problems.push('tooLong');
  }
  return problems;
}

export function toBody(form: Form): Record<string, unknown> {
  const [actionA, actionB, scope] = form.pair.split('|');
  return { action_a: actionA, action_b: actionB, scope, subject_id: form.subjectId.trim().toLowerCase(), member_id: form.memberId, reason: form.reason.trim(), valid_from: form.validFrom, valid_to: form.validTo };
}

export type Problem = 'self' | 'state' | 'window' | 'stale' | 'invalid' | 'scope' | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'SELF_APPROVAL_DENIED':
      return 'self';
    case 'SOD_EXCEPTION_STATE_INVALID':
      return 'state';
    case 'SOD_EXCEPTION_WINDOW_INVALID':
      return 'window';
    case 'VERSION_CONFLICT':
      return 'stale';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'RESOURCE_NOT_FOUND':
      return 'invalid';
    case 'SCOPE_DENIED':
      return 'scope';
    default:
      return 'general';
  }
}

/** The fields of a form the server named in a refusal (`detail` of the problem), so the screen can mark them. */
export function refusedField(error: unknown): string | undefined {
  return error instanceof ApiError && typeof error.detail === 'string' ? error.detail : undefined;
}

/** The business day (Vietnam time) of an instant, `YYYY-MM-DD`: the day the days of an exception are counted from. */
export function todayOf(now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
