import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { DELETION_REASON_MIN, WITHDRAWAL_REASON_MIN, canDelete, canRestore, canStillRestore, canWithdraw, describeRemoval, reasonBody, restoreDeadline, validateRemovalReason } from './lifecycle-model';

describe('who may take a report back, delete a draft and restore it (the server decides again)', () => {
  it('lets the maker with the right withdraw a report that was handed in and is not being reviewed, in a tenant that is not read only', () => {
    expect(canWithdraw(['report.withdraw'], 'FULL', 'SUBMITTED')).toBe(true);
    expect(canWithdraw(undefined, undefined, 'SUBMITTED')).toBe(true);
    expect(canWithdraw(['report.edit'], 'FULL', 'SUBMITTED')).toBe(false);
    expect(canWithdraw(['report.withdraw'], 'READ_ONLY', 'SUBMITTED')).toBe(false);
    for (const status of ['DRAFT', 'UNDER_REVIEW', 'ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'] as const) expect(canWithdraw(['report.withdraw'], 'FULL', status)).toBe(false);
  });

  it('lets an editor delete a draft that stands and restore one that was deleted, and nothing else', () => {
    expect(canDelete(['report.edit'], 'FULL', { status: 'DRAFT', deleted: false })).toBe(true);
    expect(canDelete(['report.edit'], 'FULL', { status: 'DRAFT', deleted: true })).toBe(false);
    expect(canDelete(['report.edit'], 'FULL', { status: 'SUBMITTED', deleted: false })).toBe(false);
    expect(canDelete(['report.read'], 'FULL', { status: 'DRAFT', deleted: false })).toBe(false);
    expect(canDelete(['report.edit'], 'READ_ONLY', { status: 'DRAFT', deleted: false })).toBe(false);
    expect(canRestore(['report.edit'], 'FULL', { status: 'DRAFT', deleted: true })).toBe(true);
    expect(canRestore(['report.edit'], 'FULL', { status: 'DRAFT', deleted: false })).toBe(false);
    expect(canRestore(['report.read'], 'FULL', { status: 'DRAFT', deleted: true })).toBe(false);
  });

  it('counts the 30 days of the restore from the instant of the deletion, the last instant included', () => {
    const deletedAt = '2027-01-11T03:00:00.000Z';
    expect(restoreDeadline(deletedAt).toISOString()).toBe('2027-02-10T03:00:00.000Z');
    expect(canStillRestore(deletedAt, new Date('2027-02-10T03:00:00.000Z'))).toBe(true);
    expect(canStillRestore(deletedAt, new Date('2027-02-10T03:00:00.001Z'))).toBe(false);
  });
});

describe('the reason of a deletion and of a withdrawal', () => {
  it('asks for words, at least as many characters as the case wants, at most 2000', () => {
    expect(validateRemovalReason('', WITHDRAWAL_REASON_MIN)).toBe('required');
    expect(validateRemovalReason('   ', DELETION_REASON_MIN)).toBe('required');
    expect(validateRemovalReason('too short a reason', WITHDRAWAL_REASON_MIN)).toBe('tooShort');
    expect(validateRemovalReason('no', DELETION_REASON_MIN)).toBe('tooShort');
    expect(validateRemovalReason('x'.repeat(2001), DELETION_REASON_MIN)).toBe('tooLong');
    expect(validateRemovalReason('Started in the wrong week.', DELETION_REASON_MIN)).toBeUndefined();
    expect(validateRemovalReason('x'.repeat(WITHDRAWAL_REASON_MIN), WITHDRAWAL_REASON_MIN)).toBeUndefined();
    expect(reasonBody('  Started in the wrong week.  ')).toEqual({ reason: 'Started in the wrong week.' });
    // A character outside the basic plane is one character, as the database counts it.
    expect(validateRemovalReason(`${'x'.repeat(18)}😀`, WITHDRAWAL_REASON_MIN)).toBe('tooShort');
    expect(validateRemovalReason(`${'x'.repeat(19)}😀`, WITHDRAWAL_REASON_MIN)).toBeUndefined();
  });

  it('names what the server refused in the words of the screen', () => {
    const refused = (code: string) => describeRemoval(new ApiError({ status: 409, code, correlationId: 'c' }));
    expect(refused('REPORT_STATE_INVALID')).toBe('stateChanged');
    expect(refused('REPORT_NOT_EDITABLE')).toBe('stateChanged');
    expect(refused('PERIOD_LOCKED')).toBe('periodLocked');
    expect(refused('RESTORE_WINDOW_EXPIRED')).toBe('windowExpired');
    expect(refused('VERSION_CONFLICT')).toBe('versionConflict');
    expect(refused('SCOPE_DENIED')).toBe('scopeDenied');
    expect(refused('VALIDATION_FAILED')).toBe('reasonInvalid');
    expect(refused('RESOURCE_NOT_FOUND')).toBe('notFound');
    expect(refused('SOMETHING_ELSE')).toBe('general');
    expect(describeRemoval(new Error('network'))).toBe('general');
  });
});
