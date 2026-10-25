import type { DomainError } from '../src/errors';
import { ADVANCE_KINDS, ADVANCE_STATUSES, COUNTED_STATUSES, RECOVERY_BASES, advanceCap, assertRecoverable, capPercentFor, gpmbDeadline, recoveryPlan } from '../src/pay-advance';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('the advance of a contract (PAY 3.2)', () => {
  it('names the kinds, the statuses and the bases, and counts every status but the cancelled one under the cap', () => {
    expect(ADVANCE_KINDS).toEqual(['CONTRACT', 'GPMB']);
    expect(ADVANCE_STATUSES).toHaveLength(6);
    expect(RECOVERY_BASES).toEqual(['COMPENSATION_PAYMENT', 'REFUND', 'OTHER']);
    expect(COUNTED_STATUSES).not.toContain('CANCELLED');
    expect(COUNTED_STATUSES).toHaveLength(5);
  });

  describe('the share the table gives (BR-PAY-10)', () => {
    const tiers = [
      { minValueVnd: '0', capPct: '10' },
      { minValueVnd: '10000000000', capPct: '20' },
    ];

    it('takes the tier with the highest minimum the value reaches, to the dong', () => {
      expect(capPercentFor(tiers, '10000000000')).toBe('20');
      expect(capPercentFor(tiers, '9999999999')).toBe('10');
      expect(capPercentFor([...tiers].reverse(), '25000000000')).toBe('20');
    });

    it('has no answer when the value reaches no tier, and refuses a table that does not read', () => {
      expect(capPercentFor([{ minValueVnd: '10000000000', capPct: '20' }], '9999999999')).toBeUndefined();
      expect(capPercentFor([], '1')).toBeUndefined();
      expect(failure(() => capPercentFor([{ minValueVnd: 'x', capPct: '20' }], '1')).code).toBe('VALIDATION_FAILED');
      expect(failure(() => capPercentFor([{ minValueVnd: '0', capPct: '120.5' }], '1')).code).toBe('VALIDATION_FAILED');
      expect(failure(() => capPercentFor(tiers, '-1')).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('the room under the cap (UAT-AC326)', () => {
    it('is the share of the work of the member less what is advanced, at the boundary to the dong', () => {
      expect(advanceCap('20', '10000000000', '0')).toBe('2000000000');
      expect(advanceCap('20', '10000000000', '1500000000')).toBe('500000000');
      expect(advanceCap('30', '1000000000', '0')).toBe('300000000');
      // The share has four decimals and the cap is rounded down to the dong.
      expect(advanceCap('12.3456', '1000000001', '0')).toBe('123456000');
    });

    it('is never below zero', () => {
      expect(advanceCap('20', '10000000000', '2000000000')).toBe('0');
      expect(advanceCap('20', '10000000000', '2500000000')).toBe('0');
    });

    it('refuses figures that are not whole dong or a share that is not a percentage', () => {
      expect(failure(() => advanceCap('20', '1.5', '0')).code).toBe('VALIDATION_FAILED');
      expect(failure(() => advanceCap('abc', '10', '0')).code).toBe('VALIDATION_FAILED');
      expect(failure(() => advanceCap('20', '10', '-1')).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('the deadline of a land clearance advance (BR-PAY-11)', () => {
    it('is the day it was paid and the days of the rule, across a month and a year', () => {
      expect(gpmbDeadline('2026-07-01', 30)).toBe('2026-07-31');
      expect(gpmbDeadline('2026-12-15', 30)).toBe('2027-01-14');
    });

    it('refuses a number of days that is not one', () => {
      for (const days of [0, -1, 1.5, 367]) expect(failure(() => gpmbDeadline('2026-07-01', days)).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('a recovery outside the payments (UAT-AC61)', () => {
    it('adds to what is recovered up to what was paid, to the dong', () => {
      expect(assertRecoverable('2000000000', '750000000', '1250000000')).toBe('2000000000');
      expect(assertRecoverable('2000000000', '0', '1')).toBe('1');
    });

    it('is 422 ADVANCE_RECOVERY_EXCEEDED with the figures when it would take more than is owed', () => {
      const refused = failure(() => assertRecoverable('2000000000', '750000000', '1300000000'));
      expect(refused).toMatchObject({ code: 'ADVANCE_RECOVERY_EXCEEDED', status: 422, extensions: { outstanding_vnd: '1250000000', exceeds_by_vnd: '50000000' } });
      expect(failure(() => assertRecoverable('2000000000', '2000000000', '1')).code).toBe('ADVANCE_RECOVERY_EXCEEDED');
    });

    it('takes a positive amount of whole dong only', () => {
      expect(failure(() => assertRecoverable('10', '0', '0')).code).toBe('VALIDATION_FAILED');
      expect(failure(() => assertRecoverable('10', '0', '1.5')).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('the recovery of one member (BR-PAY-04, UAT-AC327)', () => {
    // M1 of the joint venture: work 6bn, advance 900m, threshold 80 percent, so the advance is recovered in full at 4.8bn.
    const m1 = { paidVnd: '900000000', workValueVnd: '6000000000', thresholdPct: '80' };

    it('recovers in proportion until the threshold and in full at it, whatever the other member did', () => {
      const first = recoveryPlan({ ...m1, recoveredVnd: '0', grossToDateVnd: '2400000000' });
      expect(first).toMatchObject({ thresholdValueVnd: '4800000000', targetRecoveredVnd: '450000000', outstandingVnd: '900000000', behindVnd: '450000000', remainingToThresholdVnd: '2400000000' });
      const second = recoveryPlan({ ...m1, recoveredVnd: '450000000', grossToDateVnd: '4800000000' });
      expect(second).toMatchObject({ targetRecoveredVnd: '900000000', outstandingVnd: '450000000', behindVnd: '450000000', remainingToThresholdVnd: '0' });
      const done = recoveryPlan({ ...m1, recoveredVnd: '900000000', grossToDateVnd: '5000000000' });
      expect(done).toMatchObject({ outstandingVnd: '0', behindVnd: '0' });
    });

    it('shows the milestones at a quarter, a half, three quarters and all of the threshold', () => {
      const plan = recoveryPlan({ ...m1, recoveredVnd: '0', grossToDateVnd: '0' });
      expect(plan.milestones).toEqual([
        { atPct: 25, atGrossVnd: '1200000000', recoveredVnd: '225000000' },
        { atPct: 50, atGrossVnd: '2400000000', recoveredVnd: '450000000' },
        { atPct: 75, atGrossVnd: '3600000000', recoveredVnd: '675000000' },
        { atPct: 100, atGrossVnd: '4800000000', recoveredVnd: '900000000' },
      ]);
      expect(plan.targetRecoveredVnd).toBe('0');
    });

    it('is never ahead of itself: a member recovered beyond the formula is not behind', () => {
      expect(recoveryPlan({ ...m1, recoveredVnd: '600000000', grossToDateVnd: '2400000000' }).behindVnd).toBe('0');
    });

    it('does not divide by a threshold of nothing', () => {
      const none = recoveryPlan({ paidVnd: '100', recoveredVnd: '0', workValueVnd: '0', thresholdPct: '80', grossToDateVnd: '0' });
      expect(none).toMatchObject({ thresholdValueVnd: '0', targetRecoveredVnd: '100', remainingToThresholdVnd: '0' });
    });
  });
});
