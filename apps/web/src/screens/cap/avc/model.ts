import { ApiError } from '@machvon/api-client';

/** The permissions of CAP-17 (x-permission in openapi.json). */
export const READ_PERMISSION = 'capital.read';
export const MANAGE_PERMISSION = 'capital.avc.manage';
export const APPROVE_PERMISSION = 'capital.avc.approve';
export const READ_UNITS_PERMISSION = 'organization_unit.read';

export const SCOPE_KINDS = ['TENANT', 'FUND_SOURCE', 'UNIT', 'PROJECT_GROUP'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export const CONTROL_OBJECTS = ['ALLOCATION_LINE', 'APPROPRIATION'] as const;
export type ControlObject = (typeof CONTROL_OBJECTS)[number];
export const POLICY_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];
export const PROJECT_GROUPS = ['QTQG', 'A', 'B', 'C'] as const;

export interface PolicyRow {
  id: string;
  policyCode: string;
  revision: number;
  scopeKind: ScopeKind;
  scopeRefId: string | null;
  scopeValue: string | null;
  controlObject: ControlObject;
  warnPct: string;
  blockPct: string;
  includeReservations: boolean;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  status: PolicyStatus;
  createdBy: string;
  version: number;
}

export interface PreviewCounts {
  policyId: string;
  controlObject: ControlObject;
  total: number;
  ok: number;
  warn: number;
  block: number;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

export function toPolicy(raw: unknown): PolicyRow | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  return {
    id: row.id,
    policyCode: text(row.policy_code),
    revision: count(row.revision),
    scopeKind: oneOf(row.scope_kind, SCOPE_KINDS, 'TENANT'),
    scopeRefId: nullableText(row.scope_ref_id),
    scopeValue: nullableText(row.scope_value),
    controlObject: oneOf(row.control_object, CONTROL_OBJECTS, 'ALLOCATION_LINE'),
    warnPct: text(row.warn_pct),
    blockPct: text(row.block_pct),
    includeReservations: row.include_reservations !== false,
    legalBasis: text(row.legal_basis),
    effectiveFrom: text(row.effective_from),
    effectiveUntil: nullableText(row.effective_until),
    status: oneOf(row.status, POLICY_STATUSES, 'DRAFT'),
    createdBy: text(row.created_by),
    version: count(row.version),
  };
}

export function toPreview(raw: unknown): PreviewCounts {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    policyId: text(row.policy_id),
    controlObject: oneOf(row.control_object, CONTROL_OBJECTS, 'ALLOCATION_LINE'),
    total: count(row.total),
    ok: count(row.ok),
    warn: count(row.warn),
    block: count(row.block),
  };
}

// ---- the form -----------------------------------------------------------------------------------------------------------

export interface PolicyForm {
  policyCode: string;
  scopeKind: ScopeKind;
  scopeRefId: string;
  scopeValue: string;
  controlObject: ControlObject;
  warnPct: string;
  blockPct: string;
  includeReservations: boolean;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string;
}

/** A tenant policy of 90 and 100 (the tenant default of BR-CAP-06) over lines, for a day typed by the author. */
export const EMPTY_FORM: PolicyForm = {
  policyCode: '',
  scopeKind: 'TENANT',
  scopeRefId: '',
  scopeValue: '',
  controlObject: 'ALLOCATION_LINE',
  warnPct: '90',
  blockPct: '100',
  includeReservations: true,
  legalBasis: '',
  effectiveFrom: '',
  effectiveUntil: '',
};

export type FormField = 'policyCode' | 'scope' | 'warnPct' | 'blockPct' | 'legalBasis' | 'effectiveFrom' | 'effectiveUntil';
export type FieldProblem = 'required' | 'format' | 'notPercentage' | 'above100' | 'warnAboveBlock' | 'tooShort' | 'beforeStart' | 'notDate';

const PCT = /^[0-9]{1,3}(\.[0-9]{1,2})?$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MIN_LEGAL_BASIS = 3;
export const MAX_LEGAL_BASIS = 2000;

/** A percentage as hundredths of a percent, or undefined when it is not one of at most two decimals. */
export function hundredths(value: string): number | undefined {
  const text = value.trim();
  if (!PCT.test(text)) return undefined;
  const [whole = '0', fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0') || '0');
}

const isCalendarDate = (value: string): boolean => {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return date.getUTCFullYear() === year && date.getUTCMonth() === (month ?? 1) - 1 && date.getUTCDate() === day;
};

/** What is wrong with the form, field by field, in the order the server judges them (the thresholds first). */
export function validateForm(form: PolicyForm): Partial<Record<FormField, FieldProblem>> {
  const problems: Partial<Record<FormField, FieldProblem>> = {};
  const warn = hundredths(form.warnPct);
  const block = hundredths(form.blockPct);
  if (warn === undefined) problems.warnPct = 'notPercentage';
  else if (warn > 10000) problems.warnPct = 'above100';
  if (block === undefined) problems.blockPct = 'notPercentage';
  else if (block > 10000) problems.blockPct = 'above100';
  if (warn !== undefined && block !== undefined && problems.warnPct === undefined && problems.blockPct === undefined && warn > block) problems.warnPct = 'warnAboveBlock';
  if (form.policyCode.trim() === '') problems.policyCode = 'required';
  else if (!CODE.test(form.policyCode.trim())) problems.policyCode = 'format';
  if ((form.scopeKind === 'UNIT' && form.scopeRefId === '') || ((form.scopeKind === 'FUND_SOURCE' || form.scopeKind === 'PROJECT_GROUP') && form.scopeValue === '')) problems.scope = 'required';
  const basis = form.legalBasis.trim();
  if (basis === '') problems.legalBasis = 'required';
  else if (basis.length < MIN_LEGAL_BASIS) problems.legalBasis = 'tooShort';
  if (form.effectiveFrom === '') problems.effectiveFrom = 'required';
  else if (!isCalendarDate(form.effectiveFrom)) problems.effectiveFrom = 'notDate';
  if (form.effectiveUntil !== '') {
    if (!isCalendarDate(form.effectiveUntil)) problems.effectiveUntil = 'notDate';
    else if (problems.effectiveFrom === undefined && form.effectiveUntil < form.effectiveFrom) problems.effectiveUntil = 'beforeStart';
  }
  return problems;
}

/** The body of `createAvcPolicyVersion` for a form that passed `validateForm`. */
export function createBody(form: PolicyForm): Record<string, unknown> {
  return {
    policy_code: form.policyCode.trim(),
    scope_kind: form.scopeKind,
    ...(form.scopeKind === 'UNIT' ? { scope_ref_id: form.scopeRefId } : {}),
    ...(form.scopeKind === 'FUND_SOURCE' || form.scopeKind === 'PROJECT_GROUP' ? { scope_value: form.scopeValue } : {}),
    control_object: form.controlObject,
    warn_pct: form.warnPct.trim(),
    block_pct: form.blockPct.trim(),
    include_reservations: form.includeReservations,
    legal_basis: form.legalBasis.trim(),
    effective_from: form.effectiveFrom,
    ...(form.effectiveUntil === '' ? {} : { effective_until: form.effectiveUntil }),
  };
}

/** The form that drafts the next revision of a policy: the same code, scope and object (the code is one policy over time), the thresholds and basis to be changed. */
export function formOfRevision(policy: PolicyRow): PolicyForm {
  return {
    policyCode: policy.policyCode,
    scopeKind: policy.scopeKind,
    scopeRefId: policy.scopeRefId ?? '',
    scopeValue: policy.scopeValue ?? '',
    controlObject: policy.controlObject,
    warnPct: policy.warnPct,
    blockPct: policy.blockPct,
    includeReservations: policy.includeReservations,
    legalBasis: policy.legalBasis,
    effectiveFrom: '',
    effectiveUntil: '',
  };
}

export interface Bars {
  /** Where the warning starts and where the block starts, as a share of the bar (0 to 100), for the two marks of the thresholds. */
  warn: number;
  block: number;
}

/** The two threshold marks of the editor; a value that is not a percentage is drawn at 0 and the field says why. */
export function barsOf(warnPct: string, blockPct: string): Bars {
  const clamp = (value: number | undefined): number => (value === undefined ? 0 : Math.min(100, value / 100));
  return { warn: clamp(hundredths(warnPct)), block: clamp(hundredths(blockPct)) };
}

/** Whether a draft may be published by the member: they hold the right and are not its maker (the server judges the same). */
export const mayPublish = (policy: PolicyRow, membershipId: string | undefined, holdsApprove: boolean): boolean =>
  holdsApprove && policy.status === 'DRAFT' && (membershipId === undefined || policy.createdBy.toLowerCase() !== membershipId.toLowerCase());

// ---- refusals -----------------------------------------------------------------------------------------------------------

export type ProblemReason = 'threshold' | 'invalid' | 'selfApproval' | 'state' | 'overlap' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  AVC_THRESHOLD_INVALID: 'threshold',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  SELF_APPROVAL_DENIED: 'selfApproval',
  AVC_POLICY_STATE_INVALID: 'state',
  AVC_POLICY_OVERLAP: 'overlap',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
