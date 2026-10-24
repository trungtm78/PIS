import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DomainError } from './errors.ts';
import { CALENDAR_TIMEZONES } from './reporting-calendar.ts';
import { WORKING_TIME_ZONE, addWorkingTime, calendarFindings, isWorkingDay, singleYear, validateWorkCalendar } from './working-time.ts';
import type { WorkCalendarContent, WorkCalendarSource, WorkingInterval } from './working-time.ts';

interface Addition {
  name: string;
  calendars: string[];
  start: string;
  duration: { hours?: number; minutes?: number };
  intervals?: WorkingInterval[];
  expected: string;
}
interface Refusal extends Omit<Addition, 'expected'> {
  code: string;
}
interface Vectors {
  calendars: Record<string, WorkCalendarContent>;
  additions: Addition[];
  refused: Refusal[];
}
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../contracts/test-vectors/work-calendar.json'), 'utf8')) as Vectors;

const sourceOf = (names: string[]): WorkCalendarSource => {
  const byYear = new Map(names.map((name) => [(vectors.calendars[name] as WorkCalendarContent).year, vectors.calendars[name] as WorkCalendarContent]));
  return { forYear: (year) => byYear.get(year) };
};
const std2026 = vectors.calendars['VN-STD-2026'] as WorkCalendarContent;
const problem = (work: () => unknown): DomainError | undefined => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  return undefined;
};

describe('addWorkingTime (BR-ADM-08, UAT-AC134)', () => {
  it.each(vectors.additions)('$name', ({ calendars, start, duration, intervals, expected }) => {
    expect(addWorkingTime(sourceOf(calendars), new Date(start), duration, intervals).toISOString()).toBe(new Date(expected).toISOString());
  });

  it.each(vectors.refused)('$name', ({ calendars, start, duration, code }) => {
    expect(problem(() => addWorkingTime(sourceOf(calendars), new Date(start), duration))).toMatchObject({ code, status: 422 });
  });

  it('takes one calendar version as well as a set of them', () => {
    const due = addWorkingTime(std2026, new Date('2026-04-29T15:00:00+07:00'), { hours: 8 });
    expect(due.toISOString()).toBe(new Date('2026-05-04T15:00:00+07:00').toISOString());
    expect(singleYear(std2026).forYear(2027)).toBeUndefined();
  });

  it('does not change the start it is given', () => {
    const start = new Date('2026-06-01T09:00:00+07:00');
    const due = addWorkingTime(std2026, start, { hours: 0 });
    expect(due).not.toBe(start);
    expect(start.toISOString()).toBe(new Date('2026-06-01T09:00:00+07:00').toISOString());
  });

  it.each([{ hours: -1 }, { hours: Number.NaN }, { hours: Number.POSITIVE_INFINITY }, { minutes: 0.5 }, { hours: 0.001 }])('refuses the duration %j', (duration) => {
    expect(problem(() => addWorkingTime(std2026, new Date('2026-06-01T09:00:00+07:00'), duration))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'duration' });
  });

  it.each([
    ['no interval', []],
    ['a time that is not HH:MM', [{ from: '8:00', to: '12:00' }]],
    ['an interval that ends before it begins', [{ from: '12:00', to: '08:00' }]],
    ['an empty interval', [{ from: '08:00', to: '08:00' }]],
    ['intervals out of order', [{ from: '13:00', to: '17:00' }, { from: '08:00', to: '12:00' }]],
    ['intervals that overlap', [{ from: '08:00', to: '13:00' }, { from: '12:00', to: '17:00' }]],
  ])('refuses a working window with %s', (_label, intervals) => {
    expect(problem(() => addWorkingTime(std2026, new Date('2026-06-01T09:00:00+07:00'), { hours: 1 }, intervals))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'segments' });
  });

  it('takes a fraction of an hour that is a whole number of minutes', () => {
    expect(addWorkingTime(std2026, new Date('2026-06-01T09:00:00+07:00'), { hours: 1.5 }).toISOString()).toBe(new Date('2026-06-01T10:30:00+07:00').toISOString());
  });

  it('stops when a calendar leaves no working day within three years, instead of looping', () => {
    const everyDayOff: WorkCalendarSource = { forYear: (year) => ({ ...std2026, year, working_days: [], holidays: [], compensated_workdays: [] }) };
    expect(problem(() => addWorkingTime(everyDayOff, new Date('2026-06-01T09:00:00+07:00'), { hours: 1 }))).toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE', detail: 'duration' });
  });

  it('counts the days in the zone of the tenant, not in UTC', () => {
    // 2026-06-01T20:00Z is 03:00 on Tuesday 2 June in Vietnam: before the working day, so the day begins at 08:00.
    expect(addWorkingTime(std2026, new Date('2026-06-01T20:00:00Z'), { hours: 1 }).toISOString()).toBe(new Date('2026-06-02T09:00:00+07:00').toISOString());
  });

  it('reads working hours in a zone the reporting calendar of MDM also knows', () => {
    expect(Object.keys(CALENDAR_TIMEZONES)).toContain(WORKING_TIME_ZONE);
  });
});

describe('isWorkingDay', () => {
  it('lets a holiday win over the weekday, a compensated day win over the weekend, and a weekend stay off', () => {
    expect(isWorkingDay(std2026, '2026-04-30')).toBe(false);
    expect(isWorkingDay(std2026, '2026-05-09')).toBe(true);
    expect(isWorkingDay(std2026, '2026-05-10')).toBe(false);
    expect(isWorkingDay(std2026, '2026-05-11')).toBe(true);
  });
});

describe('validateWorkCalendar (UAT-AC135)', () => {
  const draft = (changes: Partial<WorkCalendarContent>): WorkCalendarContent => ({ ...std2026, ...changes });
  const codesOf = (content: WorkCalendarContent): string[] => calendarFindings(content).map((entry) => `${entry.field}:${entry.code}`);

  it('accepts the calendar of the vectors', () => {
    expect(() => validateWorkCalendar(std2026)).not.toThrow();
    expect(() => validateWorkCalendar(vectors.calendars['VN-STD-2027'] as WorkCalendarContent)).not.toThrow();
  });

  it('refuses a 2027 calendar that holds a date outside its year with 422 CALENDAR_INVALID, naming the field and the code', () => {
    const content = draft({ year: 2027, compensated_workdays: [], holidays: [{ date: '2027-01-01', name: 'New Year' }, { date: '2026-12-31', name: 'Last day of the year before' }] });
    const failure = problem(() => validateWorkCalendar(content));
    expect(failure).toMatchObject({ code: 'CALENDAR_INVALID', status: 422, detail: 'holidays[1]' });
    expect(failure?.extensions).toEqual({ errors: [{ field: 'holidays[1]', code: 'OUT_OF_YEAR', message: 'adm.calendar.error.outOfYear' }] });
  });

  it('names every finding, not only the first', () => {
    const content = draft({
      calendar_code: ' bad code',
      legal_basis_ref: '  ',
      working_days: [],
      holidays: [{ date: '2026-02-30', name: 'Not a date' }, { date: '2026-05-01', name: '' }, { date: '2026-05-01', name: 'Twice' }],
      compensated_workdays: ['2026-05-01', '2026-05-12', '2026-05-12', '2025-05-09'],
    });
    expect(codesOf(content)).toEqual([
      'calendar_code:CODE_INVALID',
      'legal_basis_ref:LEGAL_BASIS_REQUIRED',
      'working_days:NO_WORKING_DAYS',
      'holidays[0]:DATE_INVALID',
      'holidays[2]:DUPLICATE',
      'holidays[1].name:NAME_REQUIRED',
      'compensated_workdays[2]:DUPLICATE',
      'compensated_workdays[3]:OUT_OF_YEAR',
      'compensated_workdays[0]:COMPENSATED_ON_HOLIDAY',
    ]);
  });

  it('refuses a compensated day that falls on an ordinary working day', () => {
    expect(codesOf(draft({ compensated_workdays: ['2026-05-12'] }))).toEqual(['compensated_workdays[0]:COMPENSATED_ALREADY_WORKING']);
  });

  it('refuses a weekday listed twice and a date that is not written as YYYY-MM-DD', () => {
    expect(codesOf(draft({ working_days: [1, 1, 2] }))).toEqual(['working_days:DUPLICATE']);
    expect(codesOf(draft({ holidays: [{ date: '1/5/2026', name: 'Labour Day' }] }))).toEqual(['holidays[0]:DATE_INVALID']);
  });

  it('treats a missing list of compensated days as none', () => {
    const withoutCompensated: WorkCalendarContent = { calendar_code: 'VN-STD', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code 2019 art. 112' };
    expect(codesOf(withoutCompensated)).toEqual([]);
    expect(isWorkingDay(withoutCompensated, '2026-05-09')).toBe(false);
  });
});
