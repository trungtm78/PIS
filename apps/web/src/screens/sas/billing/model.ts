import { ApiError } from '@machvon/api-client';

/** The permissions of SAS-09 (x-permission of the operations in openapi.json). */
export const READ_BILLING_PERMISSION = 'system.tenant.read';
export const MANAGE_BILLING_PERMISSION = 'system.billing.manage';

export const INVOICE_STATUSES = ['Draft', 'Discarded', 'PendingIssue', 'IssueFailed', 'Issued', 'Sent', 'PartiallyPaid', 'Paid', 'Overdue', 'Adjusted', 'Replaced'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const LINE_KINDS = ['SUBSCRIPTION', 'USAGE', 'ADJUSTMENT', 'DISCOUNT'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export interface InvoiceLineView {
  id: string;
  lineNo: number;
  kind: LineKind;
  description: string;
  amountVnd: string;
  vatCategory: string;
  vatVnd: string;
}

export const PAYMENT_STATUSES = ['Unmatched', 'PendingReview', 'Matched', 'Reversed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'GATEWAY', 'TREASURY_TRANSFER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface PaymentView {
  id: string;
  provider: string;
  txnRef: string;
  amountVnd: string;
  method: PaymentMethod;
  receivedAt: string;
  status: PaymentStatus;
  memo: string;
  invoiceId: string | undefined;
  version: number;
  canMatch: boolean;
}

export const INVOICE_KINDS = ['ORIGINAL', 'ADJUSTMENT', 'REPLACEMENT'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export interface InvoiceView {
  id: string;
  kind: InvoiceKind;
  /** The invoice a correction corrects, with why and the document of the buyer's agreement. */
  relatedInvoiceId: string | undefined;
  correctionReason: string | undefined;
  agreementDocumentRef: string | undefined;
  invoiceCode: string;
  periodStart: string;
  periodEnd: string;
  status: InvoiceStatus;
  subtotalVnd: string;
  vatVnd: string;
  totalVnd: string;
  /** What the invoice stands for: its total and the adjustments of it that were issued. */
  standingVnd: string;
  /** What is still owed on the invoice: the amount a payment must be to settle it. */
  outstandingVnd: string;
  dueAt: string | undefined;
  issuedAt: string | undefined;
  series: string | undefined;
  number: string | undefined;
  /** The code the tax authority gave the invoice, and the code to look it up with. */
  taxAuthorityCode: string | undefined;
  lookupCode: string | undefined;
  payments: PaymentView[];
  issueAttempts: number;
  nextAttemptAt: string | undefined;
  issueError: string | undefined;
  version: number;
  lines: InvoiceLineView[];
  canIssue: boolean;
}

export interface TenantInvoices {
  items: InvoiceView[];
  subscriptionStatus: string | undefined;
  pastDueSince: string | undefined;
  suspensionProposedAt: string | undefined;
  /** What the tenant owes: the invoices that stand, less what was paid. */
  receivableVnd: string | undefined;
  /** The cursor of the next (older) page of invoices. */
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

function toLine(raw: unknown): InvoiceLineView | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  return { id: row.id, lineNo: count(row.line_no), kind: oneOf(row.kind, LINE_KINDS, 'SUBSCRIPTION'), description: text(row.description), amountVnd: text(row.amount_vnd) || '0', vatCategory: text(row.vat_category), vatVnd: text(row.vat_vnd) || '0' };
}

export function toPayment(raw: unknown): PaymentView | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  const actions: Raw = isRecord(row.actions) ? row.actions : {};
  return {
    id: row.id,
    provider: text(row.provider),
    txnRef: text(row.txn_ref),
    amountVnd: text(row.amount_vnd) || '0',
    method: oneOf(row.method, PAYMENT_METHODS, 'BANK_TRANSFER'),
    receivedAt: text(row.received_at),
    status: oneOf(row.match_status, PAYMENT_STATUSES, 'Unmatched'),
    memo: text(row.memo),
    invoiceId: optionalText(row.invoice_id),
    version: count(row.version),
    canMatch: actions.match === true,
  };
}

function toInvoice(raw: unknown): InvoiceView | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  const einvoice: Raw = isRecord(row.einvoice) ? row.einvoice : {};
  const actions: Raw = isRecord(row.actions) ? row.actions : {};
  return {
    id: row.id,
    kind: oneOf(row.kind, INVOICE_KINDS, 'ORIGINAL'),
    relatedInvoiceId: optionalText(row.related_invoice_id),
    correctionReason: optionalText(row.correction_reason),
    agreementDocumentRef: optionalText(row.agreement_document_ref),
    invoiceCode: text(row.invoice_code),
    periodStart: text(row.period_start),
    periodEnd: text(row.period_end),
    status: oneOf(row.status, INVOICE_STATUSES, 'Draft'),
    subtotalVnd: text(row.subtotal_vnd) || '0',
    vatVnd: text(row.vat_vnd) || '0',
    totalVnd: text(row.total_vnd) || '0',
    standingVnd: text(row.standing_vnd) || text(row.total_vnd) || '0',
    outstandingVnd: text(row.outstanding_vnd) || text(row.standing_vnd) || text(row.total_vnd) || '0',
    dueAt: optionalText(row.due_at),
    issuedAt: optionalText(row.issued_at),
    series: optionalText(einvoice.series),
    number: optionalText(einvoice.number),
    taxAuthorityCode: optionalText(einvoice.tax_authority_code),
    lookupCode: optionalText(einvoice.lookup_code),
    payments: Array.isArray(row.payments) ? row.payments.flatMap((payment) => toPayment(payment) ?? []) : [],
    issueAttempts: count(row.issue_attempts),
    nextAttemptAt: optionalText(row.next_attempt_at),
    issueError: optionalText(row.issue_error),
    version: count(row.version),
    lines: Array.isArray(row.lines) ? row.lines.flatMap((line) => toLine(line) ?? []) : [],
    canIssue: actions.issue === true,
  };
}

export function toTenantInvoices(raw: unknown): TenantInvoices {
  const view: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(view.items) ? view.items.flatMap((item) => toInvoice(item) ?? []) : [],
    subscriptionStatus: optionalText(view.subscription_status),
    pastDueSince: optionalText(view.past_due_since),
    suspensionProposedAt: optionalText(view.suspension_proposed_at),
    receivableVnd: optionalText(view.receivable_vnd),
    nextCursor: optionalText(view.next_cursor),
  };
}

/** Whole VND with the thousands separators of the language, exact for any size; anything that is not digits is shown as it came. */
export function formatVnd(amount: string, locale: string): string {
  return /^-?[0-9]{1,24}$/.test(amount) ? BigInt(amount).toLocaleString(locale) : amount;
}

export interface RunForm {
  periodStart: string;
  periodEnd: string;
}

export type RunField = 'periodStart' | 'periodEnd';
export type RunProblem = 'required' | 'notDate' | 'backwards' | 'tooLong';

export const EMPTY_RUN: RunForm = { periodStart: '', periodEnd: '' };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayNumber = (value: string): number | undefined => {
  const match = DAY.exec(value);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() / 86_400_000 : undefined;
};

/** The problems of the form of the run: both days are calendar days, the end is not before the start, and the period is no longer than a year (the server judges the same, and that it has begun). */
export function validateRun(form: RunForm): Partial<Record<RunField, RunProblem>> {
  const problems: Partial<Record<RunField, RunProblem>> = {};
  const [start, end] = [dayNumber(form.periodStart), dayNumber(form.periodEnd)];
  if (form.periodStart === '') problems.periodStart = 'required';
  else if (start === undefined) problems.periodStart = 'notDate';
  if (form.periodEnd === '') problems.periodEnd = 'required';
  else if (end === undefined) problems.periodEnd = 'notDate';
  if (start !== undefined && end !== undefined) {
    if (end < start) problems.periodEnd = 'backwards';
    else if (end - start > 365) problems.periodEnd = 'tooLong';
  }
  return problems;
}

export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;

export type ProblemReason = 'period' | 'stateInvalid' | 'conflict' | 'provider' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  BILLING_PERIOD_INVALID: 'period',
  EINVOICE_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'conflict',
  EINVOICE_PROVIDER_UNAVAILABLE: 'provider',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}

/** How the screen asks again while an invoice waits for the provider: the worker asks, and the page follows without being reloaded by hand. */
export const WAITING_REFRESH_MS = 15_000;
export const isWaiting = (invoices: readonly InvoiceView[] | undefined): boolean => (invoices ?? []).some((invoice) => invoice.status === 'PendingIssue');
