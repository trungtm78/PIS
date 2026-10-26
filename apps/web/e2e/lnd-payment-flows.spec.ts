import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * LND-07 (the payments of an approved plan) in a real browser against the real API and database (apps/api/test/e2e-stack): the one who pays schedules a payment for each household inside the days of the plan,
 * confirms one on time, is asked why for one made after its day, deposits the money a household does not take, and the plan is completed when everything was paid or deposited; the timers end by the day of the
 * payment; the trail carries ids, amounts and dates and never a household or an account; a reader sees the payments and no button.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const POLICY = 'Nghị định 88/2024/NĐ-CP, Điều 21';
const DAY = 24 * 60 * 60 * 1000;

const vietnamToday = (): string => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
const shift = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

interface Seeded {
  projectId: string;
  planId: string;
  planCode: string;
  documentId: string;
  households: Array<{ id: string; code: string; amount: string }>;
}

/** A project with three households of the unit and an approved plan that holds an amount for each (approved 20 days ago, payments due in 10 days), and a voucher that was scanned clean. */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('landPlanWriter');
  const approver = membershipOf('landPlanApprover');
  const today = vietnamToday();
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const projectId = randomUUID();
  const code = `E2E-PAY-${Date.now().toString(36).toUpperCase()}-${projectId.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, code, `Dự án GPMB ${code}`, unit, area?.id, officer],
  );
  const planId = randomUUID();
  const planCode = `PA-${projectId.slice(0, 6).toUpperCase()}`;
  await sql(
    `insert into machvon.compensation_plan (tenant_id, id, project_id, executor_unit_id, executor_kind, plan_code, status, created_by, updated_by, version)
     values ($1, $2, $3, $4, 'LAND_FUND_CENTRE', $5, 'DRAFT', $6, $6, 1)`,
    [tenant, planId, projectId, unit, planCode, officer],
  );
  const households: Seeded['households'] = [];
  for (const [index, amount] of ['450000000', '300000000', '120000000'].entries()) {
    const id = randomUUID();
    const householdCode = `HH-${String.fromCharCode(65 + index)}${projectId.slice(0, 4).toUpperCase()}`;
    await sql(
      `insert into machvon.affected_household
         (tenant_id, id, project_id, owner_unit_id, household_code, head_name, head_name_enc, legal_basis, legal_basis_ref, retention_until, status, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'N***** V** A', decode('00', 'hex'), 'PUBLIC_TASK_LAND_LAW', 'Luật Đất đai 2024, Điều 87', date '2036-12-31', 'REGISTERED', 1, $6, $6)`,
      [tenant, id, projectId, unit, householdCode, officer],
    );
    await sql(
      `insert into machvon.compensation_plan_item (tenant_id, id, plan_id, household_id, owner_unit_id, item_kind, amount_vnd, legal_basis, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, 'SUPPORT_LIVELIHOOD', $6::numeric, $7, $8, $8, 1)`,
      [tenant, randomUUID(), planId, id, unit, amount, POLICY, officer],
    );
    households.push({ id, code: householdCode, amount });
  }
  await sql('update machvon.compensation_plan set total_support_vnd = 870000000, version = 2 where id = $1', [planId]);
  await sql("update machvon.compensation_plan set status = 'POSTING', posting_started_on = $2::date, posting_ends_on = $3::date, posting_place_text = 'Commune office', timer_rule_version_id = gen_random_uuid() where id = $1", [planId, shift(today, -60), shift(today, -30)]);
  await sql("update machvon.compensation_plan set status = 'POSTING_CLOSED', feedback_summary = 'No opinions' where id = $1", [planId]);
  const [clean] = await sql<{ id: string }>("select id from machvon.document_version where tenant_id = $1 and scan_status = 'CLEAN' limit 1", [tenant]);
  await sql("update machvon.compensation_plan set status = 'APPROVED', approved_on = $2::date, approved_by = $3, payment_due_on = $4::date, decision_document_version_id = $5 where id = $1", [planId, shift(today, -20), approver, shift(today, 10), clean?.id]);
  return { projectId, planId, planCode, documentId: clean?.id ?? '', households };
}

async function open(page: Page, user: string, aim: Seeded, plan = false): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/lnd/lnd-07?project=${aim.projectId}${plan ? `&plan=${aim.planId}` : ''}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const money = (amount: string): string => amount.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

test.describe('LND-07: the payments of an approved plan', () => {
  test('the one who pays schedules a payment for each household, confirms one on time, says why another is late, deposits the money of the third, and the plan is completed (AC-ST-LND-007-1, AC-ST-LND-007-3, UAT-AC378, UI-LND-07)', async ({ page }) => {
    const aim = await seed();
    const today = vietnamToday();
    const [a, b, c] = aim.households as [Seeded['households'][number], Seeded['households'][number], Seeded['households'][number]];
    await open(page, 'landPayer', aim);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.payments.page.title'] })).toBeVisible();
    const row = page.locator(`[data-plan-id="${aim.planId}"]`);
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.approved.label']);
    await expect(row.getByTestId('due')).toHaveText(shift(today, 10));

    // A payment for each household: A and C by the day of the plan, B for a day that has passed.
    const schedule = async (household: Seeded['households'][number], extra: { due?: string; account?: string } = {}) => {
      await row.getByRole('button', { name: vi['lnd.payments.schedule.aria'].replace('{code}', aim.planCode).replace('{revision}', '1') }).click();
      await page.getByLabel(vi['lnd.payments.scheduleDialog.household.label'], { exact: true }).selectOption({ label: household.code });
      await page.getByLabel(vi['lnd.payments.scheduleDialog.amount.label'], { exact: true }).fill(household.amount);
      if (extra.due !== undefined) await page.getByLabel(vi['lnd.payments.scheduleDialog.due.label'], { exact: true }).fill(extra.due);
      if (extra.account !== undefined) await page.getByLabel(vi['lnd.payments.scheduleDialog.account.label'], { exact: true }).fill(extra.account);
      await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    await schedule(a, { account: '0123456789' });
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.paying.label']);
    await row.getByRole('button', { name: vi['lnd.payments.open.aria'].replace('{code}', aim.planCode).replace('{revision}', '1') }).click();
    await schedule(b, { due: shift(today, -5) });
    await schedule(c);
    const detail = page.getByTestId('payment-detail');
    await expect(detail.locator('[data-payment-id]')).toHaveCount(3);
    await expect(detail.getByTestId('tile-scheduled')).toContainText(money('870000000'));
    await expect(detail.getByTestId('tile-pending')).toContainText(money('870000000'));
    const paymentOf = (household: Seeded['households'][number]) => detail.locator('[data-payment-id]').filter({ hasText: household.code });
    await expect(paymentOf(a).getByTestId('account')).toHaveText('******6789');
    await expect(paymentOf(a).getByTestId('due')).toContainText(shift(today, 10));
    await expect(paymentOf(b).getByTestId('left')).toContainText(vi['lnd.payments.due.late'].replace('{days}', '5'));
    const timers = await sql<{ status: string; due_on: string }>("select d.status, d.due_on::text as due_on from machvon.land_deadline d join machvon.compensation_payment p on p.id = d.subject_id where p.plan_id = $1 order by p.amount_vnd desc", [aim.planId]);
    expect(timers).toEqual([
      { status: 'RUNNING', due_on: shift(today, 10) },
      { status: 'RUNNING', due_on: shift(today, -5) },
      { status: 'RUNNING', due_on: shift(today, 10) },
    ]);

    // A on time: no reason is asked for.
    await paymentOf(a).getByRole('button', { name: vi['lnd.payments.confirm.aria'].replace('{household}', a.code).replace('{number}', '1') }).click();
    await page.getByLabel(vi['lnd.payments.confirmDialog.method.label'], { exact: true }).selectOption('BANK_TRANSFER');
    await expect(page.getByLabel(vi['lnd.payments.confirmDialog.late.label'], { exact: true })).toHaveCount(0);
    await page.getByLabel(vi['lnd.payments.confirmDialog.voucher.label'], { exact: true }).fill(aim.documentId);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(paymentOf(a).getByTestId('payment-status')).toHaveText(vi['lnd.paymentStatus.paid.label']);
    await expect(paymentOf(a).getByTestId('paid')).toContainText(today);
    await expect(detail.getByTestId('tile-settled')).toContainText(money('450000000'));

    // B after its day: the reason is asked for, and recorded.
    await paymentOf(b).getByRole('button', { name: vi['lnd.payments.confirm.aria'].replace('{household}', b.code).replace('{number}', '1') }).click();
    await page.getByLabel(vi['lnd.payments.confirmDialog.method.label'], { exact: true }).selectOption('CASH_VOUCHER');
    await page.getByLabel(vi['lnd.payments.confirmDialog.voucher.label'], { exact: true }).fill(aim.documentId);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error'])).toBeVisible();
    await page.getByLabel(vi['lnd.payments.confirmDialog.late.label'], { exact: true }).fill('Kho bạc nghỉ ngày đến hạn');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(paymentOf(b).getByTestId('payment-status')).toHaveText(vi['lnd.paymentStatus.paid.label']);
    await expect(paymentOf(b).getByTestId('late-reason')).toContainText('Kho bạc nghỉ ngày đến hạn');

    // C does not take the money: it is deposited, and the plan is complete.
    await paymentOf(c).getByRole('button', { name: vi['lnd.payments.deposit.aria'].replace('{household}', c.code).replace('{number}', '1') }).click();
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error']).first()).toBeVisible();
    await page.getByLabel(vi['lnd.payments.depositDialog.reason.label'], { exact: true }).fill('Hộ không nhận tiền');
    await page.getByLabel(vi['lnd.payments.depositDialog.voucher.label'], { exact: true }).fill(aim.documentId);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(paymentOf(c).getByTestId('payment-status')).toHaveText(vi['lnd.paymentStatus.deposited.label']);
    await expect(paymentOf(c).getByTestId('deposit-reason')).toHaveText('Hộ không nhận tiền');
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.planStatus.completed.label']);
    await expect(detail.getByTestId('tile-pending')).toContainText('0');
    await expect(detail.getByRole('button')).toHaveCount(0);

    const settled = await sql<{ status: string; satisfied_on: string | null }>('select d.status, d.satisfied_on::text as satisfied_on from machvon.land_deadline d join machvon.compensation_payment p on p.id = d.subject_id where p.plan_id = $1 order by p.amount_vnd desc', [aim.planId]);
    expect(settled).toEqual([
      { status: 'SATISFIED', satisfied_on: today },
      { status: 'BREACHED', satisfied_on: null },
      { status: 'SATISFIED', satisfied_on: today },
    ]);
    const [plan] = await sql<{ status: string }>('select status from machvon.compensation_plan where id = $1', [aim.planId]);
    expect(plan?.status).toBe('COMPLETED');
    const trail = await sql<{ action: string; diff: string }>(
      "select action, safe_diff::text as diff from machvon.audit_event where action like 'lnd.payment%' and (resource_id = $1 or resource_id in (select id from machvon.compensation_payment where plan_id = $1)) order by occurred_at",
      [aim.planId],
    );
    expect(trail.map((entry) => entry.action)).toEqual(['lnd.payments_scheduled', 'lnd.payments_scheduled', 'lnd.payments_scheduled', 'lnd.payment_confirmed', 'lnd.payment_confirmed', 'lnd.payment_deposited']);
    for (const entry of trail) {
      for (const household of aim.households) expect(entry.diff).not.toContain(household.id);
      expect(entry.diff).not.toContain('0123456789');
      expect(entry.diff).not.toContain('Kho bạc');
      expect(entry.diff).not.toContain('Hộ không nhận');
    }
  });

  test('a reader sees the payments and the masked account and no button that schedules, confirms or deposits (UI-LND-07)', async ({ page }) => {
    const aim = await seed();
    const [a] = aim.households as [Seeded['households'][number]];
    await open(page, 'landPayer', aim);
    const row = page.locator(`[data-plan-id="${aim.planId}"]`);
    await row.getByRole('button', { name: vi['lnd.payments.schedule.aria'].replace('{code}', aim.planCode).replace('{revision}', '1') }).click();
    await page.getByLabel(vi['lnd.payments.scheduleDialog.household.label'], { exact: true }).selectOption({ label: a.code });
    await page.getByLabel(vi['lnd.payments.scheduleDialog.amount.label'], { exact: true }).fill('1000');
    await page.getByLabel(vi['lnd.payments.scheduleDialog.account.label'], { exact: true }).fill('9876543210');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await open(page, 'landPlanReader', aim, true);
    const detail = page.getByTestId('payment-detail');
    await expect(detail.locator('[data-payment-id]')).toHaveCount(1);
    await expect(detail.getByTestId('account')).toHaveText('******3210');
    await expect(detail.getByTestId('payment-status')).toHaveText(vi['lnd.paymentStatus.pending.label']);
    await expect(detail.getByRole('button')).toHaveCount(0);
    await expect(page.locator(`[data-plan-id="${aim.planId}"]`).getByRole('button')).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText('9876543210');
  });
});
