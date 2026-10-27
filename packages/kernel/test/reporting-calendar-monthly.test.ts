import { MONTHLY_DEADLINE_DAY, isLate, monthlyPeriodOf, monthlyPeriods, periodOfType } from '../src/reporting-calendar.ts';
import type { CalendarDefinition } from '../src/reporting-calendar.ts';

const CALENDAR: CalendarDefinition = { weekStartsOn: 'MONDAY', deadlineWeekday: 'FRIDAY', deadlineTime: '10:00', timezone: 'Asia/Ho_Chi_Minh' };

describe('the monthly reporting periods (ST-DIS-015, an assumption of the first release until D03 is signed)', () => {
  it('has twelve periods a year with no gap and no overlap, each a calendar month with a code of its own', () => {
    const periods = monthlyPeriods(CALENDAR, 2027);
    expect(periods).toHaveLength(12);
    expect(periods.map((period) => period.code)).toEqual(Array.from({ length: 12 }, (_, n) => `M2027-${String(n + 1).padStart(2, '0')}`));
    expect(periods[0]).toMatchObject({ startsOn: '2027-01-01', endsOn: '2027-01-31', number: 1, year: 2027 });
    expect(periods[1]).toMatchObject({ startsOn: '2027-02-01', endsOn: '2027-02-28' });
    expect(monthlyPeriods(CALENDAR, 2028)[1]).toMatchObject({ endsOn: '2028-02-29' });
    periods.slice(1).forEach((period, n) => expect(Date.parse(period.startsOn) - Date.parse((periods[n] as { endsOn: string }).endsOn)).toBe(86_400_000));
  });

  it('is due on the 5th of the next month at the time of the calendar, in its time zone, and the last month is due in January of the next year', () => {
    expect(MONTHLY_DEADLINE_DAY).toBe(5);
    expect(monthlyPeriods(CALENDAR, 2027)[8]?.deadlineAt).toBe('2027-10-05T03:00:00.000Z');
    expect(monthlyPeriods(CALENDAR, 2027)[11]?.deadlineAt).toBe('2028-01-05T03:00:00.000Z');
    // A report at 03:00:01Z after a 03:00:00Z deadline is late; at the deadline it is still in time.
    const september = monthlyPeriods(CALENDAR, 2027)[8] as { deadlineAt: string };
    expect(isLate(september, new Date('2027-10-05T03:00:01Z'))).toBe(true);
    expect(isLate(september, new Date('2027-10-05T03:00:00Z'))).toBe(false);
  });

  it('finds the month that contains a date, and the period of the type the period names', () => {
    expect(monthlyPeriodOf(CALENDAR, '2027-09-30')).toMatchObject({ code: 'M2027-09', startsOn: '2027-09-01', endsOn: '2027-09-30' });
    expect(monthlyPeriodOf(CALENDAR, '2028-02-29')).toMatchObject({ code: 'M2028-02' });
    expect(periodOfType(CALENDAR, 'MONTH', '2027-09-01').code).toBe('M2027-09');
    expect(periodOfType(CALENDAR, 'WEEK', '2027-09-01').code).toMatch(/^W2027-/);
  });

  it('refuses a year that cannot be a year and a calendar that cannot produce one', () => {
    expect(() => monthlyPeriods(CALENDAR, 1969)).toThrow();
    expect(() => monthlyPeriods({ ...CALENDAR, timezone: 'nowhere' }, 2027)).toThrow();
  });
});
