import { pwfSchedule } from '@machvon/kernel';
import { causedChanges } from '../src/pwf-reschedule-store';

/*
 * Review finding 3 of the wfxmodel lane: a limit in calendar days that does not roll moves its deadline from Saturday to Sunday when it is extended by one day. The working-day shift is 0 (the same slot), yet the deadline is another
 * day: the change must be listed, marked EXTENDED, and counted as a finish that moved later (the count of reschedules of the task reads `finishMovedLater`). No database is needed: the functions are pure.
 */
const calendars: pwfSchedule.PinnedCalendar[] = [{ year: 2026, version: 1, content: { calendar_code: 'WORKDAY_VN', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'fixture' } }];
const input = (days: number): Omit<pwfSchedule.ScheduleInput, 'baseline'> => ({
  tasks: [
    { code: 'A', kind: 'TASK', durationWorkingDays: Math.max(1, Math.ceil((days * 5) / 7)), duration: { value: days, unit: 'CALENDAR_DAY', rollToWorkingDay: false }, predecessors: [] },
    { code: 'B', kind: 'TASK', durationWorkingDays: 1, predecessors: [{ task: 'A', kind: 'FS', lagWorkingDays: 0 }] },
  ],
  plannedStart: '2026-11-13',
  calendars,
});

describe('causedChanges on a deadline that moves by the calendar only', () => {
  it('lists the task as EXTENDED and counts its finish as later, although no working slot moved', () => {
    const before = pwfSchedule.scheduleProject(input(2));
    const rescheduled = pwfSchedule.rescheduleProject({ before, input: input(3) });
    expect(before.tasks.find((one) => one.code === 'A')?.finish).toBe('2026-11-14');
    expect(rescheduled.schedule.tasks.find((one) => one.code === 'A')?.finish).toBe('2026-11-15');
    const changes = causedChanges(rescheduled.diff, before, rescheduled.schedule, { extensions: [{ taskCode: 'A', addValue: 1 }], reason: 'Gia hạn một ngày theo đề nghị của đơn vị' });
    expect(changes).toEqual([expect.objectContaining({ code: 'A', finishShiftDays: 0, finishCalendarShiftDays: 1, cause: 'EXTENDED' })]);
    expect(changes.filter((change) => pwfSchedule.finishMovedLater(change)).map((change) => change.code)).toEqual(['A']);
    // B starts on Monday either way: it did not move and is not listed, so it is not counted.
    expect(rescheduled.schedule.tasks.find((one) => one.code === 'B')?.start).toBe('2026-11-16');
  });
});
