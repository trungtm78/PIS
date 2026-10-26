import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * LND-05 (the plans of compensation, support and resettlement) in a real browser against the real API and database (apps/api/test/e2e-stack): an officer drafts a plan, adds a compensation counted from a
 * confirmed record of the inventory (the amount is the amount of the record, with the price decision it was counted by) and a support, the totals are the sums of the items; a record that is not confirmed is not
 * offered; a plan that was posted is revised into a new revision that takes its items, and the earlier revision stays readable as replaced; a reader sees the plans and no button.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const DECISION = 'QD-GIA-PLAN-E2E';
const POLICY = 'Nghị định 88/2024/NĐ-CP, Điều 21';
const BASIS = 'Luật Đất đai 2024, Điều 91';

interface Seeded {
  projectId: string;
  householdId: string;
  householdCode: string;
  confirmedId: string;
  draftId: string;
}

async function priceDecision(): Promise<void> {
  const tenant = stackInfo().tenants.A;
  const officer = membershipOf('landPlanWriter');
  const [existing] = await sql<{ id: string }>("select id from machvon.master_record where tenant_id = $1 and master_type = 'LND_PRICE_DECISION' and business_key = $2", [tenant, DECISION]);
  if (existing !== undefined) return;
  const record = randomUUID();
  await sql(
    `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, steward_membership_id, created_by, updated_by)
     values ($1, $2, 'TENANT', 'LND_PRICE_DECISION', $3, 'EFFECTIVE', $4, $4, $4)`,
    [tenant, record, DECISION, officer],
  );
  await sql(
    `insert into machvon.master_record_version
       (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, valid_until, status, namespace, content_sha256, published_at, created_by, updated_by)
     values ($1, $2, $3, 'LND_PRICE_DECISION', $4, 1, $4, $5::jsonb, date '2024-01-01', null, 'EFFECTIVE', 'TENANT', repeat('d', 64), now(), $6, $6)`,
    [tenant, randomUUID(), record, DECISION, JSON.stringify({ title: `Decision ${DECISION}` }), officer],
  );
}

/** A project with a household of the unit that holds a right on a parcel, and two records of the inventory of it: one the household confirmed and one nobody confirmed. */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('landPlanWriter');
  const checker = membershipOf('inventoryChecker');
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const projectId = randomUUID();
  const code = `E2E-PLN-${Date.now().toString(36).toUpperCase()}-${projectId.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, code, `Dự án GPMB ${code}`, unit, area?.id, officer],
  );
  const parcelId = randomUUID();
  await sql(
    `insert into machvon.land_parcel (tenant_id, id, project_id, owner_unit_id, parcel_code, land_use_group, area_total_m2, area_affected_m2, status, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'AGRICULTURAL', 1000, 500, 'SURVEYED', 1, $6, $6)`,
    [tenant, parcelId, projectId, unit, `PL-P-${projectId.slice(0, 6).toUpperCase()}`, officer],
  );
  const householdId = randomUUID();
  const householdCode = `HH-P${projectId.slice(0, 5).toUpperCase()}`;
  await sql(
    `insert into machvon.affected_household
       (tenant_id, id, project_id, owner_unit_id, household_code, head_name, head_name_enc, legal_basis, legal_basis_ref, retention_until, status, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'N***** V** A', decode('00', 'hex'), 'PUBLIC_TASK_LAND_LAW', 'Luật Đất đai 2024, Điều 87', date '2036-12-31', 'REGISTERED', 1, $6, $6)`,
    [tenant, householdId, projectId, unit, householdCode, officer],
  );
  await sql(
    `insert into machvon.household_parcel (tenant_id, id, household_id, parcel_id, owner_unit_id, right_kind, share_pct, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'OWNER', 100, $6, $6)`,
    [tenant, randomUUID(), householdId, parcelId, unit, officer],
  );
  await priceDecision();
  const record = async (quantity: string): Promise<string> => {
    const id = randomUUID();
    await sql(
      `insert into machvon.land_inventory_record
         (tenant_id, id, household_id, parcel_id, owner_unit_id, item_kind, description, quantity, unit_code, unit_price_vnd, amount_vnd, price_decision_ref, surveyed_on, surveyed_by, status, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, 'HOUSE', 'Nhà cấp 4', $6::numeric, 'M2', 4500000, round($6::numeric * 4500000), $7, date '2026-06-20', $8, 'DRAFT', $8, $8, 1)`,
      [tenant, id, householdId, parcelId, unit, quantity, DECISION, officer],
    );
    return id;
  };
  const confirmedId = await record('80');
  await sql("update machvon.land_inventory_record set status = 'CONFIRMED', household_confirmed_on = date '2026-07-01', confirmed_by = $2, confirmed_at = now(), version = 2 where id = $1", [confirmedId, checker]);
  const draftId = await record('10');
  return { projectId, householdId, householdCode, confirmedId, draftId };
}

async function open(page: Page, user: string, aim: Seeded): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/lnd/lnd-05?project=${aim.projectId}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

test.describe('LND-05: the plans of compensation, support and resettlement', () => {
  test('an officer drafts a plan, composes it from a confirmed record and a policy, revises it after it was posted, and the earlier revision stays readable (AC-ST-LND-005-1, AC-ST-LND-005-2, UAT-AC382, UAT-PLAN-30, UI-LND-05)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'landPlanWriter', aim);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.plans.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-match')).toHaveText(vi['lnd.plans.empty.notice']);

    // The plan is drafted: a code, the executor and its kind.
    await page.getByRole('button', { name: vi['lnd.plans.draft.action'] }).click();
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error']).first()).toBeVisible();
    await page.getByLabel(vi['lnd.plans.draftDialog.code.label'], { exact: true }).fill('PA-E2E');
    await page.getByLabel(vi['lnd.plans.draftDialog.unit.label'], { exact: true }).selectOption({ index: 1 });
    await page.getByLabel(vi['lnd.plans.draftDialog.kind.label'], { exact: true }).selectOption('LAND_FUND_CENTRE');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    const row = page.locator('[data-plan-id]').first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.draft.label']);
    await expect(row.getByTestId('total-grand')).toHaveText('0');

    // A compensation rests on a record the household confirmed: the one nobody confirmed is not offered, and the amount is the amount of the record.
    await row.getByRole('button', { name: vi['lnd.plans.items.action'] }).click();
    await page.getByLabel(vi['lnd.plans.itemDialog.household.label'], { exact: true }).selectOption({ index: 1 });
    await page.getByLabel(vi['lnd.plans.itemDialog.kind.label'], { exact: true }).selectOption('COMPENSATION_ASSET');
    const basis = page.getByLabel(vi['lnd.plans.itemDialog.basis.label'], { exact: true });
    await expect(basis.locator('option')).toHaveCount(2);
    await expect(basis.locator('option').nth(1)).toContainText('360.000.000');
    await basis.selectOption({ index: 1 });
    await page.getByLabel(vi['lnd.plans.itemDialog.legalBasis.label'], { exact: true }).fill(BASIS);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(row.getByTestId('total-compensation')).toHaveText('360.000.000');

    // A support is the amount of a policy.
    await row.getByRole('button', { name: vi['lnd.plans.items.action'] }).click();
    await page.getByLabel(vi['lnd.plans.itemDialog.household.label'], { exact: true }).selectOption({ index: 1 });
    await page.getByLabel(vi['lnd.plans.itemDialog.kind.label'], { exact: true }).selectOption('SUPPORT_LIVELIHOOD');
    await page.getByLabel(vi['lnd.plans.itemDialog.amount.label'], { exact: true }).fill('10000000');
    await page.getByLabel(vi['lnd.plans.itemDialog.legalBasis.label'], { exact: true }).fill(POLICY);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(row.getByTestId('total-support')).toHaveText('10.000.000');
    await expect(row.getByTestId('total-grand')).toHaveText('370.000.000');
    const [plan] = await sql<{ id: string; comp: string; support: string; grand: string; version: string }>(
      "select id, total_compensation_vnd::text as comp, total_support_vnd::text as support, grand_total_vnd::text as grand, version::text as version from machvon.compensation_plan where project_id = $1 and plan_code = 'PA-E2E'",
      [aim.projectId],
    );
    expect(plan).toMatchObject({ comp: '360000000', support: '10000000', grand: '370000000', version: '3' });
    const [item] = await sql<{ amount: string; price_decision_ref: string; price_decision_revision: number | null }>(
      "select amount_vnd::text as amount, price_decision_ref, price_decision_revision from machvon.compensation_plan_item where plan_id = $1 and item_kind = 'COMPENSATION_ASSET'",
      [plan?.id],
    );
    expect(item).toEqual({ amount: '360000000', price_decision_ref: DECISION, price_decision_revision: null });

    // The plan is posted (a later story's command, here its effect) and then revised: the new revision takes the items and the earlier one stays readable as replaced.
    await sql("update machvon.compensation_plan set status = 'POSTING', posting_started_on = date '2026-10-01', posting_ends_on = date '2026-10-31', posting_place_text = 'Commune office', timer_rule_version_id = gen_random_uuid() where id = $1", [plan?.id]);
    await open(page, 'landPlanWriter', aim);
    await expect(page.locator('[data-plan-id]').first().getByRole('button', { name: vi['lnd.plans.items.action'] })).toHaveCount(0);
    await page.locator('[data-plan-id]').first().getByRole('button', { name: vi['lnd.plans.revise.action'] }).click();
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error'])).toBeVisible();
    await page.getByLabel(vi['lnd.plans.reviseDialog.reason.label'], { exact: true }).fill('Giá đất thay đổi');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.locator('[data-plan-id]')).toHaveCount(2);
    const newest = page.locator('[data-plan-id]').first();
    await expect(newest.getByTestId('revision')).toHaveText('2');
    await expect(newest.getByTestId('status')).toContainText(vi['lnd.planStatus.draft.label']);
    await expect(newest.getByTestId('reason')).toHaveText('Giá đất thay đổi');
    await expect(newest.getByTestId('total-grand')).toHaveText('370.000.000');
    const earlier = page.locator('[data-plan-id]').nth(1);
    await expect(earlier.getByTestId('revision')).toHaveText('1');
    await expect(earlier.getByTestId('status')).toHaveText(vi['lnd.planStatus.revised.label']);
    await earlier.getByRole('button', { name: vi['lnd.plans.open.aria'].replace('{code}', 'PA-E2E').replace('{revision}', '1') }).click();
    await expect(page.getByTestId('plan-detail').locator('[data-item-id]')).toHaveCount(2);
    const rows = await sql<{ status: string; revision: number }>("select status, revision from machvon.compensation_plan where project_id = $1 and plan_code = 'PA-E2E' order by revision", [aim.projectId]);
    expect(rows).toEqual([
      { status: 'REVISED', revision: 1 },
      { status: 'DRAFT', revision: 2 },
    ]);
    const trail = await sql<{ action: string; diff: string }>(
      "select action, safe_diff::text as diff from machvon.audit_event where action like 'lnd.plan_%' and resource_id in (select id from machvon.compensation_plan where project_id = $1) order by occurred_at",
      [aim.projectId],
    );
    expect(trail.map((entry) => entry.action)).toEqual(['lnd.plan_drafted', 'lnd.plan_items_added', 'lnd.plan_items_added', 'lnd.plan_revised']);
    for (const entry of trail) expect(entry.diff).not.toContain(aim.householdId);
  });

  test('a reader sees the plans and the totals and no button that drafts, adds or revises (UI-LND-05)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'landPlanWriter', aim);
    await page.getByRole('button', { name: vi['lnd.plans.draft.action'] }).click();
    await page.getByLabel(vi['lnd.plans.draftDialog.code.label'], { exact: true }).fill('PA-READ');
    await page.getByLabel(vi['lnd.plans.draftDialog.unit.label'], { exact: true }).selectOption({ index: 1 });
    await page.getByLabel(vi['lnd.plans.draftDialog.kind.label'], { exact: true }).selectOption('PROJECT_OWNER');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.locator('[data-plan-id]')).toHaveCount(1);

    await open(page, 'landPlanReader', aim);
    const row = page.locator('[data-plan-id]').first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.draft.label']);
    await expect(page.getByRole('button', { name: vi['lnd.plans.draft.action'] })).toHaveCount(0);
    await expect(row.getByRole('button')).toHaveCount(1);
  });
});
