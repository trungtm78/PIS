import { builtInDefault, builtInCodes, validateRuleParams } from '../src/governance-rules.ts';
import { MONTHLY_DEADLINE_DAY, monthlyPeriods, periodOfType, quarterlyPeriods, yearlyPeriods } from '../src/reporting-calendar.ts';
import type { CalendarDefinition } from '../src/reporting-calendar.ts';
import {
  BASIS_OF,
  REMINDER_ALERT_TYPES,
  SCHEDULE_CODES,
  SCHEDULE_RULE_TYPE,
  daysOverdue,
  entryDeadline,
  entryOffsetOf,
  localTimeOf,
  meetingPeriod,
  reminderDue,
  scheduleDefaults,
  scheduleDefect,
  schedulePeriods,
  schedulePolicyOf,
  stepDeadlines,
  scheduleStepState,
} from '../src/reporting-schedule.ts';

const CALENDAR: CalendarDefinition = { weekStartsOn: 'MONDAY', deadlineWeekday: 'FRIDAY', deadlineTime: '10:00', timezone: 'Asia/Ho_Chi_Minh' };
const NONE = { BEFORE_DUE: [], OVERDUE: [], ESCALATED: [] } as const;
const policyOf = (code: (typeof SCHEDULE_CODES)[number]) => schedulePolicyOf(scheduleDefaults(code));
const DAY = 86_400_000;

describe('the reporting schedule rule (QT.02)', () => {
  it('is a registered governance rule type with a built-in default for each kind of period, all unconfirmed', () => {
    expect(builtInCodes(SCHEDULE_RULE_TYPE)).toEqual([...SCHEDULE_CODES]);
    for (const code of SCHEDULE_CODES) {
      const found = builtInDefault(SCHEDULE_RULE_TYPE, code);
      expect(found?.unverified).toBe(true);
      expect(scheduleDefect(found?.params as Record<string, unknown>)).toBeUndefined();
    }
  });

  it('keeps the monthly entry deadline of the constant it replaces: the 5th of the next month at the time of the calendar', () => {
    const policy = policyOf('MONTH');
    expect(entryOffsetOf(policy)).toBe(MONTHLY_DEADLINE_DAY);
    for (const period of monthlyPeriods(CALENDAR, 2027)) {
      expect(entryDeadline(policy, period, CALENDAR.deadlineTime)).toBe(period.deadlineAt);
      expect(monthlyPeriods(CALENDAR, 2027, entryOffsetOf(policy))[0]?.deadlineAt).toBe(monthlyPeriods(CALENDAR, 2027)[0]?.deadlineAt);
    }
  });

  it('moves the deadline of the period when the entry offset changes, and the other kinds of period follow the same arithmetic', () => {
    expect(monthlyPeriods(CALENDAR, 2027, 8)[8]?.deadlineAt).toBe('2027-10-08T03:00:00.000Z');
    expect(periodOfType(CALENDAR, 'MONTH', '2027-09-12', 8).deadlineAt).toBe('2027-10-08T03:00:00.000Z');
    expect(quarterlyPeriods(CALENDAR, 2027).map((period) => period.code)).toEqual(['Q2027-1', 'Q2027-2', 'Q2027-3', 'Q2027-4']);
    expect(quarterlyPeriods(CALENDAR, 2027)[3]?.deadlineAt).toBe('2028-01-10T03:00:00.000Z');
    expect(yearlyPeriods(CALENDAR, 2027)[0]).toMatchObject({ code: 'Y2027', startsOn: '2027-01-01', endsOn: '2027-12-31', deadlineAt: '2028-01-20T03:00:00.000Z' });
    expect(periodOfType(CALENDAR, 'QUARTER', '2027-05-17').code).toBe('Q2027-2');
    expect(periodOfType(CALENDAR, 'YEAR', '2027-05-17').code).toBe('Y2027');
  });

  it('lists the periods of a year with no gap and no overlap, and a meeting as the day it was held', () => {
    for (const basis of ['MONTH', 'QUARTER', 'YEAR'] as const) {
      const periods = schedulePeriods(basis, 2028);
      expect(periods[0]?.startsOn).toBe('2028-01-01');
      expect(periods[periods.length - 1]?.endsOn).toBe('2028-12-31');
      periods.slice(1).forEach((period, at) => expect(Date.parse(period.startsOn) - Date.parse((periods[at] as { endsOn: string }).endsOn)).toBe(DAY));
    }
    expect(schedulePeriods('MONTH', 2028)[1]).toMatchObject({ code: 'M2028-02', endsOn: '2028-02-29' });
    expect(meetingPeriod('GB-2027-014', '2027-03-04')).toMatchObject({ basis: 'MEETING', startsOn: '2027-03-04', endsOn: '2027-03-04' });
    expect(BASIS_OF.PLAN_ADJUSTMENT).toBe('QUARTER');
    expect(() => schedulePeriods('MONTH', 1969)).toThrow();
  });

  it('gives each of the five steps its own deadline, at the time of the step or else of the calendar', () => {
    const policy = schedulePolicyOf({ ...scheduleDefaults('MONTH'), steps: [
      { kind: 'ENTRY', offset_days: 5 },
      { kind: 'UNIT_APPROVAL', offset_days: 7, time: '16:30' },
      { kind: 'PLANNING_REVIEW', offset_days: 10 },
      { kind: 'PERIOD_CLOSE', offset_days: 12 },
      { kind: 'PUSH', offset_days: 12, time: '17:00' },
    ] });
    const deadlines = stepDeadlines(policy, { endsOn: '2027-09-30' }, '10:00');
    expect(deadlines.map((step) => [step.kind, step.dueOn, step.dueTime])).toEqual([
      ['ENTRY', '2027-10-05', '10:00'],
      ['UNIT_APPROVAL', '2027-10-07', '16:30'],
      ['PLANNING_REVIEW', '2027-10-10', '10:00'],
      ['PERIOD_CLOSE', '2027-10-12', '10:00'],
      ['PUSH', '2027-10-12', '17:00'],
    ]);
    expect(deadlines[1]?.dueAt).toBe('2027-10-07T09:30:00.000Z');
    expect(() => stepDeadlines(policy, { endsOn: '2027-09-30' }, '25:00')).toThrow();
    expect(() => stepDeadlines(policy, { endsOn: '2027-09-30' }, '10:00', 'Mars/Base')).toThrow();
  });

  it('keeps the entry deadline a period was generated with when the rule has moved since, and reads the calendar time from it', () => {
    const policy = schedulePolicyOf({ ...scheduleDefaults('MONTH'), steps: [{ kind: 'ENTRY', offset_days: 9 }, { kind: 'UNIT_APPROVAL', offset_days: 10 }, { kind: 'PLANNING_REVIEW', offset_days: 11 }, { kind: 'PERIOD_CLOSE', offset_days: 12 }, { kind: 'PUSH', offset_days: 13 }] });
    const generated = '2027-10-05T03:00:00.000Z';
    expect(localTimeOf(generated)).toBe('10:00');
    expect(localTimeOf('2027-10-05T17:30:00.000Z')).toBe('00:30');
    const kept = stepDeadlines(policy, { endsOn: '2027-09-30' }, localTimeOf(generated), undefined, generated);
    expect(kept[0]).toMatchObject({ kind: 'ENTRY', dueAt: generated, dueOn: '2027-10-05', dueTime: '10:00' });
    expect(kept[1]).toMatchObject({ dueOn: '2027-10-10', dueTime: '10:00' });
    expect(stepDeadlines(policy, { endsOn: '2027-09-30' }, '10:00')[0]?.dueOn).toBe('2027-10-09');
  });

  it('refuses a schedule that cannot be run: wrong chain, a deadline that goes back, reminders out of order', () => {
    const base = scheduleDefaults('MONTH');
    const steps = base.steps as Array<Record<string, unknown>>;
    expect(validateRuleParams(SCHEDULE_RULE_TYPE, base)).toMatchObject({ overdue_repeat_days: 1 });
    expect(scheduleDefect({ ...base, steps: steps.slice(0, 4) })).toBe('steps');
    expect(scheduleDefect({ ...base, steps: [steps[1], steps[0], ...steps.slice(2)] })).toBe('steps[0].kind');
    expect(scheduleDefect({ ...base, steps: steps.map((step, at) => (at === 3 ? { ...step, offset_days: 2 } : step)) })).toBe('steps[3].offset_days');
    expect(scheduleDefect({ ...base, reminder_days_before: [1, 3] })).toBe('reminder_days_before');
    expect(scheduleDefect({ ...base, overdue_repeat_days: 0, overdue_max_reminders: 3 })).toBe('overdue_max_reminders');
    expect(() => validateRuleParams(SCHEDULE_RULE_TYPE, { ...base, steps: steps.map((step, at) => (at === 0 ? { ...step, time: '9am' } : step)) })).toThrow();
    expect(() => validateRuleParams(SCHEDULE_RULE_TYPE, { ...base, extra: 1 })).toThrow();
  });
});

describe('the state of a step', () => {
  const due = '2027-10-05T03:00:00.000Z';
  const at = (offsetHours: number): Date => new Date(Date.parse(due) + offsetHours * 3_600_000);

  it('is never done or open without a fact', () => {
    expect(scheduleStepState(due, undefined, at(0))).toBe('NOT_TRACKED');
    expect(scheduleStepState(due, null, at(-24 * 10))).toBe('OPEN');
    expect(scheduleStepState(due, null, at(-24 * 2))).toBe('DUE_SOON');
    expect(scheduleStepState(due, null, at(0))).toBe('DUE_SOON');
    expect(scheduleStepState(due, null, at(1))).toBe('OVERDUE');
    expect(scheduleStepState(due, due, at(5))).toBe('DONE');
    expect(scheduleStepState(due, '2027-10-05T03:00:01.000Z', at(5))).toBe('DONE_LATE');
    expect(daysOverdue(due, at(60))).toBe(2);
    expect(daysOverdue(due, at(-60))).toBe(0);
  });
});

describe('the reminders', () => {
  const policy = policyOf('MONTH');
  const due = '2027-10-05T03:00:00.000Z';
  const at = (days: number): Date => new Date(Date.parse(due) + days * DAY);

  it('sends the reminders before the deadline at the days the rule names, once each', () => {
    expect(reminderDue(policy, due, at(-5), NONE)).toBeUndefined();
    expect(reminderDue(policy, due, at(-3), NONE)).toMatchObject({ kind: 'BEFORE_DUE', ordinal: 1 });
    expect(reminderDue(policy, due, at(-2), { ...NONE, BEFORE_DUE: [1] })).toBeUndefined();
    expect(reminderDue(policy, due, at(-1), { ...NONE, BEFORE_DUE: [1] })).toMatchObject({ kind: 'BEFORE_DUE', ordinal: 2 });
    expect(reminderDue(policy, due, at(-1), { ...NONE, BEFORE_DUE: [1, 2] })).toBeUndefined();
  });

  it('sends one reminder, not a burst, when the job was down for days, and none that falls before the period ended', () => {
    expect(reminderDue(policy, due, at(-0.5), NONE)).toMatchObject({ kind: 'BEFORE_DUE', ordinal: 2 });
    expect(reminderDue(policy, due, at(-3), NONE, '2027-10-04')).toBeUndefined();
    expect(reminderDue(policy, due, at(-3), NONE, '2027-09-30')).toMatchObject({ ordinal: 1 });
  });

  it('keeps reminding after the deadline at the interval of the rule up to its limit, then escalates once', () => {
    expect(reminderDue(policy, due, at(0.01), NONE)).toMatchObject({ kind: 'OVERDUE', ordinal: 1 });
    expect(reminderDue(policy, due, at(0.5), { ...NONE, OVERDUE: [1] })).toBeUndefined();
    expect(reminderDue(policy, due, at(1.2), { ...NONE, OVERDUE: [1] })).toMatchObject({ kind: 'OVERDUE', ordinal: 2 });
    expect(reminderDue(policy, due, at(2.5), { ...NONE, OVERDUE: [1, 2, 3] })).toBeUndefined();
    expect(reminderDue(policy, due, at(3.1), { ...NONE, OVERDUE: [1, 2, 3, 4] })).toMatchObject({ kind: 'ESCALATED', ordinal: 1 });
    expect(reminderDue(policy, due, at(3.1), { ...NONE, OVERDUE: [1, 2, 3, 4], ESCALATED: [1] })).toBeUndefined();
    expect(reminderDue(policy, due, at(40), { BEFORE_DUE: [], OVERDUE: [5], ESCALATED: [1] })).toBeUndefined();
    expect(reminderDue(policy, due, at(40), { BEFORE_DUE: [], OVERDUE: [], ESCALATED: [1] })).toMatchObject({ kind: 'OVERDUE', ordinal: 5 });
  });

  it('names an alert type for each kind, and the types are in the registry with an owner, an action and a consequence', () => {
    for (const code of Object.values(REMINDER_ALERT_TYPES)) {
      const rule = builtInDefault('ALERT_TYPE', code);
      expect(rule?.params).toMatchObject({ source: 'REPORTING_CALENDAR', enabled: true });
      expect(String(rule?.params.owner)).not.toBe('');
      expect(String(rule?.params.expected_action).length).toBeGreaterThan(10);
      expect(String(rule?.params.consequence).length).toBeGreaterThan(10);
    }
  });
});
