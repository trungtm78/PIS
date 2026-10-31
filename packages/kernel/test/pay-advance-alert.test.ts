import type { DomainError } from '../src/errors';
import { advanceAlert, assertAcknowledgeable, assertPlanDue } from '../src/pay-advance-alert';
import type { AdvanceAlertFacts } from '../src/pay-advance-alert';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const gpmb = (overrides: Partial<AdvanceAlertFacts> = {}): AdvanceAlertFacts => ({
  kind: 'GPMB',
  outstandingVnd: '1000000000',
  recoveryDeadline: '2026-07-31',
  overdueSince: null,
  thresholdReached: false,
  contractEnded: false,
  ...overrides,
});
const contract = (overrides: Partial<AdvanceAlertFacts> = {}): AdvanceAlertFacts => gpmb({ kind: 'CONTRACT', recoveryDeadline: null, ...overrides });

describe('the alerts of an advance that is not recovered in time (ST-PAY-011, UAT-AC328, UAT-AC329)', () => {
  it('goes through the four levels around the deadline of a land clearance advance', () => {
    expect(advanceAlert(gpmb(), '2026-07-23')).toEqual({ level: 0, overdueSince: null });
    expect(advanceAlert(gpmb(), '2026-07-24')).toEqual({ level: 1, overdueSince: null });
    expect(advanceAlert(gpmb(), '2026-07-30')).toEqual({ level: 1, overdueSince: null });
    expect(advanceAlert(gpmb(), '2026-07-31')).toEqual({ level: 2, overdueSince: null });
    expect(advanceAlert(gpmb(), '2026-08-01')).toEqual({ level: 3, overdueSince: '2026-08-01' });
    expect(advanceAlert(gpmb(), '2026-08-06')).toEqual({ level: 3, overdueSince: '2026-08-01' });
    expect(advanceAlert(gpmb(), '2026-08-07')).toEqual({ level: 4, overdueSince: '2026-08-01' });
    expect(advanceAlert(gpmb(), '2026-12-01')).toEqual({ level: 4, overdueSince: '2026-08-01' });
  });

  it('raises nothing for an advance that is not owed or has no deadline, and never changes the day it became overdue', () => {
    expect(advanceAlert(gpmb({ outstandingVnd: '0', overdueSince: '2026-08-01' }), '2026-08-20')).toEqual({ level: 0, overdueSince: '2026-08-01' });
    expect(advanceAlert(gpmb({ recoveryDeadline: null }), '2026-08-20')).toEqual({ level: 0, overdueSince: null });
    expect(advanceAlert(gpmb({ overdueSince: '2026-08-01' }), '2026-07-20')).toEqual({ level: 0, overdueSince: '2026-08-01' });
  });

  it('flags an advance of a contract from the day it is found past the threshold, or on a contract that has ended, and raises it a week later', () => {
    expect(advanceAlert(contract(), '2026-12-31')).toEqual({ level: 0, overdueSince: null });
    expect(advanceAlert(contract({ thresholdReached: true }), '2026-12-31')).toEqual({ level: 3, overdueSince: '2026-12-31' });
    expect(advanceAlert(contract({ contractEnded: true }), '2026-12-31')).toEqual({ level: 3, overdueSince: '2026-12-31' });
    expect(advanceAlert(contract({ contractEnded: true, overdueSince: '2026-12-31' }), '2027-01-06')).toEqual({ level: 3, overdueSince: '2026-12-31' });
    expect(advanceAlert(contract({ contractEnded: true, overdueSince: '2026-12-31' }), '2027-01-07')).toEqual({ level: 4, overdueSince: '2026-12-31' });
    expect(advanceAlert(contract({ thresholdReached: true, outstandingVnd: '0' }), '2026-12-31')).toEqual({ level: 0, overdueSince: null });
  });

  it('acknowledges only an advance that is overdue and owed, with a plan due today or later', () => {
    expect(() => assertAcknowledgeable({ outstandingVnd: '300', overdueSince: '2026-12-31' })).not.toThrow();
    for (const facts of [
      { outstandingVnd: '300', overdueSince: null },
      { outstandingVnd: '0', overdueSince: '2026-12-31' },
    ]) {
      expect(failure(() => assertAcknowledgeable(facts))).toMatchObject({ code: 'ADVANCE_NOT_OVERDUE', status: 422 });
    }
    expect(() => assertPlanDue('2027-01-10', '2027-01-10')).not.toThrow();
    expect(failure(() => assertPlanDue('2027-01-09', '2027-01-10'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'action_plan_due_on' });
  });
});
