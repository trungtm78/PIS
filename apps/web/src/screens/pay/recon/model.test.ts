import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ASSIGN,
  EMPTY_MATCH,
  EMPTY_RESOLVE,
  assignBody,
  boardLink,
  candidatesFor,
  describeProblem,
  differenceOf,
  differenceText,
  dueInstant,
  itemLink,
  matchBody,
  resolveBody,
  sameAmount,
  toItem,
  toItemAnswer,
  toItemPage,
  toMember,
  toSettlement,
  toTracking,
  toTransaction,
  trackingLink,
  unmatchedTransactions,
  validateAssign,
  validateMatch,
  validateResolve,
  vndText,
} from './model';
import { answer, documentId, item, itemId, member, memberId, settledAnswer, tracking, transaction } from './test-support';

const refusal = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const NOW = new Date('2026-07-25T05:00:00Z');

describe('the differences on the screens', () => {
  it('links the board, an item and the tracking table', () => {
    expect(boardLink()).toBe('/pay/pay-05');
    expect(itemLink(itemId(1))).toBe(`/pay/pay-06?item=${itemId(1)}`);
    expect(trackingLink()).toBe('/pay/pay-09');
  });

  it('reads an item with both figures, the signed difference, the owner, the day and what its state allows', () => {
    expect(toItem(item(1))).toMatchObject({
      id: itemId(1),
      kind: 'AMOUNT_MISMATCH',
      status: 'OPEN',
      internalVnd: '1000000000',
      confirmedVnd: '990000000',
      differenceVnd: '-10000000',
      ownerMembershipId: memberId(1),
      ownerName: 'Kế toán trưởng',
      overdue: false,
      sourceFileSha256: 'ab'.repeat(32),
      version: 1,
      actions: { assign: true, explain: true, resolve: false, writeOff: true },
    });
    expect(toItem(item(1, { source_file_sha256: 'not a hash', internal_amount_vnd: null, confirmed_amount_vnd: '1.5', overdue: true }))).toMatchObject({ sourceFileSha256: null, internalVnd: null, confirmedVnd: null, overdue: true });
  });

  it('drops what is not an item', () => {
    for (const broken of [null, 'x', [], {}, item(1, { kind: 'OTHER' }), item(1, { status: 'DONE' }), item(1, { version: '1' }), item(1, { actions: null }), item(1, { owner_membership_id: 7 }), item(1, { due_at: null })]) {
      expect(toItem(broken)).toBeUndefined();
    }
  });

  it('reads a page with what the board counts, and a page without a summary as empty counts', () => {
    expect(toItemPage({ items: [item(1), { broken: true }], summary: { waiting: 4, overdue: 1, waiting_difference_vnd: '-10000000' } })).toMatchObject({
      items: [{ id: itemId(1) }],
      summary: { waiting: 4, overdue: 1, waitingDifferenceVnd: '-10000000' },
    });
    expect(toItemPage({ items: 'x' })).toEqual({ items: [], summary: { waiting: 0, overdue: 0, waitingDifferenceVnd: '0' } });
    expect(toItemPage(null).items).toEqual([]);
    expect(toItemPage({ items: [], summary: { waiting: 'x', overdue: 1.5, waiting_difference_vnd: 'a' } }).summary).toEqual({ waiting: 0, overdue: 0, waitingDifferenceVnd: '0' });
  });

  it('reads a transaction, the settlement of a match, the answer of a command, a member and a row of the tracking table', () => {
    expect(toTransaction(transaction(1))).toMatchObject({ amountVnd: '2100000000', matchStatus: 'UNMATCHED', direction: 'PAYMENT', projectCode: 'DA-A-001', documentNo: 'CT-0001' });
    expect(toTransaction(transaction(1, { match_status: 'DONE' }))).toBeUndefined();
    expect(toTransaction(transaction(1, { amount_vnd: 'x' }))).toBeUndefined();
    expect(toSettlement(settledAnswer())).toEqual({ paymentRequestId: expect.any(String), transactionId: expect.any(String), amountVnd: '2100000000', treasuryPaidOn: '2026-07-25' });
    expect(toSettlement({ status: 'SETTLED' })).toBeUndefined();
    expect(toItemAnswer(answer())).toEqual({ id: itemId(1), status: 'EXPLAINED', version: 2 });
    expect(toItemAnswer({})).toBeUndefined();
    expect(toMember(member(1, 'An'))).toEqual({ id: memberId(1), name: 'An' });
    expect(toMember(member(1, 'An', { status: 'Suspended' }))).toBeUndefined();
    expect(toMember(member(1, 'An', { membership_type: 'GUEST' }))).toBeUndefined();
    expect(toMember({ id: 'x' })).toBeUndefined();
    expect(toTracking(tracking(1))).toMatchObject({ projectCode: 'DA-A-001', sent: { count: 2, amountVnd: '4200000000' }, unmatched: 1, differences: { count: 1, amountVnd: '-10000000' } });
    expect(toTracking(tracking(1, { sent: null }))).toBeUndefined();
    expect(toTracking(tracking(1, { unmatched: 'x' }))).toBeUndefined();
  });

  it('picks the transactions that wait and the requests a transaction can be matched to', () => {
    const rows = [transaction(1), transaction(2, { match_status: 'MATCHED' }), transaction(3, { direction: 'REFUND' }), transaction(4, { match_status: 'EXCEPTION' })].flatMap((raw) => toTransaction(raw) ?? []);
    expect(unmatchedTransactions(rows).map((row) => row.documentNo)).toEqual(['CT-0001']);
    const requests = [
      { status: 'SENT_TREASURY', projectId: 'p1' },
      { status: 'SETTLED', projectId: 'p1' },
      { status: 'SENT_TREASURY', projectId: 'p2' },
    ];
    expect(candidatesFor(requests, { projectId: 'p1' })).toEqual([{ status: 'SENT_TREASURY', projectId: 'p1' }]);
    expect(sameAmount('2100000000', '2100000000')).toBe(true);
    expect(sameAmount('2100000000', '2090000000')).toBe(false);
    expect(differenceOf('1000000000', '990000000')).toBe('-10000000');
    expect(differenceOf('990000000', '1000000000')).toBe('10000000');
  });

  it('words the amounts in groups of three digits, and the difference with its sign', () => {
    expect(vndText('2100000000', 'vi')).toBe('2.100.000.000');
    expect(vndText('x', 'vi')).toBe('x');
    expect(differenceText('-10000000', 'vi')).toBe('-10.000.000');
    expect(differenceText('10000000', 'vi')).toBe('+10.000.000');
    expect(differenceText('0', 'vi')).toBe('0');
    expect(differenceText('x', 'vi')).toBe('x');
  });
});

describe('the commands on a difference', () => {
  it('asks for a request that is an identifier, and keeps a note within its length', () => {
    expect(validateMatch(EMPTY_MATCH)).toEqual({ requestId: 'required' });
    expect(validateMatch({ requestId: 'x', note: '' })).toEqual({ requestId: 'uuid' });
    expect(validateMatch({ requestId: itemId(1), note: 'x'.repeat(2001) })).toEqual({ note: 'tooLong' });
    expect(validateMatch({ requestId: itemId(1), note: '' })).toEqual({});
    expect(matchBody({ requestId: ` ${itemId(1)} `, note: '  ' })).toEqual({ payment_request_id: itemId(1) });
    expect(matchBody({ requestId: itemId(1), note: ' Khớp sao kê ' })).toEqual({ payment_request_id: itemId(1), note: 'Khớp sao kê' });
  });

  it('asks for an owner and a day that is still to come, in Vietnam time', () => {
    expect(validateAssign(EMPTY_ASSIGN, NOW)).toEqual({ ownerId: 'required', dueAt: 'required' });
    expect(validateAssign({ ownerId: 'x', dueAt: 'tomorrow' }, NOW)).toEqual({ ownerId: 'uuid', dueAt: 'invalid' });
    expect(validateAssign({ ownerId: memberId(1), dueAt: '2026-02-30T10:00' }, NOW)).toEqual({ dueAt: 'invalid' });
    expect(validateAssign({ ownerId: memberId(1), dueAt: '2026-07-25T12:00' }, NOW)).toEqual({ dueAt: 'past' });
    expect(validateAssign({ ownerId: memberId(1), dueAt: '2026-07-25T12:01' }, NOW)).toEqual({});
    expect(dueInstant('2026-07-26T10:00')?.toISOString()).toBe('2026-07-26T03:00:00.000Z');
    expect(dueInstant('2026-07-26 10:00')).toBeUndefined();
    expect(assignBody({ ownerId: ` ${memberId(2)} `, dueAt: '2026-07-26T10:00' })).toEqual({ owner_membership_id: memberId(2), due_at: '2026-07-26T03:00:00.000Z' });
  });

  it('always asks for the words, and for the approving document only when writing off', () => {
    expect(validateResolve(EMPTY_RESOLVE, 'EXPLAINED')).toEqual({ note: 'required' });
    expect(validateResolve({ note: 'x'.repeat(2001), approvalDocumentVersionId: '' }, 'RESOLVED')).toEqual({ note: 'tooLong' });
    expect(validateResolve({ note: 'Ghi chú', approvalDocumentVersionId: '' }, 'RESOLVED')).toEqual({});
    expect(validateResolve({ note: 'Ghi chú', approvalDocumentVersionId: '' }, 'WRITTEN_OFF')).toEqual({ approvalDocumentVersionId: 'required' });
    expect(validateResolve({ note: 'Ghi chú', approvalDocumentVersionId: 'x' }, 'WRITTEN_OFF')).toEqual({ approvalDocumentVersionId: 'uuid' });
    expect(validateResolve({ note: 'Ghi chú', approvalDocumentVersionId: documentId(1) }, 'WRITTEN_OFF')).toEqual({});
    expect(resolveBody({ note: ' Phí ', approvalDocumentVersionId: documentId(1) }, 'EXPLAINED')).toEqual({ resolution: 'EXPLAINED', note: 'Phí' });
    expect(resolveBody({ note: ' Phí ', approvalDocumentVersionId: ` ${documentId(1)} ` }, 'WRITTEN_OFF')).toEqual({ resolution: 'WRITTEN_OFF', note: 'Phí', approval_document_version_id: documentId(1) });
  });
});

describe('the refusals of the server', () => {
  it('names a match that did not agree with the two figures and the item that was opened', () => {
    expect(
      describeProblem(refusal('AMOUNT_MISMATCH_OPENED', { reconciliation_item_id: itemId(1), internal_amount_vnd: '1000000000', confirmed_amount_vnd: '990000000', difference_vnd: '-10000000' })),
    ).toEqual({ problem: 'mismatch', mismatch: { itemId: itemId(1), internalVnd: '1000000000', confirmedVnd: '990000000', differenceVnd: '-10000000' } });
    expect(describeProblem(refusal('AMOUNT_MISMATCH_OPENED', {}))).toEqual({ problem: 'mismatch', mismatch: null });
  });

  it('words every other refusal, and anything that is not a refusal of the server as a general one', () => {
    const cases: Array<[string, string, number?]> = [
      ['TRANSACTION_ALREADY_MATCHED', 'alreadyMatched', 409],
      ['PAYMENT_STATE_INVALID', 'paymentState', 409],
      ['RECONCILIATION_STATE_INVALID', 'itemState', 409],
      ['APPROVAL_REQUIRED', 'approvalRequired'],
      ['SELF_APPROVAL_DENIED', 'selfApproval', 403],
      ['PLAN_YEAR_MISMATCH', 'planYear'],
      ['DOCUMENT_NOT_CLEAN', 'notClean'],
      ['VERSION_CONFLICT', 'versionConflict', 409],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation', 400],
      ['FIELD_NOT_ALLOWED', 'validation', 400],
      ['RESOURCE_NOT_FOUND', 'notFound', 404],
      ['SCOPE_DENIED', 'denied', 403],
      ['ENTITLEMENT_DENIED', 'denied', 403],
      ['SESSION_EXPIRED', 'session', 401],
      ['SOMETHING_ELSE', 'general', 500],
    ];
    for (const [code, problem, status] of cases) expect(describeProblem(refusal(code, {}, status))).toEqual({ problem, mismatch: null });
    expect(describeProblem(new Error('x'))).toEqual({ problem: 'general', mismatch: null });
  });
});
