import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { ME, OTHER, ALL_PERMISSIONS, READ_ONLY, refusal, routeOf, schedulePreview, scheduleTask, serve, templateParams, text } from '../test/fixtures';
import type { Answer } from '../test/fixtures';
import { shippedEffective, templateEffective, templateVersion, uuid, validation } from './test/fixtures';
import { mountAs } from './test/mount';
import TemplateEditorScreen from './TemplateEditorScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-02');
const WITHIN = { timeout: 4000 };

interface Setup {
  path?: string;
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  effective?: Answer;
  versions?: unknown[];
  rule?: unknown;
  commands?: Record<string, Answer>;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getEffectiveGovernanceRule: setup.effective ?? templateEffective(),
      listGovernanceRuleVersions: { items: setup.versions ?? [templateVersion(2), templateVersion(1, { status: 'RETIRED', phase: 'ENDED' })] },
      getGovernanceRule: setup.rule ?? templateVersion(1),
    },
    {
      validateProjectWorkflowTemplate: validation(),
      previewProjectWorkflowTemplate: schedulePreview(),
      createGovernanceRuleDraft: { resource_id: uuid(200), status: 'DRAFT', resource_version: 1 },
      ...setup.commands,
    },
  );
  mountAs(<TemplateEditorScreen route={route} />, h, { permissions: setup.permissions ?? ALL_PERMISSIONS, ...(setup.mode === undefined ? {} : { mode: setup.mode }), path: setup.path ?? '/pwf/pwf-02?code=PUBLIC_INVESTMENT' });
  return h;
};

const field = (path: string) => screen.getByTestId(`field-${path}`) as HTMLInputElement;
const change = (path: string, value: string) => fireEvent.change(field(path), { target: { value } });
const click = (action: string) => fireEvent.click(document.querySelector(`[data-action="${action}"]`) as HTMLElement);
const ready = async () => screen.findByTestId('tree');
const lastBody = (h: ReturnType<typeof open>, operation: string) => {
  const calls = h.command.mock.calls.filter((call) => call[0] === operation);
  return (calls[calls.length - 1]?.[1] as { body: Record<string, unknown> }).body;
};

describe('PWF-02: starting the template', () => {
  it('starts from the rule in force of the code: name, project type, phases and the task tree', async () => {
    open();
    await ready();
    expect(field('name').value).toBe('Mẫu bản 2');
    expect(field('project_type').value).toBe('CONSTRUCTION');
    expect(field('code').value).toBe('PUBLIC_INVESTMENT');
    expect(field('phases[0].code').value).toBe('PREPARATION');
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwf.templates.editor.base.rule', { version: 2 }));
    const tree = screen.getByTestId('tree');
    expect(within(tree).getByText('T1')).toBeTruthy();
    expect(within(tree).getByText('T2')).toBeTruthy();
    // The milestone says so, in words.
    expect(within(tree).getByText(text('pwf.kind.milestone.word'))).toBeTruthy();
    // Every limit has its "i".
    expect(screen.getAllByTestId('limit').length).toBeGreaterThanOrEqual(2);
  });

  it('labels a template that ships unconfirmed, and says it is the shipped one', async () => {
    open({ path: '/pwf/pwf-02?code=PUBLIC_REPAIR', effective: shippedEffective() });
    await ready();
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwf.templates.editor.base.default'));
    expect(screen.getAllByText(text('pwf.common.unverified.label')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('unverified-note')).toBeTruthy();
  });

  it('starts from the version the address names, and says when that version is not there', async () => {
    open({ path: `/pwf/pwf-02?code=PUBLIC_INVESTMENT&from=${uuid(101)}`, rule: templateVersion(1, { params: templateParams({ name: 'Bản một' }) }) });
    await waitFor(() => expect(field('name').value).toBe('Bản một'));
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwf.templates.editor.base.version', { version: 1 }));
    cleanup();
    open({ path: `/pwf/pwf-02?code=PUBLIC_INVESTMENT&from=${uuid(105)}`, rule: refusal('GOVERNANCE_RULE_NOT_FOUND', 404) });
    expect(await screen.findByTestId('from-missing')).toBeTruthy();
  });

  it('opens blank with one empty phase when no code is given, and takes the rule in force once a code is typed', async () => {
    open({ path: '/pwf/pwf-02', effective: refusal('GOVERNANCE_RULE_NOT_FOUND', 404) });
    await ready();
    expect(screen.getByTestId('base-note').textContent).toBe(text('pwf.templates.editor.base.blank'));
    expect(field('phases[0].code').value).toBe('P1');
    expect(field('name').value).toBe('');
    change('code', 'public_repair');
    expect(field('code').value).toBe('PUBLIC_REPAIR');
  });

  it('is denied without the permission to manage templates and reads nothing', () => {
    const h = open({ permissions: READ_ONLY });
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the template but changes nothing when the session is read-only', async () => {
    const h = open({ mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('read-only')).toBeTruthy();
    expect(field('name').disabled).toBe(true);
    expect(screen.getByTestId('no-store')).toBeTruthy();
    expect(screen.queryByTestId('save')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });
});

describe('PWF-02: editing the template', () => {
  it('edits the phases: a gate of a command of the project, a new phase, and the removal of one with its tasks', async () => {
    open();
    await ready();
    fireEvent.click(field('phases[0].gates.closeProject'));
    expect(field('phases[0].gates.closeProject').checked).toBe(true);
    fireEvent.click(field('phases[0].gates.closeProject'));
    expect(field('phases[0].gates.closeProject').checked).toBe(false);
    change('phases[0].name', 'Chuẩn bị');
    click('add-phase');
    expect(field('phases[1].code').value).toBe('P2');
    click('remove-phase-0');
    await waitFor(() => expect(screen.queryByTestId('pick-0')).toBeNull());
    expect(screen.getByTestId('task-pick')).toBeTruthy();
  });

  it('adds a task, selects it, and edits every part: identity, duration, roles, constraint, links, branches, documents, checklist', async () => {
    const h = open();
    await ready();
    click('add-task');
    // The new task is selected and its panel is open.
    expect(field('tasks[2].code').value).toBe('T3');
    change('tasks[2].code', 'T3X');
    change('tasks[2].name', 'Việc mới');
    change('tasks[2].duration_working_days', '12');
    change('tasks[2].kind', 'MILESTONE');
    change('tasks[2].priority', 'HIGH');
    change('tasks[2].responsible_role', 'PROJECT_MANAGER');
    change('tasks[2].approver_role', 'APPROVER');
    fireEvent.click(field('tasks[2].required'));
    // A constraint with its offset.
    change('tasks[2].constraint.kind', 'FNLT');
    change('tasks[2].constraint.offset_working_days', '30');
    // A link: the first free task, then its kind and lag.
    click('add-link');
    change('tasks[2].predecessors[0].kind', 'SS');
    change('tasks[2].predecessors[0].lag_working_days', '-2');
    // A branch.
    click('add-branch');
    change('tasks[2].when[0].field', 'funding_source');
    change('tasks[2].when[0].in', 'STATE, ODA');
    // Documents and KPI codes, typed with a trailing comma and kept as typed.
    change('tasks[2].legal_doc_types', 'INVESTMENT_DECISION, ');
    expect((field('tasks[2].legal_doc_types') as unknown as HTMLTextAreaElement).value).toBe('INVESTMENT_DECISION, ');
    change('tasks[2].form_templates', 'FORM_REPORT');
    change('tasks[2].kpi_codes', 'ON_TIME');
    // A checklist item.
    click('add-item');
    change('tasks[2].checklist[0].code', 'C1');
    change('tasks[2].checklist[0].name', 'Có biên bản');
    change('tasks[2].checklist[0].evidence_kinds', 'DOCUMENT');
    fireEvent.click(field('tasks[2].checklist[0].required'));
    change('code', 'PUBLIC_TEST');
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Thêm việc mới cho thử nghiệm' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('createGovernanceRuleDraft', expect.anything()));
    const body = lastBody(h, 'createGovernanceRuleDraft') as { rule_type: string; code: string; params: { tasks: Record<string, unknown>[] }; reason: string };
    expect(body.rule_type).toBe('PROJECT_WORKFLOW_TEMPLATE');
    expect(body.code).toBe('PUBLIC_TEST');
    expect(body.params.tasks[2]).toMatchObject({
      code: 'T3X',
      name: 'Việc mới',
      kind: 'MILESTONE',
      duration_working_days: 12,
      priority: 'HIGH',
      responsible_role: 'PROJECT_MANAGER',
      approver_role: 'APPROVER',
      required: false,
      constraint: { kind: 'FNLT', offset_working_days: 30 },
      predecessors: [{ task: 'T1', kind: 'SS', lag_working_days: -2 }],
      when: [{ field: 'funding_source', in: ['STATE', 'ODA'] }],
      legal_doc_types: ['INVESTMENT_DECISION'],
      form_templates: ['FORM_REPORT'],
      kpi_codes: ['ON_TIME'],
      checklist: [{ code: 'C1', name: 'Có biên bản', required: false, evidence_kinds: ['DOCUMENT'] }],
    });
    expect(await screen.findByTestId('written')).toBeTruthy();
  });

  it('removes a link, a branch, a checklist item and a task; renaming a task code follows into the links', async () => {
    open();
    await ready();
    fireEvent.click(screen.getByTestId('pick-1'));
    expect(screen.getByTestId('predecessors').querySelectorAll('li')).toHaveLength(1);
    click('remove-link-0');
    expect(screen.getByTestId('predecessors').querySelectorAll('li')).toHaveLength(0);
    click('add-branch');
    click('remove-branch-0');
    click('add-item');
    click('remove-item-0');
    fireEvent.click(screen.getByTestId('pick-0'));
    change('tasks[0].code', 'FIRST');
    fireEvent.click(screen.getByTestId('pick-1'));
    click('add-link');
    expect((field('tasks[1].predecessors[0].task') as unknown as HTMLSelectElement).value).toBe('FIRST');
    click('remove-task');
    expect(screen.queryByTestId('pick-1')).toBeNull();
    expect(screen.getByTestId('task-pick')).toBeTruthy();
  });

  it('names the problems of a template in a summary and next to each field when it is saved, and sends nothing', async () => {
    const h = open({ path: '/pwf/pwf-02', effective: refusal('GOVERNANCE_RULE_NOT_FOUND', 404) });
    await ready();
    fireEvent.click(screen.getByTestId('save'));
    const summary = await screen.findByTestId('period-problems');
    expect(summary.textContent).toContain(text('gova1.form.error.code'));
    expect(screen.getByTestId('error-name').textContent).toContain(text('pwf.templates.problem.required.error'));
    expect(screen.getByTestId('error-phases[0].name')).toBeTruthy();
    expect(screen.getByTestId('error-tasks').textContent).toContain(text('pwf.templates.tasks.required.error'));
    expect(field('name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('local-problems').textContent).toContain('phases[0].name');
    expect(h.command).not.toHaveBeenCalledWith('createGovernanceRuleDraft', expect.anything());
  });

  it('marks a task that needs a fix in the tree, with a word', async () => {
    open();
    await ready();
    fireEvent.click(screen.getByTestId('pick-0'));
    change('tasks[0].duration_working_days', '');
    click('validate');
    expect(within(screen.getByTestId('pick-0')).getByText(text('pwf.templates.task.problem.word'))).toBeTruthy();
    expect(screen.getByTestId('error-tasks[0].duration_working_days')).toBeTruthy();
  });

  it('refuses the phase "none" in the task and keeps tasks of a missing phase apart', async () => {
    open({ effective: templateEffective({ params: templateParams({ tasks: [{ ...templateParams().tasks[0]!, phase: 'GONE' }] }) }) });
    await ready();
    expect(within(screen.getByTestId('tree')).getByText(text('pwf.templates.tasks.orphans.text'))).toBeTruthy();
  });
});

describe('PWF-02: the checks of the server', () => {
  it('checks the template once it is open and shows counts with their "i", the findings by path and the quality flags that never block', async () => {
    open({
      commands: {
        validateProjectWorkflowTemplate: validation({
          valid: false,
          findings: [
            { code: 'PWF_DEPENDENCY_CYCLE', path: 'tasks[1].predecessors[0]', severity: 'ERROR', detail: 'T1 -> T2 -> T1' },
            { code: 'LONG_NAME', path: 'name', severity: 'WARNING' },
          ],
          quality_flags: [
            { code: 'MISSING_SUCCESSOR', task: 'T2' },
            { code: 'LONG_TASK', task: 'T1', detail: '60' },
            { code: 'SOMETHING_NEW' },
          ],
        }),
      },
    });
    const panel = await screen.findByTestId('validation', undefined, WITHIN);
    expect(within(panel).getByText(text('pwf.templates.validate.invalid.word'))).toBeTruthy();
    expect(within(panel).getByTestId('count-tasks').textContent).toBe('2');
    expect(within(panel).getByTestId('findings').textContent).toContain('tasks[1].predecessors[0]');
    expect(within(panel).getByTestId('findings').textContent).toContain(text('pwf.templates.finding.error.word'));
    expect(within(panel).getByTestId('findings').textContent).toContain(text('pwf.templates.finding.warning.word'));
    expect(within(panel).getByTestId('quality').textContent).toContain(text('pwf.templates.quality.missingSuccessor.word'));
    expect(within(panel).getByTestId('quality').textContent).toContain(text('pwf.templates.quality.longTask.word'));
    expect(within(panel).getByTestId('quality').textContent).toContain('SOMETHING_NEW');
    expect(within(panel).getByTestId('template-hash').textContent).toContain('cccccccccccc');
    // The three counts each carry the "i".
    fireEvent.click(within(within(panel).getByTestId('validation-counts')).getAllByRole('button')[0] as HTMLElement);
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.templates.validate.tasks.formula'));
  });

  it('says there are no hints when the schedule has none, and that the result is old once the text changes', async () => {
    open();
    expect((await screen.findByTestId('quality-none', undefined, WITHIN)).textContent).toBe(text('pwf.templates.quality.none.text'));
    change('name', 'Tên khác');
    expect(await screen.findByTestId('validate-stale')).toBeTruthy();
    // After the person stops typing the server checks again and the result is current.
    await waitFor(() => expect(screen.queryByTestId('validate-stale')).toBeNull(), WITHIN);
  });

  it('checks on demand and shows what the editor finds wrong without asking the server', async () => {
    const h = open();
    await screen.findByTestId('validation', undefined, WITHIN);
    const before = h.command.mock.calls.filter((call) => call[0] === 'validateProjectWorkflowTemplate').length;
    click('validate');
    await waitFor(() => expect(h.command.mock.calls.filter((call) => call[0] === 'validateProjectWorkflowTemplate').length).toBeGreaterThan(before));
    change('phases[0].code', 'bad');
    click('validate');
    expect(screen.getByTestId('local-problems').textContent).toContain('phases[0].code');
  });

  it('says in words that the server refused to check, and keeps the screen', async () => {
    open({ commands: { validateProjectWorkflowTemplate: refusal('PWF_DEPENDENCY_CYCLE') } });
    const banner = await screen.findByTestId('problem', undefined, WITHIN);
    expect(banner.textContent).toContain(text('pwf.problem.dependencyCycle.error'));
    expect(screen.getByTestId('validate-none')).toBeTruthy();
  });

  it('tries the schedule on a start day and the facts of a project: dates, float, the critical path, and a year with no calendar in words', async () => {
    const h = open({
      commands: {
        previewProjectWorkflowTemplate: schedulePreview({
          project_finish: null,
          critical_path: ['T1', 'T2'],
          tasks: [
            scheduleTask('T1', { total_float: 0, free_float: 0, critical: true }),
            scheduleTask('T2', { state: 'CALENDAR_UNAVAILABLE', start: null, finish: null, total_float: null, free_float: null, critical: false, missing_year: 2028 }),
          ],
          excluded_tasks: ['T9'],
          findings: [{ code: 'CALENDAR_UNAVAILABLE', task: 'T2', year: 2028 }, { code: 'CONSTRAINT_VIOLATED', task: null }],
        }),
      },
    });
    await ready();
    expect(screen.getByTestId('preview-none')).toBeTruthy();
    fireEvent.change(screen.getByTestId('preview-start'), { target: { value: '2027-01-04' } });
    change('preview.project_group', ' A ');
    click('preview');
    const preview = await screen.findByTestId('preview');
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('previewProjectWorkflowTemplate', expect.anything()));
    const body = lastBody(h, 'previewProjectWorkflowTemplate') as { planned_start_date: string; facts: Record<string, string>; params: { name: string } };
    expect(body.planned_start_date).toBe('2027-01-04');
    expect(body.facts).toEqual({ project_group: 'A' });
    expect(body.params.name).toBe('Mẫu bản 2');
    expect(within(preview).getByTestId('critical-path').textContent).toBe('T1 → T2');
    expect(within(preview).getByText(text('pwf.templates.preview.noFinish.text'))).toBeTruthy();
    expect(within(preview).getAllByText(text('pwf.common.calendarMissingYear.text', { year: 2028 })).length).toBe(2);
    expect(within(preview).getByTestId('calendar-missing').textContent).toContain('2028');
    expect(within(preview).getByText(text('pwf.templates.preview.critical.word'))).toBeTruthy();
    expect(within(preview).getByText(text('pwf.templates.preview.float.text', { total: 0, free: 0 }))).toBeTruthy();
    expect(within(preview).getByTestId('preview-findings').textContent).toContain(text('pwf.templates.finding.calendarUnavailable.word'));
    expect(within(preview).getByTestId('preview-excluded').textContent).toContain('T9');
    // Each figure carries the "i".
    fireEvent.click(within(within(preview).getByTestId('preview-summary')).getAllByRole('button')[0] as HTMLElement);
    expect(screen.getByRole('dialog').textContent).toContain(text('pwf.templates.preview.projectFinish.formula'));
  });

  it('asks for a real start day and says the schedule is old once the template changes; says a refusal of the preview in words', async () => {
    const h = open();
    await ready();
    fireEvent.change(screen.getByTestId('preview-start'), { target: { value: '' } });
    click('preview');
    expect(h.command).not.toHaveBeenCalledWith('previewProjectWorkflowTemplate', expect.anything());
    fireEvent.change(screen.getByTestId('preview-start'), { target: { value: '2027-01-04' } });
    click('preview');
    await screen.findByTestId('preview');
    change('name', 'Đổi tên');
    expect(await screen.findByTestId('preview-stale')).toBeTruthy();
    cleanup();
    open({ commands: { previewProjectWorkflowTemplate: refusal('CALENDAR_NOT_EFFECTIVE') } });
    await ready();
    click('preview');
    await waitFor(() => expect(screen.getAllByTestId('problem').some((node) => node.textContent?.includes(text('pwf.problem.calendarNotEffective.error')))).toBe(true));
  });
});

describe('PWF-02: the rule store', () => {
  it('saves a draft with the period and the reason, and says what the store refuses', async () => {
    const h = open({ commands: { createGovernanceRuleDraft: refusal('GOVERNANCE_RULE_PERIOD_OVERLAP', 409) } });
    await ready();
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('period-problems')).textContent).toContain(text('gova1.form.error.reason', { min: 5, max: 500 }));
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Sửa thời lượng giai đoạn' } });
    fireEvent.change(screen.getByTestId('to'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByTestId('save'));
    expect(screen.getByTestId('period-problems').textContent).toContain(text('gova1.form.error.to'));
    fireEvent.change(screen.getByTestId('to'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('refusal')).textContent).toBe(text('gova1.refusal.overlap'));
    expect(lastBody(h, 'createGovernanceRuleDraft')).toMatchObject({ reason: 'Sửa thời lượng giai đoạn', effective_from: '2026-11-08' });
  });

  it('says the refusal of the module itself when the store rejects the template', async () => {
    open({ commands: { createGovernanceRuleDraft: refusal('PROJECT_WORKFLOW_TEMPLATE_INVALID', 422, {}, 'tasks[1]') } });
    await ready();
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Mẫu cần được lưu' } });
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('refusal')).textContent).toBe(text('pwf.problem.templateInvalidField.error', { field: 'tasks[1]' }));
  });

  it('lets a new draft be written after one was saved', async () => {
    open();
    await ready();
    fireEvent.change(screen.getByTestId('reason'), { target: { value: 'Lưu bản nháp đầu' } });
    fireEvent.click(screen.getByTestId('save'));
    fireEvent.click(await screen.findByTestId('again'));
    expect((screen.getByTestId('reason') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByTestId('written')).toBeNull();
  });

  it('warns that the new version takes over from the version in force', async () => {
    open({ versions: [templateVersion(2, { effective_from: '2026-06-01', approved_by: OTHER, approved_at: '2026-05-01T03:00:00.000Z' })] });
    await ready();
    expect(await screen.findByTestId('notice-takeover')).toBeTruthy();
  });

  it('lists the versions with who made and who checked each, and a link to continue from one or compare it', async () => {
    open();
    const list = await screen.findByTestId('versions');
    const first = list.querySelector('li') as HTMLElement;
    expect(within(first).getByText(text('gova1.detail.version.title', { version: 2 }))).toBeTruthy();
    expect(within(first).getByRole('group', { name: text('ui.makerChecker.label') })).toBeTruthy();
    expect(within(first).getByTestId('from-2').getAttribute('href')).toBe(`/pwf/pwf-02?code=PUBLIC_INVESTMENT&from=${uuid(102)}`);
    expect(within(first).getByTestId('diff-2').getAttribute('href')).toBe(`/adm/adm-22?rule=${uuid(102)}&against=${uuid(101)}`);
  });

  it('submits a draft through a dialog that asks for a reason, with the version the person saw', async () => {
    const h = open({ versions: [templateVersion(3, { status: 'DRAFT', phase: 'DRAFT', created_by: ME })], commands: { submitGovernanceRule: { resource_id: uuid(103), status: 'SUBMITTED', resource_version: 2 } } });
    await screen.findByTestId('versions');
    click('submit-3');
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: text('gova1.move.submit') });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Trình duyệt bản mới' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitGovernanceRule', expect.objectContaining({ ifMatchVersion: 1, path: { ruleId: uuid(103) } })));
    expect(await screen.findByTestId('receipt')).toBeTruthy();
  });

  it('does not let the maker approve: the button is off and says why', async () => {
    open({ versions: [templateVersion(3, { status: 'SUBMITTED', phase: 'SUBMITTED', created_by: ME, submitted_by: ME, effective_from: '2026-12-01' })] });
    const approve = await screen.findByRole('button', { name: text('gova1.move.approve') });
    expect(approve).toBeDisabled();
    expect(screen.getByText(text('gova1.block.selfApproval'))).toBeTruthy();
  });

  it('lets a third person approve', async () => {
    open({ versions: [templateVersion(3, { status: 'SUBMITTED', phase: 'SUBMITTED', created_by: OTHER, submitted_by: OTHER, effective_from: '2026-12-01' })] });
    expect(await screen.findByRole('button', { name: text('gova1.move.approve') })).not.toBeDisabled();
  });

  it('says there is no version yet for a code that has none', async () => {
    open({ versions: [] });
    expect((await screen.findByTestId('no-versions')).textContent).toBe(text('gova1.detail.versions.none'));
  });
});

describe('PWF-02: accessibility', () => {
  it('has no serious accessibility violation with a task open and the checks shown', async () => {
    open();
    await screen.findByTestId('validation', undefined, WITHIN);
    fireEvent.click(screen.getByTestId('pick-1'));
    click('validate');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
