import { describe, expect, it } from 'vitest';
import vectors from '../../../../../packages/contracts/test-vectors/reporting-calendar.json';
import { calendarOf, periodOf, periodsFrom, reportingPeriods } from './reporting-calendar';
import type { CalendarDefinition } from './reporting-calendar';

const calendars = vectors.calendars as Record<string, CalendarDefinition>;
const calendarNamed = (name: string): CalendarDefinition => calendars[name] as CalendarDefinition;

describe('the reporting calendar of the preview', () => {
  it.each(vectors.years)('gives the periods of $year for $calendar that the server gives (shared vectors)', ({ calendar, year, count, first, last }) => {
    const periods = reportingPeriods(calendarNamed(calendar), year);
    expect(periods).toHaveLength(count);
    expect(periods.slice(0, first.length)).toMatchObject(first);
    expect(periods[periods.length - 1]).toMatchObject(last);
  });

  it.each(vectors.containing)('finds the period of $date: $code (shared vectors)', ({ calendar, date, code, startsOn, endsOn }) => {
    expect(periodOf(calendarNamed(calendar), date)).toMatchObject({ code, startsOn, endsOn });
  });

  it('gives the periods from the one that holds a date, one after the other', () => {
    const periods = periodsFrom(calendarNamed('saturdayToFriday'), '2026-12-30', 3);
    expect(periods.map((period) => period.code)).toEqual(['W2027-01', 'W2027-02', 'W2027-03']);
    expect(periods[0]).toMatchObject({ startsOn: '2026-12-26', endsOn: '2027-01-01' });
    expect(periods[1]?.startsOn).toBe('2027-01-02');
  });

  it('reads a calendar from the attributes of an entry, and nothing from attributes that do not describe one', () => {
    const attributes = { week_starts_on: 'SATURDAY', deadline_weekday: 'FRIDAY', deadline_time: '10:00', timezone: 'Asia/Ho_Chi_Minh' };
    expect(calendarOf(attributes)).toEqual(calendars.saturdayToFriday);
    expect(calendarOf({ ...attributes, week_starts_on: 'FUNDAY' })).toBeUndefined();
    expect(calendarOf({ ...attributes, deadline_weekday: undefined })).toBeUndefined();
    expect(calendarOf({ ...attributes, deadline_time: '24:00' })).toBeUndefined();
    expect(calendarOf({ ...attributes, deadline_time: 10 })).toBeUndefined();
    expect(calendarOf({ ...attributes, timezone: 'Europe/Paris' })).toBeUndefined();
    expect(calendarOf({ ...attributes, timezone: 'toString' })).toBeUndefined();
    expect(calendarOf({})).toBeUndefined();
  });
});
