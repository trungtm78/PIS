import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { toLedger } from '../ledger/model';
import type { LedgerLine } from '../ledger/model';
import { toPaymentRequest } from '../payment/model';
import { toTransaction } from '../recon/model';
import { EMPTY_REVERSE, describeProblem, entryPairs, figureOf, refundsFor, reversalLink, reverseBody, toReversal, validateReverse } from './model';
import { answer, documentId, entryId, ledgerLines, paymentId, refund, settled, transactionId } from './test-support';
import { page } from '../ledger/test-support';

const refusal = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const linesOf = (undone: boolean): LedgerLine[] => toLedger(page(ledgerLines(undone)))?.items ?? [];

describe('the reversal of a payment on the screen', () => {
  it('links the reversal of a request', () => {
    expect(reversalLink(paymentId(1))).toBe(`/pay/pay-08?request=${paymentId(1)}`);
  });

  it('offers the refunds of the very payment that settled the request, for its project, that nobody used', () => {
    const request = toPaymentRequest(settled());
    const transactions = [
      refund(1),
      refund(2, { reversal_of_id: transactionId(7) }),
      refund(3, { match_status: 'MATCHED' }),
      refund(4, { direction: 'PAYMENT' }),
      refund(5, { project_id: '00000000-0000-4000-8000-0000000000fe' }),
    ].flatMap((raw) => toTransaction(raw) ?? []);
    expect(request?.settledTransactionId).toBe(transactionId(1));
    expect(refundsFor(transactions, request!).map((row) => row.documentNo)).toEqual(['CT-0901']);
    expect(refundsFor(transactions, { settledTransactionId: null, projectId: request!.projectId })).toEqual([]);
  });

  it('pairs each entry the payment put on the ledger with the entry that undid it, by the entry it names and, for the release of a hold, by the opposite figure', () => {
    const before = entryPairs(linesOf(false), paymentId(1));
    expect(before.map((pair) => [pair.item, pair.original.kind, pair.reversal])).toEqual([
      ['B01', 'CLAIM', null],
      ['B01', 'ADVANCE_RECOVERY', null],
      ['B01', 'RETENTION_HOLD', null],
      ['B01', 'PAYMENT', null],
    ]);
    const after = entryPairs(linesOf(true), paymentId(1));
    expect(after.map((pair) => [pair.original.kind, pair.reversal?.kind])).toEqual([
      ['CLAIM', 'CLAIM_RELEASE'],
      ['ADVANCE_RECOVERY', 'ADVANCE_RECOVERY_REVERSAL'],
      ['RETENTION_HOLD', 'RETENTION_RELEASE'],
      ['PAYMENT', 'PAYMENT_REVERSAL'],
    ]);
    // The entries of another request, and the recognition of the acceptance, are not shown.
    expect(entryPairs(linesOf(true), paymentId(2)).map((pair) => pair.original.kind)).toEqual(['CLAIM']);
    expect(entryPairs(linesOf(true), paymentId(9))).toEqual([]);
  });

  it('shows two holds of one item each beside its own release', () => {
    const lines = linesOf(true);
    const first = lines[0]!;
    const second = { ...first, entries: [...first.entries, { ...first.entries.find((entry) => entry.kind === 'RETENTION_HOLD')!, id: entryId(31), retentionDeltaVnd: '40000000', postedAt: '2026-07-20T03:00:03.000Z' }, { ...first.entries.find((entry) => entry.kind === 'RETENTION_RELEASE')!, id: entryId(32), retentionDeltaVnd: '-40000000', postedAt: '2026-07-31T03:00:04.000Z' }] };
    const holds = entryPairs([second], paymentId(1)).filter((pair) => pair.original.kind === 'RETENTION_HOLD');
    expect(holds.map((pair) => [pair.original.retentionDeltaVnd, pair.reversal?.retentionDeltaVnd])).toEqual([
      ['100000000', '-100000000'],
      ['40000000', '-40000000'],
    ]);
  });

  it('shows the figure an entry moves, whichever it is', () => {
    const [claim, recovery, hold, paid] = entryPairs(linesOf(false), paymentId(1)).map((pair) => pair.original);
    expect([claim, recovery, hold, paid].map((entry) => figureOf(entry!))).toEqual(['2000000000', '500000000', '100000000', '2000000000']);
    const recognise = linesOf(false)[0]!.entries.find((entry) => entry.kind === 'RECOGNIZE_ACCEPTANCE')!;
    expect(figureOf(recognise)).toBe('400000000');
    expect(figureOf({ ...recognise, acceptedDeltaVnd: '0' })).toBe('0');
  });

  it('asks for a refund, a reason and an approving document that are what they should be', () => {
    expect(validateReverse(EMPTY_REVERSE)).toEqual({ refundId: 'required', reason: 'required', approvalDocumentVersionId: 'required' });
    expect(validateReverse({ refundId: 'x', reason: 'x'.repeat(2001), approvalDocumentVersionId: 'y' })).toEqual({ refundId: 'uuid', reason: 'tooLong', approvalDocumentVersionId: 'uuid' });
    expect(validateReverse({ refundId: transactionId(11), reason: 'Hoàn trả', approvalDocumentVersionId: documentId(1) })).toEqual({});
    expect(reverseBody({ refundId: ` ${transactionId(11)} `, reason: ' Hoàn trả ', approvalDocumentVersionId: ` ${documentId(1)} ` })).toEqual({
      reason: 'Hoàn trả',
      approval_document_version_id: documentId(1),
      refund_treasury_transaction_id: transactionId(11),
    });
  });

  it('reads the answer of a reversal', () => {
    expect(toReversal(answer())).toEqual({ id: paymentId(1), status: 'REVERSED', version: 10, refundTransactionId: transactionId(11), treasuryPaidOn: '2026-07-25', paymentEntries: 2 });
    expect(toReversal({ ...answer(), status: undefined })?.status).toBe('');
    for (const broken of [null, {}, answer({ resource_version: '1' }), answer({ payment_entries: 'x' }), answer({ refund_transaction_id: 3 })]) expect(toReversal(broken)).toBeUndefined();
  });

  it('words a refund that is not the refund of this payment by the reason the server gives', () => {
    const cases: Array<[string | undefined, string]> = [
      ['MISSING', 'refundMissing'],
      ['NOT_FOUND', 'refundNotFound'],
      ['NOT_A_REFUND', 'refundNotRefund'],
      ['OTHER_PAYMENT', 'refundOther'],
      ['AMOUNT', 'refundAmount'],
      ['ALREADY_USED', 'refundUsed'],
      [undefined, 'refundNotFound'],
    ];
    for (const [reason, problem] of cases) expect(describeProblem(refusal('REFUND_NOT_CONFIRMED', reason === undefined ? {} : { reason }))).toBe(problem);
  });

  it('words every other refusal, and anything that is not a refusal of the server as a general one', () => {
    const cases: Array<[string, Record<string, unknown>, string, number?]> = [
      ['APPROVAL_REQUIRED', {}, 'approvalRequired'],
      ['DOCUMENT_NOT_CLEAN', {}, 'notClean'],
      ['SELF_APPROVAL_DENIED', {}, 'selfApproval', 403],
      ['PAYMENT_STATE_INVALID', {}, 'paymentState', 409],
      ['PAYMENT_STATE_INVALID', { reason: 'RETENTION_RELEASED' }, 'retentionReleased', 409],
      ['ADVANCE_STATE_INVALID', {}, 'advanceState', 409],
      ['VALUE_EXCEEDED', {}, 'valueExceeded', 409],
      ['VERSION_CONFLICT', {}, 'versionConflict', 409],
      ['VALIDATION_FAILED', {}, 'validation'],
      ['INVALID_REQUEST', {}, 'validation', 400],
      ['FIELD_NOT_ALLOWED', {}, 'validation', 400],
      ['RESOURCE_NOT_FOUND', {}, 'notFound', 404],
      ['SCOPE_DENIED', {}, 'denied', 403],
      ['ENTITLEMENT_DENIED', {}, 'denied', 403],
      ['SESSION_EXPIRED', {}, 'session', 401],
      ['SOMETHING_ELSE', {}, 'general', 500],
    ];
    for (const [code, extensions, problem, status] of cases) expect(describeProblem(refusal(code, extensions, status))).toBe(problem);
    expect(describeProblem(new Error('x'))).toBe('general');
  });
});
