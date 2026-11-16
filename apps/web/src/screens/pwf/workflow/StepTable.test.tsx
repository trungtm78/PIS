import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../prj/test-support';
import type { WorkflowDetail } from '../model';
import { PERMISSIONS } from '../model';
import type { WorkflowStep } from '../process/model';
import { legalBasis } from '../process/test/fixtures';
import { ALL_PERMISSIONS, PROJECT_ID, band, refusal, routeOf, scheduleTask, text, uuid, workflowTask } from '../test/fixtures';
import { detail, fresh, open, schedule } from './test/fixtures';
import type { Setup } from './test/fixtures';
import WorkflowScreen from './WorkflowScreen';

afterEach(cleanup);

const route = routeOf('PWF-03');
const PATH = `/pwf/pwf-03?id=${PROJECT_ID}`;
const unit = (n: number, name: string, role = 'PROJECT_MANAGER') => ({ unit_ref: `UNIT:${n}`, unit_id: uuid(n), unit_name: name, role, part: 'LEAD' as const });
const OTHER = { membership_id: uuid(71), display_name: 'Trần Văn Hùng' };

const step = (code: string, phase: string, order: number, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
  code,
  name: `Bước ${code}`,
  phase_code: phase,
  order,
  implicit: false,
  responsible_role: null,
  status: 'NOT_STARTED',
  standard_working_days: 5,
  planned_start: null,
  planned_finish: null,
  task_total: 1,
  task_done: 0,
  required_total: 1,
  required_done: 0,
  checklist_total: 0,
  checklist_done: 0,
  legal_basis: [],
  ...over,
});

const T1 = workflowTask(1, { step_code: 'S1', status: 'DONE', band: band('NONE', { reason: 'NO_DUE' }), receiving_unit_name: 'Chủ đầu tư', receiving_units: [unit(5, 'Chủ đầu tư')] });
const T2 = workflowTask(2, {
  step_code: 'S2',
  status: 'IN_PROGRESS',
  band: band('RED'),
  band_tier: 'STEP',
  band_thresholds: { green_days: 5, yellow_days: 2, red_days: 0 },
  checklist_total: 2,
  checklist_done: 1,
  receiving_unit_name: 'Sở Xây dựng',
  receiving_units: [unit(6, 'Sở Xây dựng')],
  assignee: OTHER,
  extension: { allowed: true, max_times: 1, max_value: 10, unit: 'WORKING_DAY', times_used: 0, value_used: 0 },
});
const T3 = workflowTask(3, { step_code: 'S2', status: 'NOT_STARTED', band: band('YELLOW'), receiving_unit_name: 'Sở Xây dựng', receiving_units: [unit(6, 'Sở Xây dựng')] });
const T4 = workflowTask(4, { step_code: 'S3', status: 'NOT_STARTED', band: band('YELLOW'), assignee: null, unclaimed: true, receiving_unit_name: 'UBND tỉnh', receiving_units: [unit(7, 'UBND tỉnh')], is_overall_deadline: true });
const T5 = workflowTask(5, { step_code: 'S4', phase_code: 'EXECUTION', status: 'AWAITING_APPROVAL', band: band('GREEN') });
const T6 = workflowTask(6, { step_code: 'S5', phase_code: 'EXECUTION', status: 'IN_PROGRESS', band: band('GREEN'), version: 7 });

const flow = (over: Partial<WorkflowDetail> = {}): WorkflowDetail =>
  detail({
    as_of: fresh(),
    open_phase: 'PREPARATION',
    tasks: [T1, T2, T3, T4, T5, T6],
    counts_by_band: { NONE: 1, GREEN: 2, YELLOW: 2, RED: 1, UNKNOWN: 0 },
    steps: [
      step('S1', 'PREPARATION', 1, { status: 'DONE', task_done: 1 }),
      step('S2', 'PREPARATION', 2, { status: 'IN_PROGRESS', task_total: 2, planned_finish: '2026-12-10' }),
      step('S3', 'PREPARATION', 3),
      step('S4', 'EXECUTION', 1),
      step('S5', 'EXECUTION', 2),
    ],
    overall_deadline: { task_id: T4.id, task_code: 'T4', task_name: 'Công việc 4', due_on: '2026-12-10', band: 'YELLOW', band_tier: 'STEP', remaining_days: 2 },
    ...over,
  });

const plan = () =>
  schedule({
    tasks: [
      scheduleTask('T1', { state: 'COMPLETED' }),
      scheduleTask('T2'),
      scheduleTask('T3', { driving_predecessor: 'T2' }),
      scheduleTask('T4', { finish_variance_days: 3 }),
      scheduleTask('T5'),
      scheduleTask('T6'),
    ],
  });

const show = (setup: Setup = {}, permissions: readonly string[] = ALL_PERMISSIONS, mode?: 'FULL' | 'READ_ONLY') => {
  const h = open({ workflow: () => flow(), schedule: plan, ...setup });
  const view = mount(<WorkflowScreen route={route} />, h, { permissions, path: PATH, ...(mode === undefined ? {} : { mode }) });
  return { h, ...view };
};
const ready = async () => screen.findByTestId('step-table');
const row = (code: string): HTMLElement => document.querySelector(`[data-task="${code}"]`) as HTMLElement;
const without = (...removed: string[]): string[] => ALL_PERMISSIONS.filter((one) => !removed.includes(one));

describe('PWF-03 step table: the rows', () => {
  it('shows the phases as band rows and each step on a row: the unit and who holds it, the deadline, the official colour, the state', async () => {
    show();
    const table = await ready();
    expect(screen.getByRole('heading', { level: 2, name: text('pwfp.table.title') })).toBeTruthy();
    expect([...table.querySelectorAll('tbody[data-phase] .pwfp-phase')].map((phase) => phase.textContent)).toEqual([
      expect.stringContaining(text('pwfp.table.phase.text', { order: 1, name: 'Chuẩn bị đầu tư' })),
      expect.stringContaining(text('pwfp.table.phase.text', { order: 2, name: 'Thực hiện đầu tư' })),
    ]);
    // The phase the project is in is marked, and says how far its required work is.
    expect(table.querySelector('[data-phase="PREPARATION"] .pwfp-phase')?.textContent).toContain(text('pwfp.table.phase.current.word'));
    expect(table.querySelector('[data-phase="PREPARATION"] .pwfp-phase')?.textContent).toContain(text('pwfp.table.phase.done.text', { done: 1, total: 2 }));
    const first = row('T1');
    expect(first.querySelector('.pwfp-num')?.textContent).toBe('1');
    expect(within(first).getByTestId('cell-unit').textContent).toBe('Chủ đầu tư · Nguyễn Văn An');
    expect(first.textContent).toContain(text('pwf.status.done.word'));
    expect(first.textContent).toContain(text('pwfp.cell.done.word'));
    const third = row('T4');
    expect(within(third).getByTestId('cell-deadline').textContent).toContain('10/12/2026');
    // A step with one task is ONE row, numbered as the step; a step with several is a row and its tasks the children.
    expect(row('T4').querySelector('.pwfp-num')?.textContent).toBe('3');
    expect(table.querySelector('[data-step="S2"] .pwfp-num')?.textContent).toBe('2');
  });

  it('gives a step with several tasks a row of its own that opens into child rows, open by itself while the step is in progress', async () => {
    show();
    const table = await ready();
    const parent = table.querySelector('[data-step="S2"]') as HTMLElement;
    expect(parent.textContent).toContain(text('pwfp.table.step.tasks.text', { done: 0, total: 2 }));
    expect(within(parent).getByRole('button', { name: text('pwfp.table.step.toggle.aria', { name: 'Bước S2' }) }).getAttribute('aria-expanded')).toBe('true');
    expect([row('T2').querySelector('.pwfp-num')?.textContent, row('T3').querySelector('.pwfp-num')?.textContent]).toEqual(['2.1', '2.2']);
    // The step carries the worst colour of its tasks as the server gave it.
    expect(parent.querySelector('[data-testid="cell-remaining"]')?.getAttribute('data-band')).toBe('RED');
    fireEvent.click(within(parent).getByRole('button', { name: text('pwfp.table.step.toggle.aria', { name: 'Bước S2' }) }));
    expect(row('T2')).toBeNull();
    fireEvent.click(within(parent).getByRole('button', { name: text('pwfp.table.step.toggle.aria', { name: 'Bước S2' }) }));
    expect(row('T2')).not.toBeNull();
  });

  it('folds a phase and opens it again', async () => {
    show();
    const table = await ready();
    const phase = table.querySelector('[data-phase="EXECUTION"] .pwfp-phase') as HTMLElement;
    expect(row('T5')).not.toBeNull();
    fireEvent.click(within(phase).getByRole('button', { expanded: true }));
    expect(row('T5')).toBeNull();
    fireEvent.click(within(phase).getByRole('button', { expanded: false }));
    expect(row('T5')).not.toBeNull();
  });

  it('shows the official colour exactly as the server gave it and explains the tier of its ladder with the "i"', async () => {
    show();
    await ready();
    const red = within(row('T2')).getByTestId('cell-remaining');
    expect(red.getAttribute('data-band')).toBe('RED');
    expect(red.textContent).toContain(text('pwf.band.red.word'));
    expect(row('T6').querySelector('[data-testid="cell-remaining"]')?.getAttribute('data-band')).toBe('GREEN');
    fireEvent.click(within(red).getByRole('button', { name: /Công thức và nguồn của/ }));
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain(text('pwfp.cell.tier.step.text'));
    expect(panel.textContent).toContain('Đỏ từ khi còn 0 ngày làm việc · Vàng từ khi còn 2 · Xanh từ khi còn 5');
  });

  it('never turns a deadline that cannot be counted into a colour, and names the year', async () => {
    const lost = workflowTask(7, { step_code: 'S6', status: 'NOT_STARTED', state: 'CALENDAR_UNAVAILABLE', missing_year: 2028, planned_finish: null, band: band('UNKNOWN', { reason: 'CALENDAR_UNAVAILABLE' }) });
    show({ workflow: () => flow({ tasks: [T1, lost], steps: [step('S1', 'PREPARATION', 1), step('S6', 'PREPARATION', 2)] }) });
    await ready();
    expect(row('T7').textContent).toContain(text('pwf.common.calendarMissingYear.text', { year: 2028 }));
    expect(row('T7').querySelector('[data-band="GREEN"]')).toBeNull();
    expect(row('T7').querySelector('[data-testid="cell-remaining"]')?.getAttribute('data-band')).toBe('UNKNOWN');
    expect(screen.getByTestId('calendar-missing').textContent).toContain('2028');
  });

  it('puts a star on the task whose finish is the deadline of the whole file', async () => {
    show();
    await ready();
    expect(within(row('T4')).getByTestId('cell-overall').textContent).toContain(text('pwfp.cell.overall.word'));
    expect(row('T2').querySelector('[data-testid="cell-overall"]')).toBeNull();
  });

  it('leaves out the tasks cut from the project and says so when no task remains', async () => {
    const gone = workflowTask(8, { step_code: 'S1', excluded: true });
    show({ workflow: () => flow({ tasks: [T1, gone] }) });
    await ready();
    expect(row('T8')).toBeNull();
    cleanup();
    show({ workflow: () => flow({ tasks: [], steps: [] }) });
    expect((await screen.findByTestId('steps-empty')).textContent).toBe(text('pwf.flow.tree.empty.text'));
  });

  it('shows the legal grounds of a step one click away, and says a kind of workflow chosen against the rule', async () => {
    const legal = legalBasis({ document_code: 'DECREE_214_2025_ND_CP', state: 'EXPIRED', number: '214/2025/NĐ-CP' });
    show({
      workflow: () =>
        flow({
          steps: [step('S1', 'PREPARATION', 1, { status: 'DONE', legal_basis: [legal] }), step('S2', 'PREPARATION', 2, { status: 'IN_PROGRESS', task_total: 2 }), step('S3', 'PREPARATION', 3), step('S4', 'EXECUTION', 1), step('S5', 'EXECUTION', 2)],
          selection: { mode: 'OVERRIDE', chosen_template_code: 'PUBLIC_INVESTMENT', suggested_template_code: 'PUBLIC_REPAIR', basis: 'RULE', line: 'REPAIR', rule_id: null, rule_version: 3, rule_unit_id: null, reason: 'Theo quyết định của chủ đầu tư' },
        }),
    });
    await ready();
    expect(screen.getByTestId('steps-lapsed').textContent).toBe(text('pwf.process.steps.lapsed.text', { count: 1 }));
    expect(screen.getByTestId('steps-override').textContent).toBe(text('pwf.process.steps.override.text', { suggested: text('pwf6.template.publicRepair.word'), reason: 'Theo quyết định của chủ đầu tư' }));
    expect(within(screen.getByTestId('step-legal-S1')).getByRole('listitem').textContent).toContain('214/2025/NĐ-CP');
  });
});

describe('PWF-03 step table: what blocks a row', () => {
  it('says the approver, the evidence still open and the step before, each from the answers already read, with no request of its own', async () => {
    const { h } = show();
    await ready();
    expect(within(row('T2')).getByTestId('cell-blocked').textContent).toBe(text('pwfp.cell.blocked.evidence.text', { count: 1 }));
    expect(within(row('T3')).getByTestId('cell-blocked').textContent).toBe(text('pwfp.cell.blocked.predecessor.text', { name: 'Công việc 2' }));
    expect(within(row('T5')).getByTestId('cell-blocked').textContent).toBe(text('pwfp.cell.blocked.approval.text'));
    expect(within(row('T1')).getByTestId('cell-blocked-none')).toBeTruthy();
    // The reads of the screen are the workflow, the schedule, the list of the board and the gates: nothing is asked for a row.
    const asked = h.read.mock.calls.map((call) => call[0] as string);
    expect(asked.filter((operation) => operation === 'getProjectWorkflow')).toHaveLength(1);
    expect(asked.some((operation) => operation === 'getProjectTask')).toBe(false);
  });
});

describe('PWF-03 step table: the header', () => {
  it('shows the open phase, the progress, the deadline of the whole file with its colour and how far it is behind the baseline, and the counts by colour', async () => {
    show();
    await ready();
    expect(screen.getByTestId('kpi-phase').textContent).toContain('Chuẩn bị đầu tư');
    expect(screen.getByTestId('kpi-progress').textContent).toContain(text('pwfp.head.progress.steps.text', { done: 1, total: 5 }));
    const overall = screen.getByTestId('kpi-overall');
    expect(within(overall).getByTestId('overall-due').textContent).toBe('10/12/2026');
    expect(within(overall).getByTestId('overall-band').getAttribute('data-band')).toBe('YELLOW');
    await waitFor(() => expect(within(overall).getByTestId('overall-slip').textContent).toBe(text('pwfp.head.overall.slip.text', { days: 3 })));
    expect(screen.getByTestId('count-red').textContent).toContain('1');
    expect(screen.getByTestId('count-yellow').textContent).toContain('2');
    expect(screen.getByTestId('count-green').textContent).toContain('2');
    expect(screen.queryByTestId('count-unknown')).toBeNull();
  });

  it('says there is no overall deadline when the process names none, and says tasks whose deadline cannot be counted', async () => {
    show({ workflow: () => flow({ overall_deadline: null, counts_by_band: { NONE: 0, GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 3 } }) });
    await ready();
    expect(screen.getByTestId('kpi-overall').textContent).toContain(text('pwfp.head.overall.none.text'));
    expect(screen.getByTestId('count-unknown').textContent).toBe(text('pwfp.head.unknown.text', { count: 3 }));
  });
});

describe('PWF-03 step table: the action of a row, by what the person holds', () => {
  it('offers "Nhận việc" only on a task nobody took, to who may work', async () => {
    const { unmount } = show();
    await ready();
    expect(within(row('T4')).getByRole('button', { name: text('pwfp.row.claim.aria', { name: 'Công việc 4' }) })).toBeTruthy();
    expect(row('T2').querySelector('[data-action="claim"]')).toBeNull();
    expect(within(row('T4')).getByTestId('cell-unclaimed').textContent).toContain(text('pwfp.cell.unclaimed.word'));
    unmount();
    show({}, without(PERMISSIONS.taskWork));
    await ready();
    expect(row('T4').querySelector('[data-action="claim"]')).toBeNull();
    cleanup();
    show({}, ALL_PERMISSIONS, 'READ_ONLY');
    await ready();
    expect(document.querySelector('[data-action]')).toBeNull();
  });

  it('offers "Nộp hồ sơ" while the checklist is open and "Hoàn thành" when nothing is, and "Duyệt hoàn thành" only to the approver', async () => {
    const { unmount } = show();
    await ready();
    const submit = within(row('T2')).getByRole('link', { name: text('pwfp.row.submit.aria', { name: 'Công việc 2' }) });
    expect(submit.getAttribute('href')).toBe(`/pwf/pwf-04?id=${T2.id}&project=${PROJECT_ID}`);
    expect(within(row('T6')).getByRole('button', { name: text('pwfp.row.complete.aria', { name: 'Công việc 6' }) })).toBeTruthy();
    expect(within(row('T5')).getByRole('button', { name: text('pwfp.row.approve.aria', { name: 'Công việc 5' }) })).toBeTruthy();
    unmount();
    show({}, without(PERMISSIONS.taskApprove));
    await ready();
    expect(row('T5').querySelector('[data-action]')).toBeNull();
    expect(row('T6').querySelector('[data-action="complete"]')).not.toBeNull();
    cleanup();
    show({}, [PERMISSIONS.read]);
    await ready();
    expect(document.querySelector('[data-action]')).toBeNull();
  });

  it('offers "Xin gia hạn" only where the extension is allowed, with how much is used, and says when a limit is reached', async () => {
    const { unmount } = show();
    await ready();
    const link = within(row('T2')).getByRole('link', { name: text('pwfp.row.extend.aria', { name: 'Công việc 2' }) });
    expect(link.getAttribute('href')).toBe(`/pwf/pwf-06?id=${PROJECT_ID}&extend=T2`);
    expect(within(row('T2')).getByTestId('cell-extension').textContent).toBe(text('pwfp.cell.extension.used.text', { times: '0/1 lần', value: '0/10 ngày làm việc' }));
    expect(row('T3').querySelector('[data-action="extend"]')).toBeNull();
    unmount();
    const capped = { ...T2, extension: { allowed: true, max_times: 1, max_value: 10, unit: 'WORKING_DAY' as const, times_used: 1, value_used: 4 } };
    show({ workflow: () => flow({ tasks: [T1, capped, T3, T4, T5, T6] }) });
    await ready();
    expect(within(row('T2')).getByTestId('extension-capped-T2').textContent).toBe(text('pwfp.row.extend.capped.text'));
    expect(row('T2').querySelector('[data-action="extend"]')).toBeNull();
    cleanup();
    show({}, without(PERMISSIONS.schedulePropose));
    await ready();
    expect(row('T2').querySelector('[data-action="extend"]')).toBeNull();
  });
});

describe('PWF-03 step table: the claim', () => {
  it('takes the task in one command, then reads the workflow again so that the row shows who holds it', async () => {
    let claimed = false;
    const { h } = show(
      { workflow: () => flow({ tasks: [T1, T2, T3, claimed ? { ...T4, unclaimed: false, assignee: { membership_id: uuid(9), display_name: 'Lê Thị Mai' } } : T4, T5, T6] }), commands: { claimProjectTask: () => ({ status: 'CLAIMED' }) } },
    );
    await ready();
    claimed = true;
    fireEvent.click(within(row('T4')).getByRole('button', { name: text('pwfp.row.claim.aria', { name: 'Công việc 4' }) }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('claimProjectTask', expect.objectContaining({ path: { task_id: T4.id }, body: {} })));
    await waitFor(() => expect(within(row('T4')).getByTestId('cell-unit').textContent).toBe('UBND tỉnh · Lê Thị Mai'));
    expect(row('T4').querySelector('[data-action="claim"]')).toBeNull();
    expect(screen.queryByTestId('problem')).toBeNull();
  });

  it('says why a person that does not belong to the unit, or does not hold the role, cannot take it', async () => {
    show({ commands: { claimProjectTask: () => refusal('PWF_CLAIM_NOT_ELIGIBLE', 403, { reason: 'NOT_MEMBER' }) } });
    await ready();
    fireEvent.click(within(row('T4')).getByRole('button', { name: text('pwfp.row.claim.aria', { name: 'Công việc 4' }) }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwfp.problem.claimMember.error'));
    expect(screen.getByTestId('problem').getAttribute('data-kind')).toBe('claimNotEligible');
    cleanup();
    show({ commands: { claimProjectTask: () => refusal('PWF_CLAIM_NOT_ELIGIBLE', 403, { reason: 'ROLE_NOT_HELD' }) } });
    await ready();
    fireEvent.click(within(row('T4')).getByRole('button', { name: text('pwfp.row.claim.aria', { name: 'Công việc 4' }) }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwfp.problem.claimRole.error'));
  });

  it('says somebody took it first and reads the workflow again', async () => {
    const { h } = show({ commands: { claimProjectTask: () => refusal('PWF_TASK_ALREADY_CLAIMED', 409) } });
    await ready();
    const reads = () => h.read.mock.calls.filter((call) => call[0] === 'getProjectWorkflow').length;
    fireEvent.click(within(row('T4')).getByRole('button', { name: text('pwfp.row.claim.aria', { name: 'Công việc 4' }) }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwfp.problem.claimed.error'));
    await waitFor(() => expect(reads()).toBeGreaterThan(1));
  });

  it('says the task cannot be read when the project cannot (404) and that its state does not allow it (409)', async () => {
    show({ commands: { claimProjectTask: () => refusal('RESOURCE_NOT_FOUND', 404) } });
    await ready();
    fireEvent.click(within(row('T4')).getByRole('button', { name: text('pwfp.row.claim.aria', { name: 'Công việc 4' }) }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwf.problem.notFound.error'));
    cleanup();
    show({ commands: { claimProjectTask: () => refusal('PWF_TASK_STATE_INVALID', 409, { reason: 'STATUS' }) } });
    await ready();
    fireEvent.click(within(row('T4')).getByRole('button', { name: text('pwfp.row.claim.aria', { name: 'Công việc 4' }) }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwf.problem.taskState.error'));
  });
});

describe('PWF-03 step table: complete and approve on the row', () => {
  it('completes after a confirmation that names the task, sending the version the person saw', async () => {
    const { h } = show({ commands: { completeProjectTask: () => ({ status: 'COMPLETED' }) } });
    await ready();
    fireEvent.click(within(row('T6')).getByRole('button', { name: text('pwfp.row.complete.aria', { name: 'Công việc 6' }) }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Công việc 6');
    fireEvent.click(within(dialog).getByRole('button', { name: text('pwf.task.complete.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('completeProjectTask', expect.objectContaining({ path: { task_id: T6.id }, ifMatchVersion: 7 })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says what still stands in the way when the server refuses the completion, and offers to read the newer version after a conflict', async () => {
    show({ commands: { completeProjectTask: () => refusal('PWF_TASK_COMPLETION_BLOCKED', 422, { blockers: [{ code: 'FORM_MISSING', subject: 'BM_01' }] }) } });
    await ready();
    fireEvent.click(within(row('T6')).getByRole('button', { name: text('pwfp.row.complete.aria', { name: 'Công việc 6' }) }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: text('pwf.task.complete.action') }));
    expect((await screen.findByTestId('problem')).getAttribute('data-kind')).toBe('completionBlocked');
    expect(screen.getByTestId('problem-blockers').textContent).toContain('BM_01');
    cleanup();
    show({ commands: { approveProjectTaskCompletion: () => refusal('VERSION_CONFLICT', 409) } });
    await ready();
    fireEvent.click(within(row('T5')).getByRole('button', { name: text('pwfp.row.approve.aria', { name: 'Công việc 5' }) }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: text('pwf.task.approve.action') }));
    const problem = await screen.findByTestId('problem');
    expect(problem.getAttribute('data-kind')).toBe('versionConflict');
    expect(within(problem).getByRole('button', { name: text('pwf.problem.reload.action') })).toBeTruthy();
  });

  it('says the approver cannot be the person who did the task', async () => {
    show({ commands: { approveProjectTaskCompletion: () => refusal('MAKER_IS_APPROVER', 403) } });
    await ready();
    fireEvent.click(within(row('T5')).getByRole('button', { name: text('pwfp.row.approve.aria', { name: 'Công việc 5' }) }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: text('pwf.task.approve.action') }));
    expect((await screen.findByTestId('problem')).getAttribute('data-kind')).toBe('selfApproval');
  });
});

describe('PWF-03 step table: accessibility and layout', () => {
  it('has no serious violation with the header, the rows, the actions and a refusal on screen', async () => {
    const { container } = show({ commands: { claimProjectTask: () => refusal('PWF_TASK_ALREADY_CLAIMED', 409) } });
    await ready();
    fireEvent.click(within(row('T4')).getByRole('button', { name: text('pwfp.row.claim.aria', { name: 'Công việc 4' }) }));
    await screen.findByTestId('problem');
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });

  it('keeps the table in its own named, focusable scroll region so that the page never scrolls sideways', async () => {
    show();
    const table = await ready();
    const region = table.querySelector('.ui-table-scroll') as HTMLElement;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-label')).toBe(text('pwfp.table.caption.text'));
    // Every control of a row has a name of its own (the same words on many rows are told apart by the task).
    const names = [...table.querySelectorAll('button, a[data-action]')].map((control) => control.getAttribute('aria-label') ?? control.textContent);
    expect(names.every((name) => (name ?? '').trim() !== '')).toBe(true);
  });
});
