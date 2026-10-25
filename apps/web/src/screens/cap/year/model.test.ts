import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, actionsFor, describeProblem, openYear, toYear, validateClose, validateReopen, yearChoices } from './model';

const refusal = (code: string, extensions: Record<string, unknown> = {}, detail?: string) => describeProblem(new ApiError({ status: 409, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions }));

describe('CAP-11 model (ST-CAP-008)', () => {
  it('reads a year of the control and drops what has no year', () => {
    expect(toYear({ plan_year: 2025, status: 'LOCKED', version: 3, locked_at: '2026-02-01T00:00:00Z', locked_by: 'u', close_reason: 'r', reopened_until: '2026-02-02T00:00:00Z' })).toMatchObject({
      year: 2025,
      status: 'LOCKED',
      version: 3,
      lockedAt: '2026-02-01T00:00:00Z',
      lockedBy: 'u',
      closeReason: 'r',
      reopenedUntil: '2026-02-02T00:00:00Z',
    });
    expect(toYear({ status: 'LOCKED' })).toBeUndefined();
    expect(toYear({ plan_year: 1.5 })).toBeUndefined();
    expect(toYear({ plan_year: 2025, status: 'weird' })).toMatchObject({ status: 'OPEN', version: 1 });
    expect(toYear(undefined)).toBeUndefined();
  });

  it('takes a year the control does not know for open with version 1', () => {
    expect(openYear(2027)).toMatchObject({ year: 2027, status: 'OPEN', version: 1, lockedAt: undefined });
  });

  it('offers the years the control knows and the years around today, the latest first', () => {
    const rows = [openYear(2020), openYear(2026)];
    expect(yearChoices(rows, new Date('2026-10-25T00:00:00Z'))).toEqual([2027, 2026, 2025, 2020]);
    expect(yearChoices([], new Date('2026-10-25T00:00:00Z'))).toEqual([2027, 2026, 2025]);
  });

  it('offers an open year its two closes, a soft-closed year its lock and a locked year its reopening', () => {
    expect(actionsFor('OPEN')).toEqual(['SOFT_CLOSE', 'LOCK']);
    expect(actionsFor('SOFT_CLOSED')).toEqual(['LOCK']);
    expect(actionsFor('LOCKED')).toEqual(['REOPEN']);
  });

  it('asks a reason of 5 to 2000 characters to close', () => {
    expect(validateClose({ ...EMPTY_FORM, reason: 'Hết kỳ chỉnh lý' })).toEqual({});
    expect(validateClose({ ...EMPTY_FORM, reason: 'no' })).toEqual({ reason: 'closeReasonLength' });
    expect(validateClose({ ...EMPTY_FORM, reason: ' '.repeat(10) })).toEqual({ reason: 'closeReasonLength' });
    expect(validateClose({ ...EMPTY_FORM, reason: 'x'.repeat(2001) })).toEqual({ reason: 'closeReasonLength' });
  });

  it('asks a reason of 20 to 2000 characters and a window of 1 to 168 whole hours to reopen', () => {
    const reason = 'Kiểm toán phát hiện sai sót khi phân bổ vốn';
    expect(validateReopen({ reason, hours: '24' })).toEqual({});
    expect(validateReopen({ reason, hours: ' 168 ' })).toEqual({});
    expect(validateReopen({ reason: 'ngắn', hours: '24' })).toEqual({ reason: 'reopenReasonLength' });
    for (const hours of ['', '0', '169', '1.5', 'abc']) expect(validateReopen({ reason, hours })).toEqual({ hours: 'hoursInvalid' });
  });

  it('sorts a refusal of the server by its code and what it says about the plans', () => {
    expect(refusal('YEAR_STATE_INVALID', { reason: 'PLANS_PENDING', plan_ids: ['a', 'b'] })).toMatchObject({ reason: 'plansPending', blockers: 2 });
    expect(refusal('YEAR_STATE_INVALID', { reason: 'RESERVATIONS_ACTIVE', reservation_ids: ['a'] })).toMatchObject({ reason: 'reservationsActive', blockers: 1 });
    expect(refusal('YEAR_STATE_INVALID', { reason: 'ALREADY_SOFT_CLOSED' }).reason).toBe('alreadySoftClosed');
    expect(refusal('YEAR_STATE_INVALID', { reason: 'NOT_LOCKED' }).reason).toBe('notLocked');
    expect(refusal('YEAR_STATE_INVALID', { reason: 'ALREADY_LOCKED' }).reason).toBe('alreadyLocked');
    expect(refusal('SELF_APPROVAL_DENIED').reason).toBe('selfApproval');
    expect(refusal('REOPEN_REASON_REQUIRED').reason).toBe('reasonRequired');
    expect(refusal('VERSION_CONFLICT').reason).toBe('conflict');
    expect(refusal('VALIDATION_FAILED', {}, 'window_hours')).toMatchObject({ reason: 'invalid', field: 'window_hours' });
    expect(refusal('SCOPE_DENIED').reason).toBe('denied');
    expect(refusal('RESOURCE_NOT_FOUND').reason).toBe('notFound');
    expect(refusal('SESSION_EXPIRED').reason).toBe('session');
    expect(refusal('SOMETHING_ELSE').reason).toBe('general');
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined, blockers: 0 });
  });
});
