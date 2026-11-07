import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { daysLeft, describeProblem, emptyForm, formProblems, isLive, isUuid, pairKeyOf, refusedField, toBody, toException, toMatrix, toUse, todayOf, windowDays } from './model';
import type { MatrixView } from './model';

const failure = (code: string, detail?: string): ApiError => new ApiError({ status: 422, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const UUID = '00000000-0000-4000-8000-000000000001';

const matrix = (): MatrixView =>
  toMatrix({
    as_of: '2026-11-08',
    rule_version: 0,
    source: 'DEFAULT',
    unverified: true,
    exception_approvers: 2,
    formula: 'f',
    source_text: 's',
    rule_as_of: '2026-11-08',
    expiring_exceptions: 1,
    conflicts: [
      { action_a: 'payment.request', action_b: 'payment.verify', scope: 'SAME_RECORD', severity: 'BLOCK', exception_max_days: 14 },
      { action_a: 'bid.evaluate', action_b: 'bid.award', scope: 'SAME_PACKAGE', severity: 'BLOCK', exception_max_days: 0 },
      { action_a: 'nonsense', action_b: 'x', scope: 'SAME_PLANET', severity: 'BLOCK', exception_max_days: 1 },
    ],
  }) as MatrixView;

describe('the matrix and the exceptions as the screen reads them (G4-1)', () => {
  it('keeps the pairs of a known shape and drops a pair of an unknown scope', () => {
    const view = matrix();
    expect(view.conflicts).toHaveLength(2);
    expect(view).toMatchObject({ source: 'DEFAULT', unverified: true, approvers: 2, expiring: 1 });
    expect(toMatrix({ conflicts: 'no' })).toBeUndefined();
    expect(toMatrix(null)).toBeUndefined();
  });

  it('reads an exception and refuses one that lacks what the screen needs', () => {
    const raw = { id: UUID, action_a: 'a.b', action_b: 'c.d', scope: 'SAME_CONTRACT', subject_id: UUID, member_id: UUID, requested_by: UUID, valid_from: '2026-11-08', valid_to: '2026-11-10', status: 'EXPIRED', version: 3, approvals: 1, uses: 2 };
    expect(toException(raw)).toMatchObject({ status: 'EXPIRED', approvals: 1, approversNeeded: 2, uses: 2, memberName: '' });
    expect(toException({ ...raw, status: 'LOST' })).toBeUndefined();
    expect(toException({ ...raw, version: undefined })).toBeUndefined();
    expect(isLive('REQUESTED')).toBe(true);
    expect(isLive('EXPIRED')).toBe(false);
  });

  it('reads a use with its outcome', () => {
    expect(toUse({ id: UUID, outcome: 'BLOCKED', action_a: 'a.b', action_b: 'c.d', scope: 'SAME_RECORD', used_at: '2026-11-08T01:00:00.000Z', member_name: 'An' })).toMatchObject({ outcome: 'BLOCKED', exceptionId: null, memberName: 'An' });
    expect(toUse({ id: UUID, outcome: 'SKIPPED', action_a: 'a', action_b: 'b', scope: 'SAME_RECORD', used_at: 'x' })).toBeUndefined();
  });

  it('counts the days of a window with both ends and the days left on the last day as 0', () => {
    expect(windowDays('2026-11-08', '2026-11-08')).toBe(1);
    expect(windowDays('2026-11-08', '2026-11-21')).toBe(14);
    expect(daysLeft('2026-11-10', '2026-11-08')).toBe(2);
    expect(daysLeft('2026-11-08', '2026-11-08')).toBe(0);
    expect(daysLeft('2026-11-07', '2026-11-08')).toBeNull();
    expect(todayOf(new Date('2026-11-08T18:30:00Z'))).toBe('2026-11-09');
  });

  it('stops the form for a pair that takes none, days longer than the pair allows, the past and a short reason', () => {
    const view = matrix();
    const pair = pairKeyOf(view.conflicts[0] as never);
    const ok = { ...emptyForm('2026-11-08'), pair, subjectId: UUID, memberId: UUID, reason: 'The only checker is away this week' };
    expect(formProblems(ok, '2026-11-08', view)).toEqual([]);
    expect(formProblems({ ...ok, pair: '' }, '2026-11-08', view)).toEqual(['pairRequired']);
    expect(formProblems({ ...ok, pair: pairKeyOf(view.conflicts[1] as never) }, '2026-11-08', view)).toEqual(['noException']);
    expect(formProblems({ ...ok, validTo: '2026-11-22' }, '2026-11-08', view)).toEqual(['tooLong']);
    expect(formProblems({ ...ok, validTo: '2026-11-21' }, '2026-11-08', view)).toEqual([]);
    expect(formProblems({ ...ok, validFrom: '2026-11-07' }, '2026-11-08', view)).toEqual(['inThePast']);
    expect(formProblems({ ...ok, validFrom: '2026-11-10', validTo: '2026-11-09' }, '2026-11-08', view)).toEqual(['datesInvalid']);
    expect(formProblems({ ...ok, reason: 'short' }, '2026-11-08', view)).toEqual(['reasonShort']);
    expect(formProblems({ ...ok, subjectId: 'not an id', memberId: '' }, '2026-11-08', view)).toEqual(['subjectRequired', 'memberRequired']);
    expect(isUuid(` ${UUID} `)).toBe(true);
  });

  it('sends what the form says, with the pair split and the id in lower case', () => {
    const view = matrix();
    const body = toBody({ ...emptyForm('2026-11-08'), pair: pairKeyOf(view.conflicts[0] as never), subjectId: ` ${UUID.toUpperCase()} `, memberId: UUID, reason: '  Because of the leave of the checker  ' });
    expect(body).toEqual({ action_a: 'payment.request', action_b: 'payment.verify', scope: 'SAME_RECORD', subject_id: UUID, member_id: UUID, reason: 'Because of the leave of the checker', valid_from: '2026-11-08', valid_to: '2026-11-14' });
  });

  it('names a refusal by its code and the field the server pointed at', () => {
    expect(describeProblem(failure('SELF_APPROVAL_DENIED'))).toBe('self');
    expect(describeProblem(failure('SOD_EXCEPTION_STATE_INVALID'))).toBe('state');
    expect(describeProblem(failure('SOD_EXCEPTION_WINDOW_INVALID'))).toBe('window');
    expect(describeProblem(failure('VERSION_CONFLICT'))).toBe('stale');
    expect(describeProblem(failure('VALIDATION_FAILED'))).toBe('invalid');
    expect(describeProblem(failure('SCOPE_DENIED'))).toBe('scope');
    expect(describeProblem(new Error('x'))).toBe('general');
    expect(refusedField(failure('VALIDATION_FAILED', 'subject_id'))).toBe('subject_id');
    expect(refusedField(new Error('x'))).toBeUndefined();
  });
});
