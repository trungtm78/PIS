import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * CAP-07 (adjustment and transfer) and CAP-15 (plan tracking) in a real browser against the real API and database (apps/api/test/e2e-stack): the
 * planner asks for a revision of the plan in force with a reason, the lines are copied into a draft that cannot be doubled, the revision shows the
 * capital it moves from one project to another with the same total on both sides, and the plan can be read as it stood on a day: 30/6 gives the first
 * revision and its decision, 2/7 the second. A reader has no button, a planner of one unit sees the lines of that unit only. What the screens
 * changed is looked up in the database. The lines of the revision are edited on CAP-06 (cap-plan-flows.spec.ts); here they are set in the database.
 */

const TENANT = stackInfo().tenants.A;
const BILLION = 1_000_000_000;
/** The decision documents the stack seeds in tenant A (apps/api/test/e2e-stack): 1 to 4. */
const docId = (n: number): string => `00000000-0000-4000-005d-${n.toString(16).padStart(12, '0')}`;
const unitOf = (code: string): string => stackInfo().units.A[code] as string;

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function seedProject(label: string, unit = 'CB-SKHDT-QLDA'): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = `E2E-RV-${label}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [TENANT]);
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
    [TENANT, id, code, `Dự án thử ${label}`, unitOf(unit), area?.id, String(7000000 + (Number.parseInt(id.slice(0, 6), 16) % 2000000)), membershipOf('owner')],
  );
  return { id, code };
}

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
    [TENANT, id, fund?.id, year, String(amount * BILLION), String(allocated), docId(1), membershipOf('planApprover'), membershipOf('owner')],
  );
  return id;
}

interface PlanSeed {
  code: string;
  year: number;
  revision: number;
  status: 'PUBLISHED' | 'SUPERSEDED' | 'DRAFT';
  supersedes?: string;
  document?: number;
  effectiveAt?: string;
}

async function seedPlanRow(seed: PlanSeed): Promise<string> {
  const id = randomUUID();
  const inForce = seed.status !== 'DRAFT';
  await sql(
    `insert into machvon.capital_plan
       (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, supersedes_id, submitted_by, approved_by, decision_document_id, effective_at, published_at, published_by, created_by, updated_by)
     values ($1, $2, $3, 'ANNUAL', $4, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $14)`,
    [
      TENANT,
      id,
      seed.code,
      seed.year,
      unitOf('CB-STC'),
      seed.revision,
      seed.status,
      seed.supersedes ?? null,
      inForce ? membershipOf('planSubmitter') : null,
      inForce ? membershipOf('planApprover') : null,
      inForce ? docId(seed.document ?? 1) : null,
      inForce ? (seed.effectiveAt ?? '2026-01-15T00:00:00Z') : null,
      inForce ? membershipOf('planPublisher') : null,
      membershipOf('planSubmitter'),
    ],
  );
  return id;
}

async function seedLine(planId: string, status: string, project: string, appropriation: string, year: number, amount: number, previousLine: string | null, revision: number, effectiveAt = '2026-01-15T00:00:00Z'): Promise<string> {
  const versionId = randomUUID();
  const lineId = randomUUID();
  const [source] = await sql<{ fund_source_version_id: string }>('select fund_source_version_id from machvon.appropriation where id = $1', [appropriation]);
  await sql(
    `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, decision_id, effective_at, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [TENANT, versionId, project, year, revision, status, planId, status === 'DRAFT' ? null : docId(1), status === 'DRAFT' ? null : effectiveAt, membershipOf('planSubmitter')],
  );
  await sql(
    `insert into machvon.allocation_line
       (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, previous_line_id, created_by, updated_by)
     values ($1, $2, $3, $4, 'CURRENT_YEAR', $5, $6::numeric, 0, $7, $8, 'CENTRAL', 'PM_ASSIGNED', $9, $10, $10)`,
    [TENANT, lineId, versionId, source?.fund_source_version_id, year, String(amount), appropriation, project, previousLine, membershipOf('planSubmitter')],
  );
  return lineId;
}

interface Published {
  code: string;
  year: number;
  /** Revision 1 (in force from 15/1, replaced on 1/7) and revision 2 (in force from 1/7). */
  first: string;
  second: string;
  inside: { id: string; code: string };
  outside: { id: string; code: string };
}

/**
 * CP-2044, the plan of the story: revision 1 gave the project of the Management Board 5 billion and the project of the Department office 1 billion;
 * revision 2 (from 1 July) moved 0.8 billion from the first to the second. The ceiling holds the difference only, as the publication leaves it.
 */
async function seedHistory(label: string, year: number): Promise<Published> {
  const source = await seedAppropriation(year, 20, 6 * BILLION);
  const inside = await seedProject(`${label}-IN`);
  const outside = await seedProject(`${label}-OUT`, 'CB-SKHDT-VP');
  const code = `E2E-RV-${label}`;
  const first = await seedPlanRow({ code, year, revision: 1, status: 'SUPERSEDED', document: 1, effectiveAt: '2026-01-15T00:00:00Z' });
  const insideFirst = await seedLine(first, 'SUPERSEDED', inside.id, source, year, 5 * BILLION, null, 1);
  const outsideFirst = await seedLine(first, 'SUPERSEDED', outside.id, source, year, BILLION, null, 1);
  const second = await seedPlanRow({ code, year, revision: 2, status: 'PUBLISHED', supersedes: first, document: 2, effectiveAt: '2026-07-01T00:00:00Z' });
  await seedLine(second, 'PUBLISHED', inside.id, source, year, 4.2 * BILLION, insideFirst, 2, '2026-07-01T00:00:00Z');
  await seedLine(second, 'PUBLISHED', outside.id, source, year, 1.8 * BILLION, outsideFirst, 2, '2026-07-01T00:00:00Z');
  return { code, year, first, second, inside, outside };
}

/** A plan in force with two lines, and nothing else: the one a revision is asked for. */
async function seedInForce(label: string, year: number): Promise<{ planId: string; code: string; projects: [string, string]; codes: [string, string] }> {
  const source = await seedAppropriation(year, 20, 6 * BILLION);
  const a = await seedProject(`${label}-A`);
  const b = await seedProject(`${label}-B`);
  const code = `E2E-RV-${label}`;
  const planId = await seedPlanRow({ code, year, revision: 1, status: 'PUBLISHED', document: 1 });
  await seedLine(planId, 'PUBLISHED', a.id, source, year, 5 * BILLION, null, 1);
  await seedLine(planId, 'PUBLISHED', b.id, source, year, BILLION, null, 1);
  return { planId, code, projects: [a.id, b.id], codes: [a.code, b.code] };
}

const planRow = async (id: string) => (await sql<{ status: string; version: string; revision: number; supersedes_id: string | null; created_by: string }>('select status, version::text as version, revision, supersedes_id, created_by from machvon.capital_plan where id = $1', [id]))[0];
const revisionsOf = (planId: string) => sql<{ id: string; status: string; revision: number }>('select id, status, revision from machvon.capital_plan where supersedes_id = $1 order by revision', [planId]);
const linesOf = (planId: string) =>
  sql<{ id: string; project_id: string; amount: string; previous_line_id: string | null }>(
    'select al.id, al.project_id, al.amount_vnd::text as amount, al.previous_line_id from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1 order by al.amount_vnd desc',
    [planId],
  );

const dayField = (page: Page) => page.getByLabel(vi['cap.tracking.date.label'], { exact: true });
const rowOf = (page: Page, code: string) => page.locator('tbody tr', { hasText: code });

test.describe('CAP-07 adjustment', () => {
  test('the planner asks for a revision with a reason: the lines are copied into a draft, a second one is refused, and the capital it moves is shown with the same total on both sides (AC-ST-CAP-004-2, AC-ST-CAP-004-3)', async ({ page }) => {
    const base = await seedInForce('REVISE', 2044);
    await open(page, 'planSubmitter', `/cap/cap-07?plan=${base.planId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.adjustment.page.title'] })).toBeVisible();
    await expect(page.getByTestId('plan-header')).toHaveAttribute('data-plan-id', base.planId);

    // A short reason is refused before anything is sent.
    const reason = page.getByLabel(vi['cap.adjustment.reason.label'], { exact: true });
    await reason.fill('ngắn');
    await page.getByRole('button', { name: vi['cap.adjustment.revise.action'] }).click();
    await expect(page.getByText(vi['cap.adjustment.reason.tooShort.error'])).toBeVisible();
    expect(await revisionsOf(base.planId)).toEqual([]);

    await reason.fill('Điều chuyển 0,8 tỷ sang dự án khác theo văn bản mới');
    await page.getByRole('button', { name: vi['cap.adjustment.revise.action'] }).click();
    await expect(page.getByTestId('created')).toBeVisible();
    const [revision] = await revisionsOf(base.planId);
    expect(revision).toMatchObject({ status: 'DRAFT', revision: 2 });
    expect(await planRow(revision?.id ?? '')).toMatchObject({ status: 'DRAFT', version: '1', supersedes_id: base.planId, created_by: membershipOf('planSubmitter') });
    expect(await planRow(base.planId)).toMatchObject({ status: 'PUBLISHED' });
    const copied = await linesOf(revision?.id ?? '');
    expect(copied.map((line) => line.amount)).toEqual([String(5 * BILLION), String(BILLION)]);
    expect(copied.every((line) => line.previous_line_id !== null)).toBe(true);
    await expect(sql("select 1 from machvon.audit_event where resource_id = $1 and action = 'capital.plan_revision_created'", [revision?.id ?? ''])).resolves.toHaveLength(1);

    // The plan in force now has a revision in work: the screen says so instead of offering a second one (the server would answer 409).
    await open(page, 'planSubmitter', `/cap/cap-07?plan=${base.planId}`);
    await expect(page.getByTestId('revise-state')).toHaveAttribute('data-state', 'pending');
    await expect(page.getByRole('button', { name: vi['cap.adjustment.revise.action'] })).toHaveCount(0);
    expect(await revisionsOf(base.planId)).toHaveLength(1);

    // The planner moves 0.8 billion from the first project to the second (CAP-06 does this; here the lines are set directly).
    const [from, to] = copied;
    await sql(
      `do $$ begin perform set_config('app.cap_allocation_write', 'on', true);
         update machvon.allocation_line set amount_vnd = amount_vnd - 800000000 where id = '${from?.id}';
         update machvon.allocation_line set amount_vnd = amount_vnd + 800000000 where id = '${to?.id}'; end $$`,
    );
    await open(page, 'planSubmitter', `/cap/cap-07?plan=${revision?.id}`);
    await expect(page.getByTestId('transfer')).toBeVisible();
    await expect(page.getByTestId('balance')).toHaveAttribute('data-balanced', 'true');
    await expect(page.getByTestId('side-down').locator('[data-testid="value"] .cap-money')).toHaveAttribute('data-vnd', '800000000');
    await expect(page.getByTestId('side-up').locator('[data-testid="value"] .cap-money')).toHaveAttribute('data-vnd', '800000000');
    await expect(page.getByTestId('side-down')).toContainText(base.codes[0]);
    await expect(page.getByTestId('side-up')).toContainText(base.codes[1]);
  });

  test('someone who may not draft plans is told so and sees no button, and a second request while one is in work is refused by the server (AC-ST-CAP-004-3)', async ({ page }) => {
    const base = await seedInForce('DENIED', 2045);
    await open(page, 'planReader', `/cap/cap-07?plan=${base.planId}`);
    await expect(page.getByTestId('revise-state')).toHaveAttribute('data-state', 'denied');
    await expect(page.getByRole('button', { name: vi['cap.adjustment.revise.action'] })).toHaveCount(0);

    // Two planners hold the screen at the same time: the second one's request meets the revision of the first.
    await open(page, 'planPlanner', `/cap/cap-07?plan=${base.planId}`);
    const reason = page.getByLabel(vi['cap.adjustment.reason.label'], { exact: true });
    await reason.fill('Điều chỉnh theo quyết định mới của UBND');
    await sql(
      `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, supersedes_id, created_by, updated_by)
       values ($1, $2, $3, 'ANNUAL', 2045, 2045, 2045, $4, 2, 'DRAFT', $5, $6, $6)`,
      [TENANT, randomUUID(), base.code, unitOf('CB-STC'), base.planId, membershipOf('planSecond')],
    );
    await page.getByRole('button', { name: vi['cap.adjustment.revise.action'] }).click();
    await expect(page.getByTestId('problem')).toHaveAttribute('data-problem', 'pending');
    await expect(page.getByTestId('problem')).toHaveText(vi['cap.adjustment.pending.error']);
    expect(await revisionsOf(base.planId)).toHaveLength(1);
  });
});

test.describe('CAP-15 plan tracking', () => {
  test('reads the plan as it stood on a day: 30/6 is the first revision with its decision, 2/7 the second; before the first there is nothing in force (AC-ST-CAP-004-1, AC-ST-CAP-004-2)', async ({ page }) => {
    const plan = await seedHistory('TRACK', 2046);
    await open(page, 'planReader', `/cap/cap-15?plan=${plan.second}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['cap.tracking.page.title'] })).toBeVisible();

    // Now: the second revision. The project of the Board went from 5 billion to 4.2 (-0.8), the other from 1 to 1.8 (+0.8): the total did not move.
    await expect(page.getByTestId('tracking')).toHaveAttribute('data-revision', '2');
    await expect(rowOf(page, plan.inside.code).getByTestId('initial').locator('.cap-money')).toHaveAttribute('data-vnd', String(5 * BILLION));
    await expect(rowOf(page, plan.inside.code).getByTestId('adjustment')).toContainText('-');
    await expect(rowOf(page, plan.inside.code).getByTestId('current').locator('.cap-money')).toHaveAttribute('data-vnd', String(4.2 * BILLION));
    await expect(rowOf(page, plan.outside.code).getByTestId('current').locator('.cap-money')).toHaveAttribute('data-vnd', String(1.8 * BILLION));
    await expect(page.getByTestId('total-adjustment').locator('.cap-money')).toHaveAttribute('data-vnd', '0');
    await expect(page.getByTestId('total-current').locator('.cap-money')).toHaveAttribute('data-vnd', String(6 * BILLION));

    await dayField(page).fill('2026-06-30');
    await expect(page.getByTestId('tracking')).toHaveAttribute('data-revision', '1');
    await expect(rowOf(page, plan.inside.code).getByTestId('current').locator('.cap-money')).toHaveAttribute('data-vnd', String(5 * BILLION));
    await expect(rowOf(page, plan.inside.code).getByTestId('decision')).toContainText('QD-E2E-1/2026');
    await expect(rowOf(page, plan.outside.code).getByTestId('current').locator('.cap-money')).toHaveAttribute('data-vnd', String(BILLION));

    await dayField(page).fill('2026-07-02');
    await expect(page.getByTestId('tracking')).toHaveAttribute('data-revision', '2');
    await expect(rowOf(page, plan.inside.code).getByTestId('decision')).toContainText('QD-E2E-2/2026');

    await dayField(page).fill('2026-01-14');
    await expect(page.getByTestId('nothing')).toHaveText(vi['cap.tracking.none.notice']);
  });

  test('a planner of one unit sees the lines of that unit only (AC-ST-CAP-004-4)', async ({ page }) => {
    const plan = await seedHistory('SCOPE', 2047);
    await open(page, 'planScoped', `/cap/cap-15?plan=${plan.second}`);
    await expect(page.getByTestId('tracking')).toBeVisible();
    await expect(rowOf(page, plan.inside.code)).toHaveCount(1);
    await expect(rowOf(page, plan.outside.code)).toHaveCount(0);
    await expect(page.getByTestId('tracking')).toContainText(vi['cap.tracking.scope.notice']);
  });
});
