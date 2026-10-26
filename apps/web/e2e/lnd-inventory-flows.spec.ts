import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * LND-04 (the inventory of the assets of a household) in a real browser against the real API and database (apps/api/test/e2e-stack): an officer counts the assets of a household on a parcel it
 * holds a right on, at the decision on land prices that was in force on the day of the survey; the amount is the quantity times the price to the dong; the record is a draft until someone other
 * than the officer records the answer of the household, which confirms it (the household and the parcel are then inventoried) or objects (the household is disputed); a reader sees the records and
 * no button.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const OLD_DECISION = 'QD-GIA-2024-E2E';
const NEW_DECISION = 'QD-GIA-2026-E2E';
const DESCRIPTION = 'Nhà cấp 4 mái ngói xây năm 2011';
const NOTE = 'Hộ cho rằng nhà rộng 95 m2';

interface Seeded {
  projectId: string;
  householdId: string;
  householdCode: string;
  parcelId: string;
  parcelCode: string;
}

/** A price decision of the tenant in force from one day to another, as the catalogue leaves it once it is published. */
async function priceDecision(key: string, validFrom: string, validUntil: string | null): Promise<void> {
  const tenant = stackInfo().tenants.A;
  const officer = membershipOf('inventoryCounter');
  const [existing] = await sql<{ id: string }>("select id from machvon.master_record where tenant_id = $1 and master_type = 'LND_PRICE_DECISION' and business_key = $2", [tenant, key]);
  if (existing !== undefined) return;
  const record = randomUUID();
  await sql(
    `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, steward_membership_id, created_by, updated_by)
     values ($1, $2, 'TENANT', 'LND_PRICE_DECISION', $3, 'EFFECTIVE', $4, $4, $4)`,
    [tenant, record, key, officer],
  );
  await sql(
    `insert into machvon.master_record_version
       (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, valid_until, status, namespace, content_sha256, published_at, created_by, updated_by)
     values ($1, $2, $3, 'LND_PRICE_DECISION', $4, 1, $4, $5::jsonb, $6::date, $7::date, 'EFFECTIVE', 'TENANT', repeat('c', 64), now(), $8, $8)`,
    [tenant, randomUUID(), record, key, JSON.stringify({ title: `Decision ${key} on land prices` }), validFrom, validUntil, officer],
  );
}

/** A project of the tenant with a household of the unit that holds a right on a parcel of it. The sealed data is a stand-in: the screen never opens it. */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('inventoryCounter');
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const projectId = randomUUID();
  const code = `E2E-INV-${Date.now().toString(36).toUpperCase()}-${projectId.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, code, `Dự án GPMB ${code}`, unit, area?.id, officer],
  );
  const parcelId = randomUUID();
  const parcelCode = `IN-P-${projectId.slice(0, 6).toUpperCase()}`;
  await sql(
    `insert into machvon.land_parcel (tenant_id, id, project_id, owner_unit_id, parcel_code, land_use_group, area_total_m2, area_affected_m2, status, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'AGRICULTURAL', 1000, 500, 'SURVEYED', 1, $6, $6)`,
    [tenant, parcelId, projectId, unit, parcelCode, officer],
  );
  const householdId = randomUUID();
  const householdCode = `HH-I${projectId.slice(0, 5).toUpperCase()}`;
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
  await priceDecision(OLD_DECISION, '2024-01-01', '2026-07-01');
  await priceDecision(NEW_DECISION, '2026-07-01', null);
  return { projectId, householdId, householdCode, parcelId, parcelCode };
}

async function open(page: Page, user: string, aim: Seeded): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/lnd/lnd-04?project=${aim.projectId}&household=${aim.householdId}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function count(page: Page, aim: Seeded, fields: { kind: string; description: string; quantity: string; unit: string; price: string; decision: string; surveyed: string }): Promise<void> {
  await page.getByRole('button', { name: vi['lnd.inventory.record.action'] }).click();
  await page.getByLabel(vi['lnd.inventory.recordDialog.parcel.label'], { exact: true }).selectOption({ label: aim.parcelCode });
  await page.getByLabel(vi['lnd.inventory.recordDialog.kind.label'], { exact: true }).selectOption(fields.kind);
  await page.getByLabel(vi['lnd.inventory.recordDialog.description.label'], { exact: true }).fill(fields.description);
  await page.getByLabel(vi['lnd.inventory.recordDialog.quantity.label'], { exact: true }).fill(fields.quantity);
  await page.getByLabel(vi['lnd.inventory.recordDialog.unit.label'], { exact: true }).fill(fields.unit);
  await page.getByLabel(vi['lnd.inventory.recordDialog.price.label'], { exact: true }).fill(fields.price);
  await page.getByLabel(vi['lnd.inventory.recordDialog.decision.label'], { exact: true }).fill(fields.decision);
  await page.getByLabel(vi['lnd.inventory.recordDialog.surveyed.label'], { exact: true }).fill(fields.surveyed);
}

test.describe('LND-04: the inventory of the assets of a household', () => {
  test('an officer counts an asset at the price decision of the day of the survey, someone else records the answer of the household, and the household and the parcel are inventoried (AC-ST-LND-004-1, UAT-PLAN-29, UI-LND-04)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'inventoryCounter', aim);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.inventory.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-match')).toHaveText(vi['lnd.inventory.empty.notice']);

    // A decision that was not in force on the day of the survey is refused by the server, and nothing is kept.
    await count(page, aim, { kind: 'HOUSE', description: DESCRIPTION, quantity: '80', unit: 'M2', price: '4500000', decision: OLD_DECISION, surveyed: '2026-07-15' });
    await expect(page.getByTestId('amount-preview')).toHaveText(vi['lnd.inventory.recordDialog.amount.text'].replace('{amount}', '360.000.000'));
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByTestId('refusal')).toHaveText(vi['lnd.inventory.problem.priceDecision.error']);
    expect(await sql('select 1 from machvon.land_inventory_record where household_id = $1', [aim.householdId])).toHaveLength(0);

    // The decision that was in force on that day is accepted.
    await page.getByLabel(vi['lnd.inventory.recordDialog.decision.label'], { exact: true }).fill(NEW_DECISION);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    const row = page.locator('[data-record-id]').first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('amount')).toHaveText('360.000.000');
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.inventoryStatus.draft.label']);
    await expect(row.getByTestId('decision')).toContainText(NEW_DECISION);
    // The officer who counted is not offered the answer of the household.
    await expect(row.getByRole('button')).toHaveCount(0);
    const [stored] = await sql<{ amount: string; has_version: boolean; status: string; surveyed_by: string }>(
      'select amount_vnd::text as amount, price_decision_version_id is not null as has_version, status, surveyed_by from machvon.land_inventory_record where household_id = $1',
      [aim.householdId],
    );
    expect(stored).toEqual({ amount: '360000000', has_version: true, status: 'DRAFT', surveyed_by: membershipOf('inventoryCounter') });

    // Someone else records the answer of the household.
    await open(page, 'inventoryChecker', aim);
    const record = page.locator('[data-record-id]').first();
    await record.getByRole('button').click();
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error']).first()).toBeVisible();
    await page.getByLabel(vi['lnd.inventory.answerDialog.outcome.label'], { exact: true }).selectOption('CONFIRMED');
    await page.getByLabel(vi['lnd.inventory.answerDialog.date.label'], { exact: true }).fill('2026-07-20');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(record.getByTestId('status')).toHaveText(vi['lnd.inventoryStatus.confirmed.label']);
    await expect(page.getByTestId('confirmed-total')).toHaveText(vi['lnd.inventory.total.text'].replace('{amount}', '360.000.000'));
    await expect(record.getByRole('button')).toHaveCount(0);
    const [after] = await sql<{ household: string; parcel: string; confirmed_by: string }>(
      `select (select status from machvon.affected_household where id = $1) as household, (select status from machvon.land_parcel where id = $2) as parcel,
              (select confirmed_by from machvon.land_inventory_record where household_id = $1) as confirmed_by`,
      [aim.householdId, aim.parcelId],
    );
    expect(after).toEqual({ household: 'INVENTORIED', parcel: 'INVENTORIED', confirmed_by: membershipOf('inventoryChecker') });
    const trail = await sql<{ diff: string }>("select safe_diff::text as diff from machvon.audit_event where action like 'lnd.inventory_%' and resource_id in (select id from machvon.land_inventory_record where household_id = $1)", [aim.householdId]);
    expect(trail).toHaveLength(2);
    for (const entry of trail) expect(entry.diff).not.toContain(DESCRIPTION);
  });

  test('a household that objects needs the note of the objection and is disputed (AC-ST-LND-004-1, UI-LND-04)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'inventoryCounter', aim);
    await count(page, aim, { kind: 'TREE', description: 'Cây ăn quả', quantity: '12.5', unit: 'TREE', price: '300000', decision: OLD_DECISION, surveyed: '2026-06-20' });
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.locator('[data-record-id]').first().getByTestId('amount')).toHaveText('3.750.000');

    await open(page, 'inventoryChecker', aim);
    await page.locator('[data-record-id]').first().getByRole('button').click();
    await page.getByLabel(vi['lnd.inventory.answerDialog.outcome.label'], { exact: true }).selectOption('DISPUTED');
    await page.getByLabel(vi['lnd.inventory.answerDialog.date.label'], { exact: true }).fill('2026-07-02');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error']).first()).toBeVisible();
    await page.getByLabel(vi['lnd.inventory.answerDialog.note.label'], { exact: true }).fill(NOTE);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    const record = page.locator('[data-record-id]').first();
    await expect(record.getByTestId('status')).toHaveText(vi['lnd.inventoryStatus.disputed.label']);
    await expect(record.getByTestId('note')).toHaveText(NOTE);
    await expect(page.getByTestId('confirmed-total')).toHaveText(vi['lnd.inventory.total.text'].replace('{amount}', '0'));
    const [after] = await sql<{ household: string; parcel: string }>('select (select status from machvon.affected_household where id = $1) as household, (select status from machvon.land_parcel where id = $2) as parcel', [aim.householdId, aim.parcelId]);
    expect(after).toEqual({ household: 'DISPUTED', parcel: 'SURVEYED' });
  });

  test('a reader sees the records with the amounts and no button that counts or answers (UI-LND-04)', async ({ page }) => {
    const aim = await seed();
    await open(page, 'inventoryCounter', aim);
    await count(page, aim, { kind: 'LAND', description: 'Đất vườn', quantity: '500', unit: 'M2', price: '200000', decision: OLD_DECISION, surveyed: '2026-06-20' });
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.locator('[data-record-id]')).toHaveCount(1);

    await open(page, 'householdReader', aim);
    const row = page.locator('[data-record-id]').first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('amount')).toHaveText('100.000.000');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['lnd.inventory.record.action'] })).toHaveCount(0);
  });
});
