import { DomainError } from '../src/errors';
import {
  RETURN_REASON_DEFAULTS,
  clockDueAt,
  clockKindOf,
  judgePaymentClock,
  judgeReturnReason,
  paymentClockDefaults,
  paymentClockParams,
  returnReasonParams,
  summariseClocks,
  workingMinutesPerDay,
} from '../src/pay-clock';
import type { ReasonCatalogue } from '../src/pay-clock';
import { singleYear } from '../src/working-time';

const calendar = singleYear({ calendar_code: 'WORKDAY_VN', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-12', name: 'Test holiday' }], legal_basis_ref: 'test' });
const at = (text: string): Date => new Date(text);
const catalogue: ReasonCatalogue = new Map(Object.entries(RETURN_REASON_DEFAULTS));

describe('the payment clock of the Treasury control (G1-17)', () => {
  it('counts 2 working days for a payment and 1 for an advance on the published calendar', () => {
    // Monday 9 Nov 2026 10:00 +07: two working days of 8 hours end on Wednesday 11 Nov 10:00 (360 minutes on Monday, 480 on Tuesday, 120 on Wednesday).
    const payment = clockDueAt(calendar, at('2026-11-09T10:00:00+07:00'), paymentClockDefaults('PAYMENT').working_days);
    expect(payment.basis).toBe('WORKING_TIME');
    expect(payment.dueAt?.toISOString()).toBe(at('2026-11-11T10:00:00+07:00').toISOString());
    const advance = clockDueAt(calendar, at('2026-11-09T10:00:00+07:00'), paymentClockDefaults('ADVANCE').working_days);
    expect(advance.dueAt?.toISOString()).toBe(at('2026-11-10T10:00:00+07:00').toISOString());
  });

  it('skips the weekend and a holiday', () => {
    // Wednesday 11 Nov 10:00, 2 days: Thursday 12 Nov is a holiday and 14-15 Nov is a weekend, so the end is Monday 16 Nov 10:00.
    const due = clockDueAt(calendar, at('2026-11-11T10:00:00+07:00'), 2);
    expect(due.dueAt?.toISOString()).toBe(at('2026-11-16T10:00:00+07:00').toISOString());
  });

  it('a dossier received outside working hours starts at the next opening', () => {
    const due = clockDueAt(calendar, at('2026-11-07T10:00:00+07:00'), 1);
    expect(due.dueAt?.toISOString()).toBe(at('2026-11-09T17:00:00+07:00').toISOString());
  });

  it('never guesses a day when the calendar of a year is missing', () => {
    expect(clockDueAt(undefined, at('2026-11-09T10:00:00+07:00'), 2)).toEqual({ dueAt: null, basis: 'CALENDAR_UNAVAILABLE' });
    // 30 Dec 2026 + 2 days runs into 2027, which this calendar does not cover.
    expect(clockDueAt(calendar, at('2026-12-30T10:00:00+07:00'), 2)).toEqual({ dueAt: null, basis: 'CALENDAR_UNAVAILABLE' });
  });

  it('a working day of the default window is eight hours', () => {
    expect(workingMinutesPerDay()).toBe(480);
  });

  it('judges running, near, breached, met, met late and returned', () => {
    const base = { startedAt: at('2026-11-09T10:00:00+07:00'), dueAt: null, workingDays: 2, nearWorkingHours: 8, calendars: calendar, endedAt: null, endKind: null } as const;
    expect(judgePaymentClock({ ...base, now: at('2026-11-09T11:00:00+07:00') })).toMatchObject({ state: 'RUNNING', basis: 'WORKING_TIME' });
    expect(judgePaymentClock({ ...base, now: at('2026-11-10T16:00:00+07:00') }).state).toBe('NEAR');
    const breached = judgePaymentClock({ ...base, now: at('2026-11-11T15:00:00+07:00') });
    expect(breached).toMatchObject({ state: 'BREACHED', workingMinutesLeft: 0, workingMinutesLate: 240 });
    expect(judgePaymentClock({ ...base, now: at('2026-11-20T10:00:00+07:00'), endedAt: at('2026-11-10T12:00:00+07:00'), endKind: 'SETTLED' }).state).toBe('MET');
    expect(judgePaymentClock({ ...base, now: at('2026-11-20T10:00:00+07:00'), endedAt: at('2026-11-12T09:00:00+07:00'), endKind: 'SETTLED' }).state).toBe('MET_LATE');
    expect(judgePaymentClock({ ...base, now: at('2026-11-20T10:00:00+07:00'), endedAt: at('2026-11-10T12:00:00+07:00'), endKind: 'RETURNED' }).state).toBe('RETURNED');
    expect(judgePaymentClock({ ...base, now: at('2026-11-20T10:00:00+07:00'), endedAt: at('2026-11-16T12:00:00+07:00'), endKind: 'RETURNED' }).state).toBe('RETURNED_LATE');
  });

  it('keeps the instant it was given and says so when no calendar is available now', () => {
    const due = at('2026-11-11T10:00:00+07:00');
    const kept = judgePaymentClock({ startedAt: at('2026-11-09T10:00:00+07:00'), dueAt: due, workingDays: 2, nearWorkingHours: 8, now: at('2026-11-11T12:00:00+07:00'), endedAt: null, endKind: null, calendars: undefined });
    expect(kept).toMatchObject({ state: 'BREACHED', workingMinutesLeft: 0 });
    const none = judgePaymentClock({ startedAt: at('2026-11-09T10:00:00+07:00'), dueAt: null, workingDays: 2, nearWorkingHours: 8, now: at('2026-11-11T12:00:00+07:00'), endedAt: null, endKind: null, calendars: undefined });
    expect(none).toMatchObject({ state: 'RUNNING', basis: 'CALENDAR_UNAVAILABLE', dueAt: null });
  });

  it('chooses the clock by the kind of request', () => {
    expect(clockKindOf('ADVANCE')).toBe('ADVANCE');
    expect(clockKindOf('INTERIM')).toBe('PAYMENT');
    expect(clockKindOf('FINAL')).toBe('PAYMENT');
  });
});

describe('the policy of the clock and the standard return reasons (G1-17)', () => {
  it('reads the defaults back through its own parser', () => {
    expect(paymentClockParams(paymentClockDefaults('PAYMENT'))).toEqual({ working_days: 2, near_working_hours: 8, reason_code_required: true });
    expect(paymentClockParams(paymentClockDefaults('ADVANCE')).working_days).toBe(1);
    expect(() => paymentClockParams({ working_days: 0, near_working_hours: 8, reason_code_required: true })).toThrow(DomainError);
    expect(() => paymentClockParams({ working_days: 2, near_working_hours: 8 })).toThrow(DomainError);
    for (const params of Object.values(RETURN_REASON_DEFAULTS)) expect(returnReasonParams(params)).toEqual(params);
    expect(() => returnReasonParams({ category: 'NOPE', requires_note: false, owner_side: 'INVESTOR', active: true })).toThrow(DomainError);
  });

  it('requires a known, active code when the policy says so', () => {
    expect(judgeReturnReason({ reasonCode: 'MISSING_DOCUMENT', note: 'Invoice missing', catalogue, required: true })).toBe('MISSING_DOCUMENT');
    expect(() => judgeReturnReason({ reasonCode: undefined, note: 'x', catalogue, required: true })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'reason_code' }));
    expect(judgeReturnReason({ reasonCode: undefined, note: 'x', catalogue, required: false })).toBeNull();
    expect(() => judgeReturnReason({ reasonCode: 'NOT_A_REASON', note: 'x', catalogue, required: false })).toThrow(expect.objectContaining({ detail: 'reason_code' }));
    expect(() => judgeReturnReason({ reasonCode: 'lower', note: 'x', catalogue, required: false })).toThrow(DomainError);
    const retired: ReasonCatalogue = new Map([['MISSING_DOCUMENT', { ...RETURN_REASON_DEFAULTS.MISSING_DOCUMENT!, active: false }]]);
    expect(() => judgeReturnReason({ reasonCode: 'MISSING_DOCUMENT', note: 'x', catalogue: retired, required: true })).toThrow(DomainError);
  });

  it('asks for a note of ten characters where the reason asks for it', () => {
    expect(() => judgeReturnReason({ reasonCode: 'OTHER', note: 'short', catalogue, required: true })).toThrow(expect.objectContaining({ detail: 'reason' }));
    expect(judgeReturnReason({ reasonCode: 'OTHER', note: 'Explained at length', catalogue, required: true })).toBe('OTHER');
    expect(() => judgeReturnReason({ reasonCode: 'WRONG_AMOUNT', note: '   ', catalogue, required: true })).toThrow(DomainError);
  });
});

describe('what the board adds up (G1-17)', () => {
  it('counts from the rows, with returns by reason and the in-time rate of those that ended', () => {
    const summary = summariseClocks([
      { kind: 'PAYMENT', state: 'RUNNING', returnReasonCode: null },
      { kind: 'PAYMENT', state: 'NEAR', returnReasonCode: null },
      { kind: 'ADVANCE', state: 'BREACHED', returnReasonCode: null },
      { kind: 'PAYMENT', state: 'MET', returnReasonCode: null },
      { kind: 'PAYMENT', state: 'MET_LATE', returnReasonCode: null },
      { kind: 'PAYMENT', state: 'RETURNED', returnReasonCode: 'WRONG_AMOUNT' },
      { kind: 'PAYMENT', state: 'RETURNED_LATE', returnReasonCode: 'WRONG_AMOUNT' },
      { kind: 'ADVANCE', state: 'RETURNED', returnReasonCode: null },
    ]);
    expect(summary).toMatchObject({ total: 8, open: 3, breached: 1, near: 1, returned: 3, inTimeRatePct: '60.0' });
    expect(summary.returnsByReason).toEqual([
      { reasonCode: 'WRONG_AMOUNT', count: 2 },
      { reasonCode: null, count: 1 },
    ]);
  });

  it('has no rate when nothing ended', () => {
    expect(summariseClocks([{ kind: 'PAYMENT', state: 'RUNNING', returnReasonCode: null }]).inTimeRatePct).toBeNull();
    expect(summariseClocks([])).toMatchObject({ total: 0, inTimeRatePct: null });
  });
});
