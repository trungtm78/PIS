import { ApiError } from '@machvon/api-client';
import { toPayment } from '../billing/model';
import type { InvoiceView, PaymentView } from '../billing/model';

/** The permissions of SAS-10 (x-permission of the operations in openapi.json). */
export const READ_PAYMENTS_PERMISSION = 'system.tenant.read';
export const MATCH_PAYMENT_PERMISSION = 'system.billing.manage';

export interface PaymentPage {
  items: PaymentView[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;

export function toPaymentPage(raw: unknown): PaymentPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(view.items) ? view.items.flatMap((item) => toPayment(item) ?? []) : [],
    nextCursor: typeof view.next_cursor === 'string' ? view.next_cursor : undefined,
  };
}

/** The invoices a payment can settle: the ones that were issued and are not paid (the server judges the same, and the amount). */
export const PAYABLE = ['Issued', 'Sent', 'PartiallyPaid', 'Overdue'] as const;
export const payableInvoices = (invoices: readonly InvoiceView[]): InvoiceView[] => invoices.filter((invoice) => (PAYABLE as readonly string[]).includes(invoice.status));

/** What an invoice has been paid so far and what is left, in whole VND, from the payments that matched it. */
export function outstandingOf(invoice: Pick<InvoiceView, 'totalVnd' | 'payments'>): string {
  const paid = invoice.payments.filter((payment) => payment.status === 'Matched').reduce((sum, payment) => sum + BigInt(/^-?[0-9]{1,24}$/.test(payment.amountVnd) ? payment.amountVnd : '0'), 0n);
  return (BigInt(/^-?[0-9]{1,24}$/.test(invoice.totalVnd) ? invoice.totalVnd : '0') - paid).toString();
}

export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;

export type ProblemReason = 'mismatch' | 'paymentState' | 'invoiceState' | 'conflict' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** What is still to be paid of the invoice, when the amount was the refusal. */
  outstandingVnd: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  AMOUNT_MISMATCH: 'mismatch',
  PAYMENT_STATE_INVALID: 'paymentState',
  EINVOICE_STATE_INVALID: 'invoiceState',
  VERSION_CONFLICT: 'conflict',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, outstandingVnd: undefined };
  const outstanding = error.extensions?.outstanding_vnd;
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail, outstandingVnd: typeof outstanding === 'string' ? outstanding : undefined };
}
