import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { FIRST_YEAR, LAST_YEAR, countsOf, describeProblem, generateBody, hasPassed, movesOf, periodsOf, toPeriod, validateReason, validateYear, vietnamMoment, yearsOf } from './model';
import type { PeriodView } from './model';
import { FUTURE_DEADLINE, PAST_DEADLINE, period } from './test-support';

const view = (n: number, overrides: Record<string, unknown> = {}): PeriodView => toPeriod(period(n, overrides)) as PeriodView;
const problem = (code: string, detail?: string): ApiError => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const NOW = Date.parse('2026-10-24T00:00:00Z');

describe('toPeriod', () => {
  it('reads a period of the answer, with its history of reopening', () => {
    const read = toPeriod(
      period(40, {
        status: 'LOCKED',
        soft_closed_at: '2026-10-02T03:05:00.000Z',
        locked_at: '2026-10-02T03:10:00.000Z',
        version: 3,
        calendar_version: 2,
        reopens: [{ id: 'r1', scope_kind: 'PROJECTS', status: 'APPROVED', window_until: '2026-10-05T03:00:00.000Z', requested_at: '2026-10-03T01:00:00.000Z' }],
      }),
    );
    expect(read).toMatchObject({ code: expect.stringMatching(/-40$/), status: 'LOCKED', softClosedAt: '2026-10-02T03:05:00.000Z', lockedAt: '2026-10-02T03:10:00.000Z', version: 3, calendarRevision: 2 });
    expect(read?.reopens).toEqual([{ id: 'r1', scopeKind: 'PROJECTS', status: 'APPROVED', windowUntil: '2026-10-05T03:00:00.000Z', requestedAt: '2026-10-03T01:00:00.000Z' }]);
  });

  it('drops a row that does not have the shape, and a reopening that does not have it', () => {
    expect(toPeriod(null)).toBeUndefined();
    expect(toPeriod([])).toBeUndefined();
    expect(toPeriod({ ...period(1), status: 'CLOSED' })).toBeUndefined();
    expect(toPeriod({ ...period(1), version: '1' })).toBeUndefined();
    expect(toPeriod({ ...period(1), deadline_at: undefined })).toBeUndefined();
    expect(toPeriod({ ...period(1), reopens: [null, { id: 'x' }, { id: 'r', scope_kind: 'PERIOD', status: 'EXPIRED', requested_at: 'later' }] })?.reopens).toEqual([
      { id: 'r', scopeKind: 'PERIOD', status: 'EXPIRED', windowUntil: null, requestedAt: 'later' },
    ]);
    expect(toPeriod({ ...period(1), reopens: 'none' })?.reopens).toEqual([]);
  });
});

describe('time', () => {
  it('shows an instant in Vietnam time and leaves what is not an instant as it came', () => {
    expect(vietnamMoment('2026-10-02T03:00:00.000Z')).toBe('2026-10-02 10:00');
    expect(vietnamMoment('2026-12-31T17:30:00.000Z')).toBe('2027-01-01 00:30');
    expect(vietnamMoment('soon')).toBe('soon');
  });

  it('says a deadline has passed from the deadline itself', () => {
    expect(hasPassed(view(1, { deadline_at: '2026-10-02T03:00:00.000Z' }), Date.parse('2026-10-02T02:59:59Z'))).toBe(false);
    expect(hasPassed(view(1, { deadline_at: '2026-10-02T03:00:00.000Z' }), Date.parse('2026-10-02T03:00:00Z'))).toBe(true);
  });
});

describe('movesOf', () => {
  const manager = { manage: true, lock: true };
  it('offers a soft close for an open period past its deadline and a lock for a soft-closed one', () => {
    expect(movesOf(view(1, { deadline_at: PAST_DEADLINE }), manager, NOW)).toEqual(['softClose']);
    expect(movesOf(view(1, { status: 'SOFT_CLOSED', soft_closed_at: PAST_DEADLINE }), manager, NOW)).toEqual(['lock']);
  });

  it('offers nothing for a period that is not due, a locked one, or a caller without the permission of the move', () => {
    expect(movesOf(view(1, { deadline_at: FUTURE_DEADLINE }), manager, NOW)).toEqual([]);
    expect(movesOf(view(1, { status: 'LOCKED', locked_at: PAST_DEADLINE }), manager, NOW)).toEqual([]);
    expect(movesOf(view(1), { manage: false, lock: true }, NOW)).toEqual([]);
    expect(movesOf(view(1, { status: 'SOFT_CLOSED' }), { manage: true, lock: false }, NOW)).toEqual([]);
    expect(movesOf(view(1), { manage: false, lock: false }, NOW)).toEqual([]);
  });
});

describe('the list', () => {
  const periods = [view(2, { fiscal_year: 2026, start_date: '2026-01-10' }), view(1, { fiscal_year: 2026, start_date: '2026-01-03', status: 'LOCKED', locked_at: PAST_DEADLINE }), view(3, { fiscal_year: 2027, start_date: '2027-01-02', status: 'SOFT_CLOSED' })];

  it('lists the years latest first and always the current one', () => {
    expect(yearsOf(periods, 2026)).toEqual([2027, 2026]);
    expect(yearsOf([], 2026)).toEqual([2026]);
    expect(yearsOf(periods, 2030)).toEqual([2030, 2027, 2026]);
  });

  it('keeps the periods of a year in calendar order and filters by status', () => {
    expect(periodsOf(periods, 2026, '').map((item) => item.startDate)).toEqual(['2026-01-03', '2026-01-10']);
    expect(periodsOf(periods, 2026, 'LOCKED').map((item) => item.status)).toEqual(['LOCKED']);
    expect(periodsOf(periods, 2028, '')).toEqual([]);
    expect(periodsOf([view(1, { start_date: '2026-01-03' }), view(2, { start_date: '2026-01-03' })], 2026, '')).toHaveLength(2);
  });

  it('counts the periods of a year by status', () => {
    expect(countsOf(periods, 2026)).toEqual({ OPEN: 1, SOFT_CLOSED: 0, LOCKED: 1 });
    expect(countsOf(periods, 2027)).toEqual({ OPEN: 0, SOFT_CLOSED: 1, LOCKED: 0 });
  });
});

describe('forms', () => {
  it('asks for a reason of five to 2000 characters, trimmed', () => {
    expect(validateReason('   ')).toBe('required');
    expect(validateReason(' abcd ')).toBe('tooShort');
    expect(validateReason(' abcde ')).toBeUndefined();
    expect(validateReason('x'.repeat(2000))).toBeUndefined();
    expect(validateReason('x'.repeat(2001))).toBe('tooLong');
  });

  it('asks for a four-digit year within the years the calendar is kept for', () => {
    expect(validateYear('')).toBe('required');
    expect(validateYear('27')).toBe('invalidYear');
    expect(validateYear('20x7')).toBe('invalidYear');
    expect(validateYear(String(FIRST_YEAR - 1))).toBe('invalidYear');
    expect(validateYear(String(LAST_YEAR + 1))).toBe('invalidYear');
    expect(validateYear(' 2027 ')).toBeUndefined();
    expect(generateBody(2027)).toEqual({ calendar_code: 'DEFAULT', fiscal_year: 2027, period_type: 'WEEK' });
  });
});

describe('describeProblem', () => {
  it('maps the refusals of the commands to what the screen says', () => {
    expect(describeProblem(problem('PERIOD_OVERLAP'))).toBe('overlap');
    expect(describeProblem(problem('CALENDAR_NOT_EFFECTIVE'))).toBe('noCalendar');
    expect(describeProblem(problem('PERIOD_STATE_INVALID', 'status'))).toBe('stateInvalid');
    expect(describeProblem(problem('PERIOD_STATE_INVALID', 'deadline_at'))).toBe('beforeDeadline');
    expect(describeProblem(problem('VERSION_CONFLICT'))).toBe('versionConflict');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND'))).toBe('notFound');
    expect(describeProblem(problem('VALIDATION_FAILED'))).toBe('validation');
    expect(describeProblem(problem('FIELD_NOT_ALLOWED'))).toBe('validation');
    expect(describeProblem(problem('SCOPE_DENIED'))).toBe('denied');
    expect(describeProblem(problem('SOMETHING_ELSE'))).toBe('general');
    expect(describeProblem(new Error('network'))).toBe('general');
  });
});
