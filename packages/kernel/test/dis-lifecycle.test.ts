import type { DomainError } from '../src/errors.ts';
import { DELETION_REASON_MIN, RESTORE_WINDOW_DAYS, WITHDRAWAL_REASON_MIN, deleteRefusal, deletionOf, restoreDeadline, restoreRefusal, withdrawRefusal, withdrawalOf } from '../src/dis-lifecycle.ts';

const NOW = new Date('2027-02-10T03:00:00.000Z');

function refusal(work: () => unknown): { code: string; status: number; detail?: string } {
  try {
    work();
  } catch (error) {
    const e = error as DomainError;
    return { code: e.code, status: e.status, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}
const shape = (error: DomainError | undefined) => (error === undefined ? undefined : { code: error.code, status: error.status, ...(error.detail === undefined ? {} : { detail: error.detail }) });

describe('the withdrawal of a report that was handed in (ST-DIS-007, DIS 3 F3)', () => {
  it('AC-ST-DIS-007-3 / UAT-AC259: asks the reason in words, at least 20 characters (422 on reason), and keeps it trimmed', () => {
    expect(withdrawalOf({ reason: '  The wrong period was reported by mistake.  ' })).toEqual({ reason: 'The wrong period was reported by mistake.' });
    for (const reason of [undefined, '', '   ', 'x'.repeat(WITHDRAWAL_REASON_MIN - 1), 'x'.repeat(2001), 7]) {
      expect(refusal(() => withdrawalOf({ reason: reason as string }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
    }
    expect(withdrawalOf({ reason: 'x'.repeat(WITHDRAWAL_REASON_MIN) }).reason).toHaveLength(WITHDRAWAL_REASON_MIN);
  });

  it('counts the reason in characters as the database does: a character outside the basic plane is one, so 18 letters and an emoji are 19 and are refused, 19 letters and one are 20', () => {
    expect(refusal(() => withdrawalOf({ reason: `${'x'.repeat(18)}😀` }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
    expect(withdrawalOf({ reason: `${'x'.repeat(19)}😀` }).reason).toHaveLength(21);
    expect(refusal(() => deletionOf({ reason: '😀😀😀😀' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
    expect(deletionOf({ reason: '😀😀😀😀😀' }).reason).toBe('😀😀😀😀😀');
  });

  it('AC-ST-DIS-007-3: withdraws only a report that was handed in and is not being reviewed (409 REPORT_STATE_INVALID naming the status)', () => {
    expect(withdrawRefusal('SUBMITTED', false)).toBeUndefined();
    for (const status of ['DRAFT', 'UNDER_REVIEW', 'ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'] as const) {
      expect(shape(withdrawRefusal(status, false))).toEqual({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
    }
  });
});

describe('the soft deletion and the restore of a draft', () => {
  it('asks the reason of a deletion in words, at least 5 characters (422 on reason)', () => {
    expect(deletionOf({ reason: '  Started in the wrong week.  ' })).toEqual({ reason: 'Started in the wrong week.' });
    for (const reason of [undefined, '', '   ', 'x'.repeat(DELETION_REASON_MIN - 1), 'x'.repeat(2001)]) {
      expect(refusal(() => deletionOf({ reason: reason as string }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
    }
  });

  it('AC-ST-DIS-007-1 / UAT-AC259: deletes a draft that is live and nothing else (409 REPORT_NOT_EDITABLE naming the status)', () => {
    expect(deleteRefusal('DRAFT', false)).toBeUndefined();
    expect(shape(deleteRefusal('DRAFT', true))).toEqual({ code: 'REPORT_NOT_EDITABLE', status: 409, detail: 'status' });
    for (const status of ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'] as const) {
      expect(shape(deleteRefusal(status, false))).toEqual({ code: 'REPORT_NOT_EDITABLE', status: 409, detail: 'status' });
    }
  });

  it('AC-ST-DIS-007-2 / UAT-PLAN-68: restores a draft that was deleted, within 30 days of the deletion, and not after (422 RESTORE_WINDOW_EXPIRED)', () => {
    const deletedAt = '2027-01-11T03:00:00.000Z';
    expect(RESTORE_WINDOW_DAYS).toBe(30);
    expect(restoreDeadline(deletedAt).toISOString()).toBe('2027-02-10T03:00:00.000Z');
    expect(restoreRefusal({ status: 'DRAFT', deletedAt }, NOW)).toBeUndefined();
    expect(restoreRefusal({ status: 'DRAFT', deletedAt }, new Date('2027-02-10T02:59:59.999Z'))).toBeUndefined();
    expect(shape(restoreRefusal({ status: 'DRAFT', deletedAt }, new Date('2027-02-10T03:00:00.001Z')))).toEqual({ code: 'RESTORE_WINDOW_EXPIRED', status: 422, detail: 'deleted_at' });
  });

  it('restores only what was deleted: a draft that is live, or a report that was handed in, is 409 REPORT_STATE_INVALID', () => {
    expect(shape(restoreRefusal({ status: 'DRAFT', deletedAt: null }, NOW))).toEqual({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
    expect(shape(restoreRefusal({ status: 'SUBMITTED', deletedAt: null }, NOW))).toEqual({ code: 'REPORT_STATE_INVALID', status: 409, detail: 'status' });
  });
});
