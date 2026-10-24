import { DomainError } from '../src/errors';
import { eventDueDate, nextWorkingDay, parseDueRule, periodicDueDate, reportPeriodOf, weeklyDueDate } from '../src/mne-due-rule';
import type { EventRule, FixedDateRule, WeeklyRule } from '../src/mne-due-rule';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

const H1 = { period: 'H1', month: 7, day: 10 };
const YEAR = { period: 'YEAR', month: 2, day: 10, year_offset: 1 };

describe('parseDueRule (BR-MNE-03)', () => {
  it('reads the half-year and yearly rules of the design', () => {
    expect(parseDueRule('SEMIANNUAL', H1)).toEqual({ frequency: 'SEMIANNUAL', period: 'H1', month: 7, day: 10, yearOffset: 0, shiftOnHoliday: false, calendarCode: null });
    expect(parseDueRule('ANNUAL', YEAR)).toMatchObject({ frequency: 'ANNUAL', period: 'YEAR', month: 2, day: 10, yearOffset: 1 });
  });

  it('reads the weekly rule with and without a time, and the event rule', () => {
    expect(parseDueRule('WEEKLY', { weekly: 'FRI', time: '16:00' })).toMatchObject({ frequency: 'WEEKLY', weekday: 4, weekdayCode: 'FRI', time: '16:00' });
    expect(parseDueRule('WEEKLY', { weekly: 'MON' })).toMatchObject({ weekday: 0, time: '23:59' });
    expect(parseDueRule('EVENT', { event: 'PROJECT_START', days_after: 30 })).toMatchObject({ frequency: 'EVENT', event: 'PROJECT_START', daysAfter: 30 });
  });

  it('reads the shift to a working day only together with its calendar', () => {
    expect(parseDueRule('ANNUAL', { ...YEAR, shift_on_holiday: true, calendar_code: 'DEFAULT' })).toMatchObject({ shiftOnHoliday: true, calendarCode: 'DEFAULT' });
    expect(refusal(() => parseDueRule('ANNUAL', { ...YEAR, shift_on_holiday: true })).detail).toBe('due_rule_json.calendar_code');
    expect(refusal(() => parseDueRule('ANNUAL', { ...YEAR, calendar_code: 'DEFAULT' })).detail).toBe('due_rule_json.shift_on_holiday');
    expect(refusal(() => parseDueRule('ANNUAL', { ...YEAR, shift_on_holiday: 'yes', calendar_code: 'DEFAULT' })).detail).toBe('due_rule_json.shift_on_holiday');
    expect(refusal(() => parseDueRule('ANNUAL', { ...YEAR, shift_on_holiday: true, calendar_code: '../x' })).detail).toBe('due_rule_json.calendar_code');
  });

  it.each([
    ['SEMIANNUAL', { ...H1, period: 'YEAR' }, 'period'],
    ['ANNUAL', { ...YEAR, period: 'H1' }, 'period'],
    ['SEMIANNUAL', { ...H1, month: 13 }, 'month'],
    ['SEMIANNUAL', { ...H1, month: 2, day: 29 }, 'day'],
    ['SEMIANNUAL', { ...H1, day: 0 }, 'day'],
    ['SEMIANNUAL', { ...H1, day: 1.5 }, 'day'],
    ['ANNUAL', { ...YEAR, year_offset: 3 }, 'year_offset'],
    ['ANNUAL', { ...YEAR, year_offset: -1 }, 'year_offset'],
    ['SEMIANNUAL', { ...H1, month: 6, day: 30 }, 'month'],
    ['ANNUAL', { ...YEAR, year_offset: 0 }, 'month'],
    ['SEMIANNUAL', { ...H1, unknown: 1 }, 'unknown'],
    ['WEEKLY', { weekly: 'FUN' }, 'weekly'],
    ['WEEKLY', { weekly: 'FRI', time: '24:00' }, 'time'],
    ['WEEKLY', { weekly: 'FRI', time: 1600 }, 'time'],
    ['WEEKLY', { time: '16:00' }, 'weekly'],
    ['EVENT', { event: 'PROJECT_START', days_after: -1 }, 'days_after'],
    ['EVENT', { event: 'PROJECT_START', days_after: 367 }, 'days_after'],
    ['EVENT', { event: 'PROJECT_LUNCH', days_after: 1 }, 'event'],
    ['EVENT', { event: 'PROJECT_START' }, 'days_after'],
  ])('refuses %s %j naming the field', (frequency, json, field) => {
    expect(refusal(() => parseDueRule(frequency, json))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: `due_rule_json.${field}` });
  });

  it('refuses a rule that is not an object and a frequency it does not know', () => {
    for (const json of [null, [], 'H1', 7]) expect(refusal(() => parseDueRule('SEMIANNUAL', json))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_rule_json' });
    expect(refusal(() => parseDueRule('DAILY', {}))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'frequency' });
  });
});

describe('the periods and deadlines of a year', () => {
  const half = parseDueRule('SEMIANNUAL', H1) as FixedDateRule;
  const year = parseDueRule('ANNUAL', YEAR) as FixedDateRule;

  it('H1 of 2026 is due on 2026-07-10 and the year 2026 on 2027-02-10 (AC-ST-MNE-001-1)', () => {
    expect(reportPeriodOf(half, 2026)).toEqual({ label: 'H1-2026', endsOn: '2026-06-30' });
    expect(periodicDueDate(half, 2026)).toBe('2026-07-10');
    expect(reportPeriodOf(year, 2026)).toEqual({ label: 'YEAR-2026', endsOn: '2026-12-31' });
    expect(periodicDueDate(year, 2026)).toBe('2027-02-10');
  });

  it('H2 ends on 31 December and is due in the next year when the rule says so', () => {
    const second = parseDueRule('SEMIANNUAL', { period: 'H2', month: 1, day: 10, year_offset: 1 }) as FixedDateRule;
    expect(reportPeriodOf(second, 2026)).toEqual({ label: 'H2-2026', endsOn: '2026-12-31' });
    expect(periodicDueDate(second, 2026)).toBe('2027-01-10');
  });

  it('a day off does not move the deadline unless the rule shifts it (BR-MNE-03)', () => {
    // 2026-07-10 is a Friday; 2027-02-10 is a Wednesday: take a rule on a Saturday (2026-07-11) to see the difference.
    const saturday = { ...H1, day: 11 };
    const plain = parseDueRule('SEMIANNUAL', saturday) as FixedDateRule;
    const shifting = parseDueRule('SEMIANNUAL', { ...saturday, shift_on_holiday: true, calendar_code: 'DEFAULT' }) as FixedDateRule;
    const working = (code: string, date: string): boolean => code === 'DEFAULT' && !['2026-07-11', '2026-07-12'].includes(date);
    expect(periodicDueDate(plain, 2026, working)).toBe('2026-07-11');
    expect(periodicDueDate(shifting, 2026, working)).toBe('2026-07-13');
    expect(periodicDueDate(shifting, 2026, (_code, date) => date !== '2026-07-11')).toBe('2026-07-12');
  });

  it('a shifting rule without a calendar to ask is refused, and so is a calendar that never has a working day', () => {
    const shifting = parseDueRule('SEMIANNUAL', { ...H1, shift_on_holiday: true, calendar_code: 'DEFAULT' }) as FixedDateRule;
    expect(refusal(() => periodicDueDate(shifting, 2026))).toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422 });
    expect(refusal(() => periodicDueDate(shifting, 2026, () => false))).toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422 });
    expect(nextWorkingDay('2026-07-10', () => true)).toBe('2026-07-10');
  });

  it('a weekly report is due on the first such weekday on or after the start of its week', () => {
    const friday = parseDueRule('WEEKLY', { weekly: 'FRI', time: '16:00' }) as WeeklyRule;
    // 2026-06-29 is a Monday.
    expect(weeklyDueDate(friday, '2026-06-29')).toBe('2026-07-03');
    expect(weeklyDueDate(friday, '2026-07-03')).toBe('2026-07-03');
    expect(weeklyDueDate(friday, '2026-07-04')).toBe('2026-07-10');
    const monday = parseDueRule('WEEKLY', { weekly: 'MON' }) as WeeklyRule;
    expect(weeklyDueDate(monday, '2026-06-29')).toBe('2026-06-29');
    expect(weeklyDueDate(monday, '2026-06-30')).toBe('2026-07-06');
  });

  it('an event report is due the allowed number of days after the event', () => {
    const start = parseDueRule('EVENT', { event: 'PROJECT_START', days_after: 30 }) as EventRule;
    expect(eventDueDate(start, '2026-03-15')).toBe('2026-04-14');
    expect(eventDueDate(start, '2026-12-15')).toBe('2027-01-14');
    const now = parseDueRule('EVENT', { event: 'PROJECT_COMPLETED', days_after: 0 }) as EventRule;
    expect(eventDueDate(now, '2026-03-15')).toBe('2026-03-15');
    const shifting = parseDueRule('EVENT', { event: 'PROJECT_START', days_after: 30, shift_on_holiday: true, calendar_code: 'DEFAULT' }) as EventRule;
    expect(eventDueDate(shifting, '2026-03-15', (_code, date) => date !== '2026-04-14')).toBe('2026-04-15');
  });
});
