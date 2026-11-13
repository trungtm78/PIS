import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, Locator, Page } from '@playwright/test';
// The words of the edition under test: the enterprise overlay replaces some of the words these flows read (the national project code).
import { terms as vi } from './support/edition-terms.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CAP-01 (plans), CAP-02 (propose capital), CAP-03 (annual plan) and CAP-06 (allocation grid) in a real browser against the real API and
 * database (apps/api/test/e2e-stack): the planner creates a plan and proposes capital for projects from a published appropriation, the ceiling
 * of the source follows every line and holds against a second planner who took the capital first, two planners who save the same plan meet a
 * version conflict, the CTMTQG part stays inside its line, a planner of one unit sees and writes the projects of that unit only, and someone who
 * only reads cannot write. What the screens changed is looked up in the database.
 */

const TENANT = stackInfo().tenants.A;
/**
 * The edition the stack serves (MACHVON_EDITION, which the stack and the browser build both read, as in cap-flows). The enterprise pack has its own origins, one budget level, a kind of decision document and the classes
 * EQUITY, LOAN and OTHER in place of CURRENT_YEAR and CARRYOVER: an appropriation written for these flows carries the pack of the edition, or the screen (which opens on EQUITY) is refused "Trường bucket chưa hợp lệ".
 */
const ENTERPRISE = (process.env.MACHVON_EDITION ?? process.env.VITE_EDITION) === 'enterprise';
const PACK = ENTERPRISE
  ? { pack: 'ENTERPRISE', origin: 'GROUP_ASSIGNED', level: 'ALL', kind: 'GROUP_RESOLUTION', bucket: 'EQUITY' }
  : { pack: 'PUBLIC', origin: 'PM_ASSIGNED', level: 'CENTRAL', kind: null, bucket: 'CURRENT_YEAR' };
const BILLION = 1_000_000_000;

/** The decision documents the stack seeds in tenant A (apps/api/test/e2e-stack): 1 to 4. */
const docId = (n: number): string => `00000000-0000-4000-005d-${n.toString(16).padStart(12, '0')}`;

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function inNewPage(browser: Browser, user: string, path: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await open(page, user, path);
  return page;
}

// ---- what the database holds before a flow starts ------------------------------------------------------------------------

const unitOf = (code: string): string => stackInfo().units.A[code] as string;

/** A published appropriation of the NSTW source for a year, written the way a decision leaves it (the register has its own flows). */
async function seedAppropriation(year: number, amount: number, fundKey = 'NSTW'): Promise<string> {
  const id = randomUUID();
  const [fund] = await sql<{ id: string }>(
    "select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where v.tenant_id = $1 and v.master_type = 'FUND_SOURCE' and r.business_key = $2 and v.status = 'EFFECTIVE' limit 1",
    [TENANT, fundKey],
  );
  await sql(
    `insert into machvon.appropriation
       (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by, taxonomy_pack, decision_kind)
     values ($1, $2, $3, $4, $9, $10, $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8, $11, $12)`,
    [TENANT, id, fund?.id, year, String(amount * BILLION), docId(1), membershipOf('capApprover'), membershipOf('owner'), PACK.origin, PACK.level, PACK.pack, PACK.kind],
  );
  return id;
}

async function seedProject(label: string, unit = 'CB-SKHDT-QLDA'): Promise<{ id: string; code: string; name: string }> {
  const id = randomUUID();
  const code = `E2E-${label}`;
  const name = `Dự án thử ${label}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [TENANT]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
    [TENANT, id, code, name, unitOf(unit), area?.id, String(60000000 + Number.parseInt(id.slice(0, 6), 16)), membershipOf('owner')],
  );
  return { id, code, name };
}

async function seedPlan(code: string, year: number): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, created_by, updated_by)
     values ($1, $2, $3, 'ANNUAL', $4, $4, $4, $5, 1, 'DRAFT', $6, $6)`,
    [TENANT, id, code, year, unitOf('CB-STC'), membershipOf('planPlanner')],
  );
  return id;
}

/** A line the way the drafting command leaves it: the plan version of the project, the line, the allocated total of the source and the version of the plan. */
async function seedLine(planId: string, project: string, appropriation: string, year: number, amount: number, ctmtqg = 0): Promise<string> {
  const lineId = randomUUID();
  const versionRows = await sql<{ id: string }>('select id from machvon.plan_version where capital_plan_id = $1 and project_id = $2', [planId, project]);
  const versionId = versionRows[0]?.id ?? randomUUID();
  const [source] = await sql<{ fund_source_version_id: string; budget_level: string; origin: string }>('select fund_source_version_id, budget_level, origin from machvon.appropriation where id = $1', [appropriation]);
  if (versionRows[0] === undefined) {
    await sql(
      `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, created_by, updated_by) values ($1, $2, $3, $4, 1, 'DRAFT', $5, $6, $6)`,
      [TENANT, versionId, project, year, planId, membershipOf('planPlanner')],
    );
  }
  await sql(
    `insert into machvon.allocation_line
       (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, created_by, updated_by, taxonomy_pack)
     values ($1, $2, $3, $4, $13, $5, $6::numeric, $7::numeric, $8, $9, $10, $11, $12, $12, $14)`,
    [TENANT, lineId, versionId, source?.fund_source_version_id, year, String(amount * BILLION), String(ctmtqg), appropriation, project, source?.budget_level, source?.origin, membershipOf('planPlanner'), PACK.bucket, PACK.pack],
  );
  await sql(
    `begin; select set_config('app.cap_allocation_write', 'on', true); update machvon.appropriation set allocated_total_vnd = allocated_total_vnd + ${amount * BILLION} where id = '${appropriation}'; update machvon.capital_plan set version = version + 1 where id = '${planId}'; commit`,
  );
  return lineId;
}

const planRow = async (id: string) =>
  (await sql<{ status: string; version: string; created_by: string; plan_kind: string; scope_unit_id: string }>('select status, version::text as version, created_by, plan_kind, scope_unit_id from machvon.capital_plan where id = $1', [id]))[0];
const allocatedOf = async (id: string): Promise<string | undefined> => (await sql<{ allocated: string }>('select allocated_total_vnd::text as allocated from machvon.appropriation where id = $1', [id]))[0]?.allocated;
const linesOf = (planId: string) =>
  sql<{ id: string; project_id: string; amount: string; ctmtqg: string }>(
    `select al.id, al.project_id, al.amount_vnd::text as amount, al.ctmtqg_subset_vnd::text as ctmtqg from machvon.allocation_line al
       join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1 order by al.created_at, al.id`,
    [planId],
  );

// ---- the screens ----------------------------------------------------------------------------------------------------------

const form = (page: Page, title: string): Locator => page.getByRole('form', { name: title });
const field = (scope: Locator, label: string): Locator => scope.getByLabel(label, { exact: true });
const proposal = (page: Page): Locator => form(page, vi['cap.proposal.form.title']);
const money = (locator: Locator): Locator => locator.locator('.cap-money, .cap-negative').first();
const amountInput = (page: Page, code: string): Locator => page.getByLabel(`Số tiền của dự án ${code} (triệu đồng)`, { exact: true });
const lineRow = (page: Page, lineId: string): Locator => page.locator(`tr[data-line-id="${lineId}"]`);

async function propose(page: Page, project: { code: string; name: string }, year: number, remaining: string, amount: string): Promise<void> {
  const panel = proposal(page);
  await field(panel, vi['cap.proposal.project.label']).selectOption({ label: `${project.code} · ${project.name}` });
  await field(panel, vi['cap.proposal.source.label']).selectOption({ label: `NSTW · ${year} · còn ${remaining} triệu đồng` });
  await field(panel, vi['cap.proposal.amount.label']).fill(amount);
}

test.describe('CAP-01 and CAP-02: creating a plan and proposing capital', () => {
  test('the planner creates a plan and proposes capital; the ceiling follows, a larger amount is refused, and a planner who took the capital first leaves a refusal that says what is available (AC-ST-CAP-002-1, AC-ST-CAP-002-2)', async ({ page, browser }) => {
    const year = 2031;
    const source = await seedAppropriation(year, 10);
    const first = await seedProject('A1');
    const second = await seedProject('A2');
    const rival = await seedPlan('E2E-RIVAL-2031', year);

    // CAP-01: a plan is created as a draft, revision 1, by the person who made it.
    await open(page, 'planPlanner', '/cap/cap-01');
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.plans.page.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['cap.plans.create.action'] }).click();
    const creating = form(page, vi['cap.plans.form.title']);
    await creating.getByRole('button', { name: vi['cap.plans.form.submit.action'] }).click();
    await expect(creating.getByText(vi['cap.plans.required.error']).first()).toBeVisible();
    await field(creating, vi['cap.plans.code.label']).fill('E2E-AP-2031');
    await field(creating, vi['cap.plans.kind.label']).selectOption('ANNUAL');
    await field(creating, vi['cap.plans.year.label']).fill(String(year));
    await field(creating, vi['cap.plans.unit.label']).selectOption({ label: 'CB-STC · Sở Tài chính' });
    await creating.getByRole('button', { name: vi['cap.plans.form.submit.action'] }).click();
    await expect(page.getByTestId('created')).toBeVisible();
    const [created] = await sql<{ id: string }>("select id from machvon.capital_plan where plan_code = 'E2E-AP-2031'");
    const plan = created?.id ?? '';
    expect(await planRow(plan)).toMatchObject({ status: 'DRAFT', version: '1', created_by: membershipOf('planPlanner'), plan_kind: 'ANNUAL', scope_unit_id: unitOf('CB-STC') });
    // The same code again is refused.
    await page.getByRole('button', { name: vi['cap.plans.create.action'] }).click();
    const again = form(page, vi['cap.plans.form.title']);
    await field(again, vi['cap.plans.code.label']).fill('E2E-AP-2031');
    await field(again, vi['cap.plans.kind.label']).selectOption('ANNUAL');
    await field(again, vi['cap.plans.year.label']).fill(String(year));
    await field(again, vi['cap.plans.unit.label']).selectOption({ label: 'CB-STC · Sở Tài chính' });
    await again.getByRole('button', { name: vi['cap.plans.form.submit.action'] }).click();
    await expect(page.getByTestId('problem')).toHaveText(vi['cap.planProblem.codeDuplicate.error']);
    expect(await sql("select count(*)::int as n from machvon.capital_plan where plan_code = 'E2E-AP-2031'")).toEqual([{ n: 1 }]);

    // CAP-02: 3,000 million of the 10,000 million source for the first project.
    await open(page, 'planPlanner', `/cap/cap-02?plan=${plan}`);
    await expect(proposal(page)).toBeVisible();
    await propose(page, first, year, '10.000', '3000');
    await expect(page.getByTestId('exact-amount')).toHaveText(vi['cap.form.amountExact.text'].replace('{amount}', '3.000.000.000'));
    await expect(money(page.getByTestId('ceiling'))).toHaveAttribute('data-vnd', String(10 * BILLION));
    await proposal(page).getByRole('button', { name: vi['cap.proposal.submit.action'] }).click();
    await expect(page.getByTestId('saved')).toBeVisible();
    expect(await allocatedOf(source)).toBe(String(3 * BILLION));
    expect(await planRow(plan)).toMatchObject({ status: 'DRAFT', version: '2' });
    expect(await linesOf(plan)).toMatchObject([{ project_id: first.id, amount: String(3 * BILLION), ctmtqg: '0' }]);
    const audit = await sql<{ action: string; diff: { appropriations: Array<{ allocated_before_vnd: string; allocated_after_vnd: string }> } }>(
      "select action, safe_diff as diff from machvon.audit_event where resource_id = $1 and action = 'capital.plan_allocation_drafted'",
      [plan],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.diff.appropriations[0]).toMatchObject({ allocated_before_vnd: '0', allocated_after_vnd: String(3 * BILLION) });

    // An amount larger than what is left is refused on the screen, before anything is sent.
    await propose(page, second, year, '7.000', '8000');
    await expect(page.getByTestId('ceiling').locator('.cap-negative')).toBeVisible();
    await proposal(page).getByRole('button', { name: vi['cap.proposal.submit.action'] }).click();
    await expect(proposal(page).getByText(vi['cap.proposal.exceedsRemaining.error'])).toBeVisible();
    expect(await allocatedOf(source)).toBe(String(3 * BILLION));

    // 5,000 million fits what the screen read (7,000 left). Before it is sent, a second planner takes 5,000 million for another plan.
    await field(proposal(page), vi['cap.proposal.amount.label']).fill('5000');
    const rivalPage = await inNewPage(browser, 'planSecond', `/cap/cap-02?plan=${rival}`);
    await propose(rivalPage, second, year, '7.000', '5000');
    await proposal(rivalPage).getByRole('button', { name: vi['cap.proposal.submit.action'] }).click();
    await expect(rivalPage.getByTestId('saved')).toBeVisible();
    expect(await allocatedOf(source)).toBe(String(8 * BILLION));
    await rivalPage.context().close();

    // The first planner sends: exactly one of the two got the capital, the other is told what is available, and the ceiling holds.
    await proposal(page).getByRole('button', { name: vi['cap.proposal.submit.action'] }).click();
    await expect(page.getByTestId('problem')).toHaveText(vi['cap.planProblem.ceilingAvailable.error'].replace('{available}', '2.000.000.000'));
    expect(await allocatedOf(source)).toBe(String(8 * BILLION));
    expect(await planRow(plan)).toMatchObject({ version: '2' });
    expect(await linesOf(plan)).toHaveLength(1);
    expect(await linesOf(rival)).toMatchObject([{ project_id: second.id, amount: String(5 * BILLION) }]);
    // The allocated total of the source is exactly what its lines add up to.
    const added = await sql<{ lines: string }>('select coalesce(sum(amount_vnd), 0)::text as lines from machvon.allocation_line where appropriation_id = $1', [source]);
    expect(added[0]?.lines).toBe(await allocatedOf(source));
  });

  test('the CTMTQG part is inside its line: CAP-02 refuses a part larger than the amount, and CAP-03 totals the lines without adding it (AC-ST-CAP-002-3)', async ({ page }) => {
    test.skip(ENTERPRISE, 'the CTMTQG subset belongs to the public pack: the enterprise pack has no subset (the form has no such field, the API refuses a non-zero one)');
    const year = 2032;
    const nstw = await seedAppropriation(year, 10);
    const nsdp = await seedAppropriation(year, 5, 'NSDP');
    const project = await seedProject('B1');
    const plan = await seedPlan('E2E-CT-2032', year);
    await open(page, 'planPlanner', `/cap/cap-02?plan=${plan}`);
    await expect(proposal(page)).toBeVisible();
    await propose(page, project, year, '10.000', '1000');
    await field(proposal(page), vi['cap.proposal.ctmtqg.label']).fill('1001');
    await proposal(page).getByRole('button', { name: vi['cap.proposal.submit.action'] }).click();
    await expect(proposal(page).getByText(vi['cap.proposal.subsetExceeds.error'])).toBeVisible();
    expect(await linesOf(plan)).toEqual([]);
    await field(proposal(page), vi['cap.proposal.ctmtqg.label']).fill('400');
    await proposal(page).getByRole('button', { name: vi['cap.proposal.submit.action'] }).click();
    await expect(page.getByTestId('saved')).toBeVisible();
    // The other half of the fixture: 500 million NSDP for the same project.
    await seedLine(plan, project.id, nsdp, year, 0.5);
    expect(await linesOf(plan)).toHaveLength(2);
    expect(await allocatedOf(nstw)).toBe(String(BILLION));

    await open(page, 'planReader', `/cap/cap-03?plan=${plan}`);
    // A reader does not see a revision in work: the plan is a draft, so the screen offers it nowhere (it may show a published plan of another test instead).
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.annual.page.title'] })).toBeVisible();
    await expect(page.locator('#annual-plan').or(page.getByText(vi['states.empty.title']))).toBeVisible();
    await expect(page.getByText('E2E-CT-2032')).toHaveCount(0);
    await open(page, 'planPlanner', `/cap/cap-03?plan=${plan}`);
    await expect(page.getByTestId('lines')).toBeVisible();
    await expect(money(page.getByTestId('total'))).toHaveAttribute('data-vnd', String(1.5 * BILLION));
    await expect(money(page.getByTestId('total-ctmtqg'))).toHaveAttribute('data-vnd', '400000000');
    await expect(page.getByTestId('totals')).toContainText(vi['cap.annual.total.note']);
    const row = page.locator('tr[data-line-id]').filter({ hasText: 'NSTW' });
    await expect(money(row.getByTestId('ctmtqg'))).toHaveAttribute('data-vnd', '400000000');
  });
});

test.describe('CAP-06 allocation grid', () => {
  test('two planners who save the same plan: one wins and the other is told the plan moved on; the live remaining ceiling follows the amounts (AC-ST-CAP-002-6)', async ({ page, browser }) => {
    const year = 2033;
    const source = await seedAppropriation(year, 10);
    const first = await seedProject('C1');
    const second = await seedProject('C2');
    const plan = await seedPlan('E2E-GRID-2033', year);
    const firstLine = await seedLine(plan, first.id, source, year, 2);
    const secondLine = await seedLine(plan, second.id, source, year, 1);
    expect(await planRow(plan)).toMatchObject({ version: '3' });

    await open(page, 'planPlanner', `/cap/cap-06?plan=${plan}`);
    await expect(page.getByTestId('grid')).toBeVisible();
    await expect(amountInput(page, first.code)).toHaveValue('2000');
    await expect(money(lineRow(page, firstLine).getByTestId('available'))).toHaveAttribute('data-vnd', String(7 * BILLION));
    // The remaining ceiling follows the typing; an amount the source cannot hold is marked and cannot be saved.
    await amountInput(page, first.code).fill('9500');
    await expect(lineRow(page, firstLine).getByTestId('available')).toHaveAttribute('data-exceeded', 'true');
    await expect(page.getByRole('button', { name: vi['cap.grid.save.action'] })).toBeDisabled();
    await amountInput(page, first.code).fill('2000');
    await expect(page.getByRole('button', { name: vi['cap.grid.save.action'] })).toBeDisabled();

    // The second planner opens the same version, changes a line and saves first.
    const rival = await inNewPage(browser, 'planSecond', `/cap/cap-06?plan=${plan}`);
    await amountInput(rival, first.code).fill('2500');
    await rival.getByRole('button', { name: vi['cap.grid.save.action'] }).click();
    await expect(rival.getByTestId('saved')).toBeVisible();
    await rival.context().close();
    expect(await planRow(plan)).toMatchObject({ version: '4' });
    expect(await allocatedOf(source)).toBe(String(3.5 * BILLION));

    // The first planner saves a change of the other line on the version they read: the server refuses it and nothing is lost silently.
    await amountInput(page, second.code).fill('1500');
    await page.getByRole('button', { name: vi['cap.grid.save.action'] }).click();
    await expect(page.getByTestId('problem')).toHaveText(vi['cap.planProblem.versionConflict.error']);
    expect((await linesOf(plan)).find((line) => line.id === secondLine)?.amount).toBe(String(BILLION));
    expect(await allocatedOf(source)).toBe(String(3.5 * BILLION));

    // After a reload the planner sees the other planner's amount and saves again.
    await open(page, 'planPlanner', `/cap/cap-06?plan=${plan}`);
    await expect(amountInput(page, first.code)).toHaveValue('2500');
    await amountInput(page, second.code).fill('1500');
    await page.getByRole('button', { name: vi['cap.grid.save.action'] }).click();
    await expect(page.getByTestId('saved')).toBeVisible();
    expect(await planRow(plan)).toMatchObject({ version: '5' });
    expect(await allocatedOf(source)).toBe(String(4 * BILLION));
    expect((await linesOf(plan)).find((line) => line.id === secondLine)?.amount).toBe(String(1.5 * BILLION));
    // Each saved draft left one audit row; the refused save left none.
    expect(await sql("select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = 'capital.plan_allocation_drafted'", [plan])).toEqual([{ n: 2 }]);

    // A line is removed with the capital it held.
    await lineRow(page, firstLine).getByRole('button', { name: vi['cap.grid.remove.action'] }).click();
    await expect(money(lineRow(page, secondLine).getByTestId('available'))).toHaveAttribute('data-vnd', String(8.5 * BILLION));
    await page.getByRole('button', { name: vi['cap.grid.save.action'] }).click();
    await expect(page.getByTestId('saved')).toBeVisible();
    expect(await linesOf(plan)).toHaveLength(1);
    expect(await allocatedOf(source)).toBe(String(1.5 * BILLION));

    // The last line goes too: a command that only removes sends no line (CR-CAP-01), and the plan is left empty with the whole source free.
    await lineRow(page, secondLine).getByRole('button', { name: vi['cap.grid.remove.action'] }).click();
    await page.getByRole('button', { name: vi['cap.grid.save.action'] }).click();
    await expect(page.getByTestId('no-lines')).toBeVisible();
    expect(await linesOf(plan)).toEqual([]);
    expect(await allocatedOf(source)).toBe('0');
    expect(await sql('select 1 from machvon.plan_version where capital_plan_id = $1', [plan])).toEqual([]);
  });

  test('a year that is locked turns every write off (UAT-AC230)', async ({ page }) => {
    const year = 2034;
    const source = await seedAppropriation(year, 10);
    const project = await seedProject('D1');
    const plan = await seedPlan('E2E-LOCK-2034', year);
    await seedLine(plan, project.id, source, year, 2);
    await open(page, 'planPlanner', `/cap/cap-06?plan=${plan}`);
    await expect(amountInput(page, project.code)).toHaveValue('2000');
    await sql(`insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by) values ('${TENANT}', gen_random_uuid(), ${year}, 'LOCKED', now(), '${membershipOf('owner')}', '${membershipOf('owner')}', '${membershipOf('owner')}')`);
    await amountInput(page, project.code).fill('2500');
    await page.getByRole('button', { name: vi['cap.grid.save.action'] }).click();
    await expect(page.getByTestId('year-locked')).toHaveText(vi['cap.yearLocked.banner']);
    await expect(page.getByTestId('problem')).toHaveText(vi['cap.planProblem.yearLocked.error']);
    await expect(page.getByRole('button', { name: vi['cap.grid.save.action'] })).toHaveCount(0);
    await expect(amountInput(page, project.code)).toHaveCount(0);
    expect(await allocatedOf(source)).toBe(String(2 * BILLION));
  });
});

test.describe('scope and read only', () => {
  test('a planner of one unit sees and writes the projects of that unit only, and is offered no unit above it (AC-ST-CAP-002-5)', async ({ page }) => {
    const year = 2035;
    const source = await seedAppropriation(year, 10);
    const inside = await seedProject('E1', 'CB-SKHDT-QLDA');
    const outside = await seedProject('E2', 'CB-SKHDT-VP');
    const plan = await seedPlan('E2E-SCOPE-2035', year);
    const insideLine = await seedLine(plan, inside.id, source, year, 2);
    const outsideLine = await seedLine(plan, outside.id, source, year, 1);

    await open(page, 'planScoped', `/cap/cap-06?plan=${plan}`);
    await expect(page.getByTestId('grid')).toBeVisible();
    await expect(lineRow(page, insideLine)).toBeVisible();
    await expect(lineRow(page, outsideLine)).toHaveCount(0);
    await expect(page.getByTestId('total').locator('.cap-money')).toHaveAttribute('data-vnd', String(2 * BILLION));
    await amountInput(page, inside.code).fill('2500');
    await page.getByRole('button', { name: vi['cap.grid.save.action'] }).click();
    await expect(page.getByTestId('saved')).toBeVisible();
    expect((await linesOf(plan)).find((line) => line.id === outsideLine)?.amount).toBe(String(BILLION));

    // The projects of the rest of the Department are not offered to name on CAP-02.
    await open(page, 'planScoped', `/cap/cap-02?plan=${plan}`);
    const options = field(proposal(page), vi['cap.proposal.project.label']).locator('option');
    await expect(options.filter({ hasText: inside.code })).toHaveCount(1);
    await expect(options.filter({ hasText: outside.code })).toHaveCount(0);

    // Only the unit of the planner is offered for a new plan: the Department above it is not theirs.
    await open(page, 'planScoped', '/cap/cap-01');
    await page.getByRole('button', { name: vi['cap.plans.create.action'] }).click();
    const creating = form(page, vi['cap.plans.form.title']);
    const units = field(creating, vi['cap.plans.unit.label']).locator('option');
    await expect(units.filter({ hasText: 'CB-SKHDT-QLDA' })).toHaveCount(1);
    await expect(units.filter({ hasText: 'CB-STC' })).toHaveCount(0);
    await field(creating, vi['cap.plans.code.label']).fill('E2E-OWN-2035');
    await field(creating, vi['cap.plans.kind.label']).selectOption('ANNUAL');
    await field(creating, vi['cap.plans.year.label']).fill(String(year));
    await field(creating, vi['cap.plans.unit.label']).selectOption({ label: 'CB-SKHDT-QLDA · Ban Quản lý dự án' });
    await creating.getByRole('button', { name: vi['cap.plans.form.submit.action'] }).click();
    await expect(page.getByTestId('created')).toBeVisible();
    expect(await sql<{ scope_unit_id: string }>("select scope_unit_id from machvon.capital_plan where plan_code = 'E2E-OWN-2035'")).toEqual([{ scope_unit_id: unitOf('CB-SKHDT-QLDA') }]);
  });

  test('someone who only reads sees the plans in force and no control to write; someone without the read permission is refused', async ({ page }) => {
    const year = 2036;
    const source = await seedAppropriation(year, 10);
    const project = await seedProject('F1');
    const draft = await seedPlan('E2E-READ-DRAFT-2036', year);
    await seedLine(draft, project.id, source, year, 1);
    const published = await seedPlan('E2E-READ-PUBLISHED-2036', year);
    await seedLine(published, project.id, source, year, 2);
    await sql(
      `begin; update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = '${membershipOf('planPlanner')}' where id = '${published}';
        update machvon.capital_plan set status = 'APPROVED', approved_by = '${membershipOf('capApprover')}' where id = '${published}';
        update machvon.capital_plan set status = 'PUBLISHED', decision_document_id = '${docId(2)}', effective_at = now(), published_at = now() where id = '${published}'; commit`,
    );
    const before = await sql<{ n: number }>('select count(*)::int as n from machvon.allocation_line');

    await open(page, 'planReader', '/cap/cap-01');
    await page.getByLabel(vi['cap.plans.kind.label'], { exact: true }).selectOption('');
    await expect(page.locator(`tr[data-plan-id="${published}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-plan-id="${draft}"]`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['cap.plans.create.action'] })).toHaveCount(0);

    await open(page, 'planReader', `/cap/cap-06?plan=${published}`);
    await expect(page.getByTestId('grid')).toBeVisible();
    await expect(page.getByTestId('not-draft')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['cap.grid.save.action'] })).toHaveCount(0);
    await expect(page.locator('tr[data-line-id] input')).toHaveCount(0);

    // A revision in work does not exist for the reader, by its address either.
    await open(page, 'planReader', `/cap/cap-06?plan=${draft}`);
    await expect(page.getByTestId('plan-header')).not.toContainText('E2E-READ-DRAFT-2036');

    await open(page, 'nobody', '/cap/cap-03');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    expect(await sql<{ n: number }>('select count(*)::int as n from machvon.allocation_line')).toEqual(before);
  });
});
