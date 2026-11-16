import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import { projectBody } from '../start/test/fixtures';
import { ALL_PERMISSIONS, PROJECT_ID, READ_ONLY, refusal, routeOf, serve, text, workflowTask } from '../test/fixtures';
import type { Answer } from '../test/fixtures';
import RescheduleScreen from './RescheduleScreen';
import { PROPOSAL_ID, REASON, preview, schedule, workflow } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-06');

interface Setup {
  path?: string;
  permissions?: readonly string[];
  workflow?: Answer;
  schedule?: Answer;
  commands?: Record<string, Answer>;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      get_resources_project_id: projectBody(),
      getProjectWorkflow: setup.workflow ?? workflow(),
      getProjectSchedule: setup.schedule ?? schedule(),
    },
    setup.commands ?? { proposeProjectReschedule: preview(), decideProjectReschedule: { resource_id: PROPOSAL_ID, status: 'APPROVED', resource_version: 2 } },
  );
  mount(<RescheduleScreen route={route} />, h, setup.permissions ?? ALL_PERMISSIONS, setup.path ?? `/pwf/pwf-06?id=${PROJECT_ID}`);
  return h;
};

const change = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const ready = async () => screen.findByTestId('whatif-form');
const propose = async () => {
  await ready();
  change('planned-start', '2027-01-04');
  change('reason', REASON);
  fireEvent.click(screen.getByTestId('submit-propose'));
  return screen.findByTestId('proposal');
};

describe('PWF-06: what if the start day moves', () => {
  it('shows the schedule in force with the project, its finish and its version, each with an "i"', async () => {
    open();
    await ready();
    expect(screen.getByText(/DA-2026-001/)).toBeTruthy();
    expect(screen.getByText('12/02/2027')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Công thức/ }).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a form with a problem, names the fields and sends nothing', async () => {
    const h = open();
    await ready();
    fireEvent.click(screen.getByTestId('submit-propose'));
    expect((await screen.findByTestId('error-change')).textContent).toBe(text('pwf.resched.change.error'));
    expect(screen.getByTestId('error-reason').textContent).toBe(text('pwf.form.required.error'));
    change('reason', 'ngắn');
    expect(screen.getByTestId('error-reason').textContent).toBe(text('pwf.form.tooShort.error', { min: 20 }));
    expect(screen.getByTestId('reason').getAttribute('aria-invalid')).toBe('true');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('proposes with the version of the workflow as If-Match and shows before and after in working days, float, critical path and the variance against the first baseline', async () => {
    const h = open();
    const result = await propose();
    expect(h.command.mock.calls[0]?.[0]).toBe('proposeProjectReschedule');
    const input = h.command.mock.calls[0]?.[1] as { path: unknown; body: unknown; ifMatchVersion: number };
    expect(input.path).toEqual({ project_id: PROJECT_ID });
    expect(input.ifMatchVersion).toBe(4);
    expect(input.body).toEqual({ planned_start_date: '2027-01-04', reason: REASON });
    expect(within(result).getByTestId('finish-shift').textContent).toContain(text('pwf.resched.result.shiftDays.text', { shift: '+10' }));
    const t1 = within(result).getByTestId('change-T1');
    expect(t1.textContent).toContain('01/12/2026 – 10/12/2026');
    expect(t1.textContent).toContain('04/01/2027 – 15/01/2027');
    expect(t1.textContent).toContain(text('pwf6.resched.shift.later', { days: 5 }));
    expect(t1.textContent).toContain(text('pwf.resched.critical.became.word'));
    expect(t1.textContent).toContain('T1');
    expect(within(result).getByTestId('change-T2').textContent).toContain(text('pwf.resched.critical.left.word'));
    expect(within(result).getByTestId('summary').textContent).toBe(text('pwf.resched.result.summary.text', { total: 2, slipped: 2, gained: 0, became: 1, left: 1 }));
    expect(within(result).getByTestId('baseline-note').textContent).toBe(text('pwf.resched.baseline.note'));
    expect(within(result).getAllByRole('button', { name: /Công thức/ }).length).toBeGreaterThanOrEqual(3);
  });

  it('takes the progress of tasks in the proposal', async () => {
    const h = open();
    await ready();
    fireEvent.click(document.querySelector('[data-action="add-progress"]') as HTMLElement);
    fireEvent.click(screen.getByTestId('submit-propose'));
    expect((await screen.findByTestId('error-progress-0-code')).textContent).toBe(text('pwf.form.required.error'));
    change('progress-0-code', 'T1');
    change('progress-0-start', '2026-12-01');
    change('progress-0-remaining', '4');
    change('progress-0-percent', '50');
    change('reason', REASON);
    fireEvent.click(screen.getByTestId('submit-propose'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ progress: [{ task_code: 'T1', actual_start: '2026-12-01', remaining_working_days: 4, percent_complete: 50 }], reason: REASON });
    await screen.findByTestId('proposal');
    fireEvent.click(document.querySelector('[data-action="remove-progress-0"]') as HTMLElement);
    expect(screen.queryByTestId('progress-0')).toBeNull();
  });

  it('shows the words of a year without a calendar and never a date in its place', async () => {
    const guess = preview({
      schedule: { ...preview().schedule, tasks: [{ ...preview().schedule.tasks[0]!, state: 'CALENDAR_UNAVAILABLE', missing_year: 2029, start: null, finish: null }, preview().schedule.tasks[1]!] },
    });
    open({ commands: { proposeProjectReschedule: guess } });
    const result = await propose();
    expect(within(result).getByTestId('calendar-missing').textContent).toContain('2029');
    expect(within(result).getByTestId('change-T1').textContent).toContain(text('pwf.common.calendarMissingYear.text', { year: 2029 }));
  });

  it('says so when a proposal changes nothing', async () => {
    open({ commands: { proposeProjectReschedule: preview({ changes: [], project_finish_shift_days: null }) } });
    const result = await propose();
    expect(within(result).getByTestId('no-changes')).toBeTruthy();
    expect(within(result).getByTestId('finish-shift').textContent).toContain('–');
  });

  it.each([
    ['PWF_RESCHEDULE_PENDING_EXISTS', 'pwf.problem.reschedulePending.error'],
    ['PWF_DEPENDENCY_CYCLE', 'pwf.problem.dependencyCycle.error'],
    ['PWF_SCHEDULE_INVALID', 'pwf.problem.scheduleInvalid.error'],
    ['CALENDAR_NOT_EFFECTIVE', 'pwf.problem.calendarNotEffective.error'],
  ])('says in words that the server refused with %s', async (code, key) => {
    open({ commands: { proposeProjectReschedule: refusal(code) } });
    await ready();
    change('planned-start', '2027-01-04');
    change('reason', REASON);
    fireEvent.click(screen.getByTestId('submit-propose'));
    expect((await screen.findByTestId('problem')).textContent).toContain(text(key));
    expect(screen.queryByTestId('proposal')).toBeNull();
  });

  it('keeps the proposal button off when the workflow takes no new proposal', async () => {
    open({ workflow: workflow({ can_propose_reschedule: false }) });
    await ready();
    expect((screen.getByTestId('submit-propose') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('cannot-propose')).toBeTruthy();
  });
});

describe('PWF-06: the decision of a second person', () => {
  it('approves with the version the proposal was computed on as If-Match, then says the new schedule is published and the baseline did not change', async () => {
    const h = open();
    await propose();
    fireEvent.click(screen.getByTestId('approve'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command.mock.calls[1]?.[0]).toBe('decideProjectReschedule');
    const input = h.command.mock.calls[1]?.[1] as { path: unknown; body: unknown; ifMatchVersion: number };
    expect(input.path).toEqual({ id: PROPOSAL_ID });
    expect(input.ifMatchVersion).toBe(3);
    expect(input.body).toEqual({ decision: 'APPROVE' });
    expect((await screen.findByTestId('decided')).textContent).toContain(text('pwf.resched.decided.approved.notice'));
    expect(screen.queryByTestId('decision-panel')).toBeNull();
  });

  it('asks a rejection for its reason before it sends anything, then keeps the schedule', async () => {
    const h = open();
    await propose();
    fireEvent.click(screen.getByTestId('reject'));
    expect((await screen.findByTestId('error-note')).textContent).toBe(text('pwf.form.required.error'));
    expect(h.command).toHaveBeenCalledTimes(1);
    change('decision-note', REASON);
    fireEvent.click(screen.getByTestId('reject'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect((h.command.mock.calls[1]?.[1] as { body: unknown }).body).toEqual({ decision: 'REJECT', note: REASON });
    expect((await screen.findByTestId('decided')).textContent).toContain(text('pwf.resched.decided.rejected.notice'));
  });

  it('shows the refusal of the same person deciding their own proposal', async () => {
    open({ commands: { proposeProjectReschedule: preview(), decideProjectReschedule: refusal('SELF_APPROVAL_DENIED', 403) } });
    await propose();
    expect(screen.getByTestId('maker-checker').textContent).toBe(text('pwf.resched.decision.makerChecker.note'));
    fireEvent.click(screen.getByTestId('approve'));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwf.problem.selfApproval.error'));
    expect(screen.getByTestId('decision-panel')).toBeTruthy();
  });

  it('on a schedule conflict offers to read the newer version, which clears the proposal and reads again', async () => {
    const h = open({ commands: { proposeProjectReschedule: preview(), decideProjectReschedule: refusal('PWF_SCHEDULE_VERSION_CONFLICT', 409) } });
    await propose();
    fireEvent.click(screen.getByTestId('approve'));
    const banner = await screen.findByTestId('problem');
    expect(banner.textContent).toContain(text('pwf.problem.scheduleConflict.error'));
    const reads = h.read.mock.calls.length;
    fireEvent.click(within(banner).getByText(text('pwf.problem.reload.action')));
    await waitFor(() => expect(screen.queryByTestId('proposal')).toBeNull());
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.queryByTestId('problem')).toBeNull();
  });

  it('lets a second person decide a proposal named in the address, saying that its details cannot be read again', async () => {
    const h = open({ path: `/pwf/pwf-06?id=${PROJECT_ID}&proposal=${PROPOSAL_ID}&v=3`, permissions: ['pwf.read', 'pwf.schedule.approve'] });
    const panel = await screen.findByTestId('decision-panel');
    expect(screen.queryByTestId('whatif-form')).toBeNull();
    expect(within(panel).getByTestId('no-detail').textContent).toBe(text('pwf.resched.decision.noDetail.notice'));
    fireEvent.click(screen.getByTestId('approve'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const input = h.command.mock.calls[0]?.[1] as { path: unknown; ifMatchVersion: number };
    expect(input.path).toEqual({ id: PROPOSAL_ID });
    expect(input.ifMatchVersion).toBe(3);
  });

  it('reads the stored proposal named in the address, so that the second person sees its changes before deciding, and not the notice that the details cannot be read', async () => {
    const h = serve(
      { get_resources_project_id: projectBody(), getProjectWorkflow: workflow(), getProjectSchedule: schedule(), getProjectReschedule: preview() },
      { decideProjectReschedule: { resource_id: PROPOSAL_ID, status: 'APPROVED', resource_version: 2 } },
    );
    mount(<RescheduleScreen route={route} />, h, ['pwf.read', 'pwf.schedule.approve'], `/pwf/pwf-06?id=${PROJECT_ID}&proposal=${PROPOSAL_ID}&v=3`);
    expect(await screen.findByTestId('proposal')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('no-detail')).toBeNull());
    fireEvent.click(screen.getByTestId('approve'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { ifMatchVersion: number }).ifMatchVersion).toBe(preview().base_version);
  });

  it('A6: opens the proposal that waits on the project by itself, with nothing in the address, so that who decides finds it from the menu', async () => {
    const h = serve(
      { get_resources_project_id: projectBody(), getProjectWorkflow: { ...workflow(), pending_reschedule: { proposal_id: PROPOSAL_ID, base_version: preview().base_version } }, getProjectSchedule: schedule(), getProjectReschedule: preview() },
      { decideProjectReschedule: { resource_id: PROPOSAL_ID, status: 'APPROVED', resource_version: 2 } },
    );
    mount(<RescheduleScreen route={route} />, h, ['pwf.read', 'pwf.schedule.approve'], `/pwf/pwf-06?id=${PROJECT_ID}`);
    expect(await screen.findByTestId('proposal')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('no-detail')).toBeNull());
    expect(h.read.mock.calls.some((call) => call[0] === 'getProjectReschedule' && (call[1] as { path: { id: string } }).path.id === PROPOSAL_ID)).toBe(true);
    fireEvent.click(screen.getByTestId('approve'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const input = h.command.mock.calls[0]?.[1] as { path: unknown; ifMatchVersion: number };
    expect(input.path).toEqual({ id: PROPOSAL_ID });
    expect(input.ifMatchVersion).toBe(preview().base_version);
  });

  it('A6: a workflow with no proposal waiting opens the form, as before', async () => {
    open({ workflow: { ...workflow(), pending_reschedule: null } });
    await ready();
    expect(screen.queryByTestId('proposal')).toBeNull();
  });

  it('shows no decision to a person who may only propose, and no form to a person who may only decide', async () => {
    open({ permissions: ['pwf.read', 'pwf.schedule.propose'] });
    await propose();
    expect(screen.queryByTestId('decision-panel')).toBeNull();
    cleanup();
    open({ permissions: ['pwf.read', 'pwf.schedule.approve'] });
    await screen.findByText(/DA-2026-001/);
    expect(screen.queryByTestId('whatif-form')).toBeNull();
  });

  it('does not offer a decision on a proposal that is already decided', async () => {
    open({ commands: { proposeProjectReschedule: preview({ status: 'APPROVED' }) } });
    await propose();
    expect(screen.queryByTestId('decision-panel')).toBeNull();
  });
});

describe('PWF-06: states', () => {
  it('asks for a project, says when the workflow does not exist and when the person may do nothing', async () => {
    open({ path: '/pwf/pwf-06' });
    expect((await screen.findByTestId('no-project')).textContent).toBe(text('pwf.resched.noProject.notice'));
    cleanup();
    open({ workflow: refusal('RESOURCE_NOT_FOUND', 404) });
    expect(await screen.findByTestId('no-workflow')).toBeTruthy();
    expect(screen.getByRole('link', { name: text('pwf.resched.noWorkflow.link') }).getAttribute('href')).toBe(`/pwf/pwf-05?id=${PROJECT_ID}`);
    cleanup();
    open({ permissions: READ_ONLY });
    expect((await screen.findByTestId('no-permission')).textContent).toBe(text('pwf.resched.noPermission.notice'));
  });

  it('shows the error card with a retry when the schedule cannot be read', async () => {
    const h = open({ schedule: refusal('INTERNAL_ERROR', 500) });
    expect(await screen.findByRole('alert')).toBeTruthy();
    const reads = h.read.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(reads));
  });

  it('names a year without a calendar in the schedule in force', async () => {
    open({ schedule: schedule({ tasks: [{ ...schedule().tasks[0]!, state: 'CALENDAR_UNAVAILABLE', missing_year: 2030, start: null, finish: null }] }) });
    await ready();
    expect(screen.getByTestId('calendar-missing').textContent).toContain('2030');
  });

  it('has no serious accessibility violation, with a proposal and a decision on the screen', async () => {
    open();
    await propose();
    fireEvent.click(screen.getByTestId('reject'));
    await screen.findByTestId('error-note');
    const section = screen.getByTestId('proposal').closest('section') as HTMLElement;
    expect(describeViolations(await seriousViolations(section))).toEqual([]);
  });
});

describe('PWF-06: asking to extend a step (R72)', () => {
  const rule = { allowed: true, max_times: 1, max_value: 10, unit: 'WORKING_DAY' as const, times_used: 0, value_used: 4 };
  const flow = (over: Record<string, unknown> = {}) =>
    workflow({
      tasks: [
        workflowTask(1, { name: 'Thẩm định hồ sơ', status: 'IN_PROGRESS', extension: rule }),
        workflowTask(2, { name: 'Phê duyệt', extension: { ...rule, allowed: false } }),
        workflowTask(3, { name: 'Ký hợp đồng', extension: { ...rule, unit: 'MONTH', max_times: null, max_value: null } }),
      ],
      ...over,
    });
  const extended = (over: Record<string, unknown> = {}) =>
    preview({
      changes: [
        { task_code: 'T1', start_shift_days: 0, finish_shift_days: 3, float_change: 0, became_critical: false, became_non_critical: false, state_changed: false, cause: 'EXTENDED' },
        { task_code: 'T2', start_shift_days: 3, finish_shift_days: 3, float_change: 0, became_critical: false, became_non_critical: false, state_changed: false, cause: 'CASCADED' },
        { task_code: 'T3', start_shift_days: 0, finish_shift_days: 0, float_change: 0, became_critical: false, became_non_critical: false, state_changed: false, cause: 'CASCADED', finish_calendar_shift_days: 1 },
      ],
      extensions: [{ task_code: 'T1', add_value: 3, unit: 'WORKING_DAY' }],
      ...over,
    });
  const asking = (path = `/pwf/pwf-06?id=${PROJECT_ID}&extend=T1`, commands: Record<string, Answer> | undefined = undefined) =>
    open({ workflow: flow(), path, commands: commands ?? { proposeProjectReschedule: extended(), decideProjectReschedule: { resource_id: PROPOSAL_ID, status: 'APPROVED', resource_version: 2 } } });

  it('opens with the step named in the address ready, offers only the steps whose process allows an extension, and says how much is used', async () => {
    asking();
    await ready();
    const row = screen.getByTestId('extension-0');
    expect((within(row).getByTestId('extension-0-task') as HTMLSelectElement).value).toBe('T1');
    expect(within(screen.getByTestId('extension-0-task')).getAllByRole('option').map((option) => option.textContent)).toEqual([text('pwfp.resched.extend.task.choose'), 'Thẩm định hồ sơ', 'Ký hợp đồng']);
    expect(row.textContent).toContain(text('pwfp.resched.extend.used.text', { times: '0/1', value: '4/10', unit: text('pwfp.cell.unit.workingDay.word') }));
    // The unit of the amount is the unit of the step.
    expect(within(row).getByLabelText(text('pwfp.resched.extend.valueUnit.label', { unit: text('pwfp.cell.unit.workingDay.word') }))).toBeTruthy();
  });

  it('ignores a step in the address that cannot be extended, and says when no step can', async () => {
    open({ workflow: flow(), path: `/pwf/pwf-06?id=${PROJECT_ID}&extend=T2` });
    await ready();
    expect(screen.queryByTestId('extension-0')).toBeNull();
    cleanup();
    open({ workflow: workflow() });
    await ready();
    expect(screen.getByTestId('extensions-none').textContent).toBe(text('pwfp.resched.extend.none.text'));
    expect((document.querySelector('[data-action="add-extension"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds and removes rows, and refuses a row with no step or no amount, saying where', async () => {
    const h = asking(`/pwf/pwf-06?id=${PROJECT_ID}`);
    await ready();
    fireEvent.click(document.querySelector('[data-action="add-extension"]') as HTMLElement);
    change('reason', REASON);
    fireEvent.click(screen.getByTestId('submit-propose'));
    expect((await screen.findByTestId('error-extension-0-task')).textContent).toBe(text('pwf.form.pickOne.error'));
    expect(screen.getByTestId('error-extension-0-value').textContent).toBe(text('pwf.form.required.error'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-action="remove-extension-0"]') as HTMLElement);
    expect(screen.queryByTestId('extension-0')).toBeNull();
  });

  it('proposes the extension as the step and the amount added, with the version of the workflow, and separates "Gia hạn" from "Lùi theo dây chuyền"', async () => {
    const h = asking();
    await ready();
    change('extension-0-value', '3');
    change('reason', REASON);
    fireEvent.click(screen.getByTestId('submit-propose'));
    await screen.findByTestId('proposal');
    const input = h.command.mock.calls[0]?.[1] as { ifMatchVersion: number; body: Record<string, unknown> };
    expect(input.ifMatchVersion).toBe(4);
    expect(input.body).toEqual({ reason: REASON, extensions: [{ task_code: 'T1', add_value: 3 }] });
    expect(screen.getByTestId('group-EXTENDED').textContent).toContain(text('pwfp.resched.group.extended.title'));
    expect(within(screen.getByTestId('group-EXTENDED')).getByTestId('change-T1')).toBeTruthy();
    expect(screen.getByTestId('group-CASCADED').textContent).toContain(text('pwfp.resched.group.cascaded.title'));
    expect(within(screen.getByTestId('group-CASCADED')).getByTestId('change-T2')).toBeTruthy();
    expect(screen.getByTestId('causes').textContent).toBe(text('pwfp.resched.result.causes.text', { extended: 1, cascaded: 2 }));
    expect(screen.getByTestId('extensions-asked').textContent).toBe(text('pwfp.resched.result.asked.line', { task: 'Việc T1', value: 3, unit: text('pwfp.cell.unit.workingDay.word') }));
    expect(screen.queryByTestId('group-OTHER')).toBeNull();
  });

  it('says a move of calendar days that the working days do not show, with the number of days', async () => {
    asking();
    await ready();
    change('extension-0-value', '1');
    change('reason', REASON);
    fireEvent.click(screen.getByTestId('submit-propose'));
    await screen.findByTestId('proposal');
    expect(screen.getByTestId('calendar-shift-T3').textContent).toBe(text('pwfp.resched.shift.calendar.later', { days: 1 }));
    expect(screen.queryByTestId('calendar-shift-T1')).toBeNull();
  });

  it.each([
    ['PWF_EXTENSION_LIMIT_EXCEEDED', { task_code: 'T1', limit: 'TIMES', used: 1, asked: 1, max: 1 }, text('pwfp.problem.extTimes.error', { task: 'T1', used: 1, max: 1 })],
    ['PWF_EXTENSION_LIMIT_EXCEEDED', { task_code: 'T1', limit: 'VALUE', used: 4, asked: 7, max: 10 }, text('pwfp.problem.extValue.error', { task: 'T1', used: 4, max: 10, asked: 7 })],
    ['PWF_EXTENSION_NOT_ALLOWED', { task_code: 'T1' }, text('pwfp.problem.extNotAllowed.error', { task: 'T1' })],
    ['PWF_EXTENSION_TASK_CLOSED', { task_code: 'T1' }, text('pwfp.problem.extClosed.error', { task: 'T1' })],
    ['PWF_EXTENSION_REQUIRED', { task_code: 'T1' }, text('pwfp.problem.extRequired.error', { task: 'T1' })],
  ])('says the refusal %s at the row of the step and above, with how much is used of the cap', async (code, extensions, words) => {
    const h = asking(undefined, { proposeProjectReschedule: refusal(code, 422, extensions) });
    await ready();
    change('extension-0-value', '7');
    change('reason', REASON);
    fireEvent.click(screen.getByTestId('submit-propose'));
    const problem = await screen.findByTestId('problem');
    expect(problem.textContent).toContain(words);
    expect(screen.getByTestId('error-extension-0-value').textContent).toBe(words);
    expect(screen.getByTestId('extension-0-value').getAttribute('aria-invalid')).toBe('true');
    expect(within(problem).queryByRole('button', { name: text('pwf.problem.reload.action') })).toBeNull();
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('offers to read the newer version when somebody changed the schedule first', async () => {
    asking(undefined, { proposeProjectReschedule: refusal('PWF_SCHEDULE_VERSION_CONFLICT', 409) });
    await ready();
    change('extension-0-value', '3');
    change('reason', REASON);
    fireEvent.click(screen.getByTestId('submit-propose'));
    const problem = await screen.findByTestId('problem');
    expect(problem.getAttribute('data-kind')).toBe('scheduleConflict');
    expect(within(problem).getByRole('button', { name: text('pwf.problem.reload.action') })).toBeTruthy();
  });

  it('tells the approver that an extension can no longer be approved because the cap was used meanwhile, and offers no reload: the request is rejected', async () => {
    open({
      path: `/pwf/pwf-06?id=${PROJECT_ID}&proposal=${PROPOSAL_ID}&v=3`,
      commands: { decideProjectReschedule: refusal('PWF_SCHEDULE_VERSION_CONFLICT', 409, { reason: 'EXTENSION_REFUSED', extension_code: 'LIMIT', task_code: 'T1', limit: 'TIMES', used: 1, asked: 1, max: 1 }) },
      workflow: flow({ pending_reschedule: { proposal_id: PROPOSAL_ID, base_version: 3 } }),
    });
    fireEvent.click(await screen.findByTestId('approve'));
    const problem = await screen.findByTestId('problem');
    expect(problem.getAttribute('data-kind')).toBe('extensionRefused');
    expect(problem.textContent).toContain(text('pwfp.problem.extTimes.error', { task: 'T1', used: 1, max: 1 }));
    expect(within(problem).queryByRole('button', { name: text('pwf.problem.reload.action') })).toBeNull();
  });

  it('has no serious accessibility violation with an extension request and its result on the screen', async () => {
    asking();
    await ready();
    change('extension-0-value', '3');
    change('reason', REASON);
    fireEvent.click(screen.getByTestId('submit-propose'));
    await screen.findByTestId('proposal');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
