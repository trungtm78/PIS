import { workingDayOffset } from '../src/pwf-horizon';
import type { WorkCalendarContent, WorkCalendarSource } from '@machvon/kernel';

const content = (year: number, workingDays: number[], holidays: string[] = []): WorkCalendarContent => ({ calendar_code: 'WORKDAY_VN', year, working_days: workingDays, holidays: holidays.map((date) => ({ date, name: 'Day off' })), legal_basis_ref: 'fixture' });
const source = (...years: WorkCalendarContent[]): WorkCalendarSource => ({ forYear: (year) => years.find((one) => one.year === year) });

/** The day a read of tasks has to look as far as, on the calendar of the tenant (R35): never a fixed number of calendar days. */
describe('workingDayOffset', () => {
  it('counts the working days of a Monday to Friday calendar, forward and back, and gives the day itself for 0', () => {
    const calendars = source(content(2026, [1, 2, 3, 4, 5]));
    // Friday 6 November 2026.
    expect(workingDayOffset(calendars, '2026-11-06', 0)).toBe('2026-11-06');
    expect(workingDayOffset(calendars, '2026-11-06', 1)).toBe('2026-11-09');
    expect(workingDayOffset(calendars, '2026-11-06', 6)).toBe('2026-11-16');
    expect(workingDayOffset(calendars, '2026-11-09', -1)).toBe('2026-11-06');
    expect(workingDayOffset(calendars, '2026-11-09', -6)).toBe('2026-10-30');
  });

  it('goes as far as the calendar says: one working day a week, a long holiday, a day compensated', () => {
    const rare = source(content(2026, [3]));
    // Wednesdays only: the 6th working day after Friday 6 November is 35 days later.
    expect(workingDayOffset(rare, '2026-11-06', 6)).toBe('2026-12-16');
    const holiday = source({ ...content(2026, [1, 2, 3, 4, 5], ['2026-11-09', '2026-11-10', '2026-11-11']), compensated_workdays: ['2026-11-14'] });
    expect(workingDayOffset(holiday, '2026-11-06', 1)).toBe('2026-11-12');
    expect(workingDayOffset(holiday, '2026-11-12', 2)).toBe('2026-11-14');
    expect(workingDayOffset(source(content(2026, [1, 2, 3, 4, 5], ['2026-11-12']), ), '2026-11-11', 1)).toBe('2026-11-13');
  });

  it('crosses a year when both have a calendar, and says nothing (null) when one is missing or there is none at all', () => {
    expect(workingDayOffset(source(content(2026, [1, 2, 3, 4, 5]), content(2027, [1, 2, 3, 4, 5])), '2026-12-31', 2)).toBe('2027-01-04');
    expect(workingDayOffset(source(content(2026, [1, 2, 3, 4, 5])), '2026-12-31', 2)).toBeNull();
    expect(workingDayOffset(undefined, '2026-11-06', 1)).toBeNull();
    expect(workingDayOffset(source(content(2026, [1])), '2026-11-06', 400)).toBeNull();
  });
});
