import type { DomainError } from '../src/errors';
import {
  ACTION_STATUSES,
  NCR_SEVERITIES,
  NCR_STATUSES,
  assertActionsVerified,
  assertIndependentCloser,
  assertIndependentVerifier,
  assertNcrTransition,
  blocksAcceptance,
  canAssignAction,
  canSubmitEvidence,
  canVerify,
  statusFromActions,
} from '../src/qms-nonconformance';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('a non-conformance and its actions (ST-QMS-006, BR-QMS-07, UAT-AC361)', () => {
  it('holds back the acceptance only when it is critical', () => {
    expect(NCR_SEVERITIES.filter((severity) => blocksAcceptance(severity))).toEqual(['CRITICAL']);
  });

  it('lets an action be added until the non-conformance is verified as a whole, and answers an action only while it waits for evidence', () => {
    expect(NCR_STATUSES.filter((status) => canAssignAction(status))).toEqual(['OPEN', 'ACTION_ASSIGNED', 'ACTION_SUBMITTED', 'REOPENED']);
    expect(ACTION_STATUSES.filter((status) => canSubmitEvidence(status))).toEqual(['ASSIGNED', 'REJECTED']);
    expect(ACTION_STATUSES.filter((status) => canVerify(status))).toEqual(['SUBMITTED']);
  });

  it('works out where a non-conformance stands from its actions', () => {
    expect(statusFromActions('OPEN', [])).toBe('OPEN');
    expect(statusFromActions('REOPENED', [])).toBe('REOPENED');
    expect(statusFromActions('OPEN', ['ASSIGNED'])).toBe('ACTION_ASSIGNED');
    expect(statusFromActions('ACTION_ASSIGNED', ['SUBMITTED', 'ASSIGNED'])).toBe('ACTION_ASSIGNED');
    expect(statusFromActions('ACTION_SUBMITTED', ['SUBMITTED', 'REJECTED'])).toBe('ACTION_ASSIGNED');
    expect(statusFromActions('ACTION_ASSIGNED', ['SUBMITTED'])).toBe('ACTION_SUBMITTED');
    expect(statusFromActions('ACTION_ASSIGNED', ['SUBMITTED', 'VERIFIED'])).toBe('ACTION_SUBMITTED');
    expect(statusFromActions('ACTION_SUBMITTED', ['VERIFIED', 'VERIFIED'])).toBe('VERIFIED');
    expect(statusFromActions('CLOSED', ['ASSIGNED'])).toBe('CLOSED');
  });

  it('closes from verified and reopens from closed, and refuses every other move', () => {
    expect(assertNcrTransition('VERIFIED', 'close')).toBe('CLOSED');
    expect(assertNcrTransition('CLOSED', 'reopen')).toBe('REOPENED');
    for (const status of NCR_STATUSES) {
      if (status !== 'VERIFIED') expect(failure(() => assertNcrTransition(status, 'close'))).toMatchObject({ code: 'NCR_STATE_INVALID', status: 409, extensions: { status } });
      if (status !== 'CLOSED') expect(failure(() => assertNcrTransition(status, 'reopen'))).toMatchObject({ code: 'NCR_STATE_INVALID', status: 409 });
    }
  });

  it('closes only on actions that are all verified, and on at least one', () => {
    expect(() => assertActionsVerified(['VERIFIED', 'VERIFIED'])).not.toThrow();
    expect(failure(() => assertActionsVerified([]))).toMatchObject({ code: 'CORRECTIVE_ACTION_OPEN', status: 422, extensions: { open_actions: 0, actions: 0 } });
    expect(failure(() => assertActionsVerified(['VERIFIED', 'SUBMITTED', 'REJECTED']))).toMatchObject({ code: 'CORRECTIVE_ACTION_OPEN', extensions: { open_actions: 2, actions: 3 } });
  });

  it('keeps the people who put the non-conformance right from verifying an action and from closing it', () => {
    expect(() => assertIndependentVerifier('c', 'a', 'b')).not.toThrow();
    expect(failure(() => assertIndependentVerifier('A', 'a', 'b'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(failure(() => assertIndependentVerifier('b', 'a', 'B'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    expect(() => assertIndependentCloser('d', 'a', ['b', 'c'])).not.toThrow();
    expect(() => assertIndependentCloser('d', 'a', [])).not.toThrow();
    expect(failure(() => assertIndependentCloser('a', 'a', ['b']))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(failure(() => assertIndependentCloser('c', 'a', ['b', 'C']))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
  });
});
