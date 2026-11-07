import type { DomainError } from './errors.ts';
import { defaultGovernanceRule } from './governance-rules.ts';
import {
  SOD_ACTION_CODES,
  afterApproval,
  afterRejection,
  afterRevocation,
  approversNeeded,
  assertExceptionWindow,
  assertMayDecide,
  assertReason,
  checksFor,
  conflictOf,
  expiringWithin,
  heldKey,
  lookupsFor,
  pairKey,
  sodMatrixOf,
  subjectKeyOf,
  usable,
  viewOf,
  violationError,
  violationsOf,
} from './gov-d-sod.ts';
import type { SodExceptionFacts, SodMatrix } from './gov-d-sod.ts';

const matrix = (): SodMatrix => sodMatrixOf(defaultGovernanceRule('SOD_MATRIX', 'DEFAULT')!.params);

const failure = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const facts = (over: Partial<SodExceptionFacts> = {}): SodExceptionFacts => ({ status: 'REQUESTED', requestedBy: 'req', member: 'mem', validFrom: '2026-11-10', validTo: '2026-11-20', approvedBy: [], approversNeeded: 2, ...over });

describe('the matrix of conflicting duties (G4-1)', () => {
  it('the built-in default names only duties of the catalogue and reads under the registry schema', () => {
    const m = matrix();
    expect(m.conflicts.length).toBeGreaterThanOrEqual(8);
    for (const conflict of m.conflicts) {
      expect(SOD_ACTION_CODES).toContain(conflict.action_a);
      expect(SOD_ACTION_CODES).toContain(conflict.action_b);
      expect(conflict.action_a).not.toBe(conflict.action_b);
    }
    expect(approversNeeded(m)).toBeGreaterThanOrEqual(2);
  });

  it('a bid evaluation cannot be taken back into the award: no exception window at all', () => {
    const pair = matrix().conflicts.find((conflict) => conflict.action_a === 'bid.evaluate' && conflict.action_b === 'bid.award')!;
    expect(pair.scope).toBe('SAME_PACKAGE');
    expect(pair.severity).toBe('BLOCK');
    expect(pair.exception_max_days).toBe(0);
  });

  it('sees a conflict from either side of the pair', () => {
    const m = matrix();
    expect(checksFor(m, 'payment.verify').map((check) => check.other)).toContain('payment.request');
    expect(checksFor(m, 'payment.request').map((check) => check.other)).toContain('payment.verify');
    expect(checksFor(m, 'no.such')).toEqual([]);
  });

  it('judges only the duties the actor already holds, in the scope of the pair', () => {
    const m = matrix();
    expect(violationsOf(m, 'payment.verify', new Set())).toEqual([]);
    expect(violationsOf(m, 'payment.verify', new Set([heldKey('payment.request', 'SAME_RECORD')])).map((check) => check.other)).toEqual(['payment.request']);
    // The same duty held in another scope than the pair names is not a conflict of that pair.
    expect(violationsOf(m, 'payment.verify', new Set([heldKey('payment.request', 'SAME_PACKAGE')]))).toEqual([]);
  });

  it('asks the database for each duty once', () => {
    const m: SodMatrix = {
      exception_approvers: 2,
      conflicts: [
        { action_a: 'a.x', action_b: 'b.y', scope: 'SAME_RECORD', severity: 'BLOCK', exception_max_days: 3 },
        { action_a: 'a.x', action_b: 'b.y', scope: 'SAME_RECORD', severity: 'WARN', exception_max_days: 3 },
        { action_a: 'a.x', action_b: 'b.y', scope: 'SAME_PROJECT', severity: 'WARN', exception_max_days: 3 },
      ],
    };
    expect(lookupsFor(m, 'a.x')).toEqual([
      { action: 'b.y', scope: 'SAME_RECORD' },
      { action: 'b.y', scope: 'SAME_PROJECT' },
    ]);
  });

  it('a pair that names one duty twice judges nothing', () => {
    const m: SodMatrix = { exception_approvers: 2, conflicts: [{ action_a: 'a.x', action_b: 'a.x', scope: 'SAME_RECORD', severity: 'BLOCK', exception_max_days: 0 }] };
    expect(violationsOf(m, 'a.x', new Set([heldKey('a.x', 'SAME_RECORD')]))).toEqual([]);
    expect(lookupsFor(m, 'a.x')).toEqual([]);
  });

  it('the refusal names the two duties and never a person', () => {
    const check = checksFor(matrix(), 'payment.verify')[0]!;
    const error = violationError(check, true);
    expect(error.code).toBe('SOD_VIOLATION');
    expect(error.status).toBe(422);
    expect(Object.keys(error.extensions!).sort()).toEqual(['action_a', 'action_b', 'exception_possible', 'held', 'scope', 'taking']);
    expect(error.extensions!.exception_possible).toBe(true);
    expect(violationError({ ...check, exception_max_days: 0 }, true).extensions!.exception_possible).toBe(false);
  });

  it('reads the key of a scope from the subject', () => {
    const subject = { record: 'r', project: 'p', contract: null, package: 'k' };
    expect(subjectKeyOf(subject, 'SAME_RECORD')).toBe('r');
    expect(subjectKeyOf(subject, 'SAME_PROJECT')).toBe('p');
    expect(subjectKeyOf(subject, 'SAME_CONTRACT')).toBeNull();
    expect(subjectKeyOf(subject, 'SAME_PACKAGE')).toBe('k');
  });

  it('a matrix with an unknown scope or severity is refused by the registry schema', () => {
    const bad = { exception_approvers: 2, conflicts: [{ action_a: 'a.x', action_b: 'b.y', scope: 'SAME_PLANET', severity: 'BLOCK', exception_max_days: 1 }] };
    expect(failure(() => sodMatrixOf(bad)).code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
    expect(pairKey({ action_a: 'a', action_b: 'b' })).toBe('a|b');
  });
});

describe('time-limited exceptions', () => {
  it('finds the conflict an exception is asked for, or refuses the pair', () => {
    const m = matrix();
    expect(conflictOf(m, { action_a: 'payment.request', action_b: 'payment.verify' }, 'SAME_RECORD').severity).toBe('BLOCK');
    expect(failure(() => conflictOf(m, { action_a: 'payment.verify', action_b: 'payment.request' }, 'SAME_RECORD')).detail).toBe('pair');
    expect(failure(() => conflictOf(m, { action_a: 'payment.request', action_b: 'payment.verify' }, 'SAME_PACKAGE')).detail).toBe('pair');
  });

  it('keeps the window inside the days the pair allows, counting both ends, and never backdates', () => {
    const conflict = { action_a: 'a', action_b: 'b', scope: 'SAME_RECORD' as const, severity: 'BLOCK' as const, exception_max_days: 14 };
    expect(() => assertExceptionWindow(conflict, '2026-11-10', '2026-11-23', '2026-11-10')).not.toThrow();
    expect(failure(() => assertExceptionWindow(conflict, '2026-11-10', '2026-11-24', '2026-11-10')).detail).toBe('valid_to');
    expect(failure(() => assertExceptionWindow(conflict, '2026-11-09', '2026-11-12', '2026-11-10')).detail).toBe('valid_from');
    expect(failure(() => assertExceptionWindow(conflict, '2026-11-12', '2026-11-11', '2026-11-10')).code).toBe('SOD_EXCEPTION_WINDOW_INVALID');
    expect(failure(() => assertExceptionWindow({ ...conflict, exception_max_days: 0 }, '2026-11-10', '2026-11-10', '2026-11-10')).code).toBe('SOD_EXCEPTION_WINDOW_INVALID');
    expect(failure(() => assertExceptionWindow(conflict, '2026-02-31', '2026-03-01', '2026-02-01')).code).toBe('VALIDATION_FAILED');
  });

  it('needs two distinct approvers who are neither the requester nor the covered person', () => {
    expect(failure(() => assertMayDecide(facts(), 'req')).code).toBe('SELF_APPROVAL_DENIED');
    expect(failure(() => assertMayDecide(facts(), 'mem')).code).toBe('SELF_APPROVAL_DENIED');
    expect(failure(() => assertMayDecide(facts({ approvedBy: ['a1'] }), 'a1')).code).toBe('SOD_EXCEPTION_STATE_INVALID');
    expect(failure(() => assertMayDecide(facts({ status: 'APPROVED' }), 'a1')).code).toBe('SOD_EXCEPTION_STATE_INVALID');
    expect(afterApproval(facts(), 'a1', '2026-11-10')).toEqual({ status: 'REQUESTED', approvals: 1 });
    expect(afterApproval(facts({ approvedBy: ['a1'] }), 'a2', '2026-11-10')).toEqual({ status: 'APPROVED', approvals: 2 });
    expect(afterApproval(facts({ approvedBy: ['a1', 'a2'], approversNeeded: 3 }), 'a3', '2026-11-10').status).toBe('APPROVED');
  });

  it('is not approved late', () => {
    expect(failure(() => afterApproval(facts({ validTo: '2026-11-09' }), 'a1', '2026-11-10')).code).toBe('SOD_EXCEPTION_WINDOW_INVALID');
  });

  it('one eligible rejection ends the request; a revocation takes back a live one only', () => {
    expect(afterRejection(facts(), 'a1')).toBe('REJECTED');
    expect(failure(() => afterRejection(facts(), 'mem')).code).toBe('SELF_APPROVAL_DENIED');
    expect(afterRevocation({ status: 'APPROVED' })).toBe('REVOKED');
    expect(afterRevocation({ status: 'REQUESTED' })).toBe('REVOKED');
    expect(failure(() => afterRevocation({ status: 'REJECTED' })).code).toBe('SOD_EXCEPTION_STATE_INVALID');
    expect(failure(() => afterRevocation({ status: 'REVOKED' })).code).toBe('SOD_EXCEPTION_STATE_INVALID');
  });

  it('expires by the calendar, not by a write', () => {
    const row = { status: 'APPROVED' as const, validFrom: '2026-11-10', validTo: '2026-11-20' };
    expect(viewOf(row, '2026-11-20')).toBe('APPROVED');
    expect(viewOf(row, '2026-11-21')).toBe('EXPIRED');
    expect(viewOf({ status: 'REVOKED', validTo: '2026-11-01' }, '2026-11-21')).toBe('REVOKED');
    expect(usable(row, '2026-11-09')).toBe(false);
    expect(usable(row, '2026-11-10')).toBe(true);
    expect(usable(row, '2026-11-20')).toBe(true);
    expect(usable(row, '2026-11-21')).toBe(false);
    expect(usable({ ...row, status: 'REQUESTED' }, '2026-11-15')).toBe(false);
  });

  it('lists an approved exception as expiring in its last days', () => {
    const row = { status: 'APPROVED' as const, validTo: '2026-11-20' };
    expect(expiringWithin(row, '2026-11-15')).toBe(true);
    expect(expiringWithin(row, '2026-11-14')).toBe(false);
    expect(expiringWithin(row, '2026-11-21')).toBe(false);
    expect(expiringWithin({ ...row, status: 'REVOKED' }, '2026-11-18')).toBe(false);
  });

  it('wants a reason in words', () => {
    expect(assertReason('  Cán bộ duy nhất của đơn vị trong kỳ nghỉ  ')).toBe('Cán bộ duy nhất của đơn vị trong kỳ nghỉ');
    expect(failure(() => assertReason('ngắn')).detail).toBe('reason');
    expect(failure(() => assertReason(undefined)).detail).toBe('reason');
    expect(failure(() => assertReason('x'.repeat(501))).detail).toBe('reason');
  });
});
