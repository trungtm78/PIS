import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../prj/test-support';
import { ALL_PERMISSIONS, PROJECT_ID, READ_ONLY, refusal, routeOf, text, workflowTask } from '../test/fixtures';
import { TASKS, detail, gate, open, schedule, taskList } from './test/fixtures';
import type { Setup } from './test/fixtures';
import WorkflowScreen from './WorkflowScreen';

afterEach(cleanup);

const route = routeOf('PWF-03');
const PATH = `/pwf/pwf-03?id=${PROJECT_ID}`;

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

const show = (setup: Setup = {}, permissions: readonly string[] = ALL_PERMISSIONS, path = PATH, mode?: 'FULL' | 'READ_ONLY') => {
  const h = open(setup);
  const view = mount(
    <>
      <WorkflowScreen route={route} />
      <Where />
    </>,
    h,
    { permissions, path, ...(mode === undefined ? {} : { mode }) },
  );
  return { h, ...view };
};
const ready = () => screen.findByTestId('workflow');
const selectOf = (label: string) => screen.getByRole('combobox', { name: label });
const infoButtons = () => screen.getAllByRole('button', { name: /Công thức và nguồn của/ });

describe('PWF-03: the workflow of a project', () => {
  it('shows the frozen template, the state, the schedule figures with their "i" and the count of tasks by official colour', async () => {
    show();
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(text('pwf.flow.page.title'));
    await screen.findByText('DA-2026-001 · Dự án số 1');
    const facts = screen.getByTestId('workflow-facts');
    expect(facts.textContent).toContain(text('pwf6.flow.template.text', { name: text('pwf6.template.publicInvestment.word'), version: text('pwf6.version.numbered.text', { version: 3 }) }));
    expect(facts.textContent).toContain('PUBLIC_INVESTMENT');
    expect(facts.textContent).toContain('a'.repeat(12));
    expect(facts.textContent).toContain('01/12/2026');
    expect(screen.getByTestId('workflow-status').textContent).toContain(text('pwf.flow.status.active.word'));
    expect(screen.queryByTestId('unverified')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('project-finish').textContent).toContain('12/02/2027'));
    expect(screen.getByTestId('critical-count').textContent).toContain(text('pwf.flow.kpi.tasks.text', { count: 2 }));
    expect(screen.getByTestId('variance').textContent).toContain(text('pwf6.flow.variance.text', { days: 5, task: 'Công việc 3' }));
    // The three colours as tiles, with words and glyphs, and every figure has its "i".
    const group = screen.getByRole('group', { name: text('pwf.flow.kpi.group.label') });
    for (const word of ['red', 'yellow', 'green', 'none', 'unknown']) expect(group.textContent).toContain(text(`pwf.band.${word}.word`));
    expect(group.textContent).toContain('⛔');
    // One "i" for the strip of counts, and one for each figure of the schedule.
    expect(within(group).getAllByRole('button', { name: /Công thức và nguồn của/ }).length).toBe(1);
    expect(infoButtons().length).toBeGreaterThan(6);
  });

  it('labels a template that was not confirmed, and says a workflow on hold is on hold', async () => {
    show({ workflow: () => detail({ unverified: true, status: 'ON_HOLD' }) });
    await ready();
    expect(screen.getByTestId('unverified').textContent).toContain(text('pwf.common.unverified.label'));
    expect(screen.getByText(text('pwf.flow.unverified.note'))).toBeTruthy();
    expect(screen.getByText(text('pwf.flow.hold.note'))).toBeTruthy();
    expect(screen.getByTestId('workflow-status').textContent).toContain(text('pwf.flow.status.onHold.word'));
    expect(screen.getAllByText(text('ui.stepper.status.hold')).length).toBeGreaterThan(0);
  });

  it('says in words that a workflow is completed or cancelled', async () => {
    const { unmount } = show({ workflow: () => detail({ status: 'COMPLETED' }) });
    await ready();
    expect(screen.getByTestId('workflow-status').textContent).toContain(text('pwf.flow.status.completed.word'));
    unmount();
    show({ workflow: () => detail({ status: 'CANCELLED' }) });
    await ready();
    expect(screen.getByTestId('workflow-status').textContent).toContain(text('pwf.flow.status.cancelled.word'));
  });

  it('offers the button "what if the start date moves" only to who may propose it, and not in a read-only session', async () => {
    const { unmount } = show();
    await ready();
    expect(screen.getByTestId('reschedule-link').getAttribute('href')).toBe(`/pwf/pwf-06?id=${PROJECT_ID}`);
    unmount();
    const second = show({ workflow: () => detail({ can_propose_reschedule: false }) });
    await ready();
    expect(screen.queryByTestId('reschedule-link')).toBeNull();
    second.unmount();
    show({}, ALL_PERMISSIONS, PATH, 'READ_ONLY');
    await ready();
    expect(screen.queryByTestId('reschedule-link')).toBeNull();
  });

  it('says a deadline that cannot be counted, names the missing calendar year, and never guesses a date or a green', async () => {
    show();
    await ready();
    expect(screen.getByTestId('calendar-missing').textContent).toContain('2028');
    const card = await screen.findByTestId('card-T5');
    expect(card.textContent).toContain(text('pwf.common.calendarMissingYear.text', { year: 2028 }));
    expect(card.textContent).toContain(text('pwf.band.unknown.word'));
    expect(card.textContent).not.toContain(text('pwf.band.green.word'));
    expect(card.querySelector('[data-band="GREEN"]')).toBeNull();
  });

  it('shows the phases as a stepper with the required tasks done', async () => {
    show();
    await ready();
    const list = screen.getByRole('list', { name: text('pwf.flow.stepper.label') });
    expect(within(list).getByText('Chuẩn bị đầu tư')).toBeTruthy();
    expect(within(list).getByText(text('pwf.flow.stepper.progress.text', { done: 1, total: 2 }))).toBeTruthy();
    expect(within(list).getByText(text('ui.stepper.status.late'))).toBeTruthy();
  });
});

describe('PWF-03: the states', () => {
  it('says the project has no workflow and links to the form that starts one, for who may start it', async () => {
    const { unmount } = show({ workflow: () => refusal('RESOURCE_NOT_FOUND', 404) });
    expect((await screen.findByTestId('no-workflow')).textContent).toBe(text('pwf.flow.empty.body'));
    expect(screen.getByTestId('start-link').getAttribute('href')).toBe(`/pwf/pwf-05?id=${PROJECT_ID}`);
    unmount();
    show({ workflow: () => refusal('RESOURCE_NOT_FOUND', 404) }, READ_ONLY);
    await screen.findByTestId('no-workflow');
    expect(screen.queryByTestId('start-link')).toBeNull();
  });

  it('shows the denied card when the server refuses the read, and the error card with a retry that reads again', async () => {
    const denied = show({ workflow: () => refusal('SCOPE_DENIED', 403) });
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
    denied.unmount();
    let calls = 0;
    show({ workflow: () => (calls++ === 0 ? new Error('boom') : detail()) });
    expect(await screen.findByText(text('states.error.title'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    await ready();
    expect(calls).toBe(2);
  });

  it('shows the loading card while the workflow is read', async () => {
    show({ workflow: () => new Promise(() => undefined) });
    expect(await screen.findByRole('status', { busy: true })).toBeTruthy();
  });

  it('keeps what was read and says so when a part could not be read, and the retry reads that part again', async () => {
    let calls = 0;
    show({ schedule: () => (calls++ === 0 ? new Error('schedule down') : schedule()) });
    const partial = await screen.findByTestId('partial');
    expect(partial.textContent).toContain(text('pwf.flow.partial.text'));
    expect(screen.getByTestId('board')).toBeTruthy();
    expect(screen.getByTestId('critical-count').textContent).toContain(text('pwf.flow.finish.unknown.text'));
    fireEvent.click(within(partial).getByRole('button', { name: text('ui.common.retry') }));
    await waitFor(() => expect(screen.queryByTestId('partial')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('critical-count').textContent).toContain(text('pwf.flow.kpi.tasks.text', { count: 2 })));
  });

  it('keeps what was read for the list and the gates when they fail, each saying so', async () => {
    show({ tasks: () => new Error('list down'), gate: () => new Error('gate down') });
    expect(await screen.findByTestId('board-failed')).toBeTruthy();
    expect((await screen.findAllByText(text('pwf.flow.gate.failed.text'))).length).toBe(2);
    expect(screen.getByTestId('gate-submitProjectForAppraisal').textContent).toContain(text('pwf.flow.gate.summary.text', { count: 1 }));
  });

  it('says the figures may be out of date when the server computed them long before they were read', async () => {
    show({ workflow: () => detail({ as_of: '2020-01-01T00:00:00.000Z' }) });
    const stale = await screen.findByTestId('stale');
    expect(stale.textContent).toContain(text('pwf.flow.stale.text', { time: '00:00' }));
    expect(screen.queryByTestId('partial')).toBeNull();
  });

  it('asks for a project when the address names none', () => {
    show({}, ALL_PERMISSIONS, '/pwf/pwf-03');
    expect(screen.getByTestId('no-project').textContent).toBe(text('pwf.flow.noProject.notice'));
  });

  it('links back to the workspace of the project', async () => {
    show();
    await ready();
    expect(screen.getByRole('link', { name: text('pwf.flow.back.link') }).getAttribute('href')).toBe(`/prj/prj-03?id=${PROJECT_ID}`);
  });
});

describe('PWF-03: the tree, the schedule and the milestones', () => {
  it('reads the workflow as one tree in a table: phase, then task, each with its state, day, person and progress; a phase folds and filters the board', async () => {
    show();
    await ready();
    const outline = screen.getByTestId('outline');
    const phase = outline.querySelector('[data-node-id="phase:PREPARATION"]') as HTMLElement;
    expect(phase.textContent).toContain('Chuẩn bị đầu tư');
    expect(phase.textContent).toContain(text('pwf6.outline.late.text', { count: 1 }));
    expect(phase.textContent).toContain(text('pwf6.meter.value.text', { done: 1, total: 2, percent: 50 }));
    // A task is its name linked to its screen, with its code as a note.
    const task = outline.querySelector('[data-task="T2"]') as HTMLElement;
    expect(within(task).getByRole('link', { name: TASKS[1]?.name ?? '' }).getAttribute('href')).toBe(`/pwf/pwf-04?id=${TASKS[1]?.id ?? ''}&project=${PROJECT_ID}`);
    expect(task.textContent).toContain('T2');
    expect(task.textContent).toContain(text('pwf.band.red.word'));
    expect(task.getAttribute('data-health')).toBe('late');
    // The button of a phase filters the board to it, and clears the filter when pressed again.
    fireEvent.click(outline.querySelector('[data-action="filter-phase-EXECUTION"]') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('board').querySelectorAll('[data-testid^="card-"]').length).toBe(3));
    expect((selectOf(text('pwf.flow.filter.phase.label')) as HTMLSelectElement).value).toBe('EXECUTION');
    fireEvent.click(outline.querySelector('[data-action="filter-phase-EXECUTION"]') as HTMLElement);
    await waitFor(() => expect((selectOf(text('pwf.flow.filter.phase.label')) as HTMLSelectElement).value).toBe(''));
    // A phase folds: its tasks leave the table, and "collapse all" folds every phase.
    fireEvent.click(within(phase).getByRole('button', { expanded: true }));
    expect(outline.querySelector('[data-task="T2"]')).toBeNull();
    expect(outline.querySelector('[data-task="T3"]')).not.toBeNull();
    fireEvent.click(document.querySelector('[data-action="outline-toggle-all"]') as HTMLElement);
    expect(outline.querySelectorAll('[data-task]').length).toBe(0);
    fireEvent.click(document.querySelector('[data-action="outline-toggle-all"]') as HTMLElement);
    expect(outline.querySelectorAll('[data-task]').length).toBe(5);
  });

  it('draws the schedule on a time axis with a legend, names the tasks, says the critical path by name, and gives the same facts as a table', async () => {
    show();
    await ready();
    await waitFor(() => expect(screen.getByTestId('critical-path').textContent).toContain('Việc T2'));
    expect([...screen.getByTestId('critical-path').querySelectorAll('li')].map((item) => item.getAttribute('data-code'))).toEqual(['T2', 'T3']);
    const gantt = screen.getByTestId('gantt');
    for (const key of ['current', 'done', 'baseline', 'late', 'critical', 'milestone']) expect(gantt.textContent).toContain(text(`pwf6.gantt.legend.${key}`));
    // The label of a row is the name of the task with its code; the axis names the months.
    expect((gantt.querySelector('[data-row="T2"]') as HTMLElement).textContent).toContain('Việc T2');
    expect(gantt.textContent).toContain(text('pwf6.gantt.month.text', { month: '12', year: 2026 }));
    // What the bar runs past the baseline is said in days next to it.
    expect(gantt.textContent).toContain(text('pwf6.gantt.variance.text', { days: 5 }));
    expect(gantt.querySelectorAll('.pwf-gantt__bar[data-critical="true"]').length).toBe(2);
    expect(gantt.querySelectorAll('.pwf-gantt__milestone').length).toBe(1);
    expect(gantt.textContent).toContain(text('pwf.flow.gantt.noDate.mark'));
    const table = within(gantt).getByRole('table', { name: text('pwf6.gantt.table.caption') });
    expect(within(table).getAllByRole('row').length).toBe(6);
    expect(table.textContent).toContain('10/12/2026');
  });

  it('says when no task has a date yet, and that no task is on the critical path', async () => {
    show({ schedule: () => schedule({ critical_path: [], tasks: [schedule().tasks[4] as never] }) });
    await ready();
    expect((await screen.findByTestId('gantt-empty')).textContent).toBe(text('pwf6.gantt.empty.text'));
    expect(screen.getByTestId('critical-path').textContent).toContain(text('pwf.flow.gantt.pathNone.text'));
  });

  it('says the schedule cannot be read, with a retry, when its read fails', async () => {
    show({ schedule: () => new Error('down') });
    expect((await screen.findByTestId('gantt-failed')).textContent).toContain(text('pwf6.gantt.failed.text'));
  });

  it('lists the milestones by date with the word of their colour, or says there are none with a date', async () => {
    const { unmount } = show();
    await ready();
    // A plan table of its own: the day, the milestone by name with its code, its phase and its state; nothing of a log (no hour, no author).
    const row = screen.getByTestId('milestones').querySelector('[data-milestone="T4"]') as HTMLElement;
    expect(within(row).getByRole('link', { name: 'Mốc khởi công' }).getAttribute('href')).toBe(`/pwf/pwf-04?id=${TASKS[3]?.id ?? ''}&project=${PROJECT_ID}`);
    expect(row.textContent).toContain('12/02/2027');
    expect(row.textContent).toContain('Thực hiện đầu tư');
    expect(row.textContent).toContain(text('pwf.band.green.word'));
    expect(row.textContent).not.toContain('00:00');
    unmount();
    show({ workflow: () => detail({ tasks: TASKS.filter((task) => task.kind !== 'MILESTONE') }) });
    expect((await screen.findByTestId('no-milestones')).textContent).toBe(text('pwf.flow.timeline.empty.text'));
  });
});

describe('PWF-03: the board and its filters', () => {
  it('shows the tasks by phase with status, colour, person and the critical marker, and "showing N of M" with the exact total', async () => {
    show();
    const board = await screen.findByTestId('board');
    expect(within(board).getByRole('heading', { name: 'Chuẩn bị đầu tư' })).toBeTruthy();
    const card = within(board).getByTestId('card-T2');
    expect(card.getAttribute('data-critical')).toBe('true');
    expect(card.textContent).toContain(text('pwf.flow.critical.word'));
    expect(card.textContent).toContain(text('pwf.band.red.word'));
    expect(card.textContent).toContain('Nguyễn Văn An');
    expect(within(board).getByTestId('card-T3').textContent).toContain(text('pwf.flow.board.unassigned.text'));
    expect(within(board).getByRole('link', { name: 'Công việc 2' }).getAttribute('href')).toBe(`/pwf/pwf-04?id=${TASKS[1]?.id ?? ''}&project=${PROJECT_ID}`);
    // A finished task has no colour.
    expect(within(board).getByTestId('card-T1').querySelector('.pwf-band')).toBeNull();
    expect(screen.getByTestId('board-count').textContent).toContain(text('pwf.flow.board.shown.text', { shown: 5, total: 5 }));
  });

  it('reads the list again with the filter chosen and clears it', async () => {
    const { h } = show();
    await screen.findByTestId('board');
    fireEvent.change(selectOf(text('pwf.flow.filter.band.label')), { target: { value: 'RED' } });
    await waitFor(() => expect(screen.getByTestId('board-count').textContent).toContain(text('pwf.flow.board.shown.text', { shown: 1, total: 1 })));
    expect(h.read).toHaveBeenCalledWith('listProjectTasks', { path: { project_id: PROJECT_ID }, query: { band: 'RED', limit: 50 } });
    fireEvent.change(selectOf(text('pwf.flow.filter.status.label')), { target: { value: 'IN_PROGRESS' } });
    fireEvent.change(selectOf(text('pwf.flow.filter.assignee.label')), { target: { value: TASKS[1]?.assignee?.membership_id ?? '' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listProjectTasks', expect.objectContaining({ query: expect.objectContaining({ status: 'IN_PROGRESS', assignee_id: TASKS[1]?.assignee?.membership_id }) })));
    fireEvent.click(document.querySelector('[data-action="clear-filters"]') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('board-count').textContent).toContain(text('pwf.flow.board.shown.text', { shown: 5, total: 5 })));
    expect(document.querySelector('[data-action="clear-filters"]')).toBeNull();
  });

  it('reads the next page on request and says how many of the exact total are shown', async () => {
    const tasks = (input: Record<string, unknown>) => {
      const cursor = (input.query as { cursor?: string }).cursor;
      return cursor === undefined ? { ...taskList({}), items: TASKS.slice(0, 2), next_cursor: 'c2', total: 5 } : { ...taskList({}), items: TASKS.slice(2), next_cursor: null, total: 5 };
    };
    show({ tasks });
    await waitFor(() => expect(screen.getByTestId('board-count').textContent).toContain(text('pwf.flow.board.shown.text', { shown: 2, total: 5 })));
    fireEvent.click(document.querySelector('[data-action="more"]') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('board-count').textContent).toContain(text('pwf.flow.board.shown.text', { shown: 5, total: 5 })));
    expect(document.querySelector('[data-action="more"]')).toBeNull();
  });

  it('puts a task of a phase the template does not list in a column of its own', async () => {
    const stray = workflowTask(9, { phase_code: 'STRAY' });
    show({ tasks: () => ({ ...taskList({}), items: [stray], total: 1 }) });
    const board = await screen.findByTestId('board');
    expect(within(board).getByRole('heading', { name: 'STRAY' })).toBeTruthy();
    expect(within(board).getByTestId('card-T9').textContent).toContain(text('pwf.band.green.word'));
    expect(within(board).getAllByText(text('pwf.flow.board.empty.text')).length).toBe(2);
  });

  it('shows the board loading while the list is read', async () => {
    show({ tasks: () => new Promise(() => undefined) });
    expect(await screen.findByTestId('board-loading')).toBeTruthy();
  });
});

describe('PWF-03: the gates of the project commands', () => {
  it('shows each gate open or closed in words and glyph and, for a closed one, the missing tasks with the reason and a link to each', async () => {
    show();
    const closed = await screen.findByTestId('gate-submitProjectForAppraisal');
    await waitFor(() => expect(closed.querySelector('ul')).not.toBeNull());
    expect(closed.textContent).toContain(text('pwf.gate.submit.word'));
    expect(closed.textContent).toContain(text('pwf.flow.gate.closed.word'));
    expect(closed.textContent).toContain('⛔');
    expect(closed.getAttribute('data-state')).toBe('waiting');
    expect(within(closed).getByRole('link', { name: 'Công việc 2' }).getAttribute('href')).toBe(`/pwf/pwf-04?id=${TASKS[1]?.id ?? ''}&project=${PROJECT_ID}`);
    expect(closed.textContent).toContain(text('pwf.missing.notDone.text'));
    expect(closed.textContent).toContain(`T9 · ${text('pwf.missing.noState.text')}`);
    const open = screen.getByTestId('gate-startProjectImplementation');
    await waitFor(() => expect(open.getAttribute('data-open')).toBe('true'));
    expect(open.textContent).toContain(text('pwf.flow.gate.open.word'));
  });

  it('B15: a gate of a phase the project has not reached says so in neutral words, not that it is closed', async () => {
    show({
      workflow: () => detail({ gates: detail().gates.map((one) => (one.target === 'startProjectImplementation' ? { ...one, open: false, missing_count: 1, standing: 'NOT_DUE' as const, phases: ['EXECUTION'] } : one)) }),
      gate: (input: unknown) => {
        const answer = gate(input as Record<string, unknown>);
        return answer.target === 'startProjectImplementation' ? { ...answer, open: false, standing: 'NOT_DUE', phases: ['EXECUTION'] } : { ...answer, standing: 'CLOSED', phases: ['PREPARATION'] };
      },
    });
    const ahead = await screen.findByTestId('gate-startProjectImplementation');
    await waitFor(() => expect(ahead.getAttribute('data-standing')).toBe('NOT_DUE'));
    expect(ahead.textContent).toContain(text('pwf.flow.gate.notDue.word'));
    expect(ahead.textContent).not.toContain(text('pwf.flow.gate.closed.word'));
    expect(screen.getByTestId('gate-submitProjectForAppraisal').getAttribute('data-standing')).toBe('CLOSED');
    // The standing of the server decides the look: neutral words, no red glyph, and the list of tasks folded until asked for.
    expect(ahead.getAttribute('data-state')).toBe('upcoming');
    expect(ahead.textContent).not.toContain('⛔');
  });

  it('says a command with no gate has none, and a workflow with no gate declared says so', async () => {
    show({ gate: (input: Record<string, unknown>) => ({ ...gate(input), gated: false, open: true, missing: [] }) });
    const row = await screen.findByTestId('gate-submitProjectForAppraisal');
    await waitFor(() => expect(row.textContent).toContain(text('pwf.flow.gate.ungated.word')));
    cleanup();
    show({ workflow: () => detail({ gates: [] }) });
    expect((await screen.findByTestId('no-gates')).textContent).toBe(text('pwf.flow.gate.none.text'));
  });
});

describe('PWF-03: accessibility', () => {
  it('has no serious violation with the workflow, the board and the gates on screen', async () => {
    const { container } = show();
    await screen.findByTestId('card-T5');
    await waitFor(() => expect(screen.getByTestId('critical-path')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('gate-submitProjectForAppraisal').querySelector('ul')).not.toBeNull());
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
