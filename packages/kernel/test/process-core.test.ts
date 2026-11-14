import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../src/errors.ts';
import * as bid from '../src/bid-workflow.ts';
import { MAX_SCAN_DAYS, addWorkingDays, dayNumber, dayText, isWorkflowDay, workflowAddDays, workflowDaysBetween, workingDaysBetween } from '../src/process-core.ts';
import type { WorkCalendarContent, WorkCalendarSource } from '../src/working-time.ts';

/** 2026: Monday to Friday, Wednesday 11 November a holiday. 2027 is not published. */
const CALENDAR_2026: WorkCalendarContent = { calendar_code: 'WORKDAY_VN', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [{ date: '2026-11-11', name: 'Ngày nghỉ thử' }], legal_basis_ref: 'fixture' };
const SOURCE: WorkCalendarSource = { forYear: (year) => (year === 2026 ? CALENDAR_2026 : undefined) };

describe('process-core: the arithmetic of days shared by the processes', () => {
  it('reads a real day only', () => {
    expect(isWorkflowDay('2026-02-28')).toBe(true);
    expect(isWorkflowDay('2026-02-29')).toBe(false);
    expect(isWorkflowDay('26-02-28')).toBe(false);
    expect(isWorkflowDay(20260228)).toBe(false);
  });

  it('turns a day into a number and back without drift', () => {
    expect(dayText(dayNumber('2026-11-12'))).toBe('2026-11-12');
    expect(dayNumber('2026-11-13') - dayNumber('2026-11-12')).toBe(1);
    expect(workflowAddDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(workflowDaysBetween('2026-11-12', '2026-11-10')).toBe(-2);
  });

  it('counts working days on the published calendar and never guesses a year that has none', () => {
    // Thursday 5 November + 5 working days: 6, 9, 10, (11 is a holiday), 12, 13.
    expect(addWorkingDays(SOURCE, '2026-11-05', 5)).toBe('2026-11-13');
    expect(addWorkingDays(SOURCE, '2026-11-05', 0)).toBe('2026-11-05');
    expect(addWorkingDays(SOURCE, '2026-12-30', 3)).toBeUndefined();
    expect(addWorkingDays(undefined, '2026-11-05', 3)).toBeUndefined();
    expect(workingDaysBetween(SOURCE, '2026-11-05', '2026-11-13')).toBe(5);
    expect(workingDaysBetween(SOURCE, '2026-11-13', '2026-11-05')).toBe(0);
    expect(workingDaysBetween(SOURCE, '2026-12-30', '2027-01-05')).toBeUndefined();
    expect(workingDaysBetween(undefined, '2026-11-05', '2026-11-13')).toBeUndefined();
    expect(workingDaysBetween(SOURCE, '2026-01-01', '2030-01-01')).toBeUndefined();
    expect(MAX_SCAN_DAYS).toBe(3 * 366);
  });

  it('refuses what is not a day or a count', () => {
    expect(() => addWorkingDays(SOURCE, '2026-02-30', 1)).toThrow(DomainError);
    expect(() => addWorkingDays(SOURCE, '2026-11-05', -1)).toThrow(DomainError);
    expect(() => addWorkingDays(SOURCE, '2026-11-05', 1.5)).toThrow(DomainError);
    expect(() => workingDaysBetween(SOURCE, 'x', '2026-11-05')).toThrow(DomainError);
  });

  it('is the same function that PRC-1 exports, so the procurement workflow keeps its behaviour', () => {
    expect(bid.addWorkingDays).toBe(addWorkingDays);
    expect(bid.workingDaysBetween).toBe(workingDaysBetween);
    expect(bid.isWorkflowDay).toBe(isWorkflowDay);
    expect(bid.workflowAddDays).toBe(workflowAddDays);
    expect(bid.workflowDaysBetween).toBe(workflowDaysBetween);
  });

  it('UAT-PWF-REG-03: PRC-1 exports again the very functions of process-core and keeps its own tables: no module of the procurement workflow reads the project workflow, so PWF can neither block it nor change its transitions', () => {
    const shared = { addWorkingDays, workingDaysBetween, isWorkflowDay, workflowAddDays, workflowDaysBetween };
    for (const [name, pure] of Object.entries(shared)) expect((bid as Record<string, unknown>)[name]).toBe(pure);
    // The same answer through either name, on a day the calendar decides.
    expect(bid.addWorkingDays(SOURCE, '2026-11-10', 1)).toBe(addWorkingDays(SOURCE, '2026-11-10', 1));
    expect(bid.addWorkingDays(SOURCE, '2026-11-10', 1)).toBe('2026-11-12');
    for (const module of ['bid-workflow.ts', 'bid-process-tree.ts', 'bid-timeline.ts']) {
      const imports = readFileSync(join(__dirname, '..', 'src', module), 'utf8').split(/\r?\n/).filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line));
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter((line) => /project-workflow|project-schedule|pwf-/.test(line))).toEqual([]);
    }
    // The tables of PRC-1 are its own: the ways into and out of a step it always had.
    expect([...bid.ENTRY_KINDS]).toEqual(['START', 'ADVANCE', 'RETURN', 'CORRECTION']);
    expect([...bid.EXIT_KINDS]).toEqual(['ADVANCE', 'RETURN', 'CANCEL', 'COMPLETE', 'CORRECTED']);
  });
});
