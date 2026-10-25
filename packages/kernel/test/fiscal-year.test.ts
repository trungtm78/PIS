import { CLOSE_TARGETS, MAX_REOPEN_WINDOW_HOURS, YEAR_STATUSES, closeAllowed, reopenIssues, reopenedUntil } from '../src/fiscal-year';

describe('the rules of closing and reopening a fiscal year (ST-CAP-008)', () => {
  it('lets an open year be soft-closed or locked, a soft-closed year be locked, and nothing else', () => {
    expect(YEAR_STATUSES).toEqual(['OPEN', 'SOFT_CLOSED', 'LOCKED']);
    expect(CLOSE_TARGETS).toEqual(['SOFT_CLOSED', 'LOCKED']);
    expect(closeAllowed('OPEN', 'SOFT_CLOSED')).toBe(true);
    expect(closeAllowed('OPEN', 'LOCKED')).toBe(true);
    expect(closeAllowed('SOFT_CLOSED', 'LOCKED')).toBe(true);
    expect(closeAllowed('SOFT_CLOSED', 'SOFT_CLOSED')).toBe(false);
    expect(closeAllowed('LOCKED', 'LOCKED')).toBe(false);
    expect(closeAllowed('LOCKED', 'SOFT_CLOSED')).toBe(false);
  });

  it('asks a reason of 20 to 2000 characters and a window of 1 to 168 whole hours to reopen', () => {
    const reason = 'The audit found a mistake in the allocation of 2025';
    expect(reopenIssues({ reason, windowHours: 24 })).toEqual([]);
    expect(reopenIssues({ reason, windowHours: 1 })).toEqual([]);
    expect(reopenIssues({ reason, windowHours: MAX_REOPEN_WINDOW_HOURS })).toEqual([]);
    expect(reopenIssues({ reason: 'too short', windowHours: 24 })).toEqual([{ field: 'reason', reason: 'REASON_LENGTH' }]);
    expect(reopenIssues({ reason: ' '.repeat(40), windowHours: 24 })).toEqual([{ field: 'reason', reason: 'REASON_LENGTH' }]);
    expect(reopenIssues({ reason: 'x'.repeat(2001), windowHours: 24 })).toEqual([{ field: 'reason', reason: 'REASON_LENGTH' }]);
    for (const windowHours of [0, -1, 169, 1.5, Number.NaN]) expect(reopenIssues({ reason, windowHours })).toEqual([{ field: 'window_hours', reason: 'WINDOW_INVALID' }]);
    expect(reopenIssues({ reason: 'no', windowHours: 0 }).map((issue) => issue.field)).toEqual(['reason', 'window_hours']);
  });

  it('ends a reopening the number of hours after it starts', () => {
    expect(reopenedUntil(new Date('2026-02-01T00:00:00Z'), 24).toISOString()).toBe('2026-02-02T00:00:00.000Z');
    expect(reopenedUntil(new Date('2026-02-01T10:30:00Z'), 168).toISOString()).toBe('2026-02-08T10:30:00.000Z');
  });
});
