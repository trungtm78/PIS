import { DomainError } from './errors.ts';
import { builtInDefault } from './governance-rules.ts';
import {
  EXISTING_CLOCKS,
  activePause,
  clockPolicyDefaults,
  clockPolicyOf,
  evaluatePause,
  evaluateSnooze,
  itemClocks,
  nativeClock,
  reminderPolicyDefaults,
  reminderPolicyOf,
  reminderState,
  snoozePolicyDefaults,
  snoozePolicyOf,
} from './work-clock.ts';
import type { ItemClockInput, PauseSpan } from './work-clock.ts';
import { addWorkingTime, workingMinutesBetween } from './working-time.ts';
import type { WorkCalendarContent, WorkCalendarSource } from './working-time.ts';

const calendar = (year: number, holidays: string[] = []): WorkCalendarContent => ({
  calendar_code: 'WORKDAY_VN',
  year,
  working_days: [1, 2, 3, 4, 5],
  holidays: holidays.map((date) => ({ date, name: 'Holiday' })),
  legal_basis_ref: 'Labour Code 2019',
});
const SOURCE: WorkCalendarSource = { forYear: (year) => (year === 2027 ? calendar(2027, ['2027-10-20']) : undefined) };
// 2027-10-15 is a Friday; 10:00 Vietnam time is 03:00 UTC.
const FRI_10 = new Date('2027-10-15T03:00:00Z');
const at = (iso: string): Date => new Date(iso);

describe('the snooze rules (G2-1)', () => {
  const policy = snoozePolicyDefaults();
  const base = { now: FRI_10, until: at('2027-10-16T03:00:00Z'), reasonCode: 'WAITING_INFORMATION', note: undefined, dueOn: null, consecutive: 0 } as const;

  it('allows a Cần xử lý item for 3 days and a Theo dõi item for 14, never a Khẩn one', () => {
    expect(evaluateSnooze(policy, { ...base, severity: 'ACTION', until: at('2027-10-18T03:00:00Z') })).toMatchObject({ ok: true, ordinal: 1, final: false, maxDays: 3 });
    expect(evaluateSnooze(policy, { ...base, severity: 'ACTION', until: at('2027-10-18T03:00:01Z') })).toMatchObject({ ok: false, code: 'WORK_SNOOZE_TOO_LONG' });
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', until: at('2027-10-29T03:00:00Z') })).toMatchObject({ ok: true, maxDays: 14 });
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', until: at('2027-10-29T03:00:01Z') })).toMatchObject({ ok: false, code: 'WORK_SNOOZE_TOO_LONG' });
    expect(evaluateSnooze(policy, { ...base, severity: 'URGENT' })).toEqual({ ok: false, code: 'WORK_SNOOZE_NOT_ALLOWED', field: 'severity' });
  });

  it('allows two in a row, marks the second as the last and refuses a third', () => {
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', consecutive: 1 })).toMatchObject({ ok: true, ordinal: 2, final: true });
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', consecutive: 2 })).toEqual({ ok: false, code: 'WORK_SNOOZE_LIMIT', field: 'snooze_until' });
  });

  it('keeps the day the module says the item is due on', () => {
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', dueOn: '2027-10-15' })).toEqual({ ok: false, code: 'WORK_SNOOZE_NOT_ALLOWED', field: 'snooze_until' });
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', dueOn: '2027-10-16' })).toMatchObject({ ok: true });
  });

  it('needs a reason from the list, and words for "other"', () => {
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', reasonCode: undefined })).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason_code' });
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', reasonCode: 'BECAUSE' })).toMatchObject({ ok: false, field: 'reason_code' });
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', reasonCode: 'OTHER' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' });
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', reasonCode: 'OTHER', note: ' abc ' })).toMatchObject({ ok: false, field: 'reason' });
    expect(evaluateSnooze(policy, { ...base, severity: 'WATCH', reasonCode: 'OTHER', note: 'Waiting for the bank letter' })).toMatchObject({ ok: true });
  });

  it('reads a rule that is complete and refuses one that is not', () => {
    expect(snoozePolicyOf(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
    expect(() => snoozePolicyOf({ ...policy, max_days_by_severity: { URGENT: 1, ACTION: 3, WATCH: 14 } })).toThrow(DomainError);
    expect(() => snoozePolicyOf({ ...policy, max_consecutive: 0 })).toThrow(DomainError);
    expect(() => snoozePolicyOf({ ...policy, reasons: [] })).toThrow(DomainError);
    expect(() => snoozePolicyOf(null)).toThrow(DomainError);
  });
});

describe('workingMinutesBetween', () => {
  it('counts the working time of a span and is the inverse of addWorkingTime', () => {
    // Friday 10:00 to Monday 09:00: 2 h Friday morning + 4 h Friday afternoon + 1 h Monday = 7 h.
    expect(workingMinutesBetween(SOURCE, FRI_10, at('2027-10-18T02:00:00Z'))).toBe(7 * 60);
    expect(addWorkingTime(SOURCE, FRI_10, { minutes: 7 * 60 })).toEqual(at('2027-10-18T02:00:00Z'));
    expect(workingMinutesBetween(SOURCE, FRI_10, FRI_10)).toBe(0);
    expect(workingMinutesBetween(SOURCE, at('2027-10-16T03:00:00Z'), at('2027-10-17T10:00:00Z'))).toBe(0);
    // A holiday (Wednesday 20 October) is skipped.
    expect(workingMinutesBetween(SOURCE, at('2027-10-20T01:00:00Z'), at('2027-10-21T01:00:00Z'))).toBe(0);
  });

  it('refuses a year without a calendar', () => {
    expect(() => workingMinutesBetween(SOURCE, at('2027-12-31T03:00:00Z'), at('2028-01-03T03:00:00Z'))).toThrow(DomainError);
  });
});

describe('the clocks of an item (G2-2)', () => {
  const policy = clockPolicyDefaults();
  const input = (over: Partial<ItemClockInput> = {}): ItemClockInput => ({
    severity: 'ACTION',
    now: FRI_10,
    startedAt: at('2027-10-14T03:00:00Z'),
    dueOn: null,
    firstClaimAt: null,
    lastClaimAt: null,
    lifecycle: 'NEW',
    pauses: [],
    policy,
    calendars: SOURCE,
    ...over,
  });
  const pause = (over: Partial<PauseSpan> = {}): PauseSpan => ({
    from: '2027-10-14T04:00:00.000Z',
    until: '2027-10-14T10:00:00.000Z',
    resumedAt: null,
    reasonCode: 'WAITING_EXTERNAL_PARTY',
    reason: 'Waiting for the answer of the bank',
    allowedBy: { id: 'a', name: 'A' },
    by: { id: 'b', name: 'B' },
    ...over,
  });

  it('runs the claim clock in working hours from the start: a Cần xử lý item started Thursday 10:00 must be taken up by Friday 10:00', () => {
    const clocks = itemClocks(input({ now: at('2027-10-15T01:00:00Z') }));
    expect(clocks.basis).toBe('WORKING_TIME');
    expect(clocks.claim).toEqual({ state: 'RUNNING', started_at: '2027-10-14T03:00:00.000Z', due_at: '2027-10-15T03:00:00.000Z', met_at: null });
    expect(itemClocks(input({ now: at('2027-10-15T03:00:01Z') })).claim?.state).toBe('BREACHED');
  });

  it('meets the claim clock when somebody takes the item up, late or in time, and when the module says it was taken up', () => {
    expect(itemClocks(input({ firstClaimAt: at('2027-10-14T08:00:00Z'), lastClaimAt: at('2027-10-14T08:00:00Z'), lifecycle: 'CLAIMED' })).claim).toMatchObject({ state: 'MET', met_at: '2027-10-14T08:00:00.000Z' });
    expect(itemClocks(input({ firstClaimAt: at('2027-10-15T08:00:00Z'), lifecycle: 'CLAIMED' })).claim?.state).toBe('MET_LATE');
    expect(itemClocks(input({ lifecycle: 'IN_PROGRESS' })).claim).toMatchObject({ state: 'MET', met_at: null });
  });

  it('uses the due day of the module for the resolve clock and the policy hours when there is none', () => {
    expect(itemClocks(input({ dueOn: '2027-10-14' })).resolve).toMatchObject({ state: 'BREACHED', due_at: '2027-10-14T16:59:59.000Z' });
    expect(itemClocks(input({ dueOn: '2027-10-15' })).resolve?.state).toBe('RUNNING');
    // 40 working hours from Thursday 10:00: Thursday 6 h, Friday 8 h, Monday 8 h, Tuesday 8 h, (Wednesday 20 October is a holiday) Thursday 8 h, 2 h on Friday 22nd.
    expect(itemClocks(input()).resolve).toMatchObject({ state: 'RUNNING', due_at: '2027-10-22T03:00:00.000Z' });
    expect(itemClocks(input({ lifecycle: 'RESOLVED' })).resolve?.state).toBe('MET');
  });

  it('stops the clock while it is paused and moves the end of the claim clock by the working time paused', () => {
    const running = itemClocks(input({ now: at('2027-10-14T05:00:00Z'), pauses: [pause()] }));
    expect(running.paused?.reasonCode).toBe('WAITING_EXTERNAL_PARTY');
    expect(running.claim?.state).toBe('PAUSED');
    // The pause took 4 working hours (11:00 to 15:00 ... clipped by the lunch break to 11:00-12:00 and 13:00-17:00 is 17:00; the span 11:00-17:00 is 1 + 4 h).
    const after = itemClocks(input({ now: at('2027-10-15T01:00:00Z'), pauses: [pause()] }));
    expect(after.paused).toBeNull();
    expect(after.claim?.due_at).toBe(addWorkingTime(SOURCE, at('2027-10-14T03:00:00Z'), { minutes: 8 * 60 + 5 * 60 }).toISOString());
  });

  it('lets a pause end early, and tells which pause holds', () => {
    const ended = pause({ resumedAt: '2027-10-14T05:00:00.000Z' });
    expect(activePause([ended], at('2027-10-14T06:00:00Z'))).toBeNull();
    expect(activePause([ended], at('2027-10-14T04:30:00Z'))).toBe(ended);
    expect(activePause([ended, pause({ from: '2027-10-14T07:00:00.000Z' })], at('2027-10-14T08:00:00Z'))?.from).toBe('2027-10-14T07:00:00.000Z');
  });

  it('asks for the item to be taken up again when it was taken up and shows no work past the threshold', () => {
    const taken = { firstClaimAt: at('2027-10-13T03:00:00Z'), lastClaimAt: at('2027-10-13T03:00:00Z'), lifecycle: 'CLAIMED' } as const;
    // 24 working hours after Wednesday 10:00: 6 + 8 + 8 = 22 hours by the end of Friday, 2 more on Monday 18th, so Monday 10:00.
    expect(itemClocks(input({ ...taken, now: at('2027-10-18T02:59:00Z') })).needsReclaim).toBeNull();
    expect(itemClocks(input({ ...taken, now: at('2027-10-18T03:01:00Z') })).needsReclaim).toEqual({ since: '2027-10-18T03:00:00.000Z' });
    // Work in the module (or a handover) is a sign of work.
    expect(itemClocks(input({ ...taken, lifecycle: 'IN_PROGRESS', now: at('2027-10-18T03:01:00Z') })).needsReclaim).toBeNull();
    // A pause holds the count.
    expect(itemClocks(input({ ...taken, now: at('2027-10-18T03:01:00Z'), pauses: [pause({ from: '2027-10-14T01:00:00.000Z', until: '2027-10-19T08:00:00.000Z' })] })).needsReclaim).toBeNull();
  });

  it('never guesses: no calendar gives no claim clock, no start gives none either, and the due day of the module stays', () => {
    const none = itemClocks(input({ calendars: undefined, dueOn: '2027-10-16' }));
    expect(none).toMatchObject({ basis: 'CALENDAR_UNAVAILABLE', claim: null, needsReclaim: null });
    expect(none.resolve?.state).toBe('RUNNING');
    expect(itemClocks(input({ startedAt: at('2027-12-31T03:00:00Z'), now: at('2028-01-05T03:00:00Z') })).basis).toBe('CALENDAR_UNAVAILABLE');
    expect(itemClocks(input({ startedAt: null }))).toMatchObject({ basis: 'NO_START', claim: null, resolve: null });
  });
});

describe('pausing a clock', () => {
  const policy = clockPolicyDefaults();
  const ask = { reasonCode: 'LEGAL_OR_AUDIT_HOLD', reason: 'The audit asked to keep it', allowedBy: 'b', actor: 'a', now: FRI_10, until: at('2027-10-20T03:00:00Z') };

  it('needs a reason from the list and in words, another person who allowed it and an end within the policy', () => {
    expect(evaluatePause(policy, ask)).toEqual({ ok: true });
    expect(evaluatePause(policy, { ...ask, reasonCode: 'NO' })).toMatchObject({ ok: false, field: 'reason_code' });
    expect(evaluatePause(policy, { ...ask, reason: 'no' })).toMatchObject({ ok: false, field: 'reason' });
    expect(evaluatePause(policy, { ...ask, allowedBy: undefined })).toMatchObject({ ok: false, field: 'allowed_by_id' });
    expect(evaluatePause(policy, { ...ask, allowedBy: 'A' })).toEqual({ ok: false, code: 'WORK_CLOCK_ALLOWER_INVALID', field: 'allowed_by_id' });
    expect(evaluatePause(policy, { ...ask, until: at('2027-10-14T03:00:00Z') })).toMatchObject({ ok: false, field: 'paused_until' });
    expect(evaluatePause(policy, { ...ask, until: at('2027-12-15T03:00:00Z') })).toEqual({ ok: false, code: 'WORK_CLOCK_PAUSE_TOO_LONG', field: 'paused_until' });
  });

  it('reads a rule that is complete and refuses one that is not', () => {
    expect(clockPolicyOf(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
    expect(() => clockPolicyOf({ ...policy, max_pause_days: 0 })).toThrow(DomainError);
    expect(() => clockPolicyOf({ ...policy, claim_within_working_hours: { URGENT: 2, ACTION: 8 } })).toThrow(DomainError);
  });
});

describe('the reminder cadence (G2-4)', () => {
  const policy = reminderPolicyDefaults();
  const base = { severity: 'ACTION', now: FRI_10, anchorAt: at('2027-10-14T03:00:00Z'), sent: 0, snoozedUntil: null, paused: false, lifecycle: 'NEW', policy, calendars: SOURCE } as const;

  it('reminds an item by the cadence of its severity in working hours', () => {
    // Cần xử lý: every 8 working hours; Thursday 10:00 + 8 h is Friday 10:00 (lunch break included).
    expect(reminderState(base)).toEqual({ due: true, nextAt: '2027-10-15T03:00:00.000Z', exhausted: false, cadenceWorkingHours: 8 });
    expect(reminderState({ ...base, now: at('2027-10-15T02:00:00Z') }).due).toBe(false);
    // Khẩn every 4 hours, Theo dõi every 5 working days.
    expect(reminderState({ ...base, severity: 'URGENT', anchorAt: at('2027-10-15T01:00:00Z') }).nextAt).toBe('2027-10-15T05:00:00.000Z');
    expect(reminderState({ ...base, severity: 'WATCH', anchorAt: at('2027-10-15T01:00:00Z') }).nextAt).toBe('2027-10-22T10:00:00.000Z');
  });

  it('reminds at once when nothing is known to count from, and not at all when resolved, paused, snoozed or out of reminders', () => {
    expect(reminderState({ ...base, anchorAt: null })).toMatchObject({ due: true });
    expect(reminderState({ ...base, lifecycle: 'RESOLVED' })).toMatchObject({ due: false, nextAt: null });
    expect(reminderState({ ...base, paused: true })).toMatchObject({ due: false, nextAt: null });
    expect(reminderState({ ...base, snoozedUntil: at('2027-10-17T03:00:00Z') })).toMatchObject({ due: false, nextAt: '2027-10-17T03:00:00.000Z' });
    expect(reminderState({ ...base, snoozedUntil: at('2027-10-14T03:00:00Z') }).due).toBe(true);
    expect(reminderState({ ...base, sent: policy.max_per_item.ACTION })).toMatchObject({ due: false, exhausted: true });
  });

  it('invents no reminder without a calendar', () => {
    expect(reminderState({ ...base, calendars: undefined })).toMatchObject({ due: false, nextAt: null });
    expect(reminderState({ ...base, anchorAt: at('2027-12-31T03:00:00Z'), now: at('2028-01-10T03:00:00Z') })).toMatchObject({ due: false, nextAt: null });
  });

  it('reads a rule that is complete and refuses one that is not', () => {
    expect(reminderPolicyOf(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
    expect(() => reminderPolicyOf({ every_working_hours: { URGENT: 0, ACTION: 8, WATCH: 40 }, max_per_item: policy.max_per_item })).toThrow(DomainError);
  });
});

describe('the clocks that were there before', () => {
  it('names the five modules that keep a clock and says none of them was moved', () => {
    expect(EXISTING_CLOCKS.map((clock) => clock.code)).toEqual(['DIS-20', 'PAY-12', 'PMT-05', 'ISS-09', 'CTR-05']);
    expect(EXISTING_CLOCKS.every((clock) => !clock.migrated)).toBe(true);
  });
});

describe('a native clock (G0-2)', () => {
  const startedAt = at('2027-10-13T01:00:00Z'); // Wednesday 08:00
  const dueAt = at('2027-10-15T03:00:00Z'); // Friday 10:00
  const base = { startedAt, dueAt, now: at('2027-10-14T03:00:00Z'), pauses: [] as PauseSpan[], calendars: SOURCE, nearWorkingHours: 4 };

  it('runs until the end it was given and is breached after it', () => {
    expect(nativeClock(base)).toMatchObject({ basis: 'WORKING_TIME', resolve: { state: 'RUNNING', due_at: '2027-10-15T03:00:00.000Z' }, near: false });
    expect(nativeClock({ ...base, now: at('2027-10-15T01:00:00Z') })).toMatchObject({ resolve: { state: 'RUNNING' }, near: true });
    expect(nativeClock({ ...base, now: at('2027-10-15T03:00:01Z') })).toMatchObject({ resolve: { state: 'BREACHED' }, near: false });
  });

  it('moves the end by the working time it was paused for, and says it is paused while it is', () => {
    const pause: PauseSpan = { from: '2027-10-14T01:00:00Z', until: '2027-10-14T05:00:00Z', resumedAt: null, reasonCode: 'FORCE_MAJEURE', reason: 'Storm closed the office', allowedBy: null, by: null };
    // Thursday 08:00 to 12:00 is four working hours: the end moves from Friday 10:00 to Friday 15:00 (lunch break included).
    expect(nativeClock({ ...base, now: at('2027-10-14T07:00:00Z'), pauses: [pause] })).toMatchObject({ resolve: { state: 'RUNNING', due_at: '2027-10-15T08:00:00.000Z' } });
    expect(nativeClock({ ...base, now: at('2027-10-14T03:00:00Z'), pauses: [pause] })).toMatchObject({ resolve: { state: 'PAUSED' }, paused: { reasonCode: 'FORCE_MAJEURE' } });
  });

  it('keeps the end it was given and says so when a year has no calendar', () => {
    expect(nativeClock({ ...base, calendars: undefined })).toMatchObject({ basis: 'CALENDAR_UNAVAILABLE', resolve: { due_at: '2027-10-15T03:00:00.000Z' } });
    expect(nativeClock({ ...base, now: at('2028-01-05T03:00:00Z'), pauses: [{ from: '2027-12-30T03:00:00Z', until: '2028-01-04T03:00:00Z', resumedAt: null, reasonCode: 'OTHER', reason: 'Closed over the new year', allowedBy: null, by: null }] })).toMatchObject({ basis: 'CALENDAR_UNAVAILABLE' });
  });
});

describe('the alert type of the clocks (G0-3)', () => {
  it('gives the source CLOCK an owner, an expected action, a consequence and a review day', () => {
    const params = builtInDefault('ALERT_TYPE', 'CLOCK')?.params as Record<string, unknown>;
    expect(params).toMatchObject({ source: 'CLOCK', enabled: true });
    expect(String(params.expected_action).length).toBeGreaterThan(10);
    expect(String(params.consequence).length).toBeGreaterThan(10);
    expect(params.review_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
