import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { apiCall } from './support/api.ts';
import { editionOf, terms as vi } from './support/edition-terms.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

// The strings of this piece of work wait in a part until they are folded into the catalogue; after the fold they are read from the catalogue.
const PART = new URL('../src/i18n/parts/pwf6.vi.json', import.meta.url);
const part: Record<string, string> = existsSync(PART) ? (JSON.parse(readFileSync(PART, 'utf8')) as Record<string, string>) : vi;

/**
 * PRJ-02, the section "Loại quy trình xử lý" (ST-PWF-024, BR-PWF-46, R47 and R48) in a real browser against the real API and database (apps/api/test/e2e-stack): the person who registers a project reads the
 * kind of workflow the rule `PROJECT_WORKFLOW_ASSIGNMENT` suggests, with the reason and the version of the rule, sees what the choice gives before anything is saved, and the project and its workflow are
 * made together, once. Another kind than the suggested one needs a reason, which the workflow and the audit keep. Where the rule suggests nothing the screen says so and sends nothing; without a planned start
 * the project is registered without a workflow and the screen says where the workflow starts later.
 *
 * The section belongs to the public edition (ProjectCreateScreen): on the enterprise edition the registration screen has no such section, and that is what is checked there.
 * The person is `projectManager`, who holds `project.create`, `pwf.read` and `pwf.workflow.manage` (e2e-fixtures.json and the role E2E_PROJECT_MANAGER of the stack).
 */

const ENTERPRISE = editionOf() === 'enterprise';
const PERSON = 'projectManager';
const AREA_LABEL = 'E2E_AREA_1 · Thành phố Cao Bằng';
const TOTAL = '150000000000';
/** The built-in templates of the public edition (packages/kernel/src/project-workflow-defaults.ts): the rule in force names the first as its default. */
const SUGGESTED = 'PUBLIC_INVESTMENT';
const OTHER = 'PUBLIC_PROCUREMENT';
const REASON = 'Dự án chỉ mua sắm thiết bị dạy học, không có hạng mục xây dựng';
/** The Vietnam date today: the day the workflow is planned to start. */
const today = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const unique = (prefix: string): string => `E2E-${prefix}-${Date.now().toString(36).toUpperCase()}`;
const unitOf = (code: string): string => {
  const id = stackInfo().units.A[code];
  if (id === undefined) throw new Error(`the stack has no unit ${code}`);
  return id;
};

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/prj/prj-02?devUser=${PERSON}`);
  await expect(page.getByRole('heading', { level: 1, name: vi['prj.create.page.title'] })).toBeVisible();
}

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const section = (page: Page) => page.getByTestId('process-kind');
const save = (page: Page) => page.getByRole('button', { name: vi['prj.create.submit.action'] }).click();

async function fillProject(page: Page, code: string, unit: string): Promise<void> {
  await field(page, vi['prj.form.code.label']).fill(code);
  await field(page, vi['prj.form.name.label']).fill(`Dự án chọn loại quy trình ${code}`);
  await field(page, vi['prj.form.owner.label']).selectOption(unitOf(unit));
  await field(page, vi['prj.form.area.label']).selectOption({ label: AREA_LABEL });
  await field(page, vi['prj.form.total.label']).fill(TOTAL);
}

interface WorkflowRow {
  id: string;
  template_code: string;
  selection: { mode: string; chosen_template_code: string; suggested_template_code: string | null; basis: string; rule_version: number; reason: string | null } | null;
}

const projectId = async (code: string): Promise<string | undefined> => (await sql<{ id: string }>('select id from machvon.project where code = $1', [code]))[0]?.id;
const workflowsOf = async (code: string): Promise<WorkflowRow[]> =>
  sql<WorkflowRow>('select w.id, w.template_code, w.selection from machvon.project_workflow w join machvon.project p on p.id = w.project_id where p.code = $1', [code]);

/**
 * A rule of one unit that suggests nothing (no line, no default), approved by a second person: the nearest unit wins, so a project of that unit gets no suggestion while every other unit keeps the rule of the
 * tenant. A governance rule is never deleted, so the row is made once for the stack and found again by the next run.
 */
async function ruleWithoutSuggestion(unit: string): Promise<void> {
  await sql(
    `insert into machvon.governance_rule (tenant_id, rule_type, code, version, unit_id, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
     select $1, 'PROJECT_WORKFLOW_ASSIGNMENT', 'DEFAULT', 1, $2, 'APPROVED', '{"lines": []}'::jsonb, date '2020-01-01', 'Quy tắc của đơn vị không đề xuất loại quy trình (kiểm thử trình duyệt)', $3, $3, now(), $4, now()
      where not exists (select 1 from machvon.governance_rule where tenant_id = $1 and rule_type = 'PROJECT_WORKFLOW_ASSIGNMENT' and code = 'DEFAULT' and unit_id = $2)`,
    [stackInfo().tenants.A, unitOf(unit), membershipOf('owner'), membershipOf('unitAdmin')],
  );
}

if (ENTERPRISE) {
  test.describe('PRJ-02 on the enterprise edition', () => {
    test('the registration screen of the enterprise edition has no section for the kind of workflow (the section belongs to the public edition)', async ({ page }) => {
      await open(page);
      await field(page, vi['prj.form.owner.label']).selectOption(unitOf('CB-SKHDT-QLDA'));
      await expect(page.getByRole('button', { name: vi['prj.create.submit.action'] })).toBeVisible();
      await expect(section(page)).toHaveCount(0);
    });
  });
} else {
  test.describe('PRJ-02 the kind of workflow of a project that is registered (ST-PWF-024)', () => {
    test('TC-UAT-PWF-PRC-07: the rule suggests the kind of workflow with its reason and its version, the preview tells the schedule, and the project and its workflow are made together, once (AC-ST-PWF-024-1)', async ({ page }) => {
      const code = unique('WK7');
      await open(page);
      // Before a unit is chosen there is nothing to suggest for.
      await expect(page.getByTestId('kind-suggestion')).toHaveText(vi['pwf.process.kind.waiting.text']);
      await fillProject(page, code, 'CB-SKHDT-QLDA');

      // The suggestion: the code and the name of the kind, why (the default of the rule), and the version of the rule.
      const suggestion = page.getByTestId('kind-suggestion');
      await expect(suggestion).toContainText(SUGGESTED);
      await expect(suggestion).toContainText(vi['pwf.process.basis.default.text']);
      // The rule behind the suggestion is named with its version, or as the system default when the tenant has no version of its own.
      await expect(suggestion).toContainText(part['pwf6.kind.rule.label']);
      await expect(suggestion).toContainText(new RegExp(`phiên bản \\d+|${part['pwf6.version.default.text']}`));
      await expect(page.getByTestId('kind-template')).toHaveValue('');

      // The planned start, and the two facts the branches of this kind read: the preview tells the finish, the working days and the steps.
      await page.getByTestId('kind-start').fill(today());
      await page.getByTestId('kind-group').selectOption('B');
      await page.getByTestId('kind-funding').selectOption('STATE_BUDGET');
      const preview = page.getByTestId('kind-preview');
      await expect(preview.getByTestId('preview-finish')).toHaveText(/^\d{2}\/\d{2}\/\d{4}$/);
      await expect(preview.getByTestId('preview-total')).toHaveText(/\d/);
      await expect(preview.getByTestId('preview-counts')).toHaveText(/\d/);
      await expect(preview.getByTestId('preview-calendar')).toHaveCount(0);
      expect(await preview.locator('tr[data-step]').count()).toBeGreaterThan(0);
      expect(await projectId(code)).toBeUndefined();

      await save(page);
      const done = page.getByTestId('created');
      await expect(done).toBeVisible();
      // The link that opens the workflow that was made with the project.
      await expect(page.getByTestId('created-workflow').getByRole('link', { name: part['pwf6.kind.created.open'] })).toBeVisible();
      // The form is closed after the save: a second press of the button sends nothing.
      await expect(page.getByTestId('kind-start')).toBeDisabled();

      const id = await projectId(code);
      expect(id).toBeDefined();
      const workflows = await workflowsOf(code);
      expect(workflows).toHaveLength(1);
      expect(workflows[0]).toMatchObject({ template_code: SUGGESTED, selection: { mode: 'AUTO', chosen_template_code: SUGGESTED, suggested_template_code: SUGGESTED, basis: 'DEFAULT', reason: null } });
      expect(typeof workflows[0]?.selection?.rule_version).toBe('number');
      expect(await sql('select count(*)::int as n from machvon.project where code = $1', [code])).toEqual([{ n: 1 }]);
      expect(await sql("select count(*)::int as n from machvon.audit_event where action = 'project.created' and resource_id = $1", [id])).toEqual([{ n: 1 }]);
      expect(await sql("select count(*)::int as n from machvon.audit_event where action = 'workflow.started' and resource_id = $1", [workflows[0]?.id])).toEqual([{ n: 1 }]);
    });

    test('TC-UAT-PWF-PRC-08: another kind than the suggested one asks for a reason before anything is sent, the server refuses it without one, and the reason is kept by the workflow and the audit (AC-ST-PWF-024-2)', async ({ page }) => {
      const code = unique('WK8');
      await open(page);
      await fillProject(page, code, 'CB-SKHDT-QLDA');
      await expect(page.getByTestId('kind-suggestion')).toContainText(SUGGESTED);
      await page.getByTestId('kind-template').selectOption(OTHER);
      await page.getByTestId('kind-start').fill(today());

      // The screen asks for the reason and sends nothing.
      await expect(page.getByTestId('kind-reason')).toBeVisible();
      await save(page);
      await expect(page.getByTestId('kind-problems').locator('li')).toHaveText([vi['pwf.process.problem.reasonRequired.text']]);
      expect(await projectId(code)).toBeUndefined();

      // The server holds the same rule for a caller that skips the screen: 422, and no project is left behind.
      const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [stackInfo().tenants.A]);
      const direct = await apiCall(PERSON, 'POST', '/projects', {
        body: { code, name: 'Dự án gọi thẳng API', owner_unit_id: unitOf('CB-SKHDT-QLDA'), area_master_version_id: area?.id, total_investment_vnd: TOTAL, classification: 'INTERNAL', workflow: { template_code: OTHER, planned_start_date: today() } },
      });
      expect(direct.status).toBe(422);
      expect(direct.json.code).toBe('PWF_SELECTION_REASON_REQUIRED');
      expect(await projectId(code)).toBeUndefined();

      // With the reason the project and the workflow are made; the workflow says it was an override, of which suggestion, and why.
      await page.getByTestId('kind-reason').fill(REASON);
      await save(page);
      await expect(page.getByTestId('created')).toBeVisible();
      await expect(page.getByTestId('created-workflow').getByRole('link', { name: part['pwf6.kind.created.open'] })).toBeVisible();
      const workflows = await workflowsOf(code);
      expect(workflows).toHaveLength(1);
      expect(workflows[0]).toMatchObject({ template_code: OTHER, selection: { mode: 'OVERRIDE', chosen_template_code: OTHER, suggested_template_code: SUGGESTED, reason: REASON } });
      const [audit] = await sql<{ row: string }>("select to_jsonb(a)::text as row from machvon.audit_event a where a.action = 'workflow.started' and a.resource_id = $1", [workflows[0]?.id]);
      expect(audit?.row).toContain(REASON);
    });

    test('TC-UAT-PWF-PRC-09: where the rule suggests no kind the screen says so and sends nothing, and without a planned start the project is registered without a workflow and told where it starts later (AC-ST-PWF-024-3)', async ({ page }) => {
      const code = unique('WK9');
      await ruleWithoutSuggestion('CB-STC');
      await open(page);
      await fillProject(page, code, 'CB-STC');

      // The rule of this unit names no kind: the words say so, and a planned start without a kind is stopped with the reason before anything is sent.
      await expect(page.getByTestId('kind-suggestion')).toHaveText(vi['pwf.process.basis.none.text']);
      await page.getByTestId('kind-start').fill(today());
      await save(page);
      await expect(page.getByTestId('kind-problems').locator('li[data-problem]').first()).toHaveText(vi['pwf.process.problem.templateRequired.text']);
      await expect(page.getByTestId('created')).toHaveCount(0);
      expect(await projectId(code)).toBeUndefined();

      // Without a planned start the project is registered as it always was: no workflow, and the screen says where one is started later.
      await page.getByTestId('kind-start').fill('');
      await save(page);
      await expect(page.getByTestId('created')).toBeVisible();
      await expect(page.getByTestId('created-workflow')).toHaveText(vi['pwf.process.kind.created.later']);
      expect(await projectId(code)).toBeDefined();
      expect(await workflowsOf(code)).toEqual([]);
    });
  });
}
