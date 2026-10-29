import { ApiError } from '@machvon/api-client';
import type { InvoiceView } from '../billing/model';

/** The permissions of SAS-24 (x-permission of the operations in openapi.json). */
export const READ_CORRECTION_PERMISSION = 'system.tenant.read';
export const MANAGE_CORRECTION_PERMISSION = 'system.billing.manage';

export const CORRECTION_KINDS = ['ADJUSTMENT', 'REPLACEMENT'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export const VAT_CATEGORIES = ['NOT_SUBJECT', 'VAT_0', 'VAT_5', 'VAT_8', 'VAT_10'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];
const RATE_BASIS_POINTS: Readonly<Record<VatCategory, bigint>> = { NOT_SUBJECT: 0n, VAT_0: 0n, VAT_5: 500n, VAT_8: 800n, VAT_10: 1000n };

export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const MIN_AGREEMENT_REF = 5;
export const MAX_LINES = 50;
const MAX_DESCRIPTION = 500;
const WHOLE_VND = /^-?[0-9]{1,24}$/;

export interface LineForm {
  /** A key that stays with the row while rows are added and removed. */
  key: number;
  description: string;
  amount: string;
  vat: VatCategory;
}

export interface CorrectionForm {
  kind: CorrectionKind;
  reason: string;
  agreementRef: string;
  lines: LineForm[];
}

let nextKey = 1;
export const newLine = (): LineForm => ({ key: nextKey++, description: '', amount: '', vat: 'NOT_SUBJECT' });
export const emptyForm = (): CorrectionForm => ({ kind: 'ADJUSTMENT', reason: '', agreementRef: '', lines: [newLine()] });

/** The issued invoices a person can correct: not a correction itself and not one that has been replaced. */
const CORRECTABLE = ['Issued', 'Sent', 'PartiallyPaid', 'Paid', 'Overdue', 'Adjusted'] as const;
export const isCorrectable = (invoice: Pick<InvoiceView, 'kind' | 'status'>): boolean => invoice.kind !== 'ADJUSTMENT' && (CORRECTABLE as readonly string[]).includes(invoice.status);

const amountOf = (value: string): bigint => (WHOLE_VND.test(value) ? BigInt(value) : 0n);

/** The VAT of a line rounded half up to whole VND; a line that takes money off has the VAT of its own size with the opposite sign (the server works it out the same way). */
export function vatOf(amount: bigint, category: VatCategory): bigint {
  const size = amount < 0n ? -amount : amount;
  const vat = (size * RATE_BASIS_POINTS[category] + 5000n) / 10000n;
  return amount < 0n ? -vat : vat;
}

export interface Totals {
  subtotal: string;
  vat: string;
  total: string;
}

/** The totals of the lines that have an amount; a line that is not whole VND counts for nothing until it is corrected. */
export function totalsOf(lines: readonly LineForm[]): Totals {
  let subtotal = 0n;
  let vat = 0n;
  for (const line of lines) {
    if (!WHOLE_VND.test(line.amount)) continue;
    const amount = BigInt(line.amount);
    subtotal += amount;
    vat += vatOf(amount, line.vat);
  }
  return { subtotal: subtotal.toString(), vat: vat.toString(), total: (subtotal + vat).toString() };
}

/** What the tenant owes once the correction is issued: an adjustment adds its total; a replacement takes the place of what the invoice stood for. */
export function receivableAfter(kind: CorrectionKind, receivable: string, standing: string, total: string): string {
  const base = amountOf(receivable);
  return (kind === 'ADJUSTMENT' ? base + amountOf(total) : base - amountOf(standing) + amountOf(total)).toString();
}

export type LineProblem = 'description' | 'amount' | 'zero';
export type TotalProblem = 'zero' | 'belowZero' | 'notAbove';

export interface FormProblems {
  reason?: 'tooShort';
  agreementRef?: 'tooShort';
  lines?: 'empty' | 'tooMany';
  line: Record<number, LineProblem>;
  total?: TotalProblem;
}

/** The problems of the form as the server judges them: the reason, the agreement, each line, and the total against what the invoice stands for. */
export function validateForm(form: CorrectionForm, standing: string): FormProblems {
  const problems: FormProblems = { line: {} };
  if (form.reason.trim().length < MIN_REASON) problems.reason = 'tooShort';
  if (form.agreementRef.trim().length < MIN_AGREEMENT_REF) problems.agreementRef = 'tooShort';
  if (form.lines.length === 0) problems.lines = 'empty';
  if (form.lines.length > MAX_LINES) problems.lines = 'tooMany';
  for (const line of form.lines) {
    if (line.description.trim() === '' || line.description.length > MAX_DESCRIPTION) problems.line[line.key] = 'description';
    else if (!WHOLE_VND.test(line.amount)) problems.line[line.key] = 'amount';
    else if (BigInt(line.amount) === 0n) problems.line[line.key] = 'zero';
  }
  if (Object.keys(problems.line).length === 0 && problems.lines === undefined) {
    const total = BigInt(totalsOf(form.lines).total);
    if (form.kind === 'REPLACEMENT') {
      if (total <= 0n) problems.total = 'notAbove';
    } else if (total === 0n) problems.total = 'zero';
    else if (amountOf(standing) + total < 0n) problems.total = 'belowZero';
  }
  return problems;
}

export const hasProblems = (problems: FormProblems): boolean => problems.reason !== undefined || problems.agreementRef !== undefined || problems.lines !== undefined || problems.total !== undefined || Object.keys(problems.line).length > 0;

export function correctionBody(form: CorrectionForm): Record<string, unknown> {
  return {
    correction_reason: form.reason.trim(),
    agreement_document_ref: form.agreementRef.trim(),
    lines: form.lines.map((line) => ({ description: line.description.trim(), amount_vnd: BigInt(line.amount).toString(), vat_category: line.vat })),
  };
}

export type ProblemReason = 'adjustmentInvalid' | 'alreadyReplaced' | 'stateInvalid' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** Why the totals were refused, and what the invoice stands for, when they were. */
  detail: string | undefined;
  standingVnd: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  EINVOICE_ADJUSTMENT_INVALID: 'adjustmentInvalid',
  EINVOICE_ALREADY_REPLACED: 'alreadyReplaced',
  EINVOICE_STATE_INVALID: 'stateInvalid',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, detail: undefined, standingVnd: undefined };
  const standing = error.extensions?.standing_vnd;
  const why = error.extensions?.reason;
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, detail: typeof why === 'string' ? why : undefined, standingVnd: typeof standing === 'string' ? standing : undefined };
}
