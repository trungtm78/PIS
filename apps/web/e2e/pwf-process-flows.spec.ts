import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { apiCall } from './support/api.ts';
import { editionOf } from './support/edition-terms.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * The procedure of a project in three tiers (phase, step, task with its checklist), the legal grounds of its steps and tasks, and what the screens of the project show of them (ST-PWF-021 to ST-PWF-023,
 * BR-PWF-43 and BR-PWF-44), in a real browser against the real API and database (apps/api/test/e2e-stack). The API tests (apps/api/test/pwf/project-process.test.ts) hold the rules; these flows hold the
 * clauses of the screens: PWF-02 (the editor of a template), PWF-03 (the workflow of a project) and PWF-04 (one task).
 *
 * The person is `owner`: the fixture users of the stack hold `pwf.template.manage`, `pwf.task.work` and the rule store rights only through the owner (e2e-fixtures.json), so the cases are run as the
 * one person who may do every step. What a second person does in a case (approving a template, approving a completion) is therefore not shown here; the API tests refuse the self-approval.
 * A template is never approved here and the shared catalogue of legal documents is never changed: the stack is shared by every other flow of the run, and a template or a document in force would
 * change what they see. PRC-01 and PRC-04 leave a draft (a draft is in force for nobody).
 *
 * The screens belong to the public edition (its built-in templates PUBLIC_INVESTMENT and PUBLIC_PROCUREMENT are what the flows open); the enterprise edition runs its own templates.
 */

const ENTERPRISE = editionOf() === 'enterprise';
const PERSON = 'owner';
const TEMPLATE = 'PUBLIC_INVESTMENT';
const today = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const unique = (prefix: string): string => `E2E-${prefix}-${Date.now().toString(36).toUpperCase()}`;
const DAY = /\d{2}\/\d{2}\/\d{4}/;

interface StoredTemplate {
  steps?: Array<{ code: string; name: string; phase: string; legal_basis?: unknown[] }>;
  tasks: Array<{ code: string; step?: string | null; checklist?: Array<{ code: string; name: string; required: boolean }>; legal_basis?: unknown[]; form_policies?: unknown[] }>;
}

async function openEditor(page: Page, code: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/pwf/pwf-02?code=${code}&devUser=${PERSON}`);
  await expect(page.getByTestId('field-code')).toHaveValue(code);
  await expect(page.getByTestId('tree').locator('button[data-testid^="pick-"]').first()).toBeVisible();
}

const editorTab = (page: Page, id: 'structure' | 'steps' | 'roles' | 'checks'): Promise<void> => page.getByTestId(`editor-tab-${id}`).click();
const taskPart = (page: Page, id: 'info' | 'schedule' | 'docs' | 'checklist' | 'kpi' | 'legal'): Promise<void> => page.getByTestId(`task-parts-tab-${id}`).click();

/** Saves what the editor holds as a draft of the rule store and waits until the store says it is written. */
async function saveDraft(page: Page, reason: string): Promise<void> {
  await page.getByTestId('reason').fill(reason);
  await page.getByTestId('save').click();
  await expect(page.getByTestId('written')).toBeVisible();
}

const draftOf = async (code: string): Promise<StoredTemplate | undefined> =>
  (await sql<{ params: StoredTemplate }>("select params from machvon.governance_rule where tenant_id = $1 and rule_type = 'PROJECT_WORKFLOW_TEMPLATE' and code = $2 and status = 'DRAFT' order by version desc limit 1", [stackInfo().tenants.A, code]))[0]?.params;

/** Opens the tab (and the tab inside a tab) that holds the element, the way a person does: every panel of a screen is in the page and only the chosen one is shown. */
async function showTabOf(page: Page, target: Locator): Promise<void> {
  const tabs = await target.first().evaluate((element) => {
    const ids: string[] = [];
    for (let panel = element.closest('[role="tabpanel"]'); panel !== null; panel = panel.parentElement?.closest('[role="tabpanel"]') ?? null) {
      const tab = panel.getAttribute('aria-labelledby');
      if (tab !== null) ids.unshift(tab);
    }
    return ids;
  });
  for (const id of tabs) await page.locator(`[id="${id}"]`).click();
}

interface TaskRow {
  id: string;
  task_code: string;
  name: string;
  planned_start: string | null;
  kind: string;
}

interface TaskDetail {
  version: number;
  status: string;
  step?: { code: string; name: string } | null;
  checklist: Array<{ item_code: string; name: string; required: boolean; done: boolean; evidence_kinds: string[] }>;
  completion: { ok: boolean; blockers: Array<{ code: string; subject: string }> };
}

const CHECKLIST_TEMPLATE = 'E2E_PRC_CHECKLIST';
const OPTIONAL_ITEM = { code: 'E2E_NOTED', name: 'Đã ghi nhận ý kiến của các đơn vị liên quan', required: false, evidence_kinds: [] as string[] };
const REQUIRED_ITEM = { code: 'E2E_COMPLETE', name: 'Hồ sơ đủ thành phần theo danh mục', required: true, evidence_kinds: [] as string[] };

interface ShippedTask extends Record<string, unknown> {
  code: string;
  predecessors?: unknown[];
  when?: unknown[];
  kind?: string;
}

/**
 * A kind of workflow of its own for the case of the checklist: the shipped public investment template with the checklist of its first task (the one nothing waits for) set to one optional and one
 * mandatory item, and that task asking for no document and no approver, so that the case is about the checklist alone. It is a code of its own, approved by a second person: the templates the other
 * flows of the run use stay what they were. A governance rule is never deleted, so the row is made once for the stack and found again by the next run.
 */
async function checklistTemplate(): Promise<string> {
  const shipped = (await apiCall(PERSON, 'GET', `/governance-rules/effective?rule_type=PROJECT_WORKFLOW_TEMPLATE&code=${TEMPLATE}`)).json as unknown as { params: { tasks: ShippedTask[] } & Record<string, unknown> };
  const first = shipped.params.tasks.find((task) => (task.predecessors ?? []).length === 0 && (task.when ?? []).length === 0 && task.kind !== 'MILESTONE');
  if (first === undefined) throw new Error('the shipped template has no task that nothing waits for');
  const params = {
    ...shipped.params,
    name: 'Mẫu kiểm thử danh mục kiểm (trình duyệt)',
    tasks: shipped.params.tasks.map((task) => (task.code === first.code ? { ...task, checklist: [OPTIONAL_ITEM, REQUIRED_ITEM], legal_doc_types: [], form_templates: [], form_policies: [], approver_role: null } : task)),
  };
  await sql(
    `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
     select $1, 'PROJECT_WORKFLOW_TEMPLATE', $2, 1, 'APPROVED', $3::jsonb, date '2020-01-01', 'Mẫu của ca kiểm thử danh mục kiểm (kiểm thử trình duyệt)', $4, $4, now(), $5, now()
      where not exists (select 1 from machvon.governance_rule where tenant_id = $1 and rule_type = 'PROJECT_WORKFLOW_TEMPLATE' and code = $2)`,
    [stackInfo().tenants.A, CHECKLIST_TEMPLATE, JSON.stringify(params), membershipOf('owner'), membershipOf('unitAdmin')],
  );
  return first.code;
}

/** A project with its workflow, made by the API the way PRJ-02 makes it (TC-UAT-PWF-PRC-07 and TC-UAT-PWF-PRC-08 hold that screen): the kind the rule suggests, or another kind with the reason. */
async function projectWithWorkflow(prefix: string, template?: string): Promise<{ id: string; code: string }> {
  const code = unique(prefix);
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [stackInfo().tenants.A]);
  const unit = stackInfo().units.A['CB-SKHDT-QLDA'];
  const made = await apiCall(PERSON, 'POST', '/projects', {
    body: { code, name: `Dự án quy trình ba tầng ${code}`, owner_unit_id: unit, area_master_version_id: area?.id, total_investment_vnd: '150000000000', classification: 'INTERNAL', workflow: { planned_start_date: today(), facts: { project_group: 'B', funding_source: 'STATE_BUDGET' }, ...(template === undefined ? {} : { template_code: template, selection_reason: 'Dự án dùng mẫu của ca kiểm thử danh mục kiểm' }) } },
  });
  expect(made.status, JSON.stringify(made.json)).toBeLessThan(300);
  const [project] = await sql<{ id: string }>('select id from machvon.project where code = $1', [code]);
  if (project === undefined) throw new Error(`the project ${code} was not made`);
  expect(await sql('select template_code from machvon.project_workflow where project_id = $1', [project.id])).toEqual([{ template_code: template ?? TEMPLATE }]);
  return { id: project.id, code };
}

const detailOf = async (taskId: string): Promise<TaskDetail> => (await apiCall(PERSON, 'GET', `/project-tasks/${taskId}`)).json as unknown as TaskDetail;

/** Gives the person the first tasks of the workflow that can start and starts them, until one is found that `wanted` accepts; the tasks before it stay in progress, as on a project that is running. */
async function startTaskThat(projectId: string, wanted: (detail: TaskDetail) => boolean): Promise<{ row: TaskRow; detail: TaskDetail }> {
  const listed = (await apiCall(PERSON, 'GET', `/projects/${projectId}/workflow/tasks?status=NOT_STARTED&limit=100`)).json as unknown as { items: TaskRow[] };
  const candidates = listed.items.filter((task) => task.kind !== 'MILESTONE').sort((left, right) => String(left.planned_start ?? '9999').localeCompare(String(right.planned_start ?? '9999')));
  for (const row of candidates.slice(0, 10)) {
    await apiCall(PERSON, 'POST', `/project-tasks/${row.id}/assignments`, { body: { membership_id: membershipOf(PERSON), role: 'RESPONSIBLE', valid_from: today(), share_pct: 100, reason: 'Giao việc cho người phụ trách trực tiếp theo phân công của dự án' } });
    const before = await detailOf(row.id);
    const begun = await apiCall(PERSON, 'POST', `/project-tasks/${row.id}/start`, { body: {}, version: before.version });
    if (begun.status >= 300) continue;
    const detail = await detailOf(row.id);
    if (wanted(detail)) return { row, detail };
  }
  throw new Error('no task of the first ten that can start is of the kind the case needs');
}

if (ENTERPRISE) {
  test.describe('the procedure in three tiers on the enterprise edition', () => {
    test('the editor of the enterprise edition opens its own templates (the flows of the three tiers are those of the public edition)', async ({ page }) => {
      await page.goto(`/pwf/pwf-01?devUser=${PERSON}`);
      await expect(page.locator('[data-screen-id="PWF-01"] h1')).toBeVisible();
    });
  });
} else {
  test.describe('the procedure of a project in three tiers (ST-PWF-021, ST-PWF-022)', () => {
    test('TC-UAT-PWF-PRC-01: a step is added to a phase, a step without a task is told in place, a task moves to the step and gets a mandatory checklist item, the preview dates every task, and the draft keeps steps, legal grounds and form policies (PWF-02)', async ({ page }) => {
      const stepCode = `STEP_E2E_${Date.now().toString(36).toUpperCase()}`;
      const before = (await apiCall(PERSON, 'GET', `/governance-rules/effective?rule_type=PROJECT_WORKFLOW_TEMPLATE&code=${TEMPLATE}`)).json as unknown as { params: StoredTemplate };
      await openEditor(page, TEMPLATE);

      // "Bước của giai đoạn": the template names its steps, each in one phase with its tasks counted.
      await editorTab(page, 'steps');
      const steps = page.getByTestId('steps');
      await expect(steps).toBeVisible();
      const existing = await steps.locator('li[data-step]').count();
      expect(existing).toBeGreaterThan(0);
      const phase = await steps.locator('section[data-step-phase]').first().getAttribute('data-step-phase');
      expect(phase).not.toBeNull();

      // A new step in the first phase: it has no task yet, and the count says so.
      await steps.locator(`[data-action="add-step-${phase}"]`).click();
      await expect(steps.locator('li[data-step]')).toHaveCount(existing + 1);
      const at = existing;
      await page.getByTestId(`field-steps[${at}].code`).fill(stepCode);
      await page.getByTestId(`field-steps[${at}].name`).fill('Bước rà soát hồ sơ (kiểm thử trình duyệt)');
      await expect(page.getByTestId(`step-tasks-${at}`)).toContainText('0');

      // The check tells the step without a task where it stands, before anything is sent.
      await editorTab(page, 'checks');
      await page.locator('[data-action="validate"]').click();
      await editorTab(page, 'steps');
      await expect(page.getByTestId(`error-steps[${at}].tasks`)).toBeVisible();

      // A task of a step that has more than one moves to the new step (the step it leaves keeps a task).
      await editorTab(page, 'structure');
      const tree = page.getByTestId('tree');
      const pick = await tree.evaluate((root, phaseCode) => {
        for (const step of Array.from(root.querySelectorAll(`li[data-phase="${phaseCode}"] li[data-tree-step]`))) {
          const buttons = step.querySelectorAll('button[data-testid^="pick-"]');
          if (step.getAttribute('data-tree-step') !== '' && buttons.length >= 2) return buttons[0]?.getAttribute('data-testid') ?? null;
        }
        return null;
      }, phase);
      expect(pick, 'a step of the first phase with two tasks').not.toBeNull();
      const index = Number(String(pick).slice('pick-'.length));
      await page.getByTestId(String(pick)).click();
      await taskPart(page, 'info');
      await page.getByTestId(`field-tasks[${index}].step`).selectOption(stepCode);
      await editorTab(page, 'steps');
      await expect(page.getByTestId(`step-tasks-${at}`)).toContainText('1');
      await expect(page.getByTestId(`error-steps[${at}].tasks`)).toHaveCount(0);

      // A mandatory checklist item for that task.
      await editorTab(page, 'structure');
      await taskPart(page, 'checklist');
      const items = page.getByTestId('checklist').locator('li');
      const item = await items.count();
      await page.locator('[data-action="add-item"]').click();
      await expect(items).toHaveCount(item + 1);
      await page.getByTestId(`field-tasks[${index}].checklist[${item}].code`).fill('E2E_REVIEWED');
      await page.getByTestId(`field-tasks[${index}].checklist[${item}].name`).fill('Hồ sơ đã được rà soát đủ thành phần');
      await page.getByTestId(`field-tasks[${index}].checklist[${item}].required`).check();

      // The template is valid: the editor finds nothing, and the server finds no error.
      await editorTab(page, 'checks');
      await page.locator('[data-action="validate"]').click();
      await expect(page.getByTestId('local-problems')).toHaveCount(0);
      await expect(page.getByTestId('validation')).toHaveAttribute('data-current', 'true');
      await expect(page.getByTestId('validation').locator('[data-severity="ERROR"]')).toHaveCount(0);

      // The preview on a start day gives each task its days.
      await page.getByTestId('preview-start').fill('2026-11-02');
      for (const [name, value] of [['project_group', 'B'], ['funding_source', 'STATE_BUDGET']] as const) {
        const field = page.getByTestId(`field-preview.${name}`);
        if ((await field.count()) > 0) await field.selectOption(value).catch(() => field.fill(value));
      }
      await page.locator('[data-action="preview"]').click();
      const preview = page.getByTestId('preview');
      await expect(preview).toHaveAttribute('data-current', 'true');
      await expect(page.getByTestId('preview-summary')).toContainText(DAY);
      const dated = preview.locator('tbody tr').filter({ hasText: DAY });
      expect(await dated.count()).toBeGreaterThan(5);

      // The draft keeps the steps, the legal grounds and the form policies as they were, with the new step and the moved task.
      await saveDraft(page, 'Thêm bước rà soát hồ sơ và mục kiểm bắt buộc (kiểm thử trình duyệt)');
      const draft = await draftOf(TEMPLATE);
      expect(draft).toBeDefined();
      const taskCode = before.params.tasks[index]?.code;
      const moved = draft?.tasks.find((task) => task.code === taskCode);
      expect(moved?.step).toBe(stepCode);
      expect(moved?.checklist?.at(-1)).toMatchObject({ code: 'E2E_REVIEWED', required: true });
      expect(draft?.steps?.map((step) => step.code)).toEqual([...(before.params.steps ?? []).map((step) => step.code), stepCode]);
      // Every task belongs to one step of its own phase.
      const phaseOfStep = new Map((draft?.steps ?? []).map((step) => [step.code, step.phase]));
      for (const task of draft?.tasks ?? []) expect(phaseOfStep.has(String(task.step)), `${task.code} names a step of the template`).toBe(true);
      for (const step of before.params.steps ?? []) expect(draft?.steps?.find((one) => one.code === step.code)?.legal_basis ?? []).toEqual(step.legal_basis ?? []);
      for (const task of before.params.tasks) {
        const now = draft?.tasks.find((one) => one.code === task.code);
        expect(now?.legal_basis ?? []).toEqual(task.legal_basis ?? []);
        expect(now?.form_policies ?? []).toEqual(task.form_policies ?? []);
      }
    });

    test('TC-UAT-PWF-PRC-04: a legal ground is picked from the shared catalogue for a step, a code the catalogue does not hold is told at its field and by the check, and the workflow and the task show kind, number, title, issuer, day in force, article or its absence, and the state (PWF-02, PWF-03, PWF-04)', async ({ page }) => {
      await openEditor(page, 'PUBLIC_PROCUREMENT');

      // A ground of a step, chosen from the catalogue; the article is left empty rather than guessed.
      await editorTab(page, 'steps');
      const fold = page.getByTestId('legal-fold-steps[0]');
      await fold.locator('summary').click();
      const stepRows = page.getByTestId('legal-steps[0]').locator('li');
      const stepAt = await stepRows.count();
      // What the step cites already (the shipped template cites documents of the catalogue on its steps) is listed; the same document twice on one step is refused in place.
      const cited = await stepRows.locator('input[data-testid$=".document"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
      // One more ground, a document of the catalogue the step does not cite yet.
      const CANDIDATES: ReadonlyArray<readonly [string, string]> = [
        ['LAW_58_2024_QH15', '58/2024/QH15'],
        ['DECREE_85_2025_ND_CP', '85/2025/NĐ-CP'],
        ['LAW_22_2023_QH15', '22/2023/QH15'],
        ['LAW_50_2014_QH13', '50/2014/QH13'],
        ['LAW_15_2017_QH14', '15/2017/QH14'],
      ];
      const [stepDocument, stepNumber] = CANDIDATES.find(([code]) => !cited.includes(code)) ?? ['', ''];
      expect(stepDocument, 'a document of the catalogue the step does not cite yet').not.toBe('');
      await page.locator('[data-action="add-basis-steps[0]"]').click();
      await expect(stepRows).toHaveCount(stepAt + 1);
      await page.getByTestId(`pick-steps[0].legal_basis[${stepAt}].document`).selectOption(stepDocument);
      await expect(page.getByTestId(`field-steps[0].legal_basis[${stepAt}].document`)).toHaveValue(stepDocument);
      await expect(page.getByTestId(`name-steps[0].legal_basis[${stepAt}].document`)).toContainText(stepNumber);
      await expect(page.getByTestId(`field-steps[0].legal_basis[${stepAt}].article`)).toHaveValue('');

      // A ground of a task with a code the catalogue does not hold: told at the field at once, and by the check of the server at the same path.
      await editorTab(page, 'structure');
      await page.getByTestId('pick-0').click();
      await taskPart(page, 'legal');
      const taskRows = page.getByTestId('legal-tasks[0]').locator('li');
      const taskAt = await taskRows.count();
      await page.locator('[data-action="add-basis-tasks[0]"]').click();
      await expect(taskRows).toHaveCount(taskAt + 1);
      const path = `tasks[0].legal_basis[${taskAt}].document`;
      await page.getByTestId(`field-${path}`).fill('E2E_NO_SUCH_DOCUMENT');
      await expect(page.getByTestId(`unknown-${path}`)).toBeVisible();
      await editorTab(page, 'checks');
      await page.locator('[data-action="validate"]').click();
      const findings = page.getByTestId('findings');
      await expect(findings.locator('li[data-severity="ERROR"]').filter({ hasText: 'LEGAL_DOCUMENT_UNKNOWN' })).toContainText(path);

      // Corrected to a document of the catalogue with its article: the finding is gone.
      await editorTab(page, 'structure');
      const taskCited = await taskRows.locator('input[data-testid$=".document"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
      const taskDocument = ['DECREE_85_2025_ND_CP', 'LAW_22_2023_QH15', 'LAW_50_2014_QH13'].find((code) => !taskCited.includes(code)) ?? '';
      expect(taskDocument).not.toBe('');
      await page.getByTestId(`field-${path}`).fill(taskDocument);
      await expect(page.getByTestId(`unknown-${path}`)).toHaveCount(0);
      await page.getByTestId(`field-tasks[0].legal_basis[${taskAt}].article`).fill('Điều 12');
      await editorTab(page, 'checks');
      await page.locator('[data-action="validate"]').click();
      await expect(page.getByTestId('validation')).toHaveAttribute('data-current', 'true');
      await expect(page.getByTestId('validation')).not.toContainText('LEGAL_DOCUMENT_UNKNOWN');
      await saveDraft(page, 'Ghi căn cứ pháp lý của bước và của việc (kiểm thử trình duyệt)');
      const draft = await draftOf('PUBLIC_PROCUREMENT');
      expect(JSON.stringify(draft?.steps?.[0]?.legal_basis)).toContain(stepDocument);
      expect(draft?.tasks[0]?.legal_basis?.at(-1)).toMatchObject({ document: taskDocument, article: 'Điều 12' });

      // A workflow that runs (from the template in force, whose steps cite the same catalogue): PWF-03 shows the grounds of each step with what the catalogue says of the document.
      const project = await projectWithWorkflow('PRC4');
      const { row } = await startTaskThat(project.id, (detail) => detail.step !== undefined && detail.step !== null);
      await page.goto(`/pwf/pwf-03?id=${project.id}&devUser=${PERSON}`);
      const panel = page.getByTestId('steps-panel');
      await expect(panel).toBeAttached();
      await showTabOf(page, panel);
      await expect(panel).toBeVisible();
      const law = panel.locator('[data-document="LAW_58_2024_QH15"]').first();
      await law.scrollIntoViewIfNeeded().catch(() => undefined);
      await expect(law).toHaveAttribute('data-state', 'IN_FORCE');
      const lawText = (await law.textContent()) ?? '';
      // Number, title, issuer and the day it took force come from the catalogue; the article was never written, and the citation is not confirmed by a legal officer.
      for (const words of ['58/2024/QH15', 'Luật Đầu tư công', 'Quốc hội', '01/01/2025']) expect(lawText, words).toContain(words);
      expect(lawText).toMatch(/chưa ghi điều khoản|chờ pháp chế xác nhận/i);
      expect(lawText).toMatch(/chưa kiểm chứng|chưa xác nhận/i);
      expect(lawText).toMatch(/còn hiệu lực|đang có hiệu lực/i);

      // PWF-04: the grounds of the task, its own and those of its step.
      await page.goto(`/pwf/pwf-04?id=${row.id}&project=${project.id}&devUser=${PERSON}`);
      const taskLegal = page.getByTestId('task-legal');
      await expect(taskLegal).toBeAttached();
      await showTabOf(page, taskLegal);
      await expect(taskLegal).toBeVisible();
      await expect(taskLegal.locator('[data-document]').first()).toHaveAttribute('data-state', 'IN_FORCE');
      await expect(taskLegal).toContainText(/\d+\/\d{4}\/(QH\d+|NĐ-CP)/);
    });
  });

  test.describe('the workflow of a project shows its steps, tasks and checklists (ST-PWF-021)', () => {
    test('TC-UAT-PWF-PRC-02: the workflow tells each step with its state, its tasks done, its checklist items done and its standard time; a task with an open mandatory item is refused with the item named, and completes once the item is ticked (PRJ-03, PWF-03, PWF-04)', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      const taskCode = await checklistTemplate();
      const project = await projectWithWorkflow('PRC2', CHECKLIST_TEMPLATE);
      const { row, detail } = await startTaskThat(project.id, (one) => one.checklist.some((item) => item.item_code === REQUIRED_ITEM.code));
      expect(row.task_code).toBe(taskCode);
      // One optional and one mandatory item, both open (the server lists them in its own order).
      expect(detail.checklist.map((item) => [item.item_code, item.required, item.done]).sort()).toEqual([
        [REQUIRED_ITEM.code, true, false],
        [OPTIONAL_ITEM.code, false, false],
      ]);
      const required = detail.checklist.find((item) => item.required && !item.done);
      const step = detail.step?.code ?? '';
      if (required === undefined) throw new Error('the task has no open mandatory item');
      expect(step).not.toBe('');

      // The tab "Workflow" of the project (PRJ-03) and the screen PWF-03 are the same workflow.
      await page.goto(`/prj/prj-03?id=${project.id}&tab=workflow&devUser=${PERSON}`);
      await expect(page.getByTestId('workflow')).toBeVisible();
      await page.goto(`/pwf/pwf-03?id=${project.id}&devUser=${PERSON}`);
      const panel = page.getByTestId('steps-panel');
      await expect(panel).toBeAttached();
      await showTabOf(page, panel);
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('steps-summary')).toContainText(/\d/);
      // The step of the task that was started is under way; its standard time is told in working days, and the checklist of the task says how many items are done.
      const stepRow = panel.locator(`[data-step="${step}"]`).first();
      await expect(stepRow).toHaveAttribute('data-status', 'IN_PROGRESS');
      await expect(page.getByTestId(`step-time-${step}`)).toContainText(/\d/);
      const meter = page.getByTestId(`checklist-${row.task_code}`).first();
      await expect(meter).toContainText(new RegExp(`0\\D+${detail.checklist.length}`));

      // PWF-04: the optional item is ticked; what is missing still names the mandatory one, and the server refuses the completion with the same item.
      await page.goto(`/pwf/pwf-04?id=${row.id}&project=${project.id}&devUser=${PERSON}`);
      await expect(page.getByTestId('checklist').locator(`[data-item="${required.item_code}"]`)).toHaveAttribute('data-done', 'false');
      await page.locator(`[data-action="tick-${OPTIONAL_ITEM.code}"]`).click();
      await page.getByRole('dialog').locator('.ui-button--primary').click();
      await expect(page.getByTestId('checklist').locator(`[data-item="${OPTIONAL_ITEM.code}"]`)).toHaveAttribute('data-done', 'true');
      await expect(page.getByTestId('completion-blockers')).toContainText(required.name);
      await expect(page.getByTestId('completion-blockers')).not.toContainText(OPTIONAL_ITEM.name);
      const refused = await apiCall(PERSON, 'POST', `/project-tasks/${row.id}/complete`, { body: {}, version: (await detailOf(row.id)).version });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.json.code).toBe('PWF_TASK_COMPLETION_BLOCKED');
      expect(JSON.stringify(refused.json)).toContain(required.item_code);
      expect((await detailOf(row.id)).status).toBe('IN_PROGRESS');

      // The papers the task asks for are handed in (what the item or the task needs as evidence), then every open mandatory item is ticked on the screen.
      for (const blocker of (await detailOf(row.id)).completion.blockers) {
        if (blocker.code === 'LEGAL_DOC_MISSING') await apiCall(PERSON, 'POST', `/project-tasks/${row.id}/evidence`, { body: { evidence_kind: 'DECISION_DOCUMENT', legal_doc_type: blocker.subject, external_ref: `Văn bản ${blocker.subject} (kiểm thử trình duyệt)` } });
        if (blocker.code === 'FORM_MISSING') await apiCall(PERSON, 'POST', `/project-tasks/${row.id}/evidence`, { body: { evidence_kind: 'DOCUMENT', form_template_code: blocker.subject, external_ref: `Văn bản lập theo biểu mẫu ${blocker.subject}` } });
        if (blocker.code === 'EVIDENCE_MISSING') {
          const kind = detail.checklist.find((item) => item.item_code === blocker.subject)?.evidence_kinds[0];
          if (kind !== undefined) await apiCall(PERSON, 'POST', `/project-tasks/${row.id}/evidence`, { body: { evidence_kind: kind, item_code: blocker.subject, external_ref: `Hồ sơ kèm mục ${blocker.subject}` } });
        }
      }
      await page.reload();
      for (const item of (await detailOf(row.id)).checklist.filter((one) => one.required && !one.done)) {
        await page.locator(`[data-action="tick-${item.item_code}"]`).click();
        await page.getByRole('dialog').locator('.ui-button--primary').click();
        await expect(page.getByTestId('checklist').locator(`[data-item="${item.item_code}"]`)).toHaveAttribute('data-done', 'true');
      }
      await expect(page.getByTestId('completion-blockers')).toHaveCount(0);

      // The task completes: done, or waiting for the approval of its completion by another person where the template names an approver.
      await page.locator('[data-action="complete"]').click();
      await page.getByRole('dialog').locator('.ui-button--primary').click();
      await expect.poll(async () => (await detailOf(row.id)).status).toMatch(/^(DONE|PENDING_APPROVAL)$/);
      const done = (await detailOf(row.id)).checklist.filter((item) => item.done).length;
      await page.goto(`/pwf/pwf-03?id=${project.id}&devUser=${PERSON}`);
      await showTabOf(page, page.getByTestId('steps-panel'));
      await expect(page.getByTestId(`checklist-${row.task_code}`).first()).toContainText(new RegExp(`${done}\\D+${detail.checklist.length}`));
    });
  });
}
