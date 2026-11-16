import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { effectiveBody } from '../../adm/governance/test/fixtures';
import { ME, OTHER, ALL_PERMISSIONS, READ_ONLY, refusal, routeOf, schedulePreview, scheduleTask, serve, templateParams, text } from '../test/fixtures';
import type { Answer } from '../test/fixtures';
import { DRAFT_PREFIX } from './draft-store';
import { PREVIEW_DELAY_MS } from './live-preview';
import builtIn from './test/builtin-templates.json';
import roadRepair from './test/cb-road-repair.json';
import { shippedEffective, templateEffective, templateVersion, uuid, validation } from './test/fixtures';
import { mountAs } from './test/mount';
import TemplateEditorScreen from './TemplateEditorScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const route = routeOf('PWF-02');
const WITHIN = { timeout: 4000 };
const TEMPLATE = 'PROJECT_WORKFLOW_TEMPLATE';

interface Setup {
  path?: string;
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  effective?: Answer;
  versions?: unknown[];
  rule?: unknown;
  assignment?: unknown;
  commands?: Record<string, Answer>;
  /** The kinds of project and the units of the tenant. */
  projectTypes?: unknown[];
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getEffectiveGovernanceRule: (input: Record<string, unknown>) => {
        const type = (input.query as { rule_type: string }).rule_type;
        if (type === TEMPLATE) return typeof setup.effective === 'function' ? (setup.effective as (i: unknown) => unknown)(input) : (setup.effective ?? templateEffective());
        return setup.assignment ?? effectiveBody({ rule_type: 'PROJECT_WORKFLOW_ASSIGNMENT', code: 'DEFAULT', params: { lines: [] }, version: 1, source: 'RULE', rule_id: uuid(300) });
      },
      listGovernanceRuleVersions: { items: setup.versions ?? [templateVersion(2), templateVersion(1, { status: 'RETIRED', phase: 'ENDED' })] },
      getGovernanceRule: setup.rule ?? ((input: Record<string, unknown>) => templateVersion(3, { id: (input.path as { ruleId: string }).ruleId, status: 'DRAFT', phase: 'DRAFT', created_by: ME })),
      getGovernanceRuleCatalog: { items: [] },
    },
    {
      validateProjectWorkflowTemplate: validation(),
      previewProjectWorkflowTemplate: schedulePreview(),
      createGovernanceRuleDraft: { resource_id: uuid(200), status: 'DRAFT', resource_version: 1 },
      submitGovernanceRule: { resource_id: uuid(200), status: 'SUBMITTED', resource_version: 2 },
      ...setup.commands,
    },
  );
  (h.client.readAll as ReturnType<typeof vi.fn>).mockImplementation(async (operation: string) => (operation === 'searchMasterRecords' ? (setup.projectTypes ?? []) : []));
  mountAs(<TemplateEditorScreen route={route} />, h, { permissions: setup.permissions ?? ALL_PERMISSIONS, ...(setup.mode === undefined ? {} : { mode: setup.mode }), path: setup.path ?? '/pwf/pwf-02?code=PUBLIC_INVESTMENT' });
  return h;
};

const ready = async () => screen.findByTestId('steps-table');
const rowOf = (key: string): HTMLElement => document.querySelector(`[data-line="${key}"]`) as HTMLElement;
const nameInputs = (): HTMLInputElement[] => Array.from(document.querySelectorAll<HTMLInputElement>('[data-field="name"]'));
const lastBody = (h: ReturnType<typeof open>, operation: string) => {
  const calls = h.command.mock.calls.filter((call) => call[0] === operation);
  return (calls[calls.length - 1]?.[1] as { body: Record<string, unknown> }).body;
};
const callsOf = (h: ReturnType<typeof open>, operation: string) => h.command.mock.calls.filter((call) => call[0] === operation);
/** Opens the version in force for writing: a new draft. */
const fork = async () => {
  await ready();
  fireEvent.click(screen.getByTestId('new-draft'));
};
const saveWith = async (reason: string) => {
  fireEvent.click(screen.getByTestId('save-draft'));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: reason } });
  fireEvent.click(within(dialog).getByRole('button', { name: text('pwfx.action.saveDraft') }));
};

describe('PWF-02: one table of steps', () => {
  it('opens the procedure in force as one table: a row for each step with its unit, start point, time limit and the three colours', async () => {
    open();
    await ready();
    expect(screen.getByTestId('template-title').textContent).toBe('Mẫu bản 2');
    expect(nameInputs().map((input) => input.value)).toEqual(['Lập báo cáo nghiên cứu khả thi', 'Thẩm định']);
    expect((within(rowOf('task:T2')).getByLabelText(/mốc tính của bước 2/i) as HTMLSelectElement).value).toBe('task:T1');
    expect((within(rowOf('task:T1')).getByLabelText(/mốc tính của bước 1/i) as HTMLSelectElement).value).toBe('start');
    expect((screen.getByTestId('limit-task:T1') as HTMLInputElement).value).toBe('20');
    expect(within(rowOf('task:T1')).getAllByLabelText(/ngưỡng/i)).toHaveLength(3);
  });

  it('is denied without the permission to manage templates', async () => {
    open({ permissions: READ_ONLY });
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('opens the draft in the making when the code has one, writable, with its state in the header', async () => {
    open({ versions: [templateVersion(3, { status: 'DRAFT', phase: 'DRAFT', created_by: ME, params: templateParams({ name: 'Bản nháp 3' }) }), templateVersion(2)] });
    await ready();
    expect(screen.getByTestId('template-title').textContent).toBe('Bản nháp 3');
    expect(screen.getByTestId('template-sub').textContent).toContain(text('gova1.status.draft'));
    expect(screen.queryByTestId('read-only')).toBeNull();
  });

  it('says when the version the address names is not there', async () => {
    open({ path: `/pwf/pwf-02?from=${uuid(999)}`, rule: refusal('RESOURCE_NOT_FOUND', 404) });
    expect(await screen.findByTestId('from-missing')).toBeTruthy();
  });

  it('adds a step that copies the unit, the limit and the three colours of the row above and starts when it is done; no code is asked for', async () => {
    open();
    await fork();
    fireEvent.change(screen.getByLabelText(/ngưỡng đỏ.*bước 2/i), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/ngưỡng vàng.*bước 2/i), { target: { value: '3' } });
    fireEvent.click(document.querySelector('[data-action="add-step-PREPARATION"]') as HTMLElement);
    await waitFor(() => expect(nameInputs()).toHaveLength(3));
    const added = nameInputs()[2] as HTMLInputElement;
    expect(document.activeElement).toBe(added);
    const row = added.closest('tr') as HTMLElement;
    expect((within(row).getByLabelText(/^thời hạn của bước 3$/i) as HTMLInputElement).value).toBe('1');
    expect((within(row).getByLabelText(/ngưỡng đỏ.*bước 3/i) as HTMLInputElement).value).toBe('1');
    expect((within(row).getByLabelText(/ngưỡng vàng.*bước 3/i) as HTMLInputElement).value).toBe('3');
    expect((within(row).getByLabelText(/vai trò của bước 3/i) as HTMLSelectElement).value).toBe('APPROVER');
    expect((within(row).getByLabelText(/mốc tính của bước 3/i) as HTMLSelectElement).value).toBe('task:T2');
    expect(screen.queryByLabelText(/^mã/i)).toBeNull();
    // The code is made from the name once it is given, and a later rename never changes it.
    fireEvent.change(added, { target: { value: 'Phê duyệt kết quả' } });
    fireEvent.blur(added);
    expect(document.querySelector('[data-line="task:PHE_DUYET_KET_QUA"]')).toBeTruthy();
    fireEvent.change(added, { target: { value: 'Quyết định phê duyệt' } });
    fireEvent.blur(added);
    expect(document.querySelector('[data-line="task:PHE_DUYET_KET_QUA"]')).toBeTruthy();
  });

  it('deletes a row and puts it back with Undo, until the next edit', async () => {
    open();
    await fork();
    fireEvent.click(screen.getByTestId('remove-task:T2'));
    expect(nameInputs()).toHaveLength(1);
    fireEvent.click(screen.getByTestId('undo'));
    expect(nameInputs()).toHaveLength(2);
    expect(screen.queryByTestId('undo')).toBeNull();
    fireEvent.click(screen.getByTestId('remove-task:T2'));
    fireEvent.change(nameInputs()[0] as HTMLInputElement, { target: { value: 'Đổi tên' } });
    expect(screen.queryByTestId('undo')).toBeNull();
  });

  it('reorders a row with the buttons and marks one row as the deadline of the whole file', async () => {
    open();
    await fork();
    fireEvent.click(within(rowOf('task:T2')).getByRole('button', { name: /đưa lên/ }));
    expect(nameInputs().map((input) => input.value)).toEqual(['Thẩm định', 'Lập báo cáo nghiên cứu khả thi']);
    fireEvent.click(screen.getByTestId('overall-task:T1'));
    expect(screen.getByTestId('overall-task:T1').getAttribute('aria-pressed')).toBe('true');
  });

  it('says a problem at the cell of the row the person has been in, and the summary jumps to that cell', async () => {
    open();
    await fork();
    const first = nameInputs()[0] as HTMLInputElement;
    fireEvent.change(first, { target: { value: '' } });
    // Not said yet: the person has not left the row.
    expect(within(rowOf('task:T1')).queryByTestId('cell-problem')).toBeNull();
    fireEvent.blur(first);
    expect(await within(rowOf('task:T1')).findByTestId('cell-problem')).toBeTruthy();
    expect(first.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(await screen.findByTestId('jump'));
    await waitFor(() => expect(document.activeElement).toBe(first));
    // A limit that is not a whole number is said at the limit cell.
    fireEvent.change(screen.getByTestId('limit-task:T1'), { target: { value: '' } });
    fireEvent.blur(screen.getByTestId('limit-task:T1'));
    await waitFor(() => expect(within(rowOf('task:T1')).getAllByTestId('cell-problem')).toHaveLength(2));
  });

  it('names what an advanced link says on the row and keeps it when saved', async () => {
    const params = templateParams();
    params.tasks[1] = { ...params.tasks[1], predecessors: [{ task: 'T1', kind: 'SS', lag_working_days: 2 }] } as never;
    const h = open({ effective: templateEffective({ params }), versions: [templateVersion(2, { params })] });
    await fork();
    const row = rowOf('task:T2');
    expect(within(row).getByLabelText(/mốc tính của bước 2/i)).toHaveProperty('value', '~advanced');
    expect(within(row).getByLabelText(/liên kết và điều kiện nâng cao/i).textContent).toContain('bắt đầu cùng lúc với');
    await saveWith('Giữ nguyên liên kết nâng cao');
    await waitFor(() => expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(1));
    expect((lastBody(h, 'createGovernanceRuleDraft').params as { tasks: { predecessors: unknown[] }[] }).tasks[1]?.predecessors).toEqual([{ task: 'T1', kind: 'SS', lag_working_days: 2 }]);
  });
});

describe('PWF-02: a long procedure and the header', () => {
  const long = builtIn.PUBLIC_INVESTMENT as never;
  it('folds the phases after the first when the procedure has more than 12 rows, and opens one on request', async () => {
    open({ effective: templateEffective({ params: long }), versions: [templateVersion(2, { params: long })] });
    await ready();
    const first = document.querySelectorAll('tbody[data-phase]')[0] as HTMLElement;
    const second = document.querySelectorAll('tbody[data-phase]')[1] as HTMLElement;
    expect(first.querySelectorAll('tr.pwfx-row').length).toBeGreaterThan(0);
    expect(second.querySelectorAll('tr.pwfx-row')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('phase-toggle-1'));
    expect(second.querySelectorAll('tr.pwfx-row').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('phase-toggle-1'));
    expect(second.querySelectorAll('tr.pwfx-row')).toHaveLength(0);
  });

  it('keeps a short procedure fully open', async () => {
    open();
    await ready();
    expect(screen.getByTestId('phase-toggle-0').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('tr.pwfx-row')).toHaveLength(2);
  });

  it('opens a folded phase for a problem the summary jumps to', async () => {
    const params = JSON.parse(JSON.stringify(long));
    const last = params.tasks[params.tasks.length - 1];
    last.name = '';
    open({ effective: templateEffective({ params }), versions: [templateVersion(2, { params })] });
    await fork();
    fireEvent.click(screen.getByTestId('save-draft'));
    fireEvent.click((await screen.findAllByTestId('jump'))[0] as HTMLElement);
    await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute('data-field')).toBe('name'));
  });

  it('keeps the name and the kind of project out of the page body (they are in the "Sửa tên, mô tả" dialog) and the code of the procedure out of the header', async () => {
    open();
    await fork();
    expect(screen.queryByTestId('field-name')).toBeNull();
    expect(screen.getByTestId('template-sub').textContent).not.toContain('PUBLIC_INVESTMENT');
    fireEvent.click(screen.getByTestId('rename'));
    expect(within(screen.getByRole('dialog')).getByTestId('field-name')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByTestId('field-project-type')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('pwfx.rename.done') }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('details-task:T1'));
    expect((await screen.findByTestId('template-code')).textContent).toBe(text('pwfx.drawer.code.template', { code: 'PUBLIC_INVESTMENT' }));
  });
});

describe('PWF-02: the details of a step', () => {
  it('opens in a side drawer from the "N hồ sơ" button, closes with Escape and gives the focus back', async () => {
    open();
    await fork();
    const button = screen.getByTestId('details-task:T1');
    button.focus();
    fireEvent.click(button);
    const drawer = await screen.findByTestId('step-drawer');
    expect(within(drawer).getByRole('heading', { level: 2 }).textContent).toContain('Lập báo cáo nghiên cứu khả thi');
    // Advanced fields live here: links, constraint, branches, KPI and the codes.
    expect(within(drawer).getByText(text('pwfx.drawer.schedule.title'))).toBeTruthy();
    expect(within(drawer).getByText(text('pwfx.drawer.codes.title'))).toBeTruthy();
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(screen.queryByTestId('step-drawer')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('locks the code of a step the version in force already holds and leaves the code of a new step open until it has a name', async () => {
    open();
    await fork();
    fireEvent.click(screen.getByTestId('details-task:T1'));
    const code = within(await screen.findByTestId('step-drawer')).getByLabelText(text('pwfx.drawer.code.task')) as HTMLInputElement;
    expect(code.value).toBe('T1');
    expect(code.disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId('step-drawer'), { key: 'Escape' });
    fireEvent.click(document.querySelector('[data-action="add-step-PREPARATION"]') as HTMLElement);
    await waitFor(() => expect(nameInputs()).toHaveLength(3));
    const key = (nameInputs()[2] as HTMLInputElement).closest('tr')?.getAttribute('data-line') as string;
    fireEvent.click(within(rowOf(key)).getByRole('button', { name: /chi tiết/ }));
    expect((within(await screen.findByTestId('step-drawer')).getByLabelText(text('pwfx.drawer.code.task')) as HTMLInputElement).disabled).toBe(false);
  });

  it('writes an advanced field (the approver) from the drawer into the draft', async () => {
    const h = open();
    await fork();
    fireEvent.click(screen.getByTestId('details-task:T2'));
    const drawer = await screen.findByTestId('step-drawer');
    fireEvent.change(within(drawer).getByLabelText(text('pwf.templates.task.approver.label')), { target: { value: 'AUDITOR' } });
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await saveWith('Đổi người duyệt hoàn thành');
    await waitFor(() => expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(1));
    expect((lastBody(h, 'createGovernanceRuleDraft').params as { tasks: { approver_role: string }[] }).tasks[1]?.approver_role).toBe('AUDITOR');
  });

  it('does not block the diagram for a checklist item that has a name and no code yet: its code is made from the name when it is saved', async () => {
    const h = open();
    await fork();
    fireEvent.click(screen.getByTestId('details-task:T1'));
    const drawer = await screen.findByTestId('step-drawer');
    fireEvent.click(within(drawer).getByRole('button', { name: text('pwf.templates.checklist.add.action') }));
    fireEvent.change(within(drawer).getByLabelText(text('pwf.templates.checklist.name.label')), { target: { value: 'Hồ sơ đủ thành phần' } });
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(screen.queryByTestId('problem-summary')).toBeNull();
    await saveWith('Thêm mục kiểm bắt buộc');
    await waitFor(() => expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(1));
    expect((lastBody(h, 'createGovernanceRuleDraft').params as { tasks: { checklist: { code: string }[] }[] }).tasks[0]?.checklist.at(-1)?.code).toBe('HO_SO_DU_THANH_PHAN');
  });

  it('cites a legal ground on the row: the person marks it checked and the stamp is the server\'s, never the browser\'s', async () => {
    const h = open();
    await fork();
    fireEvent.click(within(rowOf('task:T1')).getByRole('button', { name: /căn cứ/i }));
    fireEvent.click(await screen.findByRole('button', { name: text('pwfx.basis.add') }));
    fireEvent.change(screen.getByLabelText(/văn bản 1 của việc của bước 1/i), { target: { value: 'law_58_2024_qh15' } });
    expect(screen.getAllByText(text('pwfx.basis.unverified')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('unverified-note').textContent).toContain(text('pwfx.unverified.note', { count: 1 }));
    fireEvent.click(screen.getByRole('button', { name: text('pwfx.basis.mark') }));
    expect(screen.getAllByText(text('pwfx.basis.claimed')).length).toBeGreaterThan(0);
    await saveWith('Thêm căn cứ pháp lý');
    await waitFor(() => expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(1));
    const basis = (lastBody(h, 'createGovernanceRuleDraft').params as { tasks: { legal_basis?: Record<string, unknown>[] }[] }).tasks[0]?.legal_basis;
    expect(basis?.[0]).toMatchObject({ document: 'LAW_58_2024_QH15', verification: 'VERIFIED' });
    expect(basis?.[0]).not.toHaveProperty('verified_by');
    expect(basis?.[0]).not.toHaveProperty('verified_at');
  });
});

describe('PWF-02: the rules of the store, on the new screen', () => {
  it('asks for a reason of at least 5 characters before a draft is written, and writes the draft with the day and the reason', async () => {
    const h = open();
    await fork();
    fireEvent.click(screen.getByTestId('save-draft'));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: text('pwfx.action.saveDraft') });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'ab' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Sửa thời hạn thẩm định' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(1));
    expect(lastBody(h, 'createGovernanceRuleDraft')).toMatchObject({ rule_type: TEMPLATE, code: 'PUBLIC_INVESTMENT', reason: 'Sửa thời hạn thẩm định' });
    expect(callsOf(h, 'submitGovernanceRule')).toHaveLength(0);
    expect(await screen.findByTestId('notice')).toBeTruthy();
  });

  it('keeps the reason for the next quick save of the same procedure', async () => {
    const h = open({ path: `/pwf/pwf-02?from=${uuid(103)}`, rule: templateVersion(3, { id: uuid(103), status: 'DRAFT', phase: 'DRAFT', created_by: ME }), versions: [templateVersion(3, { id: uuid(103), status: 'DRAFT', phase: 'DRAFT', created_by: ME })] });
    await ready();
    await saveWith('Lý do lần đầu');
    await waitFor(() => expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(1));
  });

  it('says what the store refuses, inside the dialog, and keeps what was typed', async () => {
    open({ commands: { createGovernanceRuleDraft: refusal('GOVERNANCE_RULE_PERIOD_OVERLAP', 409) } });
    await fork();
    await saveWith('Mẫu cần được lưu');
    expect((await within(await screen.findByRole('dialog')).findByRole('alert')).textContent).toBe(text('gova1.refusal.overlap'));
    expect(nameInputs()).toHaveLength(2);
  });

  it('submits through one short dialog (day and reason) and says that a different person approves', async () => {
    const h = open();
    await fork();
    fireEvent.click(screen.getByTestId('submit'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(text('pwfx.dialog.checker.value'));
    expect(within(dialog).getByLabelText(text('pwfx.dialog.from'))).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Trình duyệt bản mới' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('pwfx.action.submit') }));
    await waitFor(() => expect(callsOf(h, 'submitGovernanceRule')).toHaveLength(1));
    expect(callsOf(h, 'submitGovernanceRule')[0]?.[1]).toMatchObject({ path: { ruleId: uuid(200) }, body: { reason: 'Trình duyệt bản mới' } });
  });

  it('does not let the maker approve: the history drawer shows the button off and says why; a third person may approve', async () => {
    open({ versions: [templateVersion(3, { status: 'SUBMITTED', phase: 'SUBMITTED', created_by: ME, submitted_by: ME, effective_from: '2026-12-01' })] });
    await ready();
    fireEvent.click(screen.getByTestId('history'));
    const approve = await screen.findByRole('button', { name: text('gova1.move.approve') });
    expect(approve).toBeDisabled();
    expect(screen.getByText(text('gova1.block.selfApproval'))).toBeTruthy();
    cleanup();
    open({ versions: [templateVersion(3, { status: 'SUBMITTED', phase: 'SUBMITTED', created_by: OTHER, submitted_by: OTHER, effective_from: '2026-12-01' })] });
    await ready();
    fireEvent.click(screen.getByTestId('history'));
    expect(await screen.findByRole('button', { name: text('gova1.move.approve') })).not.toBeDisabled();
  });

  it('shows a submitted version read only and says it waits for another person', async () => {
    const submitted = templateVersion(3, { id: uuid(103), status: 'SUBMITTED', phase: 'SUBMITTED', created_by: ME, submitted_by: ME });
    open({ path: `/pwf/pwf-02?from=${uuid(103)}`, rule: submitted, versions: [submitted] });
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(text('pwfx.readOnly.submitted'));
  });

  it('cannot be submitted while it cites a legal document that is not approved, and can still be saved as a draft', async () => {
    open({ commands: { validateProjectWorkflowTemplate: validation({ valid: false, findings: [{ path: 'tasks[0].legal_basis[0].document', code: 'LEGAL_DOCUMENT_UNKNOWN', severity: 'ERROR' }] }) } });
    await fork();
    expect(await screen.findByTestId('unapproved-documents')).toBeTruthy();
    expect(screen.getByTestId('submit')).toBeDisabled();
    expect(screen.getByTestId('save-draft')).not.toBeDisabled();
  });

  it('is a read-only page for a session that cannot write: no new draft is offered', async () => {
    open({ mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByTestId('new-draft')).toBeNull();
    expect(screen.queryByTestId('save-draft')).toBeNull();
  });
});

describe('PWF-02: "Áp cho" travels with the submit', () => {
  it('shows the lines of the mapping rule that point at this procedure, and submits a draft of the rule with the template (two people approve both)', async () => {
    const assignment = effectiveBody({
      rule_type: 'PROJECT_WORKFLOW_ASSIGNMENT',
      code: 'DEFAULT',
      version: 1,
      source: 'RULE',
      rule_id: uuid(300),
      params: { lines: [{ code: 'INV_CONSTRUCTION', priority: 10, template_code: 'PUBLIC_INVESTMENT', when: [{ field: 'project_type', in: ['CONSTRUCTION'] }] }] },
    });
    const h = open({ assignment, projectTypes: [{ business_key: 'CONSTRUCTION', label: 'Xây dựng mới', status: 'EFFECTIVE' }], commands: { createGovernanceRuleDraft: (input: Record<string, unknown>) => ({ resource_id: (input.body as { rule_type: string }).rule_type === TEMPLATE ? uuid(200) : uuid(201), status: 'DRAFT', resource_version: 1 }) } });
    await fork();
    const bar = screen.getByTestId('apply-line');
    await waitFor(() => expect(within(bar.querySelector('.pwfx-apply__chips') as HTMLElement).getByText(/Xây dựng mới/)).toBeTruthy());
    fireEvent.change(within(bar).getByLabelText(text('pwfx.apply.add.fundingSource')), { target: { value: 'ODA' } });
    expect(bar.querySelector('[data-pending="true"]')).toBeTruthy();
    // Nothing is written to the rule yet.
    expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('submit'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(text('pwfx.dialog.apply.value', { added: 1, removed: 0 }));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Áp cho nguồn vốn ODA' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('pwfx.action.submit') }));
    await waitFor(() => expect(callsOf(h, 'submitGovernanceRule')).toHaveLength(2));
    const drafts = callsOf(h, 'createGovernanceRuleDraft').map((call) => (call[1] as { body: { rule_type: string; code: string; params: { lines?: unknown[] } } }).body);
    expect(drafts.map((body) => body.rule_type)).toEqual([TEMPLATE, 'PROJECT_WORKFLOW_ASSIGNMENT']);
    expect(drafts[1]?.code).toBe('DEFAULT');
    expect(drafts[1]?.params.lines).toHaveLength(2);
  });

  it('takes a line off by a draft of the rule, not by writing the rule in force', async () => {
    const assignment = effectiveBody({
      rule_type: 'PROJECT_WORKFLOW_ASSIGNMENT',
      code: 'DEFAULT',
      version: 1,
      source: 'RULE',
      rule_id: uuid(300),
      params: { lines: [{ code: 'INV_CONSTRUCTION', priority: 10, template_code: 'PUBLIC_INVESTMENT', when: [{ field: 'project_type', in: ['CONSTRUCTION'] }] }] },
    });
    const h = open({ assignment });
    await fork();
    fireEvent.click(await screen.findByRole('button', { name: /^Bỏ /i }));
    expect(document.querySelector('[data-removed="true"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId('submit'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Bỏ dòng áp cho' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('pwfx.action.submit') }));
    await waitFor(() => expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(2));
    expect((lastBody(h, 'createGovernanceRuleDraft').params as { lines: unknown[] }).lines).toEqual([]);
  });
});

describe('PWF-02: a template that exists is written back as it was (R62)', () => {
  const fixtures: Record<string, Record<string, unknown>> = { ...(builtIn as Record<string, Record<string, unknown>>), CB_ROAD_REPAIR: roadRepair as Record<string, unknown> };
  it.each(Object.keys(fixtures))('%s: opened on the new screen and saved without an edit, the params are the params it had', async (code) => {
    const params = fixtures[code] as never;
    const h = open({ effective: templateEffective({ params }), versions: [templateVersion(2, { params })] });
    await fork();
    await saveWith('Lưu lại không sửa gì');
    await waitFor(() => expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(1));
    expect(lastBody(h, 'createGovernanceRuleDraft').params).toEqual(fixtures[code]);
  });
});

describe('PWF-02: the diagram follows the table', () => {
  it('draws the diagram from the server and says it follows the table', async () => {
    const h = open();
    await ready();
    await waitFor(() => expect(screen.getByTestId('diagram-status').getAttribute('data-status')).toBe('ready'), WITHIN);
    expect(h.command).toHaveBeenCalledWith('previewProjectWorkflowTemplate', expect.objectContaining({ body: expect.objectContaining({ calendar_mode: 'PROVISIONAL' }) }));
    expect(await screen.findByTestId('gantt')).toBeTruthy();
  });

  it('waits for the table to settle: one question for a burst of typing, sent after the delay', async () => {
    const h = open();
    await fork();
    await waitFor(() => expect(callsOf(h, 'previewProjectWorkflowTemplate')).toHaveLength(1), WITHIN);
    const input = nameInputs()[0] as HTMLInputElement;
    vi.useFakeTimers();
    try {
      for (const value of ['Lập', 'Lập kế', 'Lập kế hoạch']) fireEvent.change(input, { target: { value } });
      await act(async () => vi.advanceTimersByTime(PREVIEW_DELAY_MS - 50));
      expect(callsOf(h, 'previewProjectWorkflowTemplate')).toHaveLength(1);
      await act(async () => vi.advanceTimersByTime(100));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(callsOf(h, 'previewProjectWorkflowTemplate')).toHaveLength(2), WITHIN);
  });

  it('drops an answer that arrives after a newer question was sent', async () => {
    const waiting: ((value: unknown) => void)[] = [];
    const h = open({
      commands: {
        previewProjectWorkflowTemplate: () =>
          new Promise((resolve) => {
            waiting.push(resolve);
          }),
      },
    });
    await fork();
    await waitFor(() => expect(waiting).toHaveLength(1), WITHIN);
    fireEvent.change(nameInputs()[0] as HTMLInputElement, { target: { value: 'Bước đã đổi tên' } });
    await waitFor(() => expect(waiting).toHaveLength(2), WITHIN);
    const answer = (label: string) => schedulePreview({ tasks: [scheduleTask('T1', { name: label }), scheduleTask('T2', { name: `${label} 2`, start: '2026-12-11', finish: '2027-01-12' })] });
    // The newer answer comes first, the older one after it: the picture is the newer one.
    await act(async () => waiting[1]?.(answer('Mới')));
    await act(async () => waiting[0]?.(answer('Cũ')));
    const chart = await screen.findByTestId('gantt');
    expect(chart.textContent).toContain('Mới');
    expect(chart.textContent).not.toContain('Cũ');
    expect(h.command).toHaveBeenCalled();
  });

  it('says in words that the dates lean on a draft calendar and when a year has no calendar, and never draws a guessed bar', async () => {
    open({
      commands: {
        previewProjectWorkflowTemplate: schedulePreview({
          calendar_mode: 'PROVISIONAL',
          provisional: true,
          calendars: [{ year: 2027, version: 1, status: 'DRAFT' }],
          tasks: [
            scheduleTask('T1', { provisional: true }),
            scheduleTask('T2', { state: 'CALENDAR_UNAVAILABLE', start: null, finish: null, missing_year: 2028, undated_reason: { code: 'CALENDAR_MISSING', year: 2028 } }),
          ],
        }),
      },
    });
    await ready();
    expect((await screen.findByTestId('diagram-provisional')).textContent).toContain('2027');
    expect(screen.getByTestId('diagram-missing').textContent).toContain('2028');
    expect(screen.getByTestId('diagram-calendar-link').getAttribute('href')).toBe('/adm/adm-07');
    expect((await screen.findByTestId('gantt')).textContent).toContain(text('pwfx.diagram.missingYear.row', { year: 2028 }));
  });

  it('keeps the table editable when the server cannot be reached, says the diagram is not up to date and offers to try again', async () => {
    let fails = true;
    const h = open({
      commands: {
        previewProjectWorkflowTemplate: () => {
          if (fails) throw new Error('offline');
          return schedulePreview();
        },
      },
    });
    await fork();
    expect(await screen.findByTestId('diagram-offline')).toBeTruthy();
    fireEvent.change(nameInputs()[0] as HTMLInputElement, { target: { value: 'Vẫn sửa được khi mất mạng' } });
    expect((nameInputs()[0] as HTMLInputElement).value).toBe('Vẫn sửa được khi mất mạng');
    fails = false;
    fireEvent.click(document.querySelector('[data-action="retry-diagram"]') as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId('diagram-offline')).toBeNull(), WITHIN);
    expect(callsOf(h, 'previewProjectWorkflowTemplate').length).toBeGreaterThan(1);
  });

  it('does not ask the server about a table with a cell to put right, and says the diagram is the one before', async () => {
    const h = open();
    await fork();
    await waitFor(() => expect(callsOf(h, 'previewProjectWorkflowTemplate')).toHaveLength(1), WITHIN);
    fireEvent.change(screen.getByTestId('limit-task:T1'), { target: { value: '' } });
    expect(await screen.findByTestId('diagram-blocked')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_DELAY_MS + 150));
    expect(callsOf(h, 'previewProjectWorkflowTemplate')).toHaveLength(1);
  });
});

describe('PWF-02: what is being written stays on the device (R70)', () => {
  const scope = (code: string) => `${DRAFT_PREFIX}`.concat(code);
  it('keeps the draft after the person stops typing and brings it back on reload', async () => {
    open();
    await fork();
    fireEvent.change(nameInputs()[0] as HTMLInputElement, { target: { value: 'Đang soạn dở' } });
    await waitFor(() => expect(Object.keys(window.localStorage).some((key) => key.startsWith(DRAFT_PREFIX))).toBe(true), WITHIN);
    cleanup();
    open();
    expect(await screen.findByTestId('restored')).toBeTruthy();
    expect(nameInputs()[0]?.value).toBe('Đang soạn dở');
    expect(screen.queryByTestId('read-only')).toBeNull();
    expect(scope('x')).toContain(DRAFT_PREFIX);
  });

  it('asks what to do when the draft was written on a version that is not the one the screen opens: keep or drop, never merged', async () => {
    open();
    await fork();
    fireEvent.change(nameInputs()[0] as HTMLInputElement, { target: { value: 'Bản trên máy' } });
    await waitFor(() => expect(Object.keys(window.localStorage).some((key) => key.startsWith(DRAFT_PREFIX))).toBe(true), WITHIN);
    cleanup();
    // Somebody approved a newer version meanwhile: the base the screen opens is version 3.
    open({ effective: templateEffective({ version: 3, params: templateParams({ name: 'Bản mới của người khác' }) }), versions: [templateVersion(3, { id: uuid(103), params: templateParams({ name: 'Bản mới của người khác' }) })] });
    const conflict = await screen.findByTestId('local-conflict');
    expect(nameInputs()[0]?.value).toBe('Lập báo cáo nghiên cứu khả thi');
    fireEvent.click(within(conflict).getByTestId('keep-local'));
    expect(nameInputs()[0]?.value).toBe('Bản trên máy');
    cleanup();
    window.localStorage.clear();
  });

  it('drops the draft of the device on request', async () => {
    open();
    await fork();
    fireEvent.change(nameInputs()[0] as HTMLInputElement, { target: { value: 'Sẽ bỏ' } });
    await waitFor(() => expect(Object.keys(window.localStorage).some((key) => key.startsWith(DRAFT_PREFIX))).toBe(true), WITHIN);
    cleanup();
    open({ effective: templateEffective({ version: 3 }), versions: [templateVersion(3, { id: uuid(103) })] });
    fireEvent.click(await screen.findByTestId('drop-local'));
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith(DRAFT_PREFIX))).toEqual([]);
  });
});

describe('PWF-02: rows pasted from a spreadsheet', () => {
  it('shows a preview, says what is wrong with each row, and only adds the good rows at the end of the phase', async () => {
    const h = open();
    await fork();
    fireEvent.click(screen.getByTestId('paste'));
    const dialog = await screen.findByRole('dialog');
    const pasted = ['Khảo sát hiện trạng\t\t4', 'Lập hồ sơ\tChủ đầu tư\t5', '\t\t3', 'Thẩm định\t\tabc'].join('\n');
    fireEvent.change(within(dialog).getByTestId('paste-text'), { target: { value: pasted } });
    const preview = within(dialog).getByTestId('paste-preview');
    expect(preview.querySelectorAll('tr[data-ok="true"]')).toHaveLength(2);
    expect(preview.querySelectorAll('tr[data-ok="false"]')).toHaveLength(2);
    // Nothing was added by reading the text.
    expect(nameInputs()).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: text('pwfx.paste.confirm', { count: 2 }) }));
    await waitFor(() => expect(nameInputs()).toHaveLength(4));
    expect(nameInputs().map((input) => input.value)).toEqual(['Lập báo cáo nghiên cứu khả thi', 'Thẩm định', 'Khảo sát hiện trạng', 'Lập hồ sơ']);
    expect((screen.getByLabelText(/^thời hạn của bước 3$/i) as HTMLInputElement).value).toBe('4');
    expect(h.command).not.toHaveBeenCalledWith('createGovernanceRuleDraft', expect.anything());
  });

  it('refuses a paste with more than three columns row by row and keeps the button off while no row can be added', async () => {
    open();
    await fork();
    fireEvent.click(screen.getByTestId('paste'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('paste-text'), { target: { value: 'Một\t\t3\tthừa' } });
    expect(within(dialog).getByRole('button', { name: text('pwfx.paste.confirm', { count: 0 }) })).toBeDisabled();
    expect(within(dialog).getByTestId('paste-preview').textContent).toContain(text('pwfx.paste.problem.tooManyColumns'));
  });
});

describe('PWF-02: a new procedure, by keyboard alone', () => {
  it('opens empty with one phase and one row to type into, and four steps are made with the keyboard: type, Enter, type, Enter', async () => {
    const h = open({ path: '/pwf/pwf-02?start=blank' });
    await ready();
    expect(screen.getByTestId('template-title').textContent).toBe(text('pwfx.title.new'));
    expect(nameInputs()).toHaveLength(1);
    let typed = 0;
    const names = ['Khảo sát hiện trạng', 'Lập hồ sơ và dự toán', 'Thẩm định', 'Phê duyệt'];
    for (const [index, name] of names.entries()) {
      const input = nameInputs()[index] as HTMLInputElement;
      input.focus();
      fireEvent.change(input, { target: { value: name } });
      typed += 1;
      if (index < names.length - 1) {
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(nameInputs()).toHaveLength(index + 2));
        // The caret is already in the new row.
        expect(document.activeElement).toBe(nameInputs()[index + 1]);
      }
    }
    expect(typed).toBe(4);
    expect(nameInputs().map((input) => input.value)).toEqual(names);
    // No box in the table asks for a code, and no capital-letter code was typed anywhere.
    expect(document.querySelector('.pwfx-table')?.querySelectorAll('input[type="text"]').length).toBe(4 + 1);
    expect(h.command).not.toHaveBeenCalledWith('createGovernanceRuleDraft', expect.anything());
  });

  it('makes the code of the procedure from its name once, at the first save, and writes the rows with codes made from their names', async () => {
    const h = open({ path: '/pwf/pwf-02?start=blank' });
    await ready();
    fireEvent.click(screen.getByTestId('rename'));
    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'Sửa chữa, bảo trì đường' } });
    fireEvent.change(document.querySelector('[data-testid="field-project-type"]') as HTMLElement, { target: { value: '' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('pwfx.rename.done') }));
    fireEvent.change(document.querySelector('[data-field="name"]') as HTMLElement, { target: { value: 'Khảo sát hiện trạng' } });
    fireEvent.change(document.querySelector('[data-testid^="phase-name-"]') as HTMLElement, { target: { value: 'Chuẩn bị' } });
    // A row needs a unit role before it is complete: the lead unit and the role are chosen from the lists.
    fireEvent.change(screen.getByLabelText(/vai trò của bước 1/i), { target: { value: 'PMB_MANAGER' } });
    fireEvent.blur(document.querySelector('[data-field="name"]') as HTMLElement);
    await saveWith('Soạn quy trình mới');
    await waitFor(() => expect(callsOf(h, 'createGovernanceRuleDraft')).toHaveLength(1));
    const body = lastBody(h, 'createGovernanceRuleDraft');
    expect(body.code).toBe('SUA_CHUA_BAO_TRI_DUONG');
    const params = body.params as { phases: { code: string }[]; tasks: { code: string; step?: string }[]; steps: { code: string }[] };
    expect(params.phases[0]?.code).toBe('CHUAN_BI');
    expect(params.tasks[0]?.code).toBe('KHAO_SAT_HIEN_TRANG');
    expect(params.steps[0]?.code).toBe('KHAO_SAT_HIEN_TRANG');
  });

  it('copies a shipped kind under a new name when started from it, and starts a copy of a procedure in use with its grounds unchecked', async () => {
    const params = templateParams({ name: 'Mẫu dựng sẵn' });
    params.tasks[0] = { ...params.tasks[0], legal_basis: [{ document: 'LAW_58_2024_QH15', verification: 'VERIFIED', verified_by: OTHER, verified_at: '2026-11-01T03:00:00.000Z' }] } as never;
    open({ path: '/pwf/pwf-02?start=clone:PUBLIC_INVESTMENT', effective: shippedEffective('PUBLIC_INVESTMENT', { params }) });
    await ready();
    expect(screen.getByTestId('template-title').textContent).toBe(text('pwfx.start.copyName', { name: 'Mẫu dựng sẵn' }));
    expect(screen.getByTestId('unverified-note').textContent).toContain(text('pwfx.unverified.note', { count: 1 }));
    expect(screen.queryByTestId('read-only')).toBeNull();
  });

  it('opens the paste dialog by itself when the library sent the person here to paste', async () => {
    open({ path: '/pwf/pwf-02?start=paste' });
    expect(await screen.findByTestId('paste-text')).toBeTruthy();
  });
});

describe('PWF-02: no old way is left', () => {
  const here = join(process.cwd(), 'src', 'screens', 'pwf', 'templates');
  it('has none of the files of the old editor, and no tab or 6-sub-tab control on the screen', async () => {
    for (const gone of ['editor-panels.tsx', 'editor-steps.tsx', 'editor-fields.tsx', 'editor-summary.tsx', 'editor-checks.tsx']) expect(existsSync(join(here, gone)), gone).toBe(false);
    expect(readdirSync(here).filter((name) => /^editor-(panels|steps|fields|summary|checks)\./.test(name))).toEqual([]);
    open();
    await ready();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.querySelector('[data-testid^="editor-tab"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-parts"]')).toBeNull();
    expect(screen.queryByTestId('save')).toBeNull();
  });
});

describe('PWF-02: the layout and the words', () => {
  it('labels every input and select, and has no serious accessibility violation with the drawer open', async () => {
    open();
    await fork();
    for (const control of Array.from(document.querySelectorAll<HTMLElement>('.pwfx-table input, .pwfx-table select, .pwfx-table textarea'))) {
      const labelled = control.getAttribute('aria-label') !== null || control.id !== '' || control.closest('label') !== null;
      expect(labelled, control.outerHTML.slice(0, 120)).toBe(true);
    }
    fireEvent.click(screen.getByTestId('details-task:T1'));
    await screen.findByTestId('step-drawer');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('keeps the table inside its own scroll frame and never writes MACHVON in a word the person reads', async () => {
    open();
    await ready();
    const frame = screen.getByTestId('steps-table');
    expect(frame.className).toContain('ui-table-scroll');
    expect(document.body.textContent).not.toMatch(/machvon/i);
  });
});
