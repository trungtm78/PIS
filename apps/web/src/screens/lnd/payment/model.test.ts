import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { toPlanLine } from '../plan/model';
import type { PlanLine } from '../plan/model';
import { paymentRecord, planRecord } from '../test-support';
import {
  EMPTY_CONFIRM_FORM,
  EMPTY_DEPOSIT_FORM,
  EMPTY_SCHEDULE_FORM,
  PAYABLE_STATUSES,
  canPayWrite,
  confirmBody,
  daysToDue,
  depositBody,
  describeProblem,
  isLateOn,
  isOpen,
  payablePlans,
  scheduleBody,
  takesPayments,
  toPaymentLine,
  totalsOf,
  validateConfirm,
  validateDeposit,
  validateSchedule,
} from './model';
import type { PaymentLine } from './model';

const plan = (overrides: Record<string, unknown> = {}): PlanLine => toPlanLine(planRecord(1, { status: 'PAYING', approved_on: '2026-09-01', payment_due_on: '2026-10-01', ...overrides })) as PlanLine;
const payment = (overrides: Record<string, unknown> = {}): PaymentLine => toPaymentLine(paymentRecord(1, 'p', { due_on: '2026-10-01', ...overrides })) as PaymentLine;
const DOCUMENT = '00000000-0000-4000-8000-000000000b01';

describe('toPaymentLine', () => {
  it('reads a payment with the household by its code and the account masked', () => {
    expect(toPaymentLine(paymentRecord(1, 'p', { bank_account_masked: '******6789' }))).toEqual({
      id: paymentRecord(1, 'p').id,
      householdId: paymentRecord(1, 'p').household_id,
      householdCode: 'HH-000001',
      paymentNo: 1,
      amountVnd: '450000000',
      dueOn: '2026-10-10',
      paidOn: null,
      method: null,
      bankAccountMasked: '******6789',
      treasuryTransactionId: null,
      advanceId: null,
      voucherDocumentVersionId: null,
      depositReason: null,
      lateReason: null,
      status: 'PENDING',
      version: 1,
    });
    expect(toPaymentLine(paymentRecord(1, 'p', { status: 'DEPOSITED', method: 'DEPOSITED' }))?.method).toBe('DEPOSITED');
    expect(toPaymentLine(paymentRecord(1, 'p', { status: 'PAID', method: 'TREASURY' }))?.method).toBe('TREASURY');
    expect(toPaymentLine(paymentRecord(1, 'p', { method: 'CARRIER_PIGEON' }))?.method).toBeNull();
  });

  it('drops a payment it cannot read rather than showing it half', () => {
    expect(toPaymentLine(null)).toBeUndefined();
    expect(toPaymentLine([])).toBeUndefined();
    for (const field of ['id', 'household_id', 'household_code', 'payment_no', 'amount_vnd', 'due_on', 'status', 'version']) expect(toPaymentLine(paymentRecord(1, 'p', { [field]: undefined }))).toBeUndefined();
    expect(toPaymentLine(paymentRecord(1, 'p', { status: 'LOST' }))).toBeUndefined();
  });
});

describe('what a plan and a payment allow', () => {
  it('lists the plans that were approved, are being paid or were paid in full, and takes payments on the first two', () => {
    const statuses = ['DRAFT', 'POSTING', 'POSTING_CLOSED', 'APPROVED', 'PAYING', 'COMPLETED', 'CANCELLED', 'REVISED'] as const;
    expect(payablePlans(statuses.map((status) => plan({ status }))).map((line) => line.status)).toEqual([...PAYABLE_STATUSES]);
    expect(statuses.filter((status) => takesPayments(plan({ status })))).toEqual(['APPROVED', 'PAYING']);
  });

  it('pays a payment that waits, and counts a payment late the day after its day', () => {
    expect((['PENDING', 'PAID', 'DEPOSITED', 'CANCELLED'] as const).filter((status) => isOpen(payment({ status })))).toEqual(['PENDING']);
    expect(isLateOn(payment(), '2026-10-01')).toBe(false);
    expect(isLateOn(payment(), '2026-10-02')).toBe(true);
    expect(daysToDue(payment(), '2026-09-29')).toBe(2);
    expect(daysToDue(payment(), '2026-10-01')).toBe(0);
    expect(daysToDue(payment(), '2026-10-03')).toBe(-2);
  });

  it('adds up what the payments scheduled, paid and still waiting, leaving out those that were cancelled', () => {
    expect(totalsOf([])).toEqual({ scheduled: 0n, settled: 0n, pending: 0n });
    expect(
      totalsOf([payment({ amount_vnd: '500' }), payment({ amount_vnd: '300', status: 'PAID' }), payment({ amount_vnd: '100', status: 'DEPOSITED' }), payment({ amount_vnd: '7', status: 'CANCELLED' })]),
    ).toEqual({ scheduled: 900n, settled: 400n, pending: 500n });
  });

  it('gates the buttons by the permission and by a session that only reads', () => {
    expect(canPayWrite(['land.payment.write'], 'FULL')).toBe(true);
    expect(canPayWrite(['land.read'], 'FULL')).toBe(false);
    expect(canPayWrite(['land.payment.write'], 'READ_ONLY')).toBe(false);
    expect(canPayWrite(undefined, undefined)).toBe(true);
  });
});

describe('the forms', () => {
  it('wants a household and a whole amount above zero to schedule, a due day inside the days of the plan if one is named, and an account in the form of one', () => {
    expect(validateSchedule(EMPTY_SCHEDULE_FORM, plan())).toEqual({ householdId: 'required', amountVnd: 'required' });
    const base = { householdId: 'h', amountVnd: '5', dueOn: '', bankAccount: '' };
    expect(validateSchedule(base, plan())).toEqual({});
    for (const amountVnd of ['0', '-1', '1.5', 'x', '1'.repeat(25)]) expect(validateSchedule({ ...base, amountVnd }, plan())).toEqual({ amountVnd: 'invalid' });
    expect(validateSchedule({ ...base, dueOn: '2026-02-30' }, plan())).toEqual({ dueOn: 'invalid' });
    expect(validateSchedule({ ...base, dueOn: '2026-09-01' }, plan())).toEqual({ dueOn: 'early' });
    expect(validateSchedule({ ...base, dueOn: '2026-10-02' }, plan())).toEqual({ dueOn: 'future' });
    expect(validateSchedule({ ...base, dueOn: '2026-09-15' }, plan())).toEqual({});
    expect(validateSchedule({ ...base, dueOn: '2030-01-01' }, plan({ approved_on: null, payment_due_on: null }))).toEqual({});
    expect(validateSchedule({ ...base, bankAccount: '12' }, plan())).toEqual({ bankAccount: 'invalid' });
    expect(validateSchedule({ ...base, bankAccount: 'x'.repeat(41) }, plan())).toEqual({ bankAccount: 'tooLong' });
    expect(validateSchedule({ ...base, bankAccount: '0123456789' }, plan())).toEqual({});
    expect(scheduleBody({ householdId: 'h', amountVnd: ' 5 ', dueOn: '', bankAccount: '' })).toEqual({ household_id: 'h', amount_vnd: '5' });
    expect(scheduleBody({ householdId: 'h', amountVnd: '5', dueOn: ' 2026-09-15 ', bankAccount: ' 0123456789 ' })).toEqual({ household_id: 'h', amount_vnd: '5', due_on: '2026-09-15', bank_account: '0123456789' });
  });

  it('wants a day that has come and is not before the approval, a method and a voucher to confirm, and the reason only for a payment made after its day', () => {
    const waiting = payment();
    const today = '2026-10-20';
    expect(validateConfirm(EMPTY_CONFIRM_FORM, waiting, plan(), today)).toEqual({ paidOn: 'required', method: 'required', voucherDocumentVersionId: 'required' });
    const base = { ...EMPTY_CONFIRM_FORM, paidOn: '2026-10-01', method: 'BANK_TRANSFER' as const, voucherDocumentVersionId: DOCUMENT };
    expect(validateConfirm(base, waiting, plan(), today)).toEqual({});
    expect(validateConfirm({ ...base, paidOn: '2026-10-02' }, waiting, plan(), today)).toEqual({ lateReason: 'required' });
    expect(validateConfirm({ ...base, paidOn: '2026-10-02', lateReason: 'x'.repeat(2001) }, waiting, plan(), today)).toEqual({ lateReason: 'tooLong' });
    expect(validateConfirm({ ...base, paidOn: '2026-10-02', lateReason: 'a\u0000b' }, waiting, plan(), today)).toEqual({ lateReason: 'invalid' });
    expect(validateConfirm({ ...base, paidOn: '2026-10-02', lateReason: 'The treasury was closed' }, waiting, plan(), today)).toEqual({});
    expect(validateConfirm({ ...base, paidOn: 'soon' }, waiting, plan(), today)).toEqual({ paidOn: 'invalid' });
    expect(validateConfirm({ ...base, paidOn: '2026-10-21' }, waiting, plan(), today)).toEqual({ paidOn: 'future', lateReason: 'required' });
    expect(validateConfirm({ ...base, paidOn: '2026-08-31' }, waiting, plan(), today)).toEqual({ paidOn: 'early' });
    expect(validateConfirm({ ...base, paidOn: '2026-08-31' }, waiting, plan({ approved_on: null }), today)).toEqual({});
    expect(validateConfirm({ ...base, voucherDocumentVersionId: 'x', treasuryTransactionId: 'x', advanceId: 'x' }, waiting, plan(), today)).toEqual({ voucherDocumentVersionId: 'invalid', treasuryTransactionId: 'invalid', advanceId: 'invalid' });
    expect(validateConfirm({ ...base, treasuryTransactionId: DOCUMENT, advanceId: DOCUMENT }, waiting, plan(), today)).toEqual({});
  });

  it('sends the late reason only with a payment made after its day, and the ids in lower case', () => {
    const waiting = payment();
    const form = { ...EMPTY_CONFIRM_FORM, paidOn: ' 2026-10-01 ', method: 'TREASURY' as const, voucherDocumentVersionId: ` ${DOCUMENT.toUpperCase()} `, lateReason: ' not needed ' };
    expect(confirmBody(form, waiting)).toEqual({ paid_on: '2026-10-01', method: 'TREASURY', voucher_document_version_id: DOCUMENT });
    expect(confirmBody({ ...form, paidOn: '2026-10-03', treasuryTransactionId: DOCUMENT.toUpperCase(), advanceId: DOCUMENT.toUpperCase() }, waiting)).toEqual({
      paid_on: '2026-10-03',
      method: 'TREASURY',
      voucher_document_version_id: DOCUMENT,
      treasury_transaction_id: DOCUMENT,
      advance_id: DOCUMENT,
      late_reason: 'not needed',
    });
  });

  it('wants a day, a reason in words and a record to deposit', () => {
    const today = '2026-10-20';
    expect(validateDeposit(EMPTY_DEPOSIT_FORM, plan(), today)).toEqual({ paidOn: 'required', depositReason: 'required', voucherDocumentVersionId: 'required' });
    const base = { paidOn: '2026-10-05', depositReason: 'The household refused', voucherDocumentVersionId: DOCUMENT };
    expect(validateDeposit(base, plan(), today)).toEqual({});
    expect(validateDeposit({ ...base, paidOn: 'soon' }, plan(), today)).toEqual({ paidOn: 'invalid' });
    expect(validateDeposit({ ...base, paidOn: '2026-10-21' }, plan(), today)).toEqual({ paidOn: 'future' });
    expect(validateDeposit({ ...base, paidOn: '2026-08-31' }, plan(), today)).toEqual({ paidOn: 'early' });
    expect(validateDeposit({ ...base, depositReason: 'x'.repeat(2001) }, plan(), today)).toEqual({ depositReason: 'tooLong' });
    expect(validateDeposit({ ...base, depositReason: 'a\u0007b', voucherDocumentVersionId: 'x' }, plan(), today)).toEqual({ depositReason: 'invalid', voucherDocumentVersionId: 'invalid' });
    expect(depositBody({ paidOn: ' 2026-10-05 ', depositReason: ' The household refused ', voucherDocumentVersionId: ` ${DOCUMENT.toUpperCase()} ` })).toEqual({ paid_on: '2026-10-05', deposit_reason: 'The household refused', voucher_document_version_id: DOCUMENT });
  });
});

describe('describeProblem', () => {
  const fail = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

  it('maps the refusals of the commands of the payments to what a dialog says, a payment over a household apart from one over the plan', () => {
    const cases: Array<[string, string]> = [
      ['PLAN_STATE_INVALID', 'planState'],
      ['PAYMENT_STATE_INVALID', 'paymentState'],
      ['PAYMENT_LATE_REASON_REQUIRED', 'lateReason'],
      ['ADVANCE_RECOVERY_EXCEEDED', 'advanceExceeded'],
      ['ADVANCE_STATE_INVALID', 'advanceState'],
      ['DOCUMENT_NOT_CLEAN', 'documentNotClean'],
      ['TIMER_RULE_UNCONFIRMED', 'ruleUnconfirmed'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['SCOPE_DENIED', 'scopeDenied'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
    ];
    for (const [code, problem] of cases) expect(describeProblem(fail(code))).toBe(problem);
    expect(describeProblem(fail('PAYMENT_EXCEEDS_PLAN', { scope: 'HOUSEHOLD' }))).toBe('exceedsHousehold');
    expect(describeProblem(fail('PAYMENT_EXCEEDS_PLAN', { scope: 'PLAN' }))).toBe('exceedsPlan');
    expect(describeProblem(fail('PAYMENT_EXCEEDS_PLAN'))).toBe('exceedsPlan');
    expect(describeProblem(fail('SOMETHING_ELSE'))).toBe('general');
    expect(describeProblem(new Error('boom'))).toBe('general');
  });
});
