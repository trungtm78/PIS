import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { SessionContext, useSession } from '../../../session/SessionContext';
import { mount } from '../../sas/test-support';
import type { TaskDetail } from '../model';
import { ALL_PERMISSIONS, ME, OTHER, assignment, band, refusal, routeOf, serve, taskDetail, text, uuid } from '../test/fixtures';
import TaskDetailScreen from './TaskDetailScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TASK = uuid(1002);
const PROJECT = uuid(900);
const OK = { resource_id: uuid(5), status: 'OK' };
const ledger = { items: [assignment(1)], next_cursor: null, as_of: '2026-11-12T03:00:00.000Z' };

const ReadOnly = ({ children }: { children: ReactNode }) => {
  const session = useSession();
  return <SessionContext.Provider value={{ ...session, mode: 'READ_ONLY' }}>{children}</SessionContext.Provider>;
};

interface Setup {
  task?: unknown;
  commands?: Record<string, unknown>;
  readOnly?: boolean;
  path?: string;
}

const open = (setup: Setup = {}) => {
  const h = serve({ getProjectTask: setup.task ?? taskDetail(), listProjectTaskAssignments: ledger }, setup.commands ?? {});
  (h.client.readAll as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const screenNode = <TaskDetailScreen route={routeOf('PWF-04')} />;
  mount(setup.readOnly === true ? <ReadOnly>{screenNode}</ReadOnly> : screenNode, h, ALL_PERMISSIONS, setup.path ?? `/pwf/pwf-04?id=${TASK}&project=${PROJECT}`);
  return h;
};

const ready = async () => screen.findByTestId('task-facts');
const dialog = async () => within(await screen.findByRole('dialog'));
const press = (action: string) => fireEvent.click(document.querySelector(`[data-action="${action}"]`) as HTMLElement);
const change = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const detail = (over: Partial<TaskDetail>) => taskDetail(over);
const LONG = 'Chờ cơ quan có thẩm quyền trả lời văn bản đề nghị';

describe('PWF-04: the head of the task', () => {
  it('shows what the task is, where it stands, the colour with its words and a way back to the workflow', async () => {
    open();
    await ready();
    // The name is the title; the code is a note under it, with the phase.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Công việc 2');
    expect(screen.getByTestId('task-where').textContent).toContain('T2');
    expect(screen.getByText(text('pwf.status.inProgress.word'))).toBeTruthy();
    expect(screen.getAllByText(text('pwf.band.yellow.word')).length).toBeGreaterThan(0);
    expect(screen.getByText(text('pwf.band.remaining.text', { days: 2, unit: text('pwf.unit.working.word') }))).toBeTruthy();
    expect(screen.getByRole('link', { name: text('pwf.task.back.link') }).getAttribute('href')).toBe(`/prj/prj-03?id=${PROJECT}&tab=workflow`);
    // The head says the deadline, who does the task and who approves it; the figures of the schedule are one block further down.
    expect(screen.getByTestId('task-due').textContent).toBe('10/12/2026');
    const facts = screen.getByTestId('schedule-facts').textContent ?? '';
    expect(facts).toContain('01/12/2026 – 10/12/2026');
    expect(facts).toContain('30/11/2026');
    expect(facts).toContain(text('pwf.task.days.text', { days: 20 }));
    expect(facts).toContain('60%');
  });

  it('gives every figure its "i" with formula and source, and a critical task its marker', async () => {
    open({ task: detail({ critical: true }) });
    await ready();
    expect(screen.getByText(text('pwf.task.critical.word'))).toBeTruthy();
    const info = screen.getByRole('button', { name: text('govc.bi.info.open', { name: text('pwf.task.float.name') }) });
    fireEvent.click(info);
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.task.float.formula'));
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.task.source.schedule.text'));
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.task.version.record.text', { version: 1 }));
  });

  it('says the calendar of the year is missing instead of showing dates or a colour', async () => {
    open({ task: detail({ state: 'CALENDAR_UNAVAILABLE', missing_year: 2028, planned_start: null, planned_finish: null, late_start: null, late_finish: null, total_float: null, free_float: null, band: band('UNKNOWN', { reason: 'CALENDAR_UNAVAILABLE' }) }) });
    await ready();
    expect(screen.getByTestId('calendar-missing').textContent).toContain('2028');
    expect(screen.getAllByText(text('pwf.common.calendarMissingYear.text', { year: 2028 })).length).toBe(2);
    expect(screen.getAllByText(text('pwf.band.unknown.word')).length).toBeGreaterThan(0);
  });

  it('shows no colour for a task that is done, and dashes for what has no value', async () => {
    open({ task: detail({ status: 'DONE', percent_complete: null, remaining_working_days: null, finish_variance_days: null, total_float: null, free_float: null, approver_role: null, assignee: null }) });
    await ready();
    expect(screen.queryByText(text('pwf.band.yellow.word'))).toBeNull();
    expect(screen.getByTestId('task-facts').textContent).toContain(text('pwf.task.approver.none'));
    expect(screen.getByTestId('task-facts').textContent).toContain(text('pwf.task.assignee.none'));
  });

  it('lists the predecessors with the kind of link and the lag, or says there are none', async () => {
    open({ task: detail({ predecessors: [{ task: 'T1', kind: 'SS', lag_working_days: 2 }] }) });
    await ready();
    const list = screen.getByTestId('predecessors').querySelector('[data-predecessor="T1"]') as HTMLElement;
    expect(list.textContent).toContain(text('pwf.dependency.ss.word'));
    expect(list.textContent).toContain(text('pwf6.task.lag.text', { days: 2 }));
    cleanup();
    open();
    await ready();
    expect(within(screen.getByTestId('predecessors')).getByText(text('pwf.task.predecessor.empty'))).toBeTruthy();
  });
});

describe('PWF-04: the states of the screen', () => {
  it('asks for a task when the address names none', () => {
    open({ path: '/pwf/pwf-04' });
    expect(screen.getByTestId('no-task').textContent).toBe(text('pwf.task.noTask.notice'));
  });

  it.each([
    ['SCOPE_DENIED', 403],
    ['INTERNAL_ERROR', 500],
  ])('shows the standard state for %s', async (code, status) => {
    open({ task: refusal(code, status) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open({
      task: detail({
        kpi_results: [{ id: uuid(7), kpi_code: 'ON_TIME', operation: 'ON_TIME_RATE', kpi_set_rule_id: null, kpi_set_version: 2, state: 'OK', value: 100, score: 90, weight: 1, inputs_hash: 'c'.repeat(64), inputs: { due: '2026-12-10' }, computed_at: '2026-12-11T01:00:00.000Z', supersedes_id: null }],
        exceptions: [{ id: uuid(8), task_id: TASK, kind: 'PAUSE', items: [], valid_from: '2026-12-01', valid_to: null, reason: LONG, evidence_ref: null, status: 'REQUESTED', requested_by: OTHER, decided_by: null, decided_at: null, decision_note: null, version: 1 }],
        can_approve: true,
      }),
    });
    await ready();
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});

describe('PWF-04: which buttons show', () => {
  it('shows exactly the buttons the server allows', async () => {
    open({ task: detail({ can_start: true, can_complete: false, can_approve: false, can_return: true, can_resume: false, can_request_exception: false, can_assign: false }) });
    await ready();
    expect(document.querySelector('[data-action="start"]')).not.toBeNull();
    expect(document.querySelector('[data-action="return"]')).not.toBeNull();
    for (const action of ['complete', 'approve', 'resume']) expect(document.querySelector(`[data-action="${action}"]`)).toBeNull();
    expect(screen.queryByTestId('exception-form')).toBeNull();
    expect(screen.queryByTestId('assign-form')).toBeNull();
    expect(screen.queryByTestId('evidence-form')).toBeNull();
    expect(document.querySelector('[data-action^="tick-"]')).toBeNull();
  });

  it('says there is nothing to do when the server allows nothing, and shows no writing control in a read-only session', async () => {
    open({ task: detail({ can_start: false, can_complete: false, can_request_exception: false, can_assign: false }) });
    await ready();
    expect(screen.getByTestId('no-actions')).toBeTruthy();
    cleanup();
    open({ readOnly: true, task: detail({ can_start: true, can_complete: true, can_approve: true, can_return: true, can_resume: true, can_request_exception: true, can_assign: true }) });
    await ready();
    expect(screen.getByTestId('no-actions')).toBeTruthy();
    expect(screen.queryByTestId('exception-form')).toBeNull();
    expect(screen.queryByTestId('assign-form')).toBeNull();
    expect(screen.queryByTestId('evidence-form')).toBeNull();
  });
});

describe('PWF-04: start, complete, approve, return, resume', () => {
  it('starts the task with the version it saw and a reason for an early start when one is given', async () => {
    const h = open({ task: detail({ status: 'NOT_STARTED', can_start: true, can_complete: false, version: 7 }), commands: { startProjectTask: OK } });
    await ready();
    press('start');
    const inside = await dialog();
    fireEvent.change(inside.getByRole('textbox'), { target: { value: ' tiền nhiệm sắp xong ' } });
    fireEvent.click(inside.getByRole('button', { name: text('pwf.task.start.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('startProjectTask', expect.objectContaining({ path: { task_id: TASK }, body: { early_start_reason: 'tiền nhiệm sắp xong' }, ifMatchVersion: 7 })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends an empty body when no reason is given', async () => {
    const h = open({ task: detail({ status: 'NOT_STARTED', can_start: true }), commands: { startProjectTask: OK } });
    await ready();
    press('start');
    fireEvent.click((await dialog()).getByRole('button', { name: text('pwf.task.start.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('startProjectTask', expect.objectContaining({ body: {} })));
  });

  it('shows what stops the completion before anyone presses the button', async () => {
    open();
    await ready();
    const list = screen.getByTestId('completion-blockers');
    expect(list.textContent).toContain(text('pwf.blocker.checklist.text', { subject: 'Có biên bản họp' }));
    expect(screen.getByText(text('pwf.task.completion.blocked'))).toBeTruthy();
  });

  it('says the task is ready when nothing stops it', async () => {
    open({ task: detail({ completion: { ok: true, blockers: [], coverable: [] } }) });
    await ready();
    expect(screen.getByText(text('pwf.task.completion.ok'))).toBeTruthy();
    expect(screen.queryByTestId('completion-blockers')).toBeNull();
  });

  it('completes the task with the day, an approved waiver and a note', async () => {
    const waiver = { id: uuid(8), task_id: TASK, kind: 'WAIVE_REQUIREMENT' as const, items: ['C1'], valid_from: null, valid_to: null, reason: LONG, evidence_ref: null, status: 'APPROVED' as const, requested_by: ME, decided_by: OTHER, decided_at: null, decision_note: null, version: 3 };
    const h = open({ task: detail({ exceptions: [waiver], version: 4 }), commands: { completeProjectTask: OK } });
    await ready();
    press('complete');
    const inside = await dialog();
    expect(inside.getByText(text('pwf.task.complete.approver.text', { role: 'APPROVER' }))).toBeTruthy();
    change('field-finish', '2026-12-10');
    change('field-waiver', uuid(8));
    fireEvent.change(inside.getAllByRole('textbox').at(-1) as HTMLElement, { target: { value: 'đủ hồ sơ' } });
    fireEvent.click(inside.getByRole('button', { name: text('pwf.task.complete.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('completeProjectTask', expect.objectContaining({ path: { task_id: TASK }, ifMatchVersion: 4, body: { actual_finish: '2026-12-10', exception_id: uuid(8), note: 'đủ hồ sơ' } })));
  });

  it('shows the blockers the server lists when the completion is refused with 422', async () => {
    open({ commands: { completeProjectTask: refusal('PWF_TASK_COMPLETION_BLOCKED', 422, { blockers: [{ code: 'FORM_MISSING', subject: 'FORM_REPORT' }, { code: 'EVIDENCE_MISSING', subject: 'E1' }] }) } });
    await ready();
    press('complete');
    fireEvent.click((await dialog()).getByRole('button', { name: text('pwf.task.complete.action') }));
    const banner = await screen.findByTestId('problem');
    expect(banner.textContent).toContain(text('pwf.problem.completionBlocked.error'));
    expect(within(banner).getByText(text('pwf.blocker.form.text', { subject: 'FORM_REPORT' }))).toBeTruthy();
    expect(within(banner).getByText(text('pwf.blocker.evidence.text', { subject: 'E1' }))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 'pwf.problem.selfApproval.error'],
    ['MAKER_IS_APPROVER', 'pwf.problem.selfApproval.error'],
    ['PWF_TASK_STATE_INVALID', 'pwf.problem.taskState.error'],
  ])('tells the refusal %s of an approval in words', async (code, key) => {
    const h = open({ task: detail({ status: 'AWAITING_APPROVAL', can_approve: true, can_complete: false, can_return: true, version: 9 }), commands: { approveProjectTaskCompletion: refusal(code, 422) } });
    await ready();
    press('approve');
    fireEvent.click((await dialog()).getByRole('button', { name: text('pwf.task.approve.action') }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text(key));
    expect(h.command).toHaveBeenCalledWith('approveProjectTaskCompletion', expect.objectContaining({ body: { decision: 'APPROVE' }, ifMatchVersion: 9 }));
  });

  it('approves with a note and clears an earlier refusal', async () => {
    open({ task: detail({ status: 'AWAITING_APPROVAL', can_approve: true, can_complete: false }), commands: { approveProjectTaskCompletion: OK } });
    await ready();
    press('approve');
    const inside = await dialog();
    fireEvent.change(inside.getByRole('textbox'), { target: { value: 'đạt' } });
    fireEvent.click(inside.getByRole('button', { name: text('pwf.task.approve.action') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByTestId('problem')).toBeNull();
  });

  it('keeps the return button off until the reason has 20 characters, then sends it', async () => {
    const h = open({ task: detail({ status: 'AWAITING_APPROVAL', can_return: true, can_approve: false, can_complete: false, version: 3 }), commands: { returnProjectTask: OK } });
    await ready();
    press('return');
    const inside = await dialog();
    const confirm = inside.getByRole('button', { name: text('pwf.task.return.action') }) as HTMLButtonElement;
    fireEvent.change(inside.getByRole('textbox'), { target: { value: 'thiếu biên bản' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(inside.getByRole('textbox'), { target: { value: ` ${LONG} ` } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('returnProjectTask', expect.objectContaining({ body: { reason: LONG }, ifMatchVersion: 3 })));
  });

  it('resumes a task on hold', async () => {
    const h = open({ task: detail({ status: 'ON_HOLD', can_resume: true, can_complete: false, version: 5 }), commands: { resumeProjectTask: OK } });
    await ready();
    press('resume');
    fireEvent.click((await dialog()).getByRole('button', { name: text('pwf.task.resume.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('resumeProjectTask', expect.objectContaining({ path: { task_id: TASK }, ifMatchVersion: 5 })));
  });

  it('offers to read the newer version after a version conflict, and reads it', async () => {
    const h = open({ task: detail({ status: 'NOT_STARTED', can_start: true }), commands: { startProjectTask: refusal('VERSION_CONFLICT', 409) } });
    await ready();
    press('start');
    fireEvent.click((await dialog()).getByRole('button', { name: text('pwf.task.start.action') }));
    const banner = await screen.findByTestId('problem');
    const before = h.read.mock.calls.filter(([operation]) => operation === 'getProjectTask').length;
    fireEvent.click(within(banner).getByRole('button', { name: text('pwf.problem.reload.action') }));
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getProjectTask').length).toBeGreaterThan(before));
    expect(screen.queryByTestId('problem')).toBeNull();
  });
});

describe('PWF-04: checklist, documents and evidence', () => {
  it('shows each checklist item, each legal document type and each form as present or missing, in words', async () => {
    open({
      task: detail({
        checklist: [
          { item_code: 'C1', name: 'Có biên bản họp', required: true, evidence_kinds: ['DOCUMENT'], done: false, done_by: null, done_at: null },
          { item_code: 'C2', name: 'Có ý kiến thẩm tra', required: false, evidence_kinds: [], done: true, done_by: ME, done_at: '2026-12-02T03:00:00.000Z' },
        ],
        legal_doc_types: [{ code: 'INVESTMENT_DECISION', satisfied: true }],
        form_templates: [{ code: 'FORM_REPORT', satisfied: false, document_id: null }],
      }),
    });
    await ready();
    const list = within(screen.getByTestId('checklist'));
    expect(list.getByText(text('pwf.task.checklist.open'))).toBeTruthy();
    expect(list.getByText(text('pwf.task.checklist.done', { at: '02/12/2026 10:00' }))).toBeTruthy();
    expect(list.getByText(text('pwf.task.checklist.kinds', { kinds: text('pwf6.evidence.document.word') }))).toBeTruthy();
    expect(list.getAllByText(text('pwf.task.required.yes')).length).toBe(1);
    const documents = within(screen.getByTestId('documents'));
    expect(documents.getByText(text('pwf.task.satisfied.yes'))).toBeTruthy();
    expect(documents.getByText(text('pwf.task.satisfied.no'))).toBeTruthy();
  });

  it('says so when there is no checklist and no document to ask for', async () => {
    open({ task: detail({ checklist: [], legal_doc_types: [], form_templates: [] }) });
    await ready();
    expect(screen.getByTestId('checklist-empty')).toBeTruthy();
    expect(within(screen.getByTestId('documents')).getByText(text('pwf.task.documents.empty'))).toBeTruthy();
  });

  it('marks a checklist item as done with the version of the task and a note', async () => {
    const h = open({ task: detail({ version: 6 }), commands: { completeProjectTaskChecklistItem: OK } });
    await ready();
    press('tick-C1');
    const inside = await dialog();
    expect(inside.getByText('C1 · Có biên bản họp')).toBeTruthy();
    fireEvent.change(inside.getByRole('textbox'), { target: { value: 'đã có' } });
    fireEvent.click(inside.getByRole('button', { name: text('pwf.task.tick.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('completeProjectTaskChecklistItem', expect.objectContaining({ path: { task_id: TASK, item_code: 'C1' }, body: { note: 'đã có' }, ifMatchVersion: 6 })));
  });

  it('marks an item without a note', async () => {
    const h = open({ commands: { completeProjectTaskChecklistItem: OK } });
    await ready();
    press('tick-C1');
    fireEvent.click((await dialog()).getByRole('button', { name: text('pwf.task.tick.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('completeProjectTaskChecklistItem', expect.objectContaining({ body: {} })));
  });

  it('lists the evidence that was attached and says when there is none', async () => {
    open({ task: detail({ evidence: [{ id: uuid(30), item_code: 'C1', evidence_kind: 'DOCUMENT', document_id: null, legal_doc_type: 'INVESTMENT_DECISION', form_template_code: null, external_ref: null, note: 'bản ký', attached_by: ME, attached_at: '2026-12-03T03:00:00.000Z' }] }) });
    await ready();
    const table = within(screen.getByTestId('evidence')).getByRole('table');
    expect(within(table).getByText('INVESTMENT_DECISION')).toBeTruthy();
    expect(within(table).getByText('bản ký')).toBeTruthy();
    cleanup();
    open();
    await ready();
    expect(screen.getByTestId('evidence-empty')).toBeTruthy();
  });

  it('refuses an evidence form with a problem and says it next to the field', async () => {
    const h = open({ commands: { attachProjectTaskEvidence: OK } });
    await ready();
    fireEvent.click(screen.getByTestId('attach'));
    expect(screen.getByTestId('error-kind').textContent).toBe(text('pwf.form.required.error'));
    expect(screen.getByTestId('error-ref').textContent).toBe(text('pwf.form.pickOne.error'));
    change('field-document', 'abc');
    expect(screen.getByTestId('error-document').textContent).toBe(text('pwf.form.pickOne.error'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('attaches evidence, offers the kinds the checklist names and clears the form', async () => {
    const h = open({ commands: { attachProjectTaskEvidence: OK } });
    await ready();
    expect(document.querySelectorAll('#evidence-kinds option').length).toBe(1);
    change('field-kind', 'DOCUMENT');
    change('field-item', 'C1');
    change('field-legal', 'INVESTMENT_DECISION');
    change('field-form', 'FORM_REPORT');
    change('field-ref', 'QD-12/2026');
    change('field-note', 'bản ký');
    fireEvent.click(screen.getByTestId('attach'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('attachProjectTaskEvidence', expect.objectContaining({ path: { task_id: TASK }, body: { evidence_kind: 'DOCUMENT', item_code: 'C1', legal_doc_type: 'INVESTMENT_DECISION', form_template_code: 'FORM_REPORT', external_ref: 'QD-12/2026', note: 'bản ký' } })));
    await waitFor(() => expect((screen.getByTestId('field-kind') as HTMLInputElement).value).toBe(''));
  });

  it('tells a legal document type the edition does not know', async () => {
    open({ commands: { attachProjectTaskEvidence: refusal('LEGAL_DOC_TYPE_UNKNOWN', 422) } });
    await ready();
    change('field-kind', 'DOCUMENT');
    change('field-ref', 'x');
    fireEvent.click(screen.getByTestId('attach'));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwf.problem.legalDocUnknown.error'));
  });
});

describe('PWF-04: exceptions', () => {
  const requested = { id: uuid(8), task_id: TASK, kind: 'PAUSE' as const, items: [], valid_from: '2026-12-01', valid_to: '2026-12-05', reason: LONG, evidence_ref: null, status: 'REQUESTED' as const, requested_by: OTHER, decided_by: null, decided_at: null, decision_note: null, version: 4 };

  it('lists the requests with their kind, period, reason and status', async () => {
    open({ task: detail({ exceptions: [requested, { ...requested, id: uuid(9), kind: 'WAIVE_REQUIREMENT', items: ['C1', 'F1'], valid_from: null, valid_to: null, status: 'REJECTED' }, { ...requested, id: uuid(10), status: 'USED' }] }) });
    await ready();
    const table = within(screen.getByTestId('exceptions')).getByRole('table');
    expect(within(table).getAllByText(text('pwf.exception.pause.word'), { selector: 'td' })).toHaveLength(2);
    expect(within(table).getByText('Có biên bản họp, F1')).toBeTruthy();
    expect(within(table).getAllByText('01/12/2026 – 05/12/2026', { selector: 'td' })).toHaveLength(2);
    expect(within(table).getByText(text('pwf.task.exception.status.requested'))).toBeTruthy();
    expect(within(table).getByText(text('pwf.task.exception.status.rejected'))).toBeTruthy();
    expect(within(table).getByText(text('pwf.task.exception.status.used'))).toBeTruthy();
  });

  it('says so when there is no request', async () => {
    open();
    await ready();
    expect(screen.getByTestId('exceptions-empty')).toBeTruthy();
  });

  it('refuses a request with a short reason and an empty list of waived items and says it in words', async () => {
    const h = open({ commands: { requestProjectTaskException: OK } });
    await ready();
    change('field-exception-reason', 'ngắn');
    fireEvent.click(screen.getByTestId('request'));
    expect(screen.getByTestId('error-exception-reason').textContent).toBe(text('pwf.form.tooShort.error', { min: 20 }));
    expect(screen.getByTestId('error-items').textContent).toBe(text('pwf.form.required.error'));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('asks for the first day of a pause, sends the request and clears the form', async () => {
    const h = open({ commands: { requestProjectTaskException: OK } });
    await ready();
    change('field-exception-kind', 'PAUSE');
    change('field-exception-reason', LONG);
    fireEvent.click(screen.getByTestId('request'));
    expect(screen.getByTestId('error-from').textContent).toBe(text('pwf.form.required.error'));
    change('field-exception-from', '2026-12-01');
    change('field-exception-to', '2026-12-05');
    change('field-exception-ref', 'CV-77');
    fireEvent.click(screen.getByTestId('request'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('requestProjectTaskException', expect.objectContaining({ path: { task_id: TASK }, body: { kind: 'PAUSE', valid_from: '2026-12-01', valid_to: '2026-12-05', evidence_ref: 'CV-77', reason: LONG } })));
    await waitFor(() => expect((screen.getByTestId('field-exception-reason') as HTMLTextAreaElement).value).toBe(''));
  });

  it('starts a waiver from the requirement the completion check says a waiver could cover', async () => {
    const h = open({
      task: detail({ completion: { ok: false, blockers: [{ code: 'MAKER_IS_APPROVER', subject: 'U1' }], coverable: [{ code: 'FORM_MISSING', subject: 'FORM_REPORT' }] } }),
      commands: { requestProjectTaskException: OK },
    });
    await ready();
    expect(document.querySelector('[data-action="waive-U1"]')).toBeNull();
    press('waive-FORM_REPORT');
    await waitFor(() => expect((screen.getByTestId('field-items') as HTMLInputElement).value).toBe('FORM_REPORT'));
    change('field-exception-reason', LONG);
    fireEvent.click(screen.getByTestId('request'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('requestProjectTaskException', expect.objectContaining({ body: { kind: 'WAIVE_REQUIREMENT', items: ['FORM_REPORT'], reason: LONG } })));
  });

  it('tells the refusal of a request in words', async () => {
    open({ commands: { requestProjectTaskException: refusal('PWF_EXCEPTION_INVALID', 422) } });
    await ready();
    change('field-items', 'C1');
    change('field-exception-reason', LONG);
    fireEvent.click(screen.getByTestId('request'));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwf.problem.exceptionInvalid.error'));
  });

  it.each([
    ['APPROVE', 'approve'],
    ['REJECT', 'reject'],
  ] as const)('decides a request (%s) with the version of the request', async (decision, action) => {
    const h = open({ task: detail({ can_approve: true, exceptions: [requested] }), commands: { decideProjectTaskException: OK } });
    await ready();
    press(`${action}-${uuid(8)}`);
    const inside = await dialog();
    fireEvent.change(inside.getByRole('textbox'), { target: { value: 'đã xem xét' } });
    fireEvent.click(inside.getByRole('button', { name: text(`pwf.task.exception.${action}.action`) }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideProjectTaskException', expect.objectContaining({ path: { id: uuid(8) }, body: { decision, note: 'đã xem xét' }, ifMatchVersion: 4 })));
  });

  it('tells the decider who asked for the exception that somebody else must decide', async () => {
    open({ task: detail({ can_approve: true, exceptions: [requested] }), commands: { decideProjectTaskException: refusal('SELF_APPROVAL_DENIED', 403) } });
    await ready();
    press(`approve-${uuid(8)}`);
    fireEvent.click((await dialog()).getByRole('button', { name: text('pwf.task.exception.approve.action') }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwf.problem.selfApproval.error'));
  });

  it('shows no decision buttons to somebody who cannot approve, nor for a request already decided', async () => {
    open({ task: detail({ can_approve: false, exceptions: [requested] }) });
    await ready();
    expect(document.querySelector(`[data-action="approve-${uuid(8)}"]`)).toBeNull();
    cleanup();
    open({ task: detail({ can_approve: true, exceptions: [{ ...requested, status: 'APPROVED' }] }) });
    await ready();
    expect(document.querySelector(`[data-action="approve-${uuid(8)}"]`)).toBeNull();
  });
});

describe('PWF-04: ledger, history and KPI', () => {
  it('shows the assignment ledger of the task with a link to its own screen', async () => {
    open();
    await ready();
    expect(await screen.findByTestId('ledger')).toBeTruthy();
    expect(screen.getByRole('link', { name: text('pwf.task.ledger.link') }).getAttribute('href')).toBe(`/pwf/pwf-16?id=${TASK}`);
  });

  it('shows the history by day, with the reason of a return', async () => {
    open({
      task: detail({
        history: [
          { id: uuid(31), kind: 'START', at: '2026-12-01T01:00:00.000Z', actor: ME, reason: null },
          { id: uuid(32), kind: 'RETURNED', at: '2026-12-02T01:00:00.000Z', actor: OTHER, reason: 'thiếu biên bản nghiệm thu' },
          { id: uuid(33), kind: 'PAUSE_APPROVED', at: '2026-12-03T01:00:00.000Z', actor: OTHER, reason: null },
          { id: uuid(34), kind: 'SOMETHING_NEW', at: '2026-12-04T01:00:00.000Z', actor: OTHER, reason: null },
        ],
      }),
    });
    await ready();
    const history = within(screen.getByTestId('history'));
    expect(history.getByText(text('pwf.task.history.start.word'))).toBeTruthy();
    expect(history.getByText(text('pwf.task.history.returned.word'))).toBeTruthy();
    expect(history.getByText('thiếu biên bản nghiệm thu')).toBeTruthy();
    expect(history.getByText(text('pwf.task.history.pauseApproved.word'))).toBeTruthy();
    expect(history.getByText('SOMETHING_NEW')).toBeTruthy();
  });

  it('shows the KPI results with the "i" of each and the facts they were computed from', async () => {
    open({ task: detail({ kpi_results: [{ id: uuid(7), kpi_code: 'ON_TIME', operation: 'DAYS_DEVIATION', kpi_set_rule_id: null, kpi_set_version: 2, state: 'OK', value: 3, score: 90, weight: 1, inputs_hash: 'c'.repeat(64), inputs: { due: '2026-12-10', waived: null }, computed_at: '2026-12-11T01:00:00.000Z', supersedes_id: null }, { id: uuid(8), kpi_code: 'RET', operation: 'RETURN_COUNT', kpi_set_rule_id: null, kpi_set_version: 2, state: 'MISSING_FACT', value: null, score: null, weight: 1, inputs_hash: 'd'.repeat(64), inputs: {}, computed_at: '2026-12-11T01:00:00.000Z', supersedes_id: null }] }) });
    await ready();
    const kpi = within(screen.getByTestId('kpi'));
    expect(kpi.getByText(text('pwf.task.kpi.state.ok'))).toBeTruthy();
    expect(kpi.getByText(text('pwf.task.kpi.state.missingFact'))).toBeTruthy();
    expect(kpi.getByText('2026-12-10')).toBeTruthy();
    fireEvent.click(kpi.getByRole('button', { name: text('govc.bi.info.open', { name: 'ON_TIME' }) }));
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.task.kpi.formula.daysDeviation'));
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.task.kpi.source.text', { hash: 'c'.repeat(12) }));
  });

  it('says the KPI is hidden when the caller may not see it, and empty when there is none', async () => {
    // A person who may not see the KPI gets no empty card about it.
    open();
    await ready();
    expect(screen.queryByTestId('kpi')).toBeNull();
    cleanup();
    open({ task: detail({ kpi_results: [] }) });
    await ready();
    expect(screen.getByTestId('kpi-empty')).toBeTruthy();
  });
});
