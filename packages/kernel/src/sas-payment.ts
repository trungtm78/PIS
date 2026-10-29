/**
 * The payment webhooks and their reconciliation (ST-SAS-012, SAS.md 3.7 item 3): what a payment callback and an e-invoice callback say once their signature has been verified, the invoice codes a
 * transfer note names, and the rule that decides whether a payment settles an invoice. The bodies are those of the providers (the MOCK ones until D06); a body that does not have the shape here is
 * `undefined`, never a guess.
 */

const MAX_EVENT = 200;
const MAX_MEMO = 500;
const WHOLE_VND = /^[0-9]{1,24}$/;
/** A code of an invoice (`invoiceCodeOf`): the period, the start of the subscription id and, for a replaced draft, its revision. */
// A code is a whole word: not part of a longer run of letters and digits, and not the front of a longer revision (`-1000` is not the revision `-100`).
const INVOICE_CODE = /(?<![0-9A-Za-z])INV-\d{8}-[0-9A-F]{8}(?:-\d{1,3})?(?![0-9A-Za-z]|-\d)/gi;

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'GATEWAY', 'TREASURY_TRANSFER'] as const;
export type BillingPaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface PaymentCallback {
  /** The event id of the provider: the key of the inbox. */
  eventKey: string;
  /** The reference of the transaction at the provider (the bank): one payment for each, whatever the number of callbacks. */
  txnRef: string;
  amountVnd: string;
  method: BillingPaymentMethod;
  receivedAt: Date;
  /** The note of the transfer, where the payer writes the code of the invoice. */
  memo: string;
}

export interface EInvoiceCallback {
  eventKey: string;
  /** The reference key the platform gave the provider: the id of the invoice. */
  referenceKey: string;
  templateCode: string;
  series: string;
  number: string;
  taxAuthorityCode: string;
  lookupCode: string;
}

type Raw = Record<string, unknown>;

function parseObject(rawBody: Buffer): Raw | undefined {
  try {
    const value: unknown = JSON.parse(rawBody.toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined;
  } catch {
    return undefined;
  }
}

const text = (value: unknown, max: number, allowEmpty = false): string | undefined =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.trim() !== '') ? value : undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidText = (value: unknown): string | undefined => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined);

/** A payment callback: `{ event_id, type: 'payment.received', txn_ref, amount_vnd, method?, received_at, memo }`. */
export function parsePaymentCallback(rawBody: Buffer): PaymentCallback | undefined {
  const body = parseObject(rawBody);
  if (body === undefined || body.type !== 'payment.received') return undefined;
  const [eventKey, txnRef, memo] = [text(body.event_id, MAX_EVENT), text(body.txn_ref, MAX_EVENT), text(body.memo, MAX_MEMO, true)];
  const amount = typeof body.amount_vnd === 'string' ? body.amount_vnd : typeof body.amount_vnd === 'number' && Number.isSafeInteger(body.amount_vnd) ? String(body.amount_vnd) : undefined;
  const method = body.method === undefined ? 'BANK_TRANSFER' : PAYMENT_METHODS.find((candidate) => candidate === body.method);
  const receivedAt = typeof body.received_at === 'string' ? new Date(body.received_at) : undefined;
  if (eventKey === undefined || txnRef === undefined || memo === undefined || amount === undefined || !WHOLE_VND.test(amount) || BigInt(amount) <= 0n || method === undefined) return undefined;
  if (receivedAt === undefined || Number.isNaN(receivedAt.getTime())) return undefined;
  return { eventKey, txnRef, amountVnd: BigInt(amount).toString(), method, receivedAt, memo };
}

/** An e-invoice callback: `{ event_id, type: 'einvoice.issued', reference_key, template_code, series, number, tax_authority_code, lookup_code }`. */
export function parseEInvoiceCallback(rawBody: Buffer): EInvoiceCallback | undefined {
  const body = parseObject(rawBody);
  if (body === undefined || body.type !== 'einvoice.issued') return undefined;
  const fields = [text(body.event_id, MAX_EVENT), uuidText(body.reference_key), text(body.template_code, 30), text(body.series, 30), text(body.number, 64), text(body.tax_authority_code, 100), text(body.lookup_code, 100)];
  if (fields.some((field) => field === undefined)) return undefined;
  const [eventKey, referenceKey, templateCode, series, number, taxAuthorityCode, lookupCode] = fields as string[];
  return { eventKey: eventKey as string, referenceKey: referenceKey as string, templateCode: templateCode as string, series: series as string, number: number as string, taxAuthorityCode: taxAuthorityCode as string, lookupCode: lookupCode as string };
}

/** The invoice codes a transfer note names, upper case, each once, in the order written: the payer may write the code in any case, with other words around it. */
export function invoiceCodesIn(memo: string): string[] {
  return [...new Set((memo.match(INVOICE_CODE) ?? []).map((code) => code.toUpperCase()))];
}

/** What is still to be paid of an invoice: the total less what the payments that matched it came to. */
export function outstandingVnd(totalVnd: string, paidVnd: string): string {
  return (BigInt(totalVnd) - BigInt(paidVnd)).toString();
}

export type MatchVerdict = 'MATCH' | 'AMOUNT_MISMATCH';

/** A payment settles an invoice only for exactly what is still to be paid (SAS.md 3.7): any other amount is for a person to look at. */
export function judgeMatch(paymentVnd: string, outstanding: string): MatchVerdict {
  return BigInt(outstanding) > 0n && BigInt(paymentVnd) === BigInt(outstanding) ? 'MATCH' : 'AMOUNT_MISMATCH';
}

export type PaymentCandidate = { tenantId: string; invoiceId: string; status: string; outstandingVnd: string };

/** The invoice statuses a payment can settle. */
export const PAYABLE_INVOICE_STATUSES: readonly string[] = ['Issued', 'Sent', 'PartiallyPaid', 'Overdue'];

/**
 * What the matching worker does with a payment given the invoices its note names (`namedCodes` is how many codes the note holds, found or not): it settles the one invoice that is payable and whose outstanding amount the payment equals; a note that names no
 * invoice leaves the payment Unmatched; a note that names several, an invoice that is not payable, or an amount that is not the outstanding one sends it to a person (PendingReview).
 */
export function autoMatch(paymentVnd: string, candidates: readonly PaymentCandidate[], namedCodes: number): { verdict: 'MATCH'; candidate: PaymentCandidate } | { verdict: 'UNMATCHED' } | { verdict: 'REVIEW' } {
  // A note that names several codes is ambiguous whether or not each of them is an invoice that can be found now (one may be discarded, or not made yet).
  if (namedCodes > 1) return { verdict: 'REVIEW' };
  if (candidates.length === 0) return { verdict: 'UNMATCHED' };
  const [only] = candidates;
  if (candidates.length > 1 || only === undefined || !PAYABLE_INVOICE_STATUSES.includes(only.status)) return { verdict: 'REVIEW' };
  return judgeMatch(paymentVnd, only.outstandingVnd) === 'MATCH' ? { verdict: 'MATCH', candidate: only } : { verdict: 'REVIEW' };
}
