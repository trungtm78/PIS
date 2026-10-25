import type { DomainError } from '../src/errors';
import {
  OPEN_SETTLEMENT_STATUSES,
  SETTLEMENT_STATUSES,
  assertClosable,
  assertExceptionNeeded,
  assertNotPreparer,
  assertVerifier,
  daysBetween,
  deadlineDays,
  deadlineStage,
  hasOutstanding,
  isOpenSettlement,
  isSettlementEditable,
  settlementFigures,
  verificationDueOn,
  verificationTarget,
} from '../src/pay-project-settlement';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const GROUPS = [
  { projectGroup: 'QTQG', days: 270 },
  { projectGroup: 'A', days: 270 },
  { projectGroup: 'B', days: 180 },
  { projectGroup: 'C', days: 120 },
];

describe('the verification deadline of a settlement (ST-PAY-009, BR-PAY-15, UAT-AC339)', () => {
  it('is the day of the submission plus the days the rule gives the group', () => {
    expect(verificationDueOn('2026-10-01', deadlineDays(GROUPS, 'B') ?? 0)).toBe('2027-03-30');
    expect(verificationDueOn('2026-10-01', deadlineDays(GROUPS, 'C') ?? 0)).toBe('2027-01-29');
    expect(verificationDueOn('2026-10-01', deadlineDays(GROUPS, 'A') ?? 0)).toBe('2027-06-28');
    expect(verificationDueOn('2026-10-01', deadlineDays(GROUPS, 'QTQG') ?? 0)).toBe('2027-06-28');
  });

  it('is not given for a group the rule does not know, and a day that is not a day is refused', () => {
    expect(deadlineDays(GROUPS, 'D')).toBeUndefined();
    expect(deadlineDays([], 'A')).toBeUndefined();
    expect(failure(() => verificationDueOn('2026-02-30', 10))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(failure(() => verificationDueOn('2026-10-01', 0.5))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('counts the days between two days and puts a deadline in its stage (T-30, T-7, overdue)', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
    expect(failure(() => daysBetween('2026-13-01', '2026-10-01'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    const due = '2027-03-30';
    expect(deadlineStage(due, '2026-10-01')).toBeUndefined();
    expect(deadlineStage(due, '2027-02-28')).toBe('T30');
    expect(deadlineStage(due, '2027-03-23')).toBe('T7');
    expect(deadlineStage(due, '2027-03-30')).toBe('T7');
    expect(deadlineStage(due, '2027-03-31')).toBe('OVERDUE');
    expect(deadlineStage(due, '2027-02-27')).toBeUndefined();
  });
});

describe('the states of a settlement', () => {
  it('knows the ones that are still being worked and the ones that can be changed', () => {
    expect(SETTLEMENT_STATUSES.filter((status) => isOpenSettlement(status))).toEqual(SETTLEMENT_STATUSES.filter((status) => OPEN_SETTLEMENT_STATUSES.includes(status)));
    expect(isOpenSettlement('CLOSED')).toBe(false);
    expect(isOpenSettlement('SUPERSEDED')).toBe(false);
    expect(SETTLEMENT_STATUSES.filter((status) => isSettlementEditable(status))).toEqual(['DRAFT', 'RETURNED']);
  });

  it('takes a verification only along the moves of the state machine', () => {
    expect(verificationTarget('SUBMITTED', 'VERIFYING')).toBe('VERIFYING');
    expect(verificationTarget('VERIFYING', 'VERIFIED')).toBe('VERIFIED');
    expect(verificationTarget('VERIFYING', 'RETURNED')).toBe('RETURNED');
    expect(verificationTarget('SUBMITTED', 'RETURNED')).toBe('RETURNED');
    for (const from of SETTLEMENT_STATUSES) {
      if (from !== 'SUBMITTED') expect(verificationTarget(from, 'VERIFYING')).toBeUndefined();
      if (from !== 'VERIFYING') expect(verificationTarget(from, 'VERIFIED')).toBeUndefined();
      if (from !== 'SUBMITTED' && from !== 'VERIFYING') expect(verificationTarget(from, 'RETURNED')).toBeUndefined();
    }
  });
});

describe('the figures of a settlement from the ledgers (UAT-PLAN-21)', () => {
  const sums = { acceptedVnd: '10000000000', paidVnd: '9850000000', retentionHeldVnd: '0', advanceDisbursedVnd: '500000000', advanceRecoveredVnd: '500000000' };

  it('owes the accepted work not paid and the retention still held, and the advance not recovered', () => {
    expect(settlementFigures(sums)).toEqual({ settledVnd: '9850000000', outstandingVnd: '150000000', unrecoveredAdvanceVnd: '0' });
    expect(settlementFigures({ ...sums, paidVnd: '10000000000', retentionHeldVnd: '300000000', advanceRecoveredVnd: '200000000' })).toEqual({
      settledVnd: '10000000000',
      outstandingVnd: '300000000',
      unrecoveredAdvanceVnd: '300000000',
    });
    expect(settlementFigures({ acceptedVnd: '0', paidVnd: '0', retentionHeldVnd: '0', advanceDisbursedVnd: '0', advanceRecoveredVnd: '0' })).toEqual({ settledVnd: '0', outstandingVnd: '0', unrecoveredAdvanceVnd: '0' });
  });

  it('refuses a figure below nothing instead of showing it as nothing, and an amount that is not whole dong', () => {
    expect(failure(() => settlementFigures({ ...sums, paidVnd: '10000000001' }))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'NEGATIVE' }, detail: 'outstanding_vnd' });
    expect(failure(() => settlementFigures({ ...sums, advanceRecoveredVnd: '500000001' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'unrecovered_advance_vnd' });
    expect(failure(() => settlementFigures({ ...sums, paidVnd: '1.5' }))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('closing a settlement that still owes (UAT-AC66)', () => {
  const owing = { settledVnd: '9850000000', outstandingVnd: '150000000', unrecoveredAdvanceVnd: '0' };
  const unrecovered = { settledVnd: '1', outstandingVnd: '0', unrecoveredAdvanceVnd: '5' };
  const clear = { settledVnd: '1', outstandingVnd: '0', unrecoveredAdvanceVnd: '0' };

  it('asks for the exception when anything is owed, and says how much, and never when nothing is', () => {
    expect(hasOutstanding(owing)).toBe(true);
    expect(hasOutstanding(unrecovered)).toBe(true);
    expect(hasOutstanding(clear)).toBe(false);
    expect(failure(() => assertClosable(owing, false))).toMatchObject({ code: 'SETTLEMENT_HAS_OUTSTANDING', status: 422, extensions: { outstanding_vnd: '150000000', unrecovered_advance_vnd: '0' } });
    expect(failure(() => assertClosable(unrecovered, false))).toMatchObject({ code: 'SETTLEMENT_HAS_OUTSTANDING' });
    expect(() => assertClosable(owing, true)).not.toThrow();
    expect(() => assertClosable(clear, false)).not.toThrow();
  });

  it('lets an exception be approved only when something is owed', () => {
    expect(() => assertExceptionNeeded(owing)).not.toThrow();
    expect(failure(() => assertExceptionNeeded(clear))).toMatchObject({ code: 'NO_OUTSTANDING_TO_EXCEPT', status: 422 });
  });
});

describe('who may do what (BR-PAY-16)', () => {
  it('lets someone other than the one who sent the settlement verify it', () => {
    expect(() => assertVerifier('b', 'a')).not.toThrow();
    expect(() => assertVerifier('b', null)).not.toThrow();
    expect(failure(() => assertVerifier('A', 'a'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
  });

  it('keeps the people who opened or sent the settlement from approving its exception or closing it', () => {
    expect(() => assertNotPreparer('c', 'a', 'b')).not.toThrow();
    expect(() => assertNotPreparer('c', null, null)).not.toThrow();
    expect(failure(() => assertNotPreparer('a', 'A', 'b'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(failure(() => assertNotPreparer('b', 'a', 'B'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
  });
});
