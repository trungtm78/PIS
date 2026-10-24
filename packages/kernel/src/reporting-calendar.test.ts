import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DomainError } from './errors.ts';
import { CALENDAR_TIMEZONES, WEEKDAYS, assertCalendar, isLate, periodOf, reportingPeriods } from './reporting-calendar.ts';
import type { CalendarDefinition, ReportingPeriod } from './reporting-calendar.ts';

interface Vectors {
  calendars: Record<string, CalendarDefinition>;
  years: Array<{ calendar: string; year: number; count: number; first: ReportingPeriod[]; last: ReportingPeriod }>;
  containing: Array<{ calendar: string; date: string; code: string; startsOn: string; endsOn: string }>;
}
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../contracts/test-vectors/reporting-calendar.json'), 'utf8')) as Vectors;
const calendarOf = (name: string): CalendarDefinition => vectors.calendars[name] as CalendarDefinition;
const SATURDAY_FRIDAY = calendarOf('saturdayToFriday');

const problem = (work: () => unknown): { code: string; detail: string | undefined } | undefined => {
  try {
    work();
  } catch (error) {
    const { code, detail } = error as DomainError;
    return { code, detail };
  }
  return undefined;
};

describe('the reporting calendar (BR-MDM-08)', () => {
  it.each(vectors.years)('generates the periods of $year for $calendar as the shared vectors say', ({ calendar, year, count, first, last }) => {
    const periods = reportingPeriods(calendarOf(calendar), year);
    expect(periods).toHaveLength(count);
    expect(periods.slice(0, first.length)).toMatchObject(first);
    expect(periods[periods.length - 1]).toMatchObject(last);
  });

  it('leaves no gap and no overlap, with a deadline inside every period, for every year and every way of counting a week (AC-ST-MDM-004-1)', () => {
    for (const start of WEEKDAYS) {
      for (const due of WEEKDAYS) {
        const calendar: CalendarDefinition = { weekStartsOn: start, deadlineWeekday: due, deadlineTime: '10:00', timezone: 'Asia/Ho_Chi_Minh' };
        for (const year of [2024, 2025, 2026, 2027, 2028, 2032]) {
          const periods = reportingPeriods(calendar, year);
          expect(periods.length).toBeGreaterThanOrEqual(52);
          periods.forEach((period, index) => {
            expect(period.number).toBe(index + 1);
            expect(period.year).toBe(year);
            const length = (Date.parse(period.endsOn) - Date.parse(period.startsOn)) / 86_400_000;
            expect(length).toBe(6);
            const deadlineDay = Date.parse(period.deadlineAt.slice(0, 10));
            // The deadline instant, read in the zone of the calendar (+07:00), falls between the first and the last day of the period.
            const local = new Date(Date.parse(period.deadlineAt) + (CALENDAR_TIMEZONES['Asia/Ho_Chi_Minh'] as number) * 60_000);
            const localDay = Date.parse(local.toISOString().slice(0, 10));
            expect(localDay).toBeGreaterThanOrEqual(Date.parse(period.startsOn));
            expect(localDay).toBeLessThanOrEqual(Date.parse(period.endsOn));
            expect(deadlineDay).toBeGreaterThan(0);
            const next = periods[index + 1];
            if (next !== undefined) expect(Date.parse(next.startsOn) - Date.parse(period.endsOn)).toBe(86_400_000);
          });
        }
        // The last day of a year and the first of the next belong to consecutive periods.
        const lastOf2026 = reportingPeriods(calendar, 2026).at(-1) as ReportingPeriod;
        const firstOf2027 = reportingPeriods(calendar, 2027)[0] as ReportingPeriod;
        expect(Date.parse(firstOf2027.startsOn) - Date.parse(lastOf2026.endsOn)).toBe(86_400_000);
      }
    }
  });

  it('puts every deadline of the Saturday to Friday calendar on Friday at 03:00 UTC, which is 10:00 in Vietnam (AC-ST-MDM-004-1)', () => {
    for (const period of reportingPeriods(SATURDAY_FRIDAY, 2027)) {
      expect(new Date(period.deadlineAt).getUTCDay()).toBe(5);
      expect(period.deadlineAt.slice(10)).toBe('T03:00:00.000Z');
      expect(period.deadlineAt.slice(0, 10)).toBe(period.endsOn);
    }
  });

  it.each(vectors.containing)('finds the period of $date: $code', ({ calendar, date, code, startsOn, endsOn }) => {
    expect(periodOf(calendarOf(calendar), date)).toMatchObject({ code, startsOn, endsOn });
  });

  it('judges lateness at the deadline instant: on time at it, late after it', () => {
    const period = periodOf(SATURDAY_FRIDAY, '2026-09-30');
    expect(period.deadlineAt).toBe('2026-10-02T03:00:00.000Z');
    expect(isLate(period, new Date('2026-10-02T03:00:00.000Z'))).toBe(false);
    expect(isLate(period, new Date('2026-10-02T03:00:00.001Z'))).toBe(true);
    expect(isLate(period, new Date('2026-09-26T00:00:00.000Z'))).toBe(false);
  });

  it('refuses a definition that cannot produce a calendar, naming the attribute', () => {
    const base = SATURDAY_FRIDAY;
    expect(problem(() => assertCalendar(base))).toBeUndefined();
    expect(problem(() => assertCalendar({ ...base, weekStartsOn: 'FUNDAY' as never }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'attributes.week_starts_on' });
    expect(problem(() => assertCalendar({ ...base, deadlineWeekday: 'x' as never }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'attributes.deadline_weekday' });
    expect(problem(() => assertCalendar({ ...base, deadlineTime: '24:00' }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'attributes.deadline_time' });
    expect(problem(() => assertCalendar({ ...base, deadlineTime: '9:00' }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'attributes.deadline_time' });
    expect(problem(() => assertCalendar({ ...base, timezone: 'Europe/Paris' }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'attributes.timezone' });
    expect(problem(() => assertCalendar({ ...base, timezone: 'toString' }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'attributes.timezone' });
    expect(problem(() => reportingPeriods(base, 1969))).toEqual({ code: 'VALIDATION_FAILED', detail: 'year' });
    expect(problem(() => reportingPeriods(base, 2026.5))).toEqual({ code: 'VALIDATION_FAILED', detail: 'year' });
    expect(problem(() => periodOf({ ...base, timezone: 'nowhere' }, '2026-01-01'))).toEqual({ code: 'VALIDATION_FAILED', detail: 'attributes.timezone' });
  });
});
