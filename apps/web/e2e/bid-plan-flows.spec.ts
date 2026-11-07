import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * BID-03, BID-15 and BID-16 in a real browser against the real API and database (apps/api/test/e2e-stack): a planner drafts a procurement plan
 * of two packages on a line of 30 billion that the capital plan published, submits it, and a second person approves it on a decision in force
 * (a pending decision is refused); the planner who holds both rights cannot approve their own plan; a revision that adds 5 billion cannot be
 * submitted, the refusal names the line with the figures, and the plan in force stays the only APPROVED plan; a project that left the stages that
 * take a plan cannot have its plan submitted; a reader sees the plans and the packages and has no action. What the screens changed is looked up
 * in the database.
 */

const TENANT = stackInfo().tenants.A;
const BILLION = 1_000_000_000;
const PLANNER = membershipOf('bidPlanner');
const APPROVER = membershipOf('bidPlanApprover');
const SOLO = membershipOf('bidPlanSolo');
let counter = 0;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** A decision of the tenant; `effective` makes it a decision in force. */
async function decisionDocument(effective: boolean): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Quyết định phê duyệt kế hoạch lựa chọn nhà thầu', 'INTERNAL', $3, date '2026-10-01', $4, $5, $5)`,
    [TENANT, id, `${50 + counter}/QD-UBND`, effective ? 'EFFECTIVE' : 'PENDING', membershipOf('owner')],
  );
  return id;
}

interface Seeded {
  projectId: string;
  code: string;
  line: string;
}

/** A project of the Project Management Board with a line of capital (billions) that the capital plan of the year has published. */
async function seedProject(billions = 30): Promise<Seeded> {
  counter += 1;
  const [projectId, capitalPlan, version, line] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const code = `E2E-BP-${Date.now() % 100000}-${counter}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [TENANT]);
  const [fund] = await sql<{ id: string }>(
    "select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where v.tenant_id = $1 and v.master_type = 'FUND_SOURCE' and r.business_key = 'NSTW' and v.status = 'EFFECTIVE' limit 1",
    [TENANT],
  );
  const decision = await decisionDocument(true);
  const unit = stackInfo().units.A['CB-SKHDT-QLDA'] as string;
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
    [TENANT, projectId, code, `Cầu thử ${counter}`, unit, area?.id, String(70000000 + Number.parseInt(projectId.slice(0, 6), 16)), membershipOf('owner')],
  );
  await sql(
    `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
     values ($1, $2, $3, 'ANNUAL', 2026, 2026, 2026, $4, 1, 'PUBLISHED', $5, now(), $6, $6)`,
    [TENANT, capitalPlan, `E2E-BP-CAP-${Date.now() % 100000}-${counter}`, stackInfo().units.A['CB-STC'], decision, membershipOf('owner')],
  );
  await sql(
    `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id, created_by, updated_by)
     values ($1, $2, $3, 2026, 1, $4, 'PUBLISHED', now(), $5, $6, $6)`,
    [TENANT, version, projectId, decision, capitalPlan, membershipOf('owner')],
  );
  await sql(
    `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, created_by, updated_by)
     values ($1, $2, $3, $4, 'CURRENT_YEAR', 2026, $5::numeric, 0, $6, $7, $7)`,
    [TENANT, line, version, fund?.id, String(billions * BILLION), projectId, membershipOf('owner')],
  );
  return { projectId, code, line };
}

interface PlanRow {
  id: string;
  status: string;
  revision: number;
  version: string;
  total: string;
  created_by: string;
  submitted_by: string | null;
  approved_by: string | null;
  decision_document_id: string | null;
}

const plansOf = (projectId: string): Promise<PlanRow[]> =>
  sql(
    `select id, status, revision, version::text as version, total_value_vnd::text as total, created_by, submitted_by, approved_by, decision_document_id
       from machvon.procurement_plan where project_id = $1 order by revision`,
    [projectId],
  );

const eventsOf = async (planId: string): Promise<string[]> => (await sql<{ event_kind: string }>('select event_kind from machvon.procurement_plan_event where plan_id = $1 order by occurred_at, id', [planId])).map((row) => row.event_kind);

const field = (scope: Page | Locator, label: string): Locator => scope.getByLabel(label, { exact: true });

/** Fills one package of the editor (the n-th, from 0). */
async function fillPackage(page: Page, n: number, input: { code: string; title: string; budget: string; line: string }): Promise<void> {
  const row = page.getByTestId('package-row').nth(n);
  await field(row, vi['bid.editor.row.code']).fill(input.code);
  await field(row, vi['bid.editor.row.title.label']).fill(input.title);
  await field(row, vi['bid.editor.row.budget']).fill(input.budget);
  await field(row, vi['bid.editor.row.line']).fill(input.line);
  await field(row, vi['bid.editor.row.period']).fill('2026-Q4');
  await field(row, vi['bid.editor.row.duration']).fill('180');
}

async function fillHead(page: Page, project: Seeded, title: string): Promise<void> {
  await field(page, vi['bid.editor.project.label']).fill(project.projectId);
  await field(page, vi['bid.editor.title.label']).fill(title);
  await field(page, vi['bid.editor.basis.label']).fill('Luật Đấu thầu 22/2023/QH15');
}

/** The planner drafts the plan in the editor and opens it in the list; returns its id. */
async function draftPlan(page: Page, user: string, project: Seeded, packages: Array<{ code: string; title: string; budget: string }>, revise?: string): Promise<string> {
  await open(page, revise === undefined ? '/bid/bid-16' : `/bid/bid-16?revise=${revise}`, user);
  if (revise === undefined) {
    await fillHead(page, project, 'Kế hoạch lựa chọn nhà thầu năm 2026');
    for (let index = 1; index < packages.length; index += 1) await page.getByRole('button', { name: vi['bid.editor.row.add'] }).click();
    for (const [index, item] of packages.entries()) await fillPackage(page, index, { ...item, line: project.line });
  } else {
    await expect(page.getByTestId('package-row').first()).toBeVisible();
    await page.getByRole('button', { name: vi['bid.editor.row.add'] }).click();
    const last = packages[packages.length - 1];
    if (last === undefined) throw new Error('a revision names the package it adds');
    await fillPackage(page, 2, { ...last, line: project.line });
  }
  await page.getByRole('button', { name: vi['bid.editor.submit.action'] }).click();
  const done = page.getByTestId('create-done');
  await expect(done).toBeVisible();
  await done.getByRole('link', { name: vi['bid.editor.open.link'] }).click();
  await page.waitForSelector('[data-testid="plan-detail"]');
  return new URL(page.url()).searchParams.get('plan') as string;
}

test.describe('BID-03, BID-15 and BID-16 procurement plans', () => {
  test('a planner drafts and submits a plan on a line of 30 billion, a pending decision is refused, an approver approves, and a revision that adds 5 billion cannot be submitted (AC-ST-BID-001-1)', async ({ page }) => {
    const project = await seedProject();
    const decision = await decisionDocument(true);
    const pending = await decisionDocument(false);

    // The form says what is wrong and sends nothing.
    await open(page, '/bid/bid-16', 'bidPlanner');
    await page.getByRole('button', { name: vi['bid.editor.submit.action'] }).click();
    await expect(page.locator('[data-field="plan-title"]').getByText(vi['bid.planField.required.error'])).toBeVisible();
    expect(await plansOf(project.projectId)).toEqual([]);

    const planId = await draftPlan(page, 'bidPlanner', project, [
      { code: 'GT-01', title: 'Gói thầu xây lắp cầu chính', budget: String(18 * BILLION) },
      { code: 'GT-02', title: 'Gói thầu giám sát thi công', budget: String(10 * BILLION) },
    ]);
    let [plan] = await plansOf(project.projectId);
    expect(plan).toMatchObject({ id: planId, status: 'DRAFT', revision: 1, version: '1', total: String(28 * BILLION), created_by: PLANNER });
    await expect(page.getByTestId('plan-packages').getByRole('row')).toHaveCount(3);
    await expect(page.getByTestId('plan-detail')).toContainText('28.000.000.000');

    await page.getByRole('button', { name: vi['bid.plans.submit.action'] }).click();
    await expect(page.getByTestId('submit-done')).toBeVisible();
    [plan] = await plansOf(project.projectId);
    expect(plan).toMatchObject({ status: 'IN_REVIEW', version: '2', submitted_by: PLANNER });
    // A planner without the right to approve is shown no decision.
    await expect(page.getByTestId('decision-panel')).toHaveCount(0);

    // The approver is refused a decision that is not in force, then approves on one that is.
    await open(page, `/bid/bid-15?plan=${planId}`, 'bidPlanApprover');
    const panel = page.getByTestId('decision-panel');
    await panel.getByRole('button', { name: vi['bid.decisionPanel.submit.action'] }).click();
    await expect(panel.getByText(vi['bid.planField.required.error'])).toBeVisible();
    await field(panel, vi['bid.decisionPanel.document.label']).fill(pending);
    await panel.getByRole('button', { name: vi['bid.decisionPanel.submit.action'] }).click();
    await expect(panel.getByTestId('decision-refusal')).toContainText(vi['bid.planProblem.decisionNotEffective.error']);
    expect((await plansOf(project.projectId))[0]).toMatchObject({ status: 'IN_REVIEW' });
    await field(panel, vi['bid.decisionPanel.document.label']).fill(decision);
    await panel.getByRole('button', { name: vi['bid.decisionPanel.submit.action'] }).click();
    await expect(page.getByTestId('decision-done')).toBeVisible();
    [plan] = await plansOf(project.projectId);
    expect(plan).toMatchObject({ status: 'APPROVED', approved_by: APPROVER, decision_document_id: decision, version: '3' });
    expect(await eventsOf(planId)).toEqual(['CREATED', 'SUBMITTED', 'APPROVED']);
    expect(await sql('select status, approved_decision_id from machvon.procurement_package where plan_id = $1', [planId])).toEqual([
      { status: 'PLANNED', approved_decision_id: decision },
      { status: 'PLANNED', approved_decision_id: decision },
    ]);
    await expect(page.getByTestId('plans').locator(`tr[data-plan-id="${planId}"]`).getByTestId('plan-status')).toHaveText(vi['bid.planStatus.approved.label']);

    // The revision starts from the packages of the plan in force and adds 5 billion on the same line: the budget check refuses it with the figures.
    const revisionId = await draftPlan(page, 'bidPlanner', project, [{ code: 'GT-03', title: 'Gói thầu thiết bị bổ sung', budget: String(5 * BILLION) }], planId);
    await page.getByRole('button', { name: vi['bid.plans.submit.action'] }).click();
    const refusal = page.getByTestId('submit-refusal');
    await expect(refusal).toContainText(vi['bid.planProblem.budgetExceeds.error']);
    const excess = refusal.getByTestId('excess-lines').locator(`tr[data-line-id="${project.line}"]`);
    await expect(excess).toContainText('30.000.000.000');
    await expect(excess).toContainText('33.000.000.000');
    await expect(excess).toContainText('3.000.000.000');
    const plans = await plansOf(project.projectId);
    expect(plans.map((row) => [row.revision, row.status])).toEqual([
      [1, 'APPROVED'],
      [2, 'DRAFT'],
    ]);
    expect(plans[1]?.id).toBe(revisionId);
    expect(plans.filter((row) => row.status === 'APPROVED')).toHaveLength(1);
  });

  test('the planner who also holds the right to approve cannot approve their own plan, and the plan stays in review', async ({ page }) => {
    const project = await seedProject();
    const decision = await decisionDocument(true);
    const planId = await draftPlan(page, 'bidPlanSolo', project, [{ code: 'GT-10', title: 'Gói thầu tự lập', budget: String(5 * BILLION) }]);
    await page.getByRole('button', { name: vi['bid.plans.submit.action'] }).click();
    await expect(page.getByTestId('submit-done')).toBeVisible();
    // The page shows the decision panel to a holder of the right; the server refuses the maker.
    await open(page, `/bid/bid-15?plan=${planId}`, 'bidPlanSolo');
    const panel = page.getByTestId('decision-panel');
    await field(panel, vi['bid.decisionPanel.document.label']).fill(decision);
    await panel.getByRole('button', { name: vi['bid.decisionPanel.submit.action'] }).click();
    await expect(panel.getByTestId('decision-refusal')).toContainText(vi['bid.planProblem.selfApproval.error']);
    expect((await plansOf(project.projectId))[0]).toMatchObject({ status: 'IN_REVIEW', approved_by: null, created_by: SOLO, submitted_by: SOLO });
    expect(await eventsOf(planId)).toEqual(['CREATED', 'SUBMITTED']);
  });

  test('an approver returns a plan with the words, which the planner reads; a stage that no longer takes procurement refuses the submission and no plan is in review (AC-ST-BID-001-2)', async ({ page }) => {
    const project = await seedProject();
    const planId = await draftPlan(page, 'bidPlanner', project, [{ code: 'GT-20', title: 'Gói thầu trả lại', budget: String(4 * BILLION) }]);
    await page.getByRole('button', { name: vi['bid.plans.submit.action'] }).click();
    await expect(page.getByTestId('submit-done')).toBeVisible();

    await open(page, `/bid/bid-15?plan=${planId}`, 'bidPlanApprover');
    const panel = page.getByTestId('decision-panel');
    await field(panel, vi['bid.decisionPanel.kind.label']).selectOption('RETURN');
    await panel.getByRole('button', { name: vi['bid.decisionPanel.submit.action'] }).click();
    await expect(panel.getByText(vi['bid.planField.required.error'])).toBeVisible();
    await field(panel, vi['bid.decisionPanel.comment.label']).fill('Tách gói giám sát thành hai gói');
    await panel.getByRole('button', { name: vi['bid.decisionPanel.submit.action'] }).click();
    await expect(page.getByTestId('decision-done')).toBeVisible();
    expect((await plansOf(project.projectId))[0]).toMatchObject({ status: 'DRAFT', submitted_by: null });

    await open(page, `/bid/bid-15?plan=${planId}`, 'bidPlanner');
    await expect(page.getByTestId('last-decision')).toHaveText(`${vi['bid.lastDecision.returned.label']}: Tách gói giám sát thành hai gói`);
    await sql("update machvon.project set status = 'CLOSED' where id = $1", [project.projectId]);
    await page.getByRole('button', { name: vi['bid.plans.submit.action'] }).click();
    await expect(page.getByTestId('submit-refusal')).toContainText(vi['bid.planProblem.stageInvalid.error']);
    expect(await sql("select 1 from machvon.procurement_plan where project_id = $1 and status = 'IN_REVIEW'", [project.projectId])).toEqual([]);
    expect(await eventsOf(planId)).toEqual(['CREATED', 'SUBMITTED', 'RETURNED']);
  });

  test('a reader sees the plan in force and its packages and has no action; the editor is read-only for them', async ({ page }) => {
    const project = await seedProject();
    const decision = await decisionDocument(true);
    const planId = await draftPlan(page, 'bidPlanner', project, [{ code: 'GT-30', title: 'Gói thầu đã duyệt', budget: String(6 * BILLION) }]);
    await page.getByRole('button', { name: vi['bid.plans.submit.action'] }).click();
    await expect(page.getByTestId('submit-done')).toBeVisible();
    await open(page, `/bid/bid-15?plan=${planId}`, 'bidPlanApprover');
    await field(page.getByTestId('decision-panel'), vi['bid.decisionPanel.document.label']).fill(decision);
    await page.getByRole('button', { name: vi['bid.decisionPanel.submit.action'] }).click();
    await expect(page.getByTestId('decision-done')).toBeVisible();

    await open(page, `/bid/bid-15?plan=${planId}`, 'bidPlanReader');
    await expect(page.getByTestId('plan-detail')).toBeVisible();
    await expect(page.getByTestId('plan-detail').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('link', { name: vi['bid.plans.create.link'] })).toHaveCount(0);

    await open(page, '/bid/bid-03', 'bidPlanReader');
    // The list pages at twenty rows: the code in the query box brings the package to the first page whatever else the stack holds.
    await page.getByLabel(vi['bid.packages.query.label'], { exact: true }).fill('GT-30');
    const row = page.locator('tr[data-package-id]', { hasText: 'GT-30' });
    await expect(row).toContainText(project.code);
    await expect(row.getByTestId('plan-status')).toHaveText(vi['bid.planStatus.approved.label']);
    await expect(row).toContainText('6.000.000.000');

    await open(page, '/bid/bid-16', 'bidPlanReader');
    await expect(page.getByTestId('read-only')).toHaveText(vi['bid.editor.readOnly.notice']);
  });

  test('a plan in work is not shown to a reader', async ({ page }) => {
    const project = await seedProject();
    await draftPlan(page, 'bidPlanner', project, [{ code: 'GT-40', title: 'Gói thầu đang soạn', budget: String(2 * BILLION) }]);
    await open(page, '/bid/bid-03', 'bidPlanReader');
    await page.getByLabel(vi['bid.packages.query.label'], { exact: true }).fill('GT-40');
    await expect(page.locator('tr[data-package-id]', { hasText: 'GT-40' })).toHaveCount(0);
    await open(page, '/bid/bid-03', 'bidPlanner');
    await page.getByLabel(vi['bid.packages.query.label'], { exact: true }).fill('GT-40');
    await expect(page.locator('tr[data-package-id]', { hasText: 'GT-40' })).toHaveCount(1);
  });
});
