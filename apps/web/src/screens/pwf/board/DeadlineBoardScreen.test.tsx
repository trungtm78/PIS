import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import type { DeadlineBoard } from '../model';
import { ALL_PERMISSIONS, PROJECT_ID, READ_ONLY, band, deadlineBoard, refusal, routeOf, serve, text, uuid } from '../test/fixtures';
import type { Answer } from '../test/fixtures';
import DeadlineBoardScreen from './DeadlineBoardScreen';
import { calendarBody, milestoneBody, row, workloadBody } from './test/fixtures';

beforeEach(() => {
  // The clock of the page is near the time the fixtures were read, so a read is not old unless a test says so.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-12T03:05:00.000Z') });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-07');

interface Setup {
  path?: string;
  permissions?: readonly string[];
  board?: Answer;
  calendar?: Answer;
  milestones?: Answer;
  workload?: Answer;
  units?: unknown[];
  members?: unknown[] | Error;
}

const open = (setup: Setup = {}) => {
  const h = serve({
    getDeadlineBoard: setup.board ?? deadlineBoard(),
    getDeadlineCalendar: setup.calendar ?? calendarBody(),
    getUpcomingMilestones: setup.milestones ?? milestoneBody(),
    getProjectWorkload: setup.workload ?? workloadBody(),
  });
  (h.client as { readAll: unknown }).readAll = vi.fn(async (operation: string) => {
    if (operation === 'get_resources_organization_unit') return setup.units ?? [{ id: uuid(60), name: 'Ban quản lý dự án 1', code: 'BQL1' }];
    if (setup.members instanceof Error) throw setup.members;
    return setup.members ?? [{ id: uuid(61), display_name: 'Nguyễn Văn An' }];
  });
  mount(<DeadlineBoardScreen route={route} />, h, setup.permissions ?? ALL_PERMISSIONS, setup.path ?? '/pwf/pwf-07');
  return h;
};

const board = (over: Partial<DeadlineBoard> = {}): DeadlineBoard => deadlineBoard(over);
const ready = async () => screen.findByTestId('board-list');
const queryOf = (h: ReturnType<typeof open>, operation: string, call = -1): Record<string, unknown> => {
  const calls = h.read.mock.calls.filter(([name]) => name === operation);
  return ((calls.at(call)?.[1] ?? {}) as { query?: Record<string, unknown> }).query ?? {};
};

describe('PWF-07: the list of the board', () => {
  it('shows each open task with its official colour as word, glyph and days, its due day, project, task, person and the critical path as words', async () => {
    open();
    await ready();
    const line = document.querySelector(`[data-task-id="${uuid(1002)}"]`) as HTMLElement;
    expect(within(line).getByText(text('pwf.band.red.word'))).toBeTruthy();
    expect(within(line).getByText('⛔')).toBeTruthy();
    expect(within(line).getByText(text('pwf.band.overdue.text', { days: 2, unit: text('pwf.unit.working.word') }))).toBeTruthy();
    expect(within(line).getByText('10/12/2026')).toBeTruthy();
    expect(line.textContent).toContain(text('pwf6.flow.critical.mark'));
    expect(line.textContent).toContain('T2');
    expect(within(line).getByText('Nguyễn Văn An')).toBeTruthy();
    expect(within(line).getByRole('link', { name: 'Công việc 2' }).getAttribute('href')).toBe(`/pwf/pwf-04?id=${uuid(1002)}&project=${PROJECT_ID}`);
    expect(line.textContent).toContain('DA-001');
    expect(within(line).getByRole('link', { name: 'Dự án thử' }).getAttribute('href')).toBe(`/prj/prj-03?id=${PROJECT_ID}&tab=workflow`);
  });

  it('counts each colour from the totals of the server, not from the rows, each with its "i"', async () => {
    open({ board: board({ counts_by_band: { NONE: 4, GREEN: 30, YELLOW: 12, RED: 7, UNKNOWN: 0 }, total: 53 }) });
    await ready();
    expect(within(screen.getByTestId('count-red')).getByText('7')).toBeTruthy();
    expect(within(screen.getByTestId('count-yellow')).getByText('12')).toBeTruthy();
    expect(within(screen.getByTestId('count-green')).getByText('30')).toBeTruthy();
    expect(within(screen.getByTestId('count-none')).getByText('4')).toBeTruthy();
    // One "i" says the formula of the five counts.
    expect(screen.getAllByRole('button', { name: /Công thức và nguồn/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Công thức và nguồn/ }));
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.board.count.formula'));
  });

  it('says "showing N of M" with the exact total and has no personal colour anywhere', async () => {
    open({ board: board({ total: 120, shown: 1 }) });
    await ready();
    expect(screen.getByTestId('range').textContent).toBe(text('pwf.board.range.text', { shown: 1, total: 120 }));
    expect(screen.getByTestId('official-notice').textContent).toBe(text('pwf.board.official.notice'));
    expect(document.body.textContent).not.toContain('theo cài đặt của bạn');
  });

  it('says the list is cut when the server cut it, and loads the next page with the cursor', async () => {
    const h = open({
      board: (input: Record<string, unknown>) => {
        const cursor = (input.query as { cursor?: string }).cursor;
        return cursor === undefined
          ? board({ truncated: true, total: 3, shown: 1, next_cursor: 'c2' })
          : board({ items: [row(3, { task_code: 'T3', task_id: uuid(1003), band: band('GREEN') })], total: 3, shown: 1, next_cursor: null });
      },
    });
    await ready();
    expect(screen.getByTestId('truncated').textContent).toContain(text('pwf.board.truncated.notice', { total: 3 }));
    fireEvent.click(screen.getByTestId('more'));
    await waitFor(() => expect(document.querySelectorAll('[data-task-id]')).toHaveLength(2));
    expect(queryOf(h, 'getDeadlineBoard').cursor).toBe('c2');
    expect(screen.getByTestId('range').textContent).toBe(text('pwf.board.range.text', { shown: 2, total: 3 }));
    expect(screen.queryByTestId('more')).toBeNull();
  });

  it('never shows a date or a green for a task whose deadline cannot be counted, and says how many there are', async () => {
    open({
      board: board({
        items: [row(1, { due_date: null, band: band('UNKNOWN', { reason: 'CALENDAR_UNAVAILABLE' }) })],
        counts_by_band: { NONE: 0, GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 1 },
      }),
    });
    await ready();
    const line = document.querySelector('[data-task-id]') as HTMLElement;
    expect(within(line).getByText(text('pwf.board.unknown.text'))).toBeTruthy();
    expect(within(line).getByText(text('pwf.band.unknown.word'))).toBeTruthy();
    expect(within(line).queryByText(text('pwf.band.green.word'))).toBeNull();
    expect(screen.getByTestId('unknown-notice').textContent).toContain(text('pwf.board.unknown.notice', { count: 1 }));
  });

  it('shows an unassigned task as such', async () => {
    open({ board: board({ items: [row(1, { assignee: null })] }) });
    await ready();
    expect(screen.getByText(text('pwf.board.unassigned.text'))).toBeTruthy();
  });
});

describe('PWF-07: the filters', () => {
  it('reads the filters from the address and sends them, so a reload keeps the board', async () => {
    const h = open({ path: '/pwf/pwf-07?band=RED&phase=EXECUTION&status=IN_PROGRESS&from=2026-12-01&to=2026-12-31&assignee=a1&unit=u1' });
    await ready();
    expect(queryOf(h, 'getDeadlineBoard')).toMatchObject({ band: 'RED', phase: 'EXECUTION', status: 'IN_PROGRESS', due_from: '2026-12-01', due_to: '2026-12-31', assignee_id: 'a1', unit_id: 'u1' });
    expect(screen.getByTestId('count-red').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('filter-status-IN_PROGRESS').getAttribute('aria-pressed')).toBe('true');
  });

  it('filters by colour, phase, person, unit, status and days, one read each time', async () => {
    const h = open();
    await ready();
    await screen.findByRole('option', { name: 'Ban quản lý dự án 1' });
    // The count of a colour is the filter of that colour (a count that is no filter, "not yet in range", is a plain tile).
    expect(screen.getByTestId('count-none').tagName).toBe('DIV');
    fireEvent.click(screen.getByTestId('count-yellow'));
    await waitFor(() => expect(queryOf(h, 'getDeadlineBoard').band).toBe('YELLOW'));
    fireEvent.change(screen.getByTestId('filter-unit'), { target: { value: uuid(60) } });
    await waitFor(() => expect(queryOf(h, 'getDeadlineBoard').unit_id).toBe(uuid(60)));
    fireEvent.change(screen.getByTestId('filter-assignee'), { target: { value: uuid(61) } });
    await waitFor(() => expect(queryOf(h, 'getDeadlineBoard').assignee_id).toBe(uuid(61)));
    fireEvent.click(screen.getByTestId('filter-status-ON_HOLD'));
    await waitFor(() => expect(queryOf(h, 'getDeadlineBoard').status).toBe('ON_HOLD'));
    fireEvent.change(screen.getByTestId('filter-phase'), { target: { value: 'PREPARATION' } });
    await waitFor(() => expect(queryOf(h, 'getDeadlineBoard').phase).toBe('PREPARATION'));
    fireEvent.change(screen.getByTestId('filter-from'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByTestId('filter-to'), { target: { value: '2026-12-31' } });
    await waitFor(() => expect(queryOf(h, 'getDeadlineBoard')).toMatchObject({ band: 'YELLOW', due_from: '2026-12-01', due_to: '2026-12-31', status: 'ON_HOLD', phase: 'PREPARATION' }));
    fireEvent.click(screen.getByTestId('filter-clear'));
    await waitFor(() => expect(queryOf(h, 'getDeadlineBoard').band).toBeUndefined());
  });

  it('asks for the code of a unit when the register of units cannot be read', async () => {
    const h = open({ units: [] });
    await ready();
    fireEvent.change(await screen.findByTestId('filter-unit'), { target: { value: 'BQL9' } });
    await waitFor(() => expect(queryOf(h, 'getDeadlineBoard').unit_id).toBe('BQL9'));
    expect(screen.getByLabelText(text('pwf.board.filter.unitId.label'))).toBeTruthy();
  });

  it('offers the people the rows are given to when the membership register cannot be read', async () => {
    open({ members: new Error('no') });
    await ready();
    expect(await screen.findByRole('option', { name: 'Nguyễn Văn An' })).toBeTruthy();
  });

  it('says there is nothing for the filters, and clears them from the empty table', async () => {
    open({ path: '/pwf/pwf-07?band=GREEN', board: board({ items: [], total: 0, shown: 0, counts_by_band: { NONE: 0, GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0 } }) });
    expect(await screen.findByText(text('ui.dataTable.emptyFiltered'))).toBeTruthy();
  });
});

describe('PWF-07: the calendar', () => {
  const openCalendar = (setup: Setup = {}) => open({ path: '/pwf/pwf-07?view=calendar&month=2026-12', ...setup });

  it('opens with arrow keys between the tabs, and shows the month with the count of each colour in words', async () => {
    const h = openCalendar();
    const grid = await screen.findByTestId('calendar-grid');
    expect(queryOf(h, 'getDeadlineCalendar')).toEqual({ month: '2026-12' });
    expect(screen.getByRole('tab', { name: text('pwf.board.tab.calendar.label') }).getAttribute('aria-selected')).toBe('true');
    const cell = within(grid).getByTestId('day-2026-12-10');
    expect(cell.textContent).toContain(text('pwf.board.calendar.day.label', { date: '10/12/2026', total: 3 }));
    expect(within(cell).getByText(`⛔ ${text('pwf.band.red.word')} 2`)).toBeTruthy();
    expect(within(cell).getByText(`⚠ ${text('pwf.band.yellow.word')} 1`)).toBeTruthy();
    expect(screen.getByTestId('calendar-range').textContent).toBe(text('pwf.board.calendar.range.text', { shown: 2, total: 3 }));
  });

  it('lists the tasks of a chosen day, each linked, and moves to the next and the previous month', async () => {
    const h = openCalendar();
    fireEvent.click(await screen.findByTestId('day-2026-12-10'));
    const day = screen.getByTestId('selected-day');
    expect(day.textContent).toContain(text('pwf.board.calendar.selected.title', { date: '10/12/2026' }));
    expect(within(day).getByRole('link', { name: 'Công việc 2' }).getAttribute('href')).toContain('/pwf/pwf-04?id=');
    expect(within(day).getByText(text('pwf.band.red.word'))).toBeTruthy();
    fireEvent.click(screen.getByTestId('calendar-next'));
    await waitFor(() => expect(queryOf(h, 'getDeadlineCalendar').month).toBe('2027-01'));
    expect(screen.queryByTestId('selected-day')).toBeNull();
    fireEvent.click(screen.getByTestId('calendar-prev'));
    fireEvent.click(screen.getByTestId('calendar-prev'));
    await waitFor(() => expect(queryOf(h, 'getDeadlineCalendar').month).toBe('2026-11'));
  });

  it('says the calendar is cut when the server cut it, and says an empty month is empty', async () => {
    openCalendar({ calendar: calendarBody({ truncated: true, total: 9 }) });
    expect((await screen.findByTestId('calendar-truncated')).textContent).toContain(text('pwf.board.calendar.truncated.notice', { total: 9 }));
    cleanup();
    openCalendar({ calendar: calendarBody({ days: [], total: 0, shown: 0 }) });
    expect(await screen.findByText(text('pwf.board.calendar.empty.text'))).toBeTruthy();
  });

  it('starts at the current month when the address names none, and passes the person and the unit', async () => {
    const h = open({ path: '/pwf/pwf-07?view=calendar&assignee=a1&unit=u1&band=RED' });
    await screen.findByTestId('calendar-grid');
    expect(queryOf(h, 'getDeadlineCalendar')).toEqual({ month: '2026-11', assignee_id: 'a1', unit_id: 'u1' });
  });
});

describe('PWF-07: milestones and workload', () => {
  it('lists the milestones of the next 30 days with the slip in words and the risk with an icon', async () => {
    const h = open({ path: '/pwf/pwf-07?view=milestones&unit=u1' });
    const table = await screen.findByTestId('milestones-table');
    expect(queryOf(h, 'getUpcomingMilestones')).toEqual({ days: 30, unit_id: 'u1' });
    expect(within(table).getByText(text('pwf.board.slip.late.text', { days: 3 }))).toBeTruthy();
    expect(within(table).getByText(text('pwf.board.slip.early.text', { days: 1 }))).toBeTruthy();
    expect(within(table).getByText(text('pwf.board.slip.none.text'))).toBeTruthy();
    expect(within(table).getByText(text('pwf.board.risk.yes.word'))).toBeTruthy();
    expect(within(table).getAllByText(text('pwf.board.risk.no.word')).length).toBeGreaterThan(0);
    expect(within(table).getByRole('link', { name: 'Mốc 1' }).getAttribute('href')).toContain('/pwf/pwf-04?id=');
    expect(screen.getByTestId('milestones-total').textContent).toBe(text('pwf.board.milestones.total.text', { total: 3 }));
  });

  it('says there is no milestone in the period', async () => {
    open({ path: '/pwf/pwf-07?view=milestones', milestones: milestoneBody({ items: [], total: 0 }) });
    expect(await screen.findByText(text('pwf.board.milestones.empty.text'))).toBeTruthy();
  });

  it('shows the workload by person and week as a display only table, heaviest first, with no control that changes it', async () => {
    const h = open({ path: '/pwf/pwf-07?view=workload' });
    const table = await screen.findByTestId('workload-table');
    expect(queryOf(h, 'getProjectWorkload')).toEqual({ weeks: 8 });
    expect(screen.getByTestId('display-only').textContent).toBe(text('pwf.board.workload.display.notice'));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getByText('Trần Thị Bình')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('5.5')).toBeTruthy();
    // The only buttons are the "i" of the totals: nothing moves work from one person to another.
    expect(within(table).getAllByRole('button').every((button) => /Công thức và nguồn/.test(button.getAttribute('aria-label') ?? ''))).toBe(true);
    expect(within(table).getAllByText(text('pwf6.workload.week.header', { date: '07/12' }))).toHaveLength(1);
  });

  it('says nobody has work in the period', async () => {
    open({ path: '/pwf/pwf-07?view=workload', workload: workloadBody({ people: [] }) });
    expect(await screen.findByText(text('pwf.board.workload.empty.text'))).toBeTruthy();
  });

  it('moves between the four views with the arrow keys and writes the view in the address', async () => {
    open();
    await ready();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    tabs[0]?.focus();
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
    expect(await screen.findByTestId('calendar-grid')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'End' });
    expect(await screen.findByTestId('workload-table')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'Home' });
    expect(await screen.findByTestId('board-list')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowLeft' });
    expect(await screen.findByTestId('workload-table')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'a' });
    expect(screen.getByTestId('workload-table')).toBeTruthy();
  });
});

describe('PWF-07: the states', () => {
  it('shows the loading state, never a count of zero', () => {
    open({ board: () => new Promise(() => undefined) });
    expect(screen.queryByTestId('count-red')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('shows the error state with a retry that reads again', async () => {
    const h = open({ board: refusal('INTERNAL_ERROR', 500) });
    fireEvent.click(await screen.findByRole('button', { name: text('states.retry.action') }));
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'getDeadlineBoard').length).toBeGreaterThan(1));
  });

  it('shows the denied state for a person without the permission and reads nothing', async () => {
    const h = open({ permissions: ['x.other'] });
    expect((await screen.findByRole('alert')).textContent).toContain(text('states.denied.title'));
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the denied state when the server refuses the read', async () => {
    open({ board: refusal('SCOPE_DENIED', 403) });
    expect((await screen.findByRole('alert')).textContent).toContain(text('states.denied.title'));
  });

  it('says the figures are old when they were read long ago, and reads again on demand', async () => {
    vi.setSystemTime(new Date('2026-11-12T04:30:00.000Z'));
    const h = open();
    const notice = await screen.findByTestId('stale');
    expect(notice.textContent).toContain('10:00');
    fireEvent.click(within(notice).getByRole('button', { name: text('pwf.board.reload.action') }));
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'getDeadlineBoard').length).toBeGreaterThan(1));
  });

  it('says one view could not be read while the board was, and keeps the counts', async () => {
    open({ path: '/pwf/pwf-07?view=calendar', calendar: refusal('INTERNAL_ERROR', 500) });
    expect((await screen.findByTestId('partial')).textContent).toContain(text('pwf.board.partial.notice', { view: text('pwf.board.tab.calendar.label') }));
    expect(screen.getByTestId('count-red')).toBeTruthy();
  });

  it('works for a person who may only read', async () => {
    open({ permissions: READ_ONLY });
    await ready();
    expect(screen.getByTestId('range')).toBeTruthy();
  });
});

describe('PWF-07: accessibility', () => {
  it.each([
    ['the list', '/pwf/pwf-07', 'board-list'],
    ['the calendar', '/pwf/pwf-07?view=calendar&month=2026-12', 'calendar-grid'],
    ['the milestones', '/pwf/pwf-07?view=milestones', 'milestones-table'],
    ['the workload', '/pwf/pwf-07?view=workload', 'workload-table'],
  ])('has no serious violation in %s', async (_name, path, testId) => {
    open({ path });
    await screen.findByTestId(testId);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
