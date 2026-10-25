import { ApiError } from '@machvon/api-client';
import { isUuid } from '../../ctr/change/model';
import type { LedgerEntry, LedgerLine } from '../ledger/model';
import type { PaymentRequest } from '../payment/model';
import type { Transaction } from '../recon/model';

export const REVERSE_PERMISSION = 'payment.reverse';
export const LEDGER_PERMISSION = 'ledger.read';
export const REQUEST_READ_PERMISSION = 'payment_request.read';
export const TRANSACTION_READ_PERMISSION = 'treasury_transaction.read';

export const REVERSAL_PATH = '/pay/pay-08';

/** The reversal of a settled payment and the entries that show it (PAY-08). */
export const reversalLink = (id: string): string => `${REVERSAL_PATH}?${new URLSearchParams({ request: id }).toString()}`;

const MAX_TEXT = 2000;

/** The refunds the Treasury confirmed for the payment that settled a request: refunds, not yet used, of the very transaction that settled it. */
export function refundsFor(transactions: readonly Transaction[], request: Pick<PaymentRequest, 'settledTransactionId' | 'projectId'>): Transaction[] {
  if (request.settledTransactionId === null) return [];
  return transactions.filter((row) => row.direction === 'REFUND' && row.matchStatus === 'UNMATCHED' && row.reversalOfId === request.settledTransactionId && row.projectId === request.projectId);
}

/** One entry of the ledger that belongs to the request, with the entry that undoes it when there is one. */
export interface EntryPair {
  /** The item the entry is on (its key, for the person to read). */
  item: string;
  original: LedgerEntry;
  reversal: LedgerEntry | null;
}

const UNDOES: Readonly<Record<string, string>> = {
  PAYMENT_REVERSAL: 'PAYMENT',
  ADVANCE_RECOVERY_REVERSAL: 'ADVANCE_RECOVERY',
  CLAIM_RELEASE: 'CLAIM',
  RETENTION_RELEASE: 'RETENTION_HOLD',
};

/**
 * The entries of the ledger that a payment request put there, each beside the entry that undid it. Most reversals name the entry they undo; the release of a hold of retention does not, so it is
 * paired with the hold on the same item that has the opposite figure and no release yet. The entries that are not reversals come in the order they were posted.
 */
export function entryPairs(lines: readonly LedgerLine[], requestId: string): EntryPair[] {
  const pairs: EntryPair[] = [];
  for (const line of lines) {
    const mine = line.entries.filter((entry) => entry.paymentRequestId === requestId);
    const undone = new Set<string>();
    const originals = mine.filter((entry) => !(entry.kind in UNDOES));
    for (const original of originals) {
      let reversal = mine.find((entry) => entry.reversalOfId === original.id) ?? null;
      if (reversal === null && original.kind === 'RETENTION_HOLD') {
        reversal = mine.find((entry) => entry.kind === 'RETENTION_RELEASE' && !undone.has(entry.id) && BigInt(entry.retentionDeltaVnd) === -BigInt(original.retentionDeltaVnd)) ?? null;
      }
      if (reversal !== null) undone.add(reversal.id);
      pairs.push({ item: line.boqItemKey, original, reversal });
    }
  }
  return pairs.sort((a, b) => (a.original.postedAt === b.original.postedAt ? (a.original.id < b.original.id ? -1 : 1) : a.original.postedAt < b.original.postedAt ? -1 : 1));
}

/** The figure an entry is about: the one it moves (an entry moves one of them). */
export function figureOf(entry: LedgerEntry): string {
  for (const value of [entry.paidDeltaVnd, entry.requestedDeltaVnd, entry.advanceRecoveryDeltaVnd, entry.retentionDeltaVnd, entry.acceptedDeltaVnd]) if (BigInt(value) !== 0n) return value;
  return '0';
}

// ---- the command --------------------------------------------------------------------------------------------------------------

export type ReversalProblem = 'required' | 'tooLong' | 'uuid';

export interface ReverseForm {
  refundId: string;
  reason: string;
  approvalDocumentVersionId: string;
}

export const EMPTY_REVERSE: ReverseForm = { refundId: '', reason: '', approvalDocumentVersionId: '' };

export function validateReverse(form: ReverseForm): Partial<Record<keyof ReverseForm, ReversalProblem>> {
  const problems: Partial<Record<keyof ReverseForm, ReversalProblem>> = {};
  if (form.refundId.trim() === '') problems.refundId = 'required';
  else if (!isUuid(form.refundId.trim())) problems.refundId = 'uuid';
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length > MAX_TEXT) problems.reason = 'tooLong';
  const document = form.approvalDocumentVersionId.trim();
  if (document === '') problems.approvalDocumentVersionId = 'required';
  else if (!isUuid(document)) problems.approvalDocumentVersionId = 'uuid';
  return problems;
}

export const reverseBody = (form: ReverseForm): { reason: string; approval_document_version_id: string; refund_treasury_transaction_id: string } => ({
  reason: form.reason.trim(),
  approval_document_version_id: form.approvalDocumentVersionId.trim(),
  refund_treasury_transaction_id: form.refundId.trim(),
});

/** The answer of a reversal. */
export interface Reversal {
  id: string;
  status: string;
  version: number;
  refundTransactionId: string;
  treasuryPaidOn: string;
  paymentEntries: number;
}

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);

export function toReversal(value: unknown): Reversal | undefined {
  const row = asRecord(value);
  const id = row?.resource_id;
  const version = row?.resource_version;
  const refund = row?.refund_transaction_id;
  const paidOn = row?.treasury_paid_on;
  const entries = row?.payment_entries;
  if (row === undefined || typeof id !== 'string' || typeof version !== 'number' || typeof refund !== 'string' || typeof paidOn !== 'string' || typeof entries !== 'number') return undefined;
  return { id, status: typeof row.status === 'string' ? row.status : '', version, refundTransactionId: refund, treasuryPaidOn: paidOn, paymentEntries: entries };
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'refundMissing'
  | 'refundNotFound'
  | 'refundNotRefund'
  | 'refundOther'
  | 'refundAmount'
  | 'refundUsed'
  | 'approvalRequired'
  | 'notClean'
  | 'selfApproval'
  | 'paymentState'
  | 'retentionReleased'
  | 'advanceState'
  | 'valueExceeded'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

/** The refusal of the server as the screen words it; a refund that is not the refund of this payment says why. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  const reason = error.extensions.reason;
  switch (error.code) {
    case 'REFUND_NOT_CONFIRMED':
      switch (reason) {
        case 'MISSING':
          return 'refundMissing';
        case 'NOT_A_REFUND':
          return 'refundNotRefund';
        case 'OTHER_PAYMENT':
          return 'refundOther';
        case 'AMOUNT':
          return 'refundAmount';
        case 'ALREADY_USED':
          return 'refundUsed';
        default:
          return 'refundNotFound';
      }
    case 'APPROVAL_REQUIRED':
      return 'approvalRequired';
    case 'DOCUMENT_NOT_CLEAN':
      return 'notClean';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
    case 'PAYMENT_STATE_INVALID':
      return reason === 'RETENTION_RELEASED' ? 'retentionReleased' : 'paymentState';
    case 'ADVANCE_STATE_INVALID':
      return 'advanceState';
    case 'VALUE_EXCEEDED':
      return 'valueExceeded';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}
