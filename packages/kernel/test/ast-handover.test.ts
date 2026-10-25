import type { DomainError } from '../src/errors';
import {
  HANDOVER_STATUSES,
  PUNCH_SEVERITIES,
  PUNCH_STATUSES,
  assertCanAddPunchItem,
  assertCanWaive,
  assertHandoverApprover,
  assertHandoverDecision,
  assertNoOpenCritical,
  assertPunchMove,
  assertPunchVerifier,
  assertPunchWaiver,
  isOpenCritical,
} from '../src/ast-handover';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('the handover of a work and its punch list (ST-AST-001, BR-AST-01, UAT-AC388)', () => {
  it('takes items on the punch list until the receiving unit has decided', () => {
    expect(HANDOVER_STATUSES.filter((status) => !failsWith(() => assertCanAddPunchItem(status)))).toEqual(['DRAFT', 'INSPECTING', 'PUNCH_PENDING']);
    expect(failure(() => assertCanAddPunchItem('ACCEPTED'))).toMatchObject({ code: 'HANDOVER_STATE_INVALID', status: 409, extensions: { status: 'ACCEPTED' } });
  });

  it('takes a handover where the decision leads, and refuses a decision on one that was decided', () => {
    expect(assertHandoverDecision('approve', 'PUNCH_PENDING')).toBe('ACCEPTED');
    expect(assertHandoverDecision('approve', 'INSPECTING')).toBe('ACCEPTED');
    expect(assertHandoverDecision('approve', 'DRAFT')).toBe('ACCEPTED');
    expect(assertHandoverDecision('return', 'PUNCH_PENDING')).toBe('PUNCH_PENDING');
    expect(assertHandoverDecision('return', 'INSPECTING')).toBe('PUNCH_PENDING');
    expect(assertHandoverDecision('reject', 'DRAFT')).toBe('REJECTED');
    expect(assertHandoverDecision('reject', 'PUNCH_PENDING')).toBe('REJECTED');
    // There is nothing to give back on a handover with no list yet.
    expect(failure(() => assertHandoverDecision('return', 'DRAFT'))).toMatchObject({ code: 'HANDOVER_STATE_INVALID', status: 409, extensions: { status: 'DRAFT', decision: 'return' } });
    for (const status of ['ACCEPTED', 'REJECTED', 'CANCELLED'] as const) {
      for (const decision of ['approve', 'return', 'reject'] as const) expect(failure(() => assertHandoverDecision(decision, status))).toMatchObject({ code: 'HANDOVER_STATE_INVALID' });
    }
  });

  it('counts an item against the acceptance while it is critical and not verified, and says which', () => {
    expect(PUNCH_SEVERITIES.flatMap((severity) => PUNCH_STATUSES.filter((status) => isOpenCritical(severity, status)).map((status) => `${severity}/${status}`))).toEqual([
      'CRITICAL/OPEN',
      'CRITICAL/FIXED',
      'CRITICAL/WAIVED',
    ]);
    expect(() =>
      assertNoOpenCritical([
        { itemNo: 1, severity: 'CRITICAL', status: 'VERIFIED' },
        { itemNo: 2, severity: 'MAJOR', status: 'OPEN' },
      ]),
    ).not.toThrow();
    expect(() => assertNoOpenCritical([])).not.toThrow();
    expect(
      failure(() =>
        assertNoOpenCritical([
          { itemNo: 1, severity: 'CRITICAL', status: 'OPEN' },
          { itemNo: 2, severity: 'MINOR', status: 'OPEN' },
          { itemNo: 3, severity: 'CRITICAL', status: 'FIXED' },
        ]),
      ),
    ).toMatchObject({ code: 'OPEN_CRITICAL_PUNCH', status: 422, extensions: { open_critical_punch_count: 2, item_nos: [1, 3] } });
  });

  it('lets an open item be answered, an answered one be verified, and either be waived, and nothing else', () => {
    expect(PUNCH_STATUSES.filter((status) => !failsWith(() => assertPunchMove('fix', status)))).toEqual(['OPEN']);
    expect(PUNCH_STATUSES.filter((status) => !failsWith(() => assertPunchMove('verify', status)))).toEqual(['FIXED']);
    expect(PUNCH_STATUSES.filter((status) => !failsWith(() => assertPunchMove('waive', status)))).toEqual(['OPEN', 'FIXED']);
    expect(failure(() => assertPunchMove('verify', 'OPEN'))).toMatchObject({ code: 'PUNCH_STATE_INVALID', status: 409, extensions: { status: 'OPEN', move: 'verify' } });
  });

  it('never waives a critical item', () => {
    expect(() => assertCanWaive('MAJOR')).not.toThrow();
    expect(() => assertCanWaive('MINOR')).not.toThrow();
    expect(failure(() => assertCanWaive('CRITICAL'))).toMatchObject({ code: 'CRITICAL_CANNOT_BE_WAIVED', status: 422 });
  });

  it('keeps the people who put it right from verifying it, the person who raised an item from waiving it and the drafter from accepting the handover', () => {
    expect(() => assertPunchVerifier('b', 'a')).not.toThrow();
    expect(() => assertPunchVerifier('b', null)).not.toThrow();
    expect(failure(() => assertPunchVerifier('A', 'a'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(() => assertPunchWaiver('b', 'a')).not.toThrow();
    expect(failure(() => assertPunchWaiver('a', 'A'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    expect(() => assertHandoverApprover('b', 'a')).not.toThrow();
    expect(() => assertHandoverApprover('b', null)).not.toThrow();
    expect(failure(() => assertHandoverApprover('a', 'a'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
  });
});

function failsWith(work: () => unknown): boolean {
  try {
    work();
    return false;
  } catch {
    return true;
  }
}
