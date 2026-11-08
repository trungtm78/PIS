import { ApiError } from '@machvon/api-client';

/** The permissions the three screens of IAM-2 are judged on: the server holds the same names. */
export const DELEGATION_READ = 'iam.delegation.read';
export const DELEGATION_CREATE = 'iam.delegation.create';
export const DELEGATION_APPROVE = 'iam.delegation.approve';
export const ACTING_READ = 'iam.acting.read';
export const ACTING_REQUEST = 'iam.acting.request';
export const ACTING_APPROVE = 'iam.acting.approve';
export const ACTING_REVOKE = 'iam.acting.revoke';
export const GRANT_PERMISSION = 'iam.role.grant';
export const GRANT_READ = 'role_grant.read';

export const REASON_MIN = 10;
export const ACTING_REASON_MIN = 20;
/** The longest an acting grant lasts, in hours (the server and the table say so too). */
export const ACTING_MAX_HOURS = 8;
/** The longest time to the next review of a permanent delegation, in days. */
export const REVIEW_MAX_DAYS = 365;
/** The longest fixed end of a permanent delegation, in days from its start. */
export const END_MAX_DAYS = 1826;
export const END_TEXT_MIN = 10;
export const MAX_PERIOD_CODES = 24;
const DAY_MS = 86_400_000;
const START_SLACK_MS = 5 * 60_000;
export const SCOPE_KINDS = ['UNIT_SUBTREE', 'UNIT_ONLY'] as const;
export const END_KINDS = ['SOURCE_HOLDS', 'UNTIL_EVENT', 'UNTIL_DATE'] as const;
export type EndKind = (typeof END_KINDS)[number];
export const SUGGESTED_DELEGABLE = ['approval.decide', 'doc.outgoing.sign'] as const;
/** The last word of a permission that decides: never done on behalf of someone (the server says so too). */
const DECISION_VERBS = ['approve', 'decide', 'sign', 'certify', 'accept', 'reject', 'return', 'issue'];
const PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const PERIOD_CODE = /^[0-9]{4}(-(M(0[1-9]|1[0-2])|Q[1-4]|H[12]))?$/;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullable = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
const nullableStrings = (value: unknown): string[] | null => (Array.isArray(value) ? strings(value) : null);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((item) => item === value);
const party = (value: unknown): { id: string; name: string } | undefined => {
  const row = record(value);
  const id = text(row?.id);
  return id === undefined ? undefined : { id, name: text(row?.name) ?? '' };
};

// ---- the permanent delegation (ADM-25) --------------------------------------------------------------------------------------------------------

export const REQUEST_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled', 'Lapsed'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface StandingRequestView {
  id: string;
  delegatorId: string;
  delegatorName: string;
  delegateId: string;
  delegateName: string;
  permissions: string[];
  scopeKind: string;
  scopeRefIds: string[];
  periodCodes: string[] | null;
  startsAt: string;
  reviewDueAt: string;
  endKind: EndKind;
  endText: string;
  endOn: string | null;
  reason: string;
  status: RequestStatus;
  expiresAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  delegationId: string | null;
  version: number;
  mayDecide: boolean;
  mayCancel: boolean;
}

export function toStandingRequest(raw: unknown): StandingRequestView | undefined {
  const row = record(raw);
  const delegator = party(row?.delegator);
  const delegate = party(row?.delegate);
  const status = oneOf(REQUEST_STATUSES, row?.status);
  const endKind = oneOf(END_KINDS, row?.end_condition_kind);
  const id = text(row?.id);
  const starts = text(row?.starts_at);
  const review = text(row?.review_due_at);
  if (row === undefined || delegator === undefined || delegate === undefined || status === undefined || endKind === undefined || id === undefined || starts === undefined || review === undefined || typeof row.version !== 'number') return undefined;
  const actions = record(row.actions);
  return {
    id,
    delegatorId: delegator.id,
    delegatorName: delegator.name,
    delegateId: delegate.id,
    delegateName: delegate.name,
    permissions: strings(row.permissions),
    scopeKind: text(row.scope_kind) ?? '',
    scopeRefIds: strings(row.scope_ref_ids),
    periodCodes: nullableStrings(row.period_codes),
    startsAt: starts,
    reviewDueAt: review,
    endKind,
    endText: text(row.end_condition_text) ?? '',
    endOn: nullable(row.end_on),
    reason: text(row.reason) ?? '',
    status,
    expiresAt: text(row.expires_at) ?? '',
    decidedByName: party(row.decided_by)?.name ?? null,
    decidedAt: nullable(row.decided_at),
    decisionReason: nullable(row.decision_reason),
    delegationId: nullable(row.delegation_id),
    version: row.version,
    mayDecide: actions?.decide === true,
    mayCancel: actions?.cancel === true,
  };
}

export const DELEGATION_STATUSES = ['Scheduled', 'Active', 'Ended', 'Revoked'] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

/** A permanent delegation as the list of delegations answers it (`kind=PERMANENT`). */
export interface PermanentView {
  id: string;
  delegatorId: string;
  delegatorName: string;
  delegateId: string;
  delegateName: string;
  permissions: string[];
  scopeKind: string;
  scopeRefIds: string[];
  periodCodes: string[] | null;
  validFrom: string;
  reviewDueAt: string;
  reviewDueSoon: boolean;
  lastReviewedAt: string | null;
  reviewCount: number;
  endKind: EndKind;
  endText: string;
  endOn: string | null;
  status: DelegationStatus;
  endReason: string | null;
  version: number;
  mayReview: boolean;
  mayRevoke: boolean;
}

export function toPermanent(raw: unknown): PermanentView | undefined {
  const row = record(raw);
  const delegator = party(row?.delegator);
  const delegate = party(row?.delegate);
  const status = oneOf(DELEGATION_STATUSES, row?.status);
  const endKind = oneOf(END_KINDS, row?.end_condition_kind);
  const id = text(row?.id);
  const from = text(row?.valid_from);
  const review = text(row?.review_due_at);
  if (row === undefined || row.kind !== 'PERMANENT' || delegator === undefined || delegate === undefined || status === undefined || endKind === undefined || id === undefined || from === undefined || review === undefined || typeof row.version !== 'number') return undefined;
  const actions = record(row.actions);
  return {
    id,
    delegatorId: delegator.id,
    delegatorName: delegator.name,
    delegateId: delegate.id,
    delegateName: delegate.name,
    permissions: strings(row.permissions),
    scopeKind: text(row.scope_kind) ?? '',
    scopeRefIds: strings(row.scope_ref_ids),
    periodCodes: nullableStrings(row.period_codes),
    validFrom: from,
    reviewDueAt: review,
    reviewDueSoon: row.review_due_soon === true,
    lastReviewedAt: nullable(row.last_reviewed_at),
    reviewCount: typeof row.review_count === 'number' ? row.review_count : 0,
    endKind,
    endText: text(row.end_condition_text) ?? '',
    endOn: nullable(row.end_on),
    status,
    endReason: nullable(row.end_reason),
    version: row.version,
    mayReview: actions?.review === true,
    mayRevoke: actions?.revoke === true,
  };
}

/** `YYYY-MM-DDTHH:mm` in the local time of the browser, as a datetime-local field wants it. */
export function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The whole days from `from` to `until`, rounded down; never negative. */
export function daysBetween(fromIso: string, untilIso: string): number {
  const span = Date.parse(untilIso) - Date.parse(fromIso);
  return Number.isFinite(span) ? Math.max(0, Math.floor(span / DAY_MS)) : 0;
}

export interface PeriodParse {
  codes: string[];
  bad: string[];
  overlapping: string[];
}

const rangeOf = (code: string): [number, number] | undefined => {
  const match = /^([0-9]{4})(?:-(?:M([0-9]{2})|Q([1-4])|H([12])))?$/.exec(code);
  if (match === null) return undefined;
  const year = Number(match[1]) * 12;
  if (match[2] !== undefined) return [year + Number(match[2]) - 1, year + Number(match[2]) - 1];
  if (match[3] !== undefined) return [year + (Number(match[3]) - 1) * 3, year + Number(match[3]) * 3 - 1];
  if (match[4] !== undefined) return [year + (Number(match[4]) - 1) * 6, year + Number(match[4]) * 6 - 1];
  return [year, year + 11];
};

/** The periods typed in a field (separated by commas, spaces or lines), sorted and without repeats; what is not a period and what lies inside another entry is told apart. */
export function parsePeriods(input: string): PeriodParse {
  const words = input.split(/[\s,;]+/).filter((word) => word !== '');
  const unique = [...new Set(words)];
  const bad = unique.filter((word) => !PERIOD_CODE.test(word));
  const good = unique.filter((word) => PERIOD_CODE.test(word)).sort();
  const overlapping = good.filter((code) =>
    good.some((other) => {
      const inner = rangeOf(code);
      const outer = rangeOf(other);
      return other !== code && inner !== undefined && outer !== undefined && outer[0] <= inner[0] && inner[1] <= outer[1];
    }),
  );
  return { codes: good, bad, overlapping };
}

export type PeriodProblem = 'periodMalformed' | 'periodOverlap' | 'periodTooMany';

function periodProblems(parsed: PeriodParse): PeriodProblem[] {
  const problems: PeriodProblem[] = [];
  if (parsed.bad.length > 0) problems.push('periodMalformed');
  if (parsed.overlapping.length > 0) problems.push('periodOverlap');
  if (parsed.codes.length > MAX_PERIOD_CODES) problems.push('periodTooMany');
  return problems;
}

export interface StandingForm {
  delegateId: string;
  permissions: string[];
  scopeKind: (typeof SCOPE_KINDS)[number];
  unitId: string;
  periods: string;
  validFrom: string;
  reviewDueAt: string;
  endKind: EndKind;
  endText: string;
  endOn: string;
  reason: string;
  legalBasis: string;
}

export const emptyStandingForm = (now: Date): StandingForm => ({
  delegateId: '',
  permissions: [],
  scopeKind: 'UNIT_SUBTREE',
  unitId: '',
  periods: '',
  validFrom: toLocalInput(now),
  reviewDueAt: toLocalInput(new Date(now.getTime() + 180 * DAY_MS)),
  endKind: 'UNTIL_EVENT',
  endText: '',
  endOn: '',
  reason: '',
  legalBasis: '',
});

export type StandingProblem = 'delegateRequired' | 'permissionsRequired' | 'unitRequired' | 'reviewInvalid' | 'reviewTooFar' | 'reviewPast' | 'startPast' | 'endTextShort' | 'endOnRequired' | 'endOnInvalid' | 'reviewAfterEnd' | 'reasonShort' | PeriodProblem;

/** What can be told without the server; the server judges the rest (what the delegator holds, the delegate's membership, a loop of delegations). */
export function standingProblems(form: StandingForm, now: Date): StandingProblem[] {
  const problems: StandingProblem[] = [];
  if (form.delegateId === '') problems.push('delegateRequired');
  if (form.permissions.length === 0) problems.push('permissionsRequired');
  if (form.unitId === '') problems.push('unitRequired');
  const from = Date.parse(form.validFrom);
  const review = Date.parse(form.reviewDueAt);
  if (Number.isFinite(from) && from < now.getTime() - START_SLACK_MS) problems.push('startPast');
  if (!Number.isFinite(from) || !Number.isFinite(review) || review <= from) problems.push('reviewInvalid');
  else if (review - from > REVIEW_MAX_DAYS * DAY_MS) problems.push('reviewTooFar');
  else if (review <= now.getTime()) problems.push('reviewPast');
  if (form.endText.trim().length < END_TEXT_MIN) problems.push('endTextShort');
  if (form.endKind === 'UNTIL_DATE') {
    const end = Date.parse(form.endOn);
    if (form.endOn === '') problems.push('endOnRequired');
    else if (!Number.isFinite(end) || end <= from || end - from > END_MAX_DAYS * DAY_MS) problems.push('endOnInvalid');
    else if (Number.isFinite(review) && review > end) problems.push('reviewAfterEnd');
  }
  if (form.reason.trim().length < REASON_MIN) problems.push('reasonShort');
  if (form.periods.trim() !== '') problems.push(...periodProblems(parsePeriods(form.periods)));
  return problems;
}

/** The body of `createStandingDelegationRequest` for a form that passed `standingProblems`. */
export function toStandingBody(form: StandingForm): Record<string, unknown> {
  const periods = parsePeriods(form.periods).codes;
  return {
    delegate_membership_id: form.delegateId,
    permissions: form.permissions,
    scope_kind: form.scopeKind,
    scope_ref_ids: [form.unitId],
    ...(periods.length === 0 ? {} : { period_codes: periods }),
    valid_from: new Date(form.validFrom).toISOString(),
    review_due_at: new Date(form.reviewDueAt).toISOString(),
    end_condition_kind: form.endKind,
    end_condition_text: form.endText.trim(),
    ...(form.endKind === 'UNTIL_DATE' ? { end_on: new Date(form.endOn).toISOString() } : {}),
    reason: form.reason.trim(),
    ...(form.legalBasis.trim() === '' ? {} : { legal_basis_ref: form.legalBasis.trim() }),
  };
}

export type ReviewProblem = 'reviewInvalid' | 'reviewTooFar' | 'reviewNotForward' | 'reviewAfterEnd';

/** The new review date against the one in force: forward, within a year of now, and not after a fixed end. */
export function reviewProblems(current: Pick<PermanentView, 'reviewDueAt' | 'endOn'>, nextLocal: string, now: Date): ReviewProblem[] {
  const next = Date.parse(nextLocal);
  if (!Number.isFinite(next)) return ['reviewInvalid'];
  if (next <= Date.parse(current.reviewDueAt)) return ['reviewNotForward'];
  if (next - now.getTime() > REVIEW_MAX_DAYS * DAY_MS) return ['reviewTooFar'];
  if (current.endOn !== null && next > Date.parse(current.endOn)) return ['reviewAfterEnd'];
  return [];
}

/** The permissions a delegator is offered: their own that something reads a delegation for (never the administration of access, nor the reads). */
export function offeredPermissions(held: readonly string[] | undefined): string[] {
  const delegable = new Set<string>(SUGGESTED_DELEGABLE);
  const own = held === undefined ? [...SUGGESTED_DELEGABLE] : held.filter((permission) => delegable.has(permission));
  return [...new Set(own)].sort();
}

// ---- acting on behalf of a person (ADM-26) ----------------------------------------------------------------------------------------------------

export const ACTING_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled', 'Revoked'] as const;
export const ACTING_PHASES = ['PENDING', 'REQUEST_LAPSED', 'REJECTED', 'CANCELLED', 'ACTIVE', 'ENDED', 'REVOKED'] as const;
export type ActingPhase = (typeof ACTING_PHASES)[number];

export interface ActingView {
  id: string;
  requesterId: string;
  requesterName: string;
  subjectId: string;
  subjectName: string;
  permissions: string[];
  periodCodes: string[] | null;
  hours: number;
  reason: string;
  phase: ActingPhase;
  requestedAt: string;
  decidedByName: string | null;
  decisionReason: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  revokeReason: string | null;
  version: number;
  mayDecide: boolean;
  mayCancel: boolean;
  mayRevoke: boolean;
}

export function toActing(raw: unknown): ActingView | undefined {
  const row = record(raw);
  const requester = party(row?.requester);
  const subject = party(row?.subject);
  const phase = oneOf(ACTING_PHASES, row?.phase);
  const id = text(row?.id);
  const requested = text(row?.requested_at);
  if (row === undefined || requester === undefined || subject === undefined || phase === undefined || id === undefined || requested === undefined || typeof row.version !== 'number' || typeof row.hours !== 'number') return undefined;
  const actions = record(row.actions);
  return {
    id,
    requesterId: requester.id,
    requesterName: requester.name,
    subjectId: subject.id,
    subjectName: subject.name,
    permissions: strings(row.permissions),
    periodCodes: nullableStrings(row.period_codes),
    hours: row.hours,
    reason: text(row.reason) ?? '',
    phase,
    requestedAt: requested,
    decidedByName: party(row.decided_by)?.name ?? null,
    decisionReason: nullable(row.decision_reason),
    windowStart: nullable(row.window_start),
    windowEnd: nullable(row.window_end),
    revokeReason: nullable(row.revoke_reason),
    version: row.version,
    mayDecide: actions?.decide === true,
    mayCancel: actions?.cancel === true,
    mayRevoke: actions?.revoke === true,
  };
}

export interface ActingForm {
  subjectId: string;
  permissions: string;
  periods: string;
  hours: string;
  reason: string;
}

export const emptyActingForm = (): ActingForm => ({ subjectId: '', permissions: '', periods: '', hours: '4', reason: '' });

/** The permission names typed in a field (separated by commas, spaces or lines), without repeats. */
export function parsePermissions(input: string): string[] {
  return [...new Set(input.split(/[\s,;]+/).filter((word) => word !== ''))];
}

/** Why a permission cannot be acted for: a pattern, an administrative permission or one that decides. */
export function actingRefusal(permission: string): 'malformed' | 'wildcard' | 'administrative' | 'decision' | undefined {
  if (permission.endsWith('*')) return 'wildcard';
  if (!PERMISSION.test(permission)) return 'malformed';
  if (/^(iam|adm|system)\./.test(permission)) return 'administrative';
  return DECISION_VERBS.includes(permission.slice(permission.lastIndexOf('.') + 1)) ? 'decision' : undefined;
}

export type ActingProblem = 'subjectRequired' | 'permissionsRequired' | 'permissionRefused' | 'hoursInvalid' | 'reasonShort' | PeriodProblem;

export function actingProblems(form: ActingForm): { problems: ActingProblem[]; refused: Array<{ permission: string; why: NonNullable<ReturnType<typeof actingRefusal>> }> } {
  const problems: ActingProblem[] = [];
  const permissions = parsePermissions(form.permissions);
  const refused = permissions.flatMap((permission) => {
    const why = actingRefusal(permission);
    return why === undefined ? [] : [{ permission, why }];
  });
  if (form.subjectId === '') problems.push('subjectRequired');
  if (permissions.length === 0) problems.push('permissionsRequired');
  if (refused.length > 0) problems.push('permissionRefused');
  const hours = Number(form.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > ACTING_MAX_HOURS) problems.push('hoursInvalid');
  if (form.reason.trim().length < ACTING_REASON_MIN) problems.push('reasonShort');
  if (form.periods.trim() !== '') problems.push(...periodProblems(parsePeriods(form.periods)));
  return { problems, refused };
}

export function toActingBody(form: ActingForm): Record<string, unknown> {
  const periods = parsePeriods(form.periods).codes;
  return { subject_membership_id: form.subjectId, permissions: parsePermissions(form.permissions), hours: Number(form.hours), reason: form.reason.trim(), ...(periods.length === 0 ? {} : { period_codes: periods }) };
}

/** The minutes left in a window at `now`, rounded down; never negative. */
export function minutesLeft(windowEnd: string | null, now: Date): number {
  if (windowEnd === null) return 0;
  const span = Date.parse(windowEnd) - now.getTime();
  return Number.isFinite(span) ? Math.max(0, Math.floor(span / 60_000)) : 0;
}

// ---- the limit of a role grant to report periods (ADM-27) -------------------------------------------------------------------------------------

export const SCOPE_STATUSES = ['Active', 'Lifted'] as const;
export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

export interface PeriodScopeView {
  id: string;
  roleGrantId: string;
  memberId: string;
  memberName: string;
  roleCode: string;
  periodCodes: string[];
  reason: string;
  status: ScopeStatus;
  setAt: string;
  liftedAt: string | null;
  liftReason: string | null;
  version: number;
  mayLift: boolean;
}

export function toPeriodScope(raw: unknown): PeriodScopeView | undefined {
  const row = record(raw);
  const member = party(row?.member);
  const status = oneOf(SCOPE_STATUSES, row?.status);
  const id = text(row?.id);
  const grant = text(row?.role_grant_id);
  const setAt = text(row?.set_at);
  if (row === undefined || member === undefined || status === undefined || id === undefined || grant === undefined || setAt === undefined || typeof row.version !== 'number') return undefined;
  return {
    id,
    roleGrantId: grant,
    memberId: member.id,
    memberName: member.name,
    roleCode: text(row.role_code) ?? '',
    periodCodes: strings(row.period_codes),
    reason: text(row.reason) ?? '',
    status,
    setAt,
    liftedAt: nullable(row.lifted_at),
    liftReason: nullable(row.lift_reason),
    version: row.version,
    mayLift: record(row.actions)?.lift === true,
  };
}

/** A role grant as the list of grants answers it, for the choice of the grant a limit is set on. */
export interface GrantOption {
  id: string;
  membershipId: string;
  roleCode: string;
}

export function toGrantOption(raw: unknown): GrantOption | undefined {
  const row = record(raw);
  const id = text(row?.id);
  const membershipId = text(row?.membership_id);
  const roleCode = text(row?.role_code);
  return row === undefined || id === undefined || membershipId === undefined || roleCode === undefined || row.status !== 'Active' ? undefined : { id, membershipId, roleCode };
}

export interface ScopeForm {
  grantId: string;
  periods: string;
  reason: string;
}

export const emptyScopeForm = (): ScopeForm => ({ grantId: '', periods: '', reason: '' });

export type ScopeProblem = 'grantRequired' | 'periodsRequired' | 'reasonShort' | PeriodProblem;

export function scopeProblems(form: ScopeForm): ScopeProblem[] {
  const problems: ScopeProblem[] = [];
  if (form.grantId === '') problems.push('grantRequired');
  const parsed = parsePeriods(form.periods);
  if (parsed.codes.length === 0 && parsed.bad.length === 0) problems.push('periodsRequired');
  problems.push(...periodProblems(parsed));
  if (form.reason.trim().length < REASON_MIN) problems.push('reasonShort');
  return problems;
}

// ---- what the server refuses -----------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'chain'
  | 'escalation'
  | 'self'
  | 'invalid'
  | 'inactive'
  | 'notFound'
  | 'versionConflict'
  | 'stateInvalid'
  | 'denied'
  | 'cycle'
  | 'selfApproval'
  | 'actingSelf'
  | 'actingInvalid'
  | 'periodDenied'
  | 'periodInvalid'
  | 'periodState'
  | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'DELEGATION_CHAIN_DENIED':
      return 'chain';
    case 'ROLE_ESCALATION_DENIED':
      return 'escalation';
    case 'SELF_GRANT_DENIED':
      return 'self';
    case 'DELEGATION_CYCLE_DENIED':
      return 'cycle';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'ACTING_SELF_DENIED':
      return 'actingSelf';
    case 'ACTING_INVALID':
      return 'actingInvalid';
    case 'PERIOD_SCOPE_DENIED':
      return 'periodDenied';
    case 'PERIOD_SCOPE_INVALID':
      return 'periodInvalid';
    case 'PERIOD_SCOPE_STATE_INVALID':
      return 'periodState';
    case 'DELEGATION_INVALID':
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
      return 'invalid';
    case 'MEMBERSHIP_INACTIVE':
      return 'inactive';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'DELEGATION_STATE_INVALID':
    case 'ACTING_STATE_INVALID':
      return 'stateInvalid';
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return 'denied';
    default:
      return 'general';
  }
}

/** The defects a refused request names, each with its field. */
export function readDefects(error: unknown): Array<{ field: string; code: string }> {
  if (!(error instanceof ApiError) || !['DELEGATION_INVALID', 'ACTING_INVALID', 'PERIOD_SCOPE_INVALID'].includes(error.code)) return [];
  const list = record(error.extensions)?.defects;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const item = record(entry);
    return typeof item?.field === 'string' && typeof item.code === 'string' ? [{ field: item.field, code: item.code }] : [];
  });
}
