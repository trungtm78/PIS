import { assertLimits, dayStartVn, deliveredRate, isPaidChannel, judgeLimits, meterOfChannel, monthStartVn, nextDayStartVn, nextMonthStartVn } from '../src/channel-limits';

const refusal = (run: () => unknown): { code: string; detail: string | undefined } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string };
    return { code: known.code, detail: known.detail };
  }
  throw new Error('it was allowed');
};
const NOW = new Date('2026-10-30T10:00:00.000Z'); // 17:00 in Vietnam

describe('the limits of a channel account (ST-NOT-010, BR-NOT-13)', () => {
  it('takes a daily cap of 1 to ten million and a budget as a whole number of VND, null takes a limit off, and an empty change is refused', () => {
    expect(assertLimits({ daily_send_cap: 500, monthly_budget_vnd: '1000000' })).toEqual({ dailySendCap: 500, monthlyBudgetVnd: '1000000' });
    expect(assertLimits({ daily_send_cap: null })).toEqual({ dailySendCap: null });
    expect(assertLimits({ monthly_budget_vnd: '000120' })).toEqual({ monthlyBudgetVnd: '120' });
    // A limit comes off with its own flag, and a value beside the flag of the same limit is a contradiction.
    expect(assertLimits({ clear_daily_send_cap: true, monthly_budget_vnd: '5' })).toEqual({ dailySendCap: null, monthlyBudgetVnd: '5' });
    expect(assertLimits({ clear_monthly_budget: true })).toEqual({ monthlyBudgetVnd: null });
    expect(assertLimits({ clear_monthly_budget: false, daily_send_cap: 3 })).toEqual({ dailySendCap: 3 });
    expect(refusal(() => assertLimits({ clear_daily_send_cap: true, daily_send_cap: 5 })).detail).toBe('clear_daily_send_cap');
    expect(refusal(() => assertLimits({ clear_monthly_budget: true, monthly_budget_vnd: '5' })).detail).toBe('clear_monthly_budget');
    expect(refusal(() => assertLimits({ clear_daily_send_cap: false }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'daily_send_cap' });
    expect(refusal(() => assertLimits({}))).toEqual({ code: 'VALIDATION_FAILED', detail: 'daily_send_cap' });
    for (const bad of [0, -1, 1.5, '5', 10_000_001]) expect(refusal(() => assertLimits({ daily_send_cap: bad })).detail).toBe('daily_send_cap');
    for (const bad of ['-5', '1.5', 'abc', '', 1000, '1'.repeat(16)]) expect(refusal(() => assertLimits({ monthly_budget_vnd: bad })).detail).toBe('monthly_budget_vnd');
  });

  it('knows which channels cost money and the meter a send is counted under', () => {
    expect(['EMAIL', 'SMS', 'PUSH_FCM', 'ZALO_ZNS', 'WHATSAPP', 'NOPE'].map(isPaidChannel)).toEqual([false, true, false, true, true, false]);
    expect([meterOfChannel('ZALO_ZNS'), meterOfChannel('SMS'), meterOfChannel('EMAIL'), meterOfChannel('PUSH_FCM')]).toEqual(['notification.zns', 'notification.sms', 'notification.email', undefined]);
  });

  it('cuts the day and the month at midnight in Vietnam, not in UTC', () => {
    expect(dayStartVn(NOW).toISOString()).toBe('2026-10-29T17:00:00.000Z');
    expect(nextDayStartVn(NOW).toISOString()).toBe('2026-10-30T17:00:00.000Z');
    expect(monthStartVn(NOW).toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(nextMonthStartVn(NOW).toISOString()).toBe('2026-10-31T17:00:00.000Z');
    // 18:00 UTC on the 31st is already November 1st in Vietnam.
    const late = new Date('2026-10-31T18:00:00.000Z');
    expect(monthStartVn(late).toISOString()).toBe('2026-10-31T17:00:00.000Z');
    expect(nextMonthStartVn(new Date('2026-12-15T00:00:00.000Z')).toISOString()).toBe('2026-12-31T17:00:00.000Z');
  });

  it('holds an ordinary message that would take the account over its budget until next month, and lets a CRITICAL one go (UAT-AC191)', () => {
    const limits = { dailySendCap: null, monthlyBudgetVnd: 1_000_000n };
    const use = { sentToday: 3, spentThisMonthVnd: 999_900n };
    // 999,900 + 300 (a ZNS message) is over 1,000,000: held. Exactly the budget is not over it.
    expect(judgeLimits({ limits, use, channel: 'ZALO_ZNS', priority: 'NORMAL', now: NOW }).kind).toBe('HOLD');
    expect(judgeLimits({ limits, use: { sentToday: 3, spentThisMonthVnd: 999_700n }, channel: 'ZALO_ZNS', priority: 'NORMAL', now: NOW })).toEqual({ kind: 'WITHIN' });
    const held = judgeLimits({ limits, use: { sentToday: 3, spentThisMonthVnd: 999_900n }, channel: 'SMS', priority: 'NORMAL', now: NOW });
    expect(held).toEqual({ kind: 'HOLD', until: new Date('2026-10-31T17:00:00.000Z'), code: 'CHANNEL_BUDGET' });
    expect(judgeLimits({ limits, use, channel: 'SMS', priority: 'CRITICAL', now: NOW })).toEqual({ kind: 'WITHIN' });
  });

  it('holds a message over the daily cap until tomorrow, a free channel by the cap only, and CRITICAL never', () => {
    const limits = { dailySendCap: 10, monthlyBudgetVnd: 0n };
    expect(judgeLimits({ limits, use: { sentToday: 9, spentThisMonthVnd: 0n }, channel: 'EMAIL', priority: 'LOW', now: NOW })).toEqual({ kind: 'WITHIN' });
    expect(judgeLimits({ limits, use: { sentToday: 10, spentThisMonthVnd: 0n }, channel: 'EMAIL', priority: 'LOW', now: NOW })).toEqual({ kind: 'HOLD', until: new Date('2026-10-30T17:00:00.000Z'), code: 'CHANNEL_CAP' });
    // A budget of 0 holds the paid channels and not the free ones.
    expect(judgeLimits({ limits, use: { sentToday: 0, spentThisMonthVnd: 0n }, channel: 'SMS', priority: 'NORMAL', now: NOW }).kind).toBe('HOLD');
    expect(judgeLimits({ limits, use: { sentToday: 99, spentThisMonthVnd: 0n }, channel: 'SMS', priority: 'CRITICAL', now: NOW })).toEqual({ kind: 'WITHIN' });
    expect(judgeLimits({ limits: { dailySendCap: null, monthlyBudgetVnd: null }, use: { sentToday: 1e9, spentThisMonthVnd: 1n << 60n }, channel: 'SMS', priority: 'NORMAL', now: NOW })).toEqual({ kind: 'WITHIN' });
  });
});

describe('the delivery rate (BR-NOT-14, UAT-AC193)', () => {
  it('is delivered and read over what ended minus what was suppressed, with the unknown in the denominator and shown apart: 100 attempts, 5 suppressed, 11 unknown, 80 delivered = 84.21 %', () => {
    expect(deliveredRate({ delivered: 70, read: 10, ended: 100, suppressed: 5, unknown: 11 })).toEqual({ rate: 84.21, denominator: 95, unknown: 11 });
  });

  it('has no rate for a period with nothing sent, instead of 0', () => {
    expect(deliveredRate({ delivered: 0, read: 0, ended: 4, suppressed: 4, unknown: 0 })).toEqual({ rate: undefined, denominator: 0, unknown: 0 });
    expect(deliveredRate({ delivered: 0, read: 0, ended: 0, suppressed: 0, unknown: 0 }).rate).toBeUndefined();
    expect(deliveredRate({ delivered: 3, read: 0, ended: 3, suppressed: 0, unknown: 0 }).rate).toBe(100);
  });
});
