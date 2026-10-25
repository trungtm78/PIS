import { ApiError } from '@machvon/api-client';

/** The permissions of CAP-20 (x-permission of the operations in openapi.json). */
export const READ_PERMISSION = 'capital.read';
export const REQUEST_PERMISSION = 'capital.extension.request';
export const APPROVE_PERMISSION = 'capital.extension.approve';

export const REASON_CODES = ['GPMB_CHAM', 'VUONG_MAC_PHAP_LY', 'THIEN_TAI_DICH_BENH', 'KHAC'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const EXTENSION_STATUSES = ['REQUESTED', 'APPROVED', 'APPLIED', 'REJECTED', 'LAPSED'] as const;
export type ExtensionStatus = (typeof EXTENSION_STATUSES)[number];

export const MIN_JUSTIFICATION = 20;
export const MAX_JUSTIFICATION = 2000;
export const MIN_DECISION_REASON = 5;
export const MAX_DECISION_REASON = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHOLE = /^[1-9][0-9]{0,23}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ExtensionEntry {
  id: string;
  allocationLineId: string;
  projectId: string;
  fromPlanYear: number;
  extendedTo: string;
  amountVnd: string;
  reasonCode: ReasonCode;
  justification: string | undefined;
  approvingDocumentId: string | undefined;
  status: ExtensionStatus;
  newAllocationLineId: string | undefined;
  newAppropriationId: string | undefined;
  requestedBy: string;
  decidedBy: string | undefined;
  decidedAt: string | undefined;
  decisionReason: string | undefined;
  version: number;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function toExtension(raw: unknown): ExtensionEntry | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  return {
    id: row.id,
    allocationLineId: text(row.allocation_line_id),
    projectId: text(row.project_id),
    fromPlanYear: count(row.from_plan_year),
    extendedTo: text(row.extended_to),
    amountVnd: text(row.amount_vnd) || '0',
    reasonCode: REASON_CODES.find((candidate) => candidate === row.reason_code) ?? 'KHAC',
    justification: optionalText(row.justification),
    approvingDocumentId: optionalText(row.approving_document_id),
    status: EXTENSION_STATUSES.find((candidate) => candidate === row.status) ?? 'REQUESTED',
    newAllocationLineId: optionalText(row.new_allocation_line_id),
    newAppropriationId: optionalText(row.new_appropriation_id),
    requestedBy: text(row.requested_by),
    decidedBy: optionalText(row.decided_by),
    decidedAt: optionalText(row.decided_at),
    decisionReason: optionalText(row.decision_reason),
    version: count(row.version),
  };
}

// ---- what is left on a line -------------------------------------------------------------------------------------------------------

export interface Availability {
  allocatedVnd: string;
  committedVnd: string;
  disbursedVnd: string;
}

export function toAvailability(raw: unknown): Availability {
  const row: Raw = isRecord(raw) ? raw : {};
  return { allocatedVnd: text(row.allocated_vnd) || '0', committedVnd: text(row.committed_vnd) || '0', disbursedVnd: text(row.disbursed_vnd) || '0' };
}

const big = (value: string): bigint => (/^-?[0-9]{1,24}$/.test(value) ? BigInt(value) : 0n);

/** Allocated less committed and disbursed and less what other open requests on the line already ask for; never below zero (the server judges the same). */
export function undisbursedOf(figures: Availability, openRequestsVnd: string): string {
  const left = big(figures.allocatedVnd) - big(figures.committedVnd) - big(figures.disbursedVnd) - big(openRequestsVnd);
  return (left > 0n ? left : 0n).toString();
}

/** What the requests of a line that still wait ask for together. */
export function openRequestsOf(entries: readonly ExtensionEntry[], lineId: string): string {
  return entries
    .filter((entry) => entry.allocationLineId === lineId && (entry.status === 'REQUESTED' || entry.status === 'APPROVED'))
    .reduce((total, entry) => total + big(entry.amountVnd), 0n)
    .toString();
}

/** Whole VND with the thousands separators of the language, exact for any size; anything that is not digits is shown as it came. */
export function formatVnd(amount: string, locale: string): string {
  return /^-?[0-9]{1,24}$/.test(amount) ? BigInt(amount).toLocaleString(locale) : amount;
}

// ---- the form of a request ---------------------------------------------------------------------------------------------------------

export interface ExtensionForm {
  planId: string;
  lineId: string;
  amountVnd: string;
  extendedTo: string;
  reasonCode: ReasonCode | '';
  justification: string;
}

export const EMPTY_FORM: ExtensionForm = { planId: '', lineId: '', amountVnd: '', extendedTo: '', reasonCode: '', justification: '' };

export type FormField = 'lineId' | 'amountVnd' | 'extendedTo' | 'reasonCode' | 'justification';
export type FieldProblem = 'required' | 'notWhole' | 'exceeds' | 'notDate' | 'tooEarly' | 'tooLate' | 'justificationRequired' | 'justificationLength';

/** The first and the last day on which capital of a year may still be disbursed: the year after it (the same window as the server). */
export function windowOf(year: number): { from: string; to: string } {
  return { from: `${year + 1}-01-01`, to: `${year + 1}-12-31` };
}

const isCalendarDate = (value: string): boolean => {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return date.getUTCFullYear() === year && date.getUTCMonth() === (month ?? 1) - 1 && date.getUTCDate() === day;
};

export interface FormContext {
  /** The plan year of the line chosen. */
  year: number | undefined;
  /** What is left to carry over on it, when the figures were read. */
  undisbursedVnd: string | undefined;
}

export function validateForm(form: ExtensionForm, context: FormContext): Partial<Record<FormField, FieldProblem>> {
  const problems: Partial<Record<FormField, FieldProblem>> = {};
  if (form.lineId === '') problems.lineId = 'required';
  const amount = form.amountVnd.trim();
  if (amount === '') problems.amountVnd = 'required';
  else if (!WHOLE.test(amount)) problems.amountVnd = 'notWhole';
  else if (context.undisbursedVnd !== undefined && big(amount) > big(context.undisbursedVnd)) problems.amountVnd = 'exceeds';
  if (form.extendedTo === '') problems.extendedTo = 'required';
  else if (!isCalendarDate(form.extendedTo)) problems.extendedTo = 'notDate';
  else if (context.year !== undefined) {
    const window = windowOf(context.year);
    if (form.extendedTo < window.from) problems.extendedTo = 'tooEarly';
    else if (form.extendedTo > window.to) problems.extendedTo = 'tooLate';
  }
  if (form.reasonCode === '') problems.reasonCode = 'required';
  const justification = form.justification.trim();
  if (justification === '') {
    if (form.reasonCode === 'KHAC') problems.justification = 'justificationRequired';
  } else if (justification.length < MIN_JUSTIFICATION || justification.length > MAX_JUSTIFICATION) problems.justification = 'justificationLength';
  return problems;
}

/** The body of `requestAllocationExtension` for a form that passed `validateForm`. */
export function requestBody(form: ExtensionForm): Record<string, unknown> {
  const justification = form.justification.trim();
  return { amount_vnd: form.amountVnd.trim(), extended_to: form.extendedTo, reason_code: form.reasonCode, ...(justification === '' ? {} : { justification }) };
}

// ---- the decision ------------------------------------------------------------------------------------------------------------------

export type Decision = 'approve' | 'reject';

export interface DecisionForm {
  documentId: string;
  reason: string;
}

export const EMPTY_DECISION: DecisionForm = { documentId: '', reason: '' };

export type DecisionField = 'documentId' | 'reason';
export type DecisionProblem = 'required' | 'invalidId' | 'reasonLength';

export function validateDecision(decision: Decision, form: DecisionForm): Partial<Record<DecisionField, DecisionProblem>> {
  const problems: Partial<Record<DecisionField, DecisionProblem>> = {};
  if (decision === 'approve') {
    const id = form.documentId.trim();
    if (id === '') problems.documentId = 'required';
    else if (!UUID.test(id)) problems.documentId = 'invalidId';
  }
  const reason = form.reason.trim();
  if (reason.length < MIN_DECISION_REASON || reason.length > MAX_DECISION_REASON) problems.reason = 'reasonLength';
  return problems;
}

/** Whether the person may decide the request: it waits, and it is not their own (four eyes: the server and the database refuse the same). */
export const mayDecide = (entry: ExtensionEntry, membershipId: string | undefined): boolean =>
  entry.status === 'REQUESTED' && membershipId !== undefined && entry.requestedBy.toLowerCase() !== membershipId.toLowerCase();

// ---- refusals ----------------------------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'amountExceeds'
  | 'notAllowed'
  | 'documentRequired'
  | 'selfApproval'
  | 'conflict'
  | 'stageDenied'
  | 'yearLocked'
  | 'duplicate'
  | 'invalid'
  | 'denied'
  | 'notFound'
  | 'session'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** What the server said it could still carry over, for an amount above it. */
  undisbursedVnd: string | undefined;
  /** Why a line cannot be carried over (the `reason` extension of EXTENSION_NOT_ALLOWED). */
  why: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  AMOUNT_EXCEEDS_UNDISBURSED: 'amountExceeds',
  EXTENSION_NOT_ALLOWED: 'notAllowed',
  EXTENSION_DOCUMENT_REQUIRED: 'documentRequired',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'conflict',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  FISCAL_YEAR_LOCKED: 'yearLocked',
  APPROPRIATION_DUPLICATE: 'duplicate',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, undisbursedVnd: undefined, why: undefined };
  return {
    reason: REASON_BY_CODE[error.code] ?? 'general',
    field: error.detail,
    undisbursedVnd: optionalText(error.extensions.undisbursed_vnd),
    why: optionalText(error.extensions.reason),
  };
}
