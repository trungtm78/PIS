import type { DomainError } from './errors.ts';
import { LAND_TIMER_CODES, NOTICE_DAYS, addCalendarDays, addWorkingDays, noticeTimerOf } from './land-timers.ts';
import type { WorkCalendarContent, WorkCalendarSource } from './working-time.ts';

const calendar = (year: number, holidays: string[] = [], compensated: string[] = []): WorkCalendarContent => ({
  calendar_code: 'WORKDAY_VN',
  year,
  working_days: [1, 2, 3, 4, 5],
  holidays: holidays.map((date) => ({ date, name: 'Holiday' })),
  compensated_workdays: compensated,
  legal_basis_ref: 'test calendar',
});

const sourceOf = (...contents: WorkCalendarContent[]): WorkCalendarSource => {
  const byYear = new Map(contents.map((content) => [content.year, content]));
  return { forYear: (year) => byYear.get(year) };
};

const problem = (work: () => unknown): DomainError | undefined => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  return undefined;
};

describe('the timers of land clearance (BR-LND-01)', () => {
  it('names the five timers and the two lengths of notice a parcel can carry', () => {
    expect(LAND_TIMER_CODES).toEqual(['NOTICE_AGRICULTURAL_90', 'NOTICE_NON_AGRICULTURAL_180', 'PLAN_POSTING_30', 'PAYMENT_30', 'COMPLAINT_RESOLUTION']);
    expect(NOTICE_DAYS).toEqual([90, 180]);
  });

  it('gives agricultural land the short notice and every other land use the long one', () => {
    expect(noticeTimerOf('AGRICULTURAL')).toBe('NOTICE_AGRICULTURAL_90');
    expect(noticeTimerOf('NON_AGRICULTURAL_RESIDENTIAL')).toBe('NOTICE_NON_AGRICULTURAL_180');
    expect(noticeTimerOf('NON_AGRICULTURAL_OTHER')).toBe('NOTICE_NON_AGRICULTURAL_180');
    expect(noticeTimerOf('PUBLIC')).toBe('NOTICE_NON_AGRICULTURAL_180');
  });
});

describe('addCalendarDays', () => {
  it('counts the example of BR-LND-01: a notice of 2026-07-01 falls due on 2026-09-29 (90) and 2026-12-28 (180)', () => {
    expect(addCalendarDays('2026-07-01', 90)).toBe('2026-09-29');
    expect(addCalendarDays('2026-07-01', 180)).toBe('2026-12-28');
  });

  it('counts across a month end, a year end and a leap day, and adds nothing for zero days', () => {
    expect(addCalendarDays('2026-08-01', 30)).toBe('2026-08-31');
    expect(addCalendarDays('2026-12-15', 30)).toBe('2027-01-14');
    expect(addCalendarDays('2028-02-01', 30)).toBe('2028-03-02');
    expect(addCalendarDays('2026-07-01', 0)).toBe('2026-07-01');
  });

  it('refuses a date that is not a date and a number of days that is not a whole number within the bound', () => {
    expect(problem(() => addCalendarDays('2026-02-30', 1))?.code).toBe('VALIDATION_FAILED');
    expect(problem(() => addCalendarDays('01/07/2026', 1))?.code).toBe('VALIDATION_FAILED');
    expect(problem(() => addCalendarDays('2026-07-01', -1))?.code).toBe('VALIDATION_FAILED');
    expect(problem(() => addCalendarDays('2026-07-01', 1.5))?.code).toBe('VALIDATION_FAILED');
    expect(problem(() => addCalendarDays('2026-07-01', 367))?.code).toBe('VALIDATION_FAILED');
  });
});

describe('addWorkingDays', () => {
  it('skips weekends: five working days after a Wednesday is the next Wednesday', () => {
    expect(addWorkingDays(sourceOf(calendar(2026)), '2026-07-01', 5)).toBe('2026-07-08');
  });

  it('skips holidays and counts compensated days', () => {
    // 2026-09-02 (Wednesday) is a holiday; the Saturday 2026-09-05 is a make-up day.
    const source = sourceOf(calendar(2026, ['2026-09-02'], ['2026-09-05']));
    expect(addWorkingDays(source, '2026-09-01', 1)).toBe('2026-09-03');
    expect(addWorkingDays(source, '2026-09-03', 2)).toBe('2026-09-05');
    expect(addWorkingDays(source, '2026-09-05', 1)).toBe('2026-09-07');
  });

  it('runs on into the next year when that year has a calendar, and refuses when it has none', () => {
    expect(addWorkingDays(sourceOf(calendar(2026), calendar(2027)), '2026-12-30', 3)).toBe('2027-01-04');
    expect(problem(() => addWorkingDays(sourceOf(calendar(2026)), '2026-12-30', 3))?.code).toBe('CALENDAR_NOT_EFFECTIVE');
  });

  it('answers the start date for zero days and refuses bad input', () => {
    expect(addWorkingDays(sourceOf(calendar(2026)), '2026-07-04', 0)).toBe('2026-07-04');
    expect(problem(() => addWorkingDays(sourceOf(calendar(2026)), 'x', 1))?.code).toBe('VALIDATION_FAILED');
    expect(problem(() => addWorkingDays(sourceOf(calendar(2026)), '2026-07-01', 367))?.code).toBe('VALIDATION_FAILED');
  });

  it('does not loop for ever over a calendar that never works', () => {
    const closed: WorkCalendarSource = { forYear: (year) => ({ ...calendar(year), working_days: [], holidays: [] }) };
    expect(problem(() => addWorkingDays(closed, '2026-07-01', 1))?.code).toBe('CALENDAR_NOT_EFFECTIVE');
  });
});
