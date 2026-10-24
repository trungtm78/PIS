import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CAP-10 (plan approval) and CAP-05 (capital decisions) in a real browser against the real API and database (apps/api/test/e2e-stack): the planner
 * submits a revision, a different person approves it, a third publishes it with the decision document; the person who made a plan is refused when
 * they try to approve it even though their role holds every step; a revision below what is committed and disbursed is refused with its line
 * listed and nothing written; the revision that fits replaces the plan in force, posts the difference to the ledger and moves the balance with its
 * commitments; and someone who only reads has no button. What the screens changed is looked up in the database.
 */

const TENANT = stackInfo().tenants.A;
const BILLION = 1_000_000_000;

/** The decision documents the stack seeds in tenant A (apps/api/test/e2e-stack): 1 to 4. */
const docId = (n: number): string => `00000000-0000-4000-005d-${n.toString(16).padStart(12, '0')}`;

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const unitOf = (code: string): string => stackInfo().units.A[code] as string;
const field = (scope: Locator, label: string): Locator => scope.getByLabel(label, { exact: true });

// ---- what the database holds before a flow starts ------------------------------------------------------------------------

async function seedProject(label: string): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = `E2E-AF-${label}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [TENANT]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
    [TENANT, id, code, `Dự án thử ${label}`, unitOf('CB-SKHDT-QLDA'), area?.id, String(6000000 + (Number.parseInt(id.slice(0, 6), 16) % 3000000)), membershipOf('owner')],
  );
  return { id, code };
}

interface Seeded {
  planId: string;
  planCode: string;
  year: number;
  appropriationId: string;
  projectId: string;
  projectCode: string;
  lineId: string;
}

/** A published appropriation, with the given amount already allocated, the way a decision and a publication leave it. */
async function seedAppropriation(year: number, amount: number, allocated: number): Promise<string> {
  const id = randomUUID();
  const [fund] = await sql<{ id: string }>(
    "select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where v.tenant_id = $1 and v.master_type = 'FUND_SOURCE' and r.business_key = 'NSTW' and v.status = 'EFFECTIVE' limit 1",
    [TENANT],
  );
  await sql(
    `insert into machvon.appropriation
       (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
     values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, $6::numeric, $7, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $8, $9, $9)`,
    [TENANT, id, fund?.id, year, String(amount * BILLION), String(allocated * BILLION), docId(1), membershipOf('capApprover'), membershipOf('owner')],
  );
  return id;
}

interface PlanSeed {
  code: string;
  year: number;
  revision: number;
  status: string;
  supersedes?: string;
  createdBy: string;
  submittedBy?: string;
  approvedBy?: string;
  published?: boolean;
}

async function seedPlanRow(seed: PlanSeed): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.capital_plan
       (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, supersedes_id, submitted_by, approved_by, decision_document_id, effective_at, published_at, published_by, created_by, updated_by)
     values ($1, $2, $3, 'ANNUAL', $4, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
    [
      TENANT,
      id,
      seed.code,
      seed.year,
      unitOf('CB-STC'),
      seed.revision,
      seed.status,
      seed.supersedes ?? null,
      seed.submittedBy === undefined ? null : membershipOf(seed.submittedBy),
      seed.approvedBy === undefined ? null : membershipOf(seed.approvedBy),
      seed.published === true ? docId(1) : null,
      seed.published === true ? '2026-01-15T00:00:00Z' : null,
      seed.published === true ? '2026-01-15T00:00:00Z' : null,
      seed.published === true ? membershipOf('planPublisher') : null,
      membershipOf(seed.createdBy),
    ],
  );
  return id;
}

async function seedLine(planId: string, status: string, project: string, appropriation: string, year: number, amount: number, previousLine: string | null = null, revision = 1): Promise<string> {
  const versionId = randomUUID();
  const lineId = randomUUID();
  const [source] = await sql<{ fund_source_version_id: string }>('select fund_source_version_id from machvon.appropriation where id = $1', [appropriation]);
  await sql(
    `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, decision_id, effective_at, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [TENANT, versionId, project, year, revision, status, planId, status === 'PUBLISHED' ? docId(1) : null, status === 'PUBLISHED' ? '2026-01-15T00:00:00Z' : null, membershipOf('planSubmitter')],
  );
  await sql(
    `insert into machvon.allocation_line
       (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, previous_line_id, created_by, updated_by)
     values ($1, $2, $3, $4, 'CURRENT_YEAR', $5, $6::numeric, 0, $7, $8, 'CENTRAL', 'PM_ASSIGNED', $9, $10, $10)`,
    [TENANT, lineId, versionId, source?.fund_source_version_id, year, String(amount), appropriation, project, previousLine, membershipOf('planSubmitter')],
  );
  return lineId;
}

/** A published plan with one line of `amount` dong, its balance (allocated, committed and disbursed in billions) and the ALLOCATE entry that explains it. */
async function seedPublished(label: string, year: number, amount: number, committed: number, disbursed: number): Promise<Seeded> {
  const appropriationId = await seedAppropriation(year, 20, amount / BILLION);
  const project = await seedProject(label);
  const planCode = `E2E-AF-${label}`;
  const planId = await seedPlanRow({ code: planCode, year, revision: 1, status: 'PUBLISHED', createdBy: 'planSubmitter', submittedBy: 'planSubmitter', approvedBy: 'planApprover', published: true });
  const lineId = await seedLine(planId, 'PUBLISHED', project.id, appropriationId, year, amount);
  await sql(
    `insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, reserved_vnd, committed_vnd, disbursed_vnd) values ($1, $2, $3, $4::numeric, 0, $5::numeric, $6::numeric)`,
    [TENANT, randomUUID(), lineId, String(amount), String(committed * BILLION), String(disbursed * BILLION)],
  );
  await sql(
    `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
     values ($1, $2, $3, $4, $5, 'ALLOCATE', $6::numeric, $7, 'CAPITAL_PLAN', $8, $9)`,
    [TENANT, randomUUID(), appropriationId, lineId, project.id, String(amount), year, planId, membershipOf('planPublisher')],
  );
  return { planId, planCode, year, appropriationId, projectId: project.id, projectCode: project.code, lineId };
}

/** A DRAFT revision of the published plan, the way the revision command of ST-CAP-004 leaves it: one copied line at the given amount, the ceiling counting the difference. */
async function seedRevision(base: Seeded, revision: number, amount: number): Promise<string> {
  const planId = await seedPlanRow({ code: base.planCode, year: base.year, revision, status: 'DRAFT', supersedes: base.planId, createdBy: 'planSubmitter' });
  await seedLine(planId, 'DRAFT', base.projectId, base.appropriationId, base.year, amount, base.lineId, revision);
  const [baseLine] = await sql<{ amount: string }>('select amount_vnd::text as amount from machvon.allocation_line where id = $1', [base.lineId]);
  const delta = BigInt(amount) - BigInt(baseLine?.amount ?? '0');
  await sql(`do $$ begin perform set_config('app.cap_allocation_write', 'on', true); update machvon.appropriation set allocated_total_vnd = allocated_total_vnd + ${delta} where id = '${base.appropriationId}'; end $$`);
  return planId;
}

/** A plan in review made and submitted by one person: the browser must not let them decide it. */
async function seedOwnReview(label: string, year: number, user: string): Promise<string> {
  const appropriationId = await seedAppropriation(year, 10, 1);
  const project = await seedProject(label);
  const planId = await seedPlanRow({ code: `E2E-AF-${label}`, year, revision: 1, status: 'IN_REVIEW', createdBy: user, submittedBy: user });
  await seedLine(planId, 'IN_REVIEW', project.id, appropriationId, year, BILLION);
  return planId;
}

const planRow = async (id: string) =>
  (
    await sql<{ status: string; version: string; submitted_by: string | null; approved_by: string | null; published_by: string | null; decision_document_id: string | null }>(
      'select status, version::text as version, submitted_by, approved_by, published_by, decision_document_id from machvon.capital_plan where id = $1',
      [id],
    )
  )[0];
const entriesOf = (planId: string) =>
  sql<{ entry_type: string; amount: string; allocation_line_id: string }>("select entry_type, amount_vnd::text as amount, allocation_line_id from machvon.capital_ledger_entry where source_ref_kind = 'CAPITAL_PLAN' and source_ref_id = $1 order by entry_type", [planId]);
const balanceOf = async (lineId: string) =>
  (await sql<{ allocated: string; committed: string; disbursed: string }>('select allocated_vnd::text as allocated, committed_vnd::text as committed, disbursed_vnd::text as disbursed from machvon.allocation_balance where allocation_line_id = $1', [lineId]))[0];
const eventsOf = (planId: string, type: string) => sql("select 1 from machvon.outbox_event where aggregate_id = $1 and type = $2", [planId, type]);

// ---- the screens ----------------------------------------------------------------------------------------------------------

const state = (page: Page): Locator => page.getByTestId('state');
const reasonField = (page: Page): Locator => field(page.getByRole('form', { name: vi['cap.approval.decide.title'] }), vi['cap.approval.reason.label']);

async function decide(page: Page, decision: 'approve' | 'return' | 'reject', reason: string): Promise<void> {
  await reasonField(page).fill(reason);
  await page.getByRole('button', { name: vi[`cap.approval.${decision}.action`] }).click();
}

async function publish(page: Page, document: number): Promise<void> {
  const publishing = page.getByRole('form', { name: vi['cap.approval.publish.title'] });
  await field(publishing, vi['cap.approval.document.label']).fill(docId(document));
  await publishing.getByRole('button', { name: vi['cap.approval.publish.action'] }).click();
}

test.describe('CAP-10 plan approval', () => {
  test('a revision goes from submission to publication by three different people; a line below what is committed is refused with the line listed, and the revision that fits replaces the plan in force (AC-ST-CAP-003-1, AC-ST-CAP-003-2)', async ({ page }) => {
    const year = 2041;
    const base = await seedPublished('FLOW', year, 10 * BILLION, 6, 3);
    const low = await seedRevision(base, 2, Math.round(8.5 * BILLION));
    const fits = await seedRevision(base, 3, 9 * BILLION);

    // The planner opens the revision that lowers the line to 8,500 million: the impact view already says it falls below the 9,000 spent.
    await open(page, 'planSubmitter', `/cap/cap-10?plan=${low}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.approval.page.title'] })).toBeVisible();
    await expect(state(page)).toHaveAttribute('data-status', 'DRAFT');
    await expect(page.getByTestId('impact').locator('tr[data-below="true"]')).toContainText(base.projectCode);
    await expect(page.getByTestId('total-delta').locator('.cap-negative')).toBeVisible();
    // A planner has no decision to take and nothing to publish.
    await expect(page.getByRole('button', { name: vi['cap.approval.approve.action'] })).toHaveCount(0);
    await page.getByRole('button', { name: vi['cap.approval.submit.action'] }).click();
    await expect(state(page)).toHaveAttribute('data-status', 'IN_REVIEW');
    expect(await planRow(low)).toMatchObject({ status: 'IN_REVIEW', submitted_by: membershipOf('planSubmitter'), approved_by: null });

    // A person whose role holds every step is refused on a plan they made and submitted themselves: the button is there, the server says no.
    const own = await seedOwnReview('OWN', 2042, 'planAll');
    await open(page, 'planAll', `/cap/cap-10?plan=${own}`);
    await decide(page, 'approve', 'Tôi tự duyệt kế hoạch của tôi');
    await expect(page.getByTestId('problem')).toHaveText(vi['cap.approvalProblem.selfApproval.error']);
    expect(await planRow(own)).toMatchObject({ status: 'IN_REVIEW', approved_by: null });

    // The approver needs a reason of five characters, then approves.
    await open(page, 'planApprover', `/cap/cap-10?plan=${low}`);
    await decide(page, 'approve', 'đủ');
    await expect(page.getByText(vi['cap.approval.reason.tooShort.error'])).toBeVisible();
    expect(await planRow(low)).toMatchObject({ status: 'IN_REVIEW' });
    await decide(page, 'approve', 'Đúng văn bản giao vốn');
    await expect(state(page)).toHaveAttribute('data-status', 'APPROVED');
    expect(await planRow(low)).toMatchObject({ status: 'APPROVED', approved_by: membershipOf('planApprover'), submitted_by: membershipOf('planSubmitter') });

    // The publisher publishes: the revision is below the floor, the answer lists the line and nothing is written.
    const before = (await entriesOf(low)).length;
    await open(page, 'planPublisher', `/cap/cap-10?plan=${low}`);
    await expect(page.getByText(vi['cap.approval.impact.below.error'].replace('{count}', '1'))).toBeVisible();
    await publish(page, 2);
    await expect(page.getByTestId('problem')).toContainText(vi['cap.approvalProblem.belowCommitted.error']);
    await expect(page.getByTestId('below-lines')).toContainText(base.projectCode);
    expect(await planRow(low)).toMatchObject({ status: 'APPROVED', decision_document_id: null });
    expect(await planRow(base.planId)).toMatchObject({ status: 'PUBLISHED' });
    expect((await entriesOf(low)).length).toBe(before);
    expect(await balanceOf(base.lineId)).toEqual({ allocated: String(10 * BILLION), committed: String(6 * BILLION), disbursed: String(3 * BILLION) });

    // The revision at 9,000 million goes through the same three people and replaces the plan in force.
    await open(page, 'planSubmitter', `/cap/cap-10?plan=${fits}`);
    await expect(page.getByTestId('impact').locator('tr[data-below="true"]')).toHaveCount(0);
    await page.getByRole('button', { name: vi['cap.approval.submit.action'] }).click();
    await expect(state(page)).toHaveAttribute('data-status', 'IN_REVIEW');
    await open(page, 'planApprover', `/cap/cap-10?plan=${fits}`);
    await decide(page, 'approve', 'Đúng văn bản giao vốn');
    await expect(state(page)).toHaveAttribute('data-status', 'APPROVED');
    await open(page, 'planPublisher', `/cap/cap-10?plan=${fits}`);
    await publish(page, 2);
    await expect(state(page)).toHaveAttribute('data-status', 'PUBLISHED');
    expect(await planRow(fits)).toMatchObject({ status: 'PUBLISHED', decision_document_id: docId(2), published_by: membershipOf('planPublisher') });
    expect(await planRow(base.planId)).toMatchObject({ status: 'SUPERSEDED' });
    expect(await entriesOf(fits)).toEqual([{ entry_type: 'REDUCE', amount: String(BILLION), allocation_line_id: expect.any(String) }]);
    const [moved] = await sql<{ id: string }>('select al.id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1', [fits]);
    expect(await balanceOf(moved?.id ?? '')).toEqual({ allocated: String(9 * BILLION), committed: String(6 * BILLION), disbursed: String(3 * BILLION) });
    expect(await balanceOf(base.lineId)).toBeUndefined();
    expect(await eventsOf(fits, 'capital.plan_published.v1')).toHaveLength(1);

    // The other revision was made from a plan that is no longer in force: it cannot be published over it.
    await open(page, 'planPublisher', `/cap/cap-10?plan=${low}`);
    await publish(page, 3);
    await expect(page.getByTestId('problem')).toHaveText(vi['cap.approvalProblem.planChanged.error']);
    expect(await planRow(low)).toMatchObject({ status: 'APPROVED' });

    // CAP-05 lists the decision that backs the plan in force, and the replaced plan stays with its note.
    await open(page, 'planReader', '/cap/cap-05');
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.decisions.page.title'] })).toBeVisible();
    const planRows = page.locator('tr[data-basis="PLAN"]');
    await expect(planRows.filter({ hasText: 'QD-E2E-2/2026' }).first()).toContainText(base.planCode);
    await expect(planRows.filter({ hasText: vi['cap.approval.superseded.label'] }).first()).toBeVisible();
  });

  test('someone who may not decide has no button, someone who only reads sees the plan in force; a plan in review is returned to its planner with the reason (AC-ST-CAP-003-1)', async ({ page }) => {
    const year = 2043;
    const base = await seedPublished('RETURN', year, 4 * BILLION, 0, 0);
    const revision = await seedRevision(base, 2, 5 * BILLION);
    await open(page, 'planSubmitter', `/cap/cap-10?plan=${revision}`);
    await page.getByRole('button', { name: vi['cap.approval.submit.action'] }).click();
    await expect(state(page)).toHaveAttribute('data-status', 'IN_REVIEW');

    // The planner holds no approval permission: the revision and its impact are shown, the decision is not offered.
    await expect(page.getByRole('button', { name: vi['cap.approval.approve.action'] })).toHaveCount(0);
    await expect(page.getByTestId('actions')).toContainText(vi['cap.approval.denied.notice']);
    await expect(page.getByTestId('impact')).toContainText(base.projectCode);
    // Someone who only reads sees the plan in force, never a revision in work, and has no step to take.
    await open(page, 'planReader', `/cap/cap-10?plan=${base.planId}`);
    await expect(state(page)).toHaveAttribute('data-status', 'PUBLISHED');
    for (const action of ['cap.approval.submit.action', 'cap.approval.approve.action', 'cap.approval.publish.action'] as const) await expect(page.getByRole('button', { name: vi[action] })).toHaveCount(0);
    await expect(page.getByTestId('actions')).toHaveCount(0);

    await open(page, 'planApprover', `/cap/cap-10?plan=${revision}`);
    await decide(page, 'return', 'Giữ nguyên số tiền cũ của dòng');
    await expect(state(page)).toHaveAttribute('data-status', 'DRAFT');
    await expect(page.getByTestId('returned')).toContainText('Giữ nguyên số tiền cũ của dòng');
    expect(await planRow(revision)).toMatchObject({ status: 'DRAFT', submitted_by: null });
    await expect(eventsOf(revision, 'capital.plan_decided.v1')).resolves.toHaveLength(1);
  });
});
