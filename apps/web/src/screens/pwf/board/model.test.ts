import { describe, expect, it } from 'vitest';
import { AS_OF } from '../test/fixtures';
import { NO_FILTERS, assigneesOf, bareBand, PAGE_SIZE, appliedCount, boardQuery, calendarGrid, calendarQuery, filtersOf, isMonth, isStale, optionsOf, paramsOf, phasesOf, shiftMonth, viewOf, workloadRows } from './model';
import type { CalendarDay } from './model';

const params = (text: string) => new URLSearchParams(text);

describe('board filters in the address', () => {
  it('reads the filters that are set and drops what the screen does not know', () => {
    expect(filtersOf(params('band=RED&phase=EXECUTION&assignee=a1&unit=u1&status=IN_PROGRESS&from=2026-12-01&to=2026-12-31'))).toEqual({
      band: 'RED',
      phase: 'EXECUTION',
      assignee: 'a1',
      unit: 'u1',
      status: 'IN_PROGRESS',
      dueFrom: '2026-12-01',
      dueTo: '2026-12-31',
    });
    expect(filtersOf(params('band=NONE&status=WHATEVER&from=2026-13-01&to=x'))).toEqual(NO_FILTERS);
    expect(filtersOf(params(''))).toEqual(NO_FILTERS);
  });

  it('writes only what is set, the view when it is not the list and the month when it reads', () => {
    expect(paramsOf({ ...NO_FILTERS, band: 'YELLOW', dueFrom: '2026-12-01' }, 'calendar', '2026-12').toString()).toBe('band=YELLOW&from=2026-12-01&view=calendar&month=2026-12');
    expect(paramsOf(NO_FILTERS, 'list', undefined).toString()).toBe('');
    expect(paramsOf(NO_FILTERS, 'list', 'bad').toString()).toBe('');
  });

  it('reads the view and counts the applied conditions', () => {
    expect(viewOf(params('view=workload'))).toBe('workload');
    expect(viewOf(params('view=nope'))).toBe('list');
    expect(appliedCount({ ...NO_FILTERS, band: 'RED', unit: 'u' })).toBe(2);
    expect(appliedCount(NO_FILTERS)).toBe(0);
  });

  it('builds the query of a page from the filters, the page size and the cursor', () => {
    expect(boardQuery(NO_FILTERS, undefined)).toEqual({ limit: PAGE_SIZE });
    expect(boardQuery({ band: 'RED', phase: 'P', assignee: 'a', unit: 'u', status: 'DONE', dueFrom: '2026-12-01', dueTo: '2026-12-31' }, 'c1')).toEqual({
      limit: PAGE_SIZE,
      band: 'RED',
      phase: 'P',
      assignee_id: 'a',
      unit_id: 'u',
      status: 'DONE',
      due_from: '2026-12-01',
      due_to: '2026-12-31',
      cursor: 'c1',
    });
  });

  it('asks the calendar for the month, the person and the unit only', () => {
    expect(calendarQuery('2026-12', { ...NO_FILTERS, band: 'RED', assignee: 'a', unit: 'u' })).toEqual({ month: '2026-12', assignee_id: 'a', unit_id: 'u' });
    expect(calendarQuery('2026-12', NO_FILTERS)).toEqual({ month: '2026-12' });
  });
});

describe('the month grid', () => {
  const day = (date: string): CalendarDay => ({ date, total: 1, counts_by_band: { NONE: 0, GREEN: 1, YELLOW: 0, RED: 0, UNKNOWN: 0 }, tasks: [] });

  it('moves a month, over the year', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-05', 0)).toBe('2026-05');
    expect(isMonth('2026-12')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
  });

  it('covers the month in weeks that start on Monday, with the days of the neighbours greyed out', () => {
    const weeks = calendarGrid('2026-12', [day('2026-12-10')]);
    // 1 December 2026 is a Tuesday: the first week starts on Monday 30 November.
    expect(weeks[0]?.[0]).toMatchObject({ date: '2026-11-30', inMonth: false });
    expect(weeks[0]?.[1]).toMatchObject({ date: '2026-12-01', inMonth: true });
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks).toHaveLength(5);
    expect(weeks.flat().find((cell) => cell.date === '2026-12-10')?.day?.total).toBe(1);
    expect(weeks.flat().find((cell) => cell.date === '2026-12-11')?.day).toBeUndefined();
    expect(weeks.at(-1)?.at(-1)).toMatchObject({ date: '2027-01-03', inMonth: false });
  });

  it('adds a sixth week when the month needs one', () => {
    expect(calendarGrid('2026-08', [])).toHaveLength(6);
  });
});

describe('workload rows (display only)', () => {
  it('sums the weeks, rounds to one decimal and puts the heaviest first', () => {
    const rows = workloadRows({
      weeks: ['2026-12-07', '2026-12-14'],
      people: [
        { membership_id: 'b', display_name: 'B', open_tasks: 1, weekly_planned_working_days: [1.04, 1] },
        { membership_id: 'a', display_name: 'A', open_tasks: 2, weekly_planned_working_days: [3, 2.26] },
        { membership_id: 'c', display_name: 'A2', open_tasks: 0, weekly_planned_working_days: [1, 1.04] },
      ],
      display_only: true,
      as_of: AS_OF,
    });
    expect(rows.map((row) => [row.id, row.total])).toEqual([
      ['a', 5.3],
      ['c', 2],
      ['b', 2],
    ]);
    expect(rows[0]?.weekly).toEqual([3, 2.3]);
  });
});

describe('reading', () => {
  it('says a read is old after the limit, and one that does not read is old', () => {
    const now = Date.parse(AS_OF);
    expect(isStale(AS_OF, now + 10 * 60_000)).toBe(false);
    expect(isStale(AS_OF, now + 31 * 60_000)).toBe(true);
    expect(isStale('bad', now)).toBe(true);
  });

  it('makes choices from a register: id and the first name that is a text, the id when there is none', () => {
    expect(optionsOf([{ id: 'u1', name: 'Phòng A', code: 'A' }, { id: 'u2', code: 'B' }, { id: 'u3' }, { name: 'no id' }, null, { id: 'u4', display_name: '' }], ['display_name', 'name', 'code'])).toEqual([
      { id: 'u1', label: 'Phòng A' },
      { id: 'u2', label: 'B' },
      { id: 'u3', label: 'u3' },
      { id: 'u4', label: 'u4' },
    ]);
  });

  it('lists the people the rows are given to, each once and by name', () => {
    expect(assigneesOf([{ assignee: { membership_id: 'b', display_name: 'Trần B' } }, { assignee: null }, { assignee: { membership_id: 'a', display_name: 'Lê A' } }, { assignee: { membership_id: 'b', display_name: 'Trần B' } }])).toEqual([
      { id: 'a', label: 'Lê A' },
      { id: 'b', label: 'Trần B' },
    ]);
    expect(bareBand('RED')).toEqual({ band: 'RED', remaining_days: null, unit: 'WORKING', overdue: false });
  });

  it('lists the phases once each', () => {
    expect(phasesOf([{ phase_code: 'A' }, { phase_code: 'B' }, { phase_code: 'A' }])).toEqual(['A', 'B']);
  });
});
