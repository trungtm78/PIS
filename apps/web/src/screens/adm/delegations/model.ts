import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'iam.delegation.read';
export const CREATE_PERMISSION = 'iam.delegation.create';
/** A delegation lasts at most this many days (the server and the table say so too). */
export const MAX_DAYS = 90;
export const REASON_MIN = 10;
const DAY_MS = 86_400_000;
const START_SLACK_MS = 5 * 60_000;
export const SCOPE_KINDS = ['UNIT_SUBTREE', 'UNIT_ONLY'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export const STATUSES = ['Scheduled', 'Active', 'Ended', 'Revoked'] as const;
export type Status = (typeof STATUSES)[number];
/** The business permissions a delegator is offered when the session does not list their own. */
export const SUGGESTED_PERMISSIONS = ['approval.decide', 'doc.outgoing.sign'] as const;
/** The permissions something reads a delegation for (the server refuses any other). */
const DELEGABLE = new Set<string>(SUGGESTED_PERMISSIONS);

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export interface DelegationView {
  id: string;
  delegatorId: string;
  delegatorName: string;
  delegateId: string;
  delegateName: string;
  permissions: string[];
  scopeKind: string;
  scopeRefIds: string[];
  validFrom: string;
  validUntil: string;
  reason: string;
  status: Status;
  endReason: string | null;
  revokeReason: string | null;
  version: number;
  mayRevoke: boolean;
}

export function toDelegation(raw: unknown): DelegationView | undefined {
  const row = record(raw);
  const delegator = record(row?.delegator);
  const delegate = record(row?.delegate);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const id = text(row?.id);
  const from = text(row?.valid_from);
  const until = text(row?.valid_until);
  const delegatorId = text(delegator?.id);
  const delegateId = text(delegate?.id);
  if (row === undefined || status === undefined || id === undefined || from === undefined || until === undefined || delegatorId === undefined || delegateId === undefined || typeof row.version !== 'number') return undefined;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  return {
    id,
    delegatorId,
    delegatorName: text(delegator?.name) ?? '',
    delegateId,
    delegateName: text(delegate?.name) ?? '',
    permissions: strings(row.permissions),
    scopeKind: text(row.scope_kind) ?? '',
    scopeRefIds: strings(row.scope_ref_ids),
    validFrom: from,
    validUntil: until,
    reason: text(row.reason) ?? '',
    status,
    endReason: text(row.end_reason) ?? null,
    revokeReason: text(row.revoke_reason) ?? null,
    version: row.version,
    mayRevoke: record(row.actions)?.revoke === true,
  };
}

/** The days a window lasts, to the tenth of a day. */
export function daysOf(fromIso: string, untilIso: string): number {
  const span = Date.parse(untilIso) - Date.parse(fromIso);
  return Number.isFinite(span) ? Math.max(0, Math.round((span / DAY_MS) * 10) / 10) : 0;
}

/** The share of the 90 days a window fills, for the bar: never more than the whole bar. */
export function barShare(fromIso: string, untilIso: string): number {
  return Math.min(1, daysOf(fromIso, untilIso) / MAX_DAYS);
}

/** `YYYY-MM-DDTHH:mm` in the local time of the browser, as a datetime-local field wants it. */
export function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The last instant a delegation starting at `fromLocal` may end at, as the date field of the form takes it. */
export function latestEnd(fromLocal: string): string {
  const from = Date.parse(fromLocal);
  return Number.isFinite(from) ? toLocalInput(new Date(from + MAX_DAYS * DAY_MS)) : '';
}

export interface Form {
  delegateId: string;
  permissions: string[];
  scopeKind: ScopeKind;
  unitId: string;
  validFrom: string;
  validUntil: string;
  reason: string;
  legalBasis: string;
}

export const emptyForm = (now: Date): Form => ({
  delegateId: '',
  permissions: [],
  scopeKind: 'UNIT_SUBTREE',
  unitId: '',
  validFrom: toLocalInput(now),
  validUntil: toLocalInput(new Date(now.getTime() + 7 * DAY_MS)),
  reason: '',
  legalBasis: '',
});

export type FormProblem = 'delegateRequired' | 'permissionsRequired' | 'unitRequired' | 'datesInvalid' | 'tooLong' | 'inThePast' | 'reasonShort';

/** What can be told without the server; the server judges the rest (what the delegator holds, the delegate's membership). */
export function formProblems(form: Form, now: Date): FormProblem[] {
  const problems: FormProblem[] = [];
  if (form.delegateId === '') problems.push('delegateRequired');
  if (form.permissions.length === 0) problems.push('permissionsRequired');
  if (form.unitId === '') problems.push('unitRequired');
  const from = Date.parse(form.validFrom);
  const until = Date.parse(form.validUntil);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) problems.push('datesInvalid');
  else if (until - from > MAX_DAYS * DAY_MS) problems.push('tooLong');
  else if (until <= now.getTime() || from < now.getTime() - START_SLACK_MS) problems.push('inThePast');
  if (form.reason.trim().length < REASON_MIN) problems.push('reasonShort');
  return problems;
}

/** The body of `createDelegation` for a form that passed `formProblems`. */
export function toBody(form: Form): Record<string, unknown> {
  return {
    delegate_membership_id: form.delegateId,
    permissions: form.permissions,
    scope_kind: form.scopeKind,
    scope_ref_ids: [form.unitId],
    valid_from: new Date(form.validFrom).toISOString(),
    valid_until: new Date(form.validUntil).toISOString(),
    reason: form.reason.trim(),
    ...(form.legalBasis.trim() === '' ? {} : { legal_basis_ref: form.legalBasis.trim() }),
  };
}

/** The permissions the delegator may offer: their own that something reads a delegation for (never the administration of access and of the organisation, nor the reads). */
export function offeredPermissions(held: readonly string[] | undefined): string[] {
  const own = held === undefined ? [...SUGGESTED_PERMISSIONS] : held.filter((permission) => DELEGABLE.has(permission));
  return [...new Set(own)].sort();
}

export type Problem = 'chain' | 'escalation' | 'self' | 'invalid' | 'inactive' | 'notFound' | 'versionConflict' | 'notRevocable' | 'denied' | 'general';

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'DELEGATION_CHAIN_DENIED':
      return 'chain';
    case 'ROLE_ESCALATION_DENIED':
      return 'escalation';
    case 'SELF_GRANT_DENIED':
      return 'self';
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
      return 'notRevocable';
    case 'SCOPE_DENIED':
    case 'PERMISSION_DENIED':
      return 'denied';
    default:
      return 'general';
  }
}

/** The defects of a refused delegation, each with its field. */
export function readDefects(error: unknown): Array<{ field: string; code: string }> {
  if (!(error instanceof ApiError) || error.code !== 'DELEGATION_INVALID') return [];
  const list = record(error.extensions)?.defects;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const item = record(entry);
    return typeof item?.field === 'string' && typeof item.code === 'string' ? [{ field: item.field, code: item.code }] : [];
  });
}
