import { addWorkingTime } from '@machvon/kernel';
import type { WorkCalendarContent, WorkCalendarSource } from '@machvon/kernel';
import { ISS_WORKING_INTERVALS } from '../src/iss-sla-deadline';

const calendar = (year: number, extras: Partial<WorkCalendarContent> = {}): WorkCalendarContent => ({
  calendar_code: 'WORKDAY_VN',
  year,
  working_days: [1, 2, 3, 4, 5],
  holidays: [],
  compensated_workdays: [],
  legal_basis_ref: 'Labour Code 2019, Article 112',
  ...extras,
});
const years =
  (...contents: WorkCalendarContent[]): WorkCalendarSource =>
  ({ forYear: (year) => contents.find((content) => content.year === year) });

/** A due time counted on the window of an issue SLA, written in Vietnam time. */
const due = (source: WorkCalendarSource, start: string, hours: number): string => {
  const at = addWorkingTime(source, new Date(`${start}+07:00`), { hours }, ISS_WORKING_INTERVALS);
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 16);
};

describe('the working window of an issue SLA (BR-ISS-01)', () => {
  it('counts Friday 16:00 plus 4 hours on the window 07:30-17:00 as Monday 10:30 (the worked example of BR-ISS-01)', () => {
    expect(due(years(calendar(2026)), '2026-07-10T16:00:00', 4)).toBe('2026-07-13T10:30');
  });

  it('skips the weekend and a holiday and counts a make-up working day (AC-ST-ISS-001-1)', () => {
    // Friday 28 August 16:00, 16 working hours: 1 hour on Friday, 9.5 on the make-up Saturday, then 5.5 hours on Tuesday 1 September.
    const calendar2026 = calendar(2026, { holidays: [{ date: '2026-08-31', name: 'Holiday' }], compensated_workdays: ['2026-08-29'] });
    expect(due(years(calendar2026), '2026-08-28T16:00:00', 16)).toBe('2026-09-01T13:00');
    // Without the make-up day the same 16 hours end a day later: the make-up day is what is counted.
    expect(due(years(calendar(2026, { holidays: [{ date: '2026-08-31', name: 'Holiday' }] })), '2026-08-28T16:00:00', 16)).toBe('2026-09-02T13:00');
  });

  it('begins at 07:30 of the next working day when the issue is created after 17:00 or at the weekend', () => {
    expect(due(years(calendar(2026)), '2026-07-10T18:00:00', 1)).toBe('2026-07-13T08:30');
    expect(due(years(calendar(2026)), '2026-07-11T10:00:00', 1)).toBe('2026-07-13T08:30');
  });
});
