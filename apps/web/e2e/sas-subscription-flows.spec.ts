import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql, stackInfo } from './support/stack.ts';

/**
 * SAS-07 and SAS-08, the subscription of a tenant and its change of plan (ST-SAS-008), in a real browser against the real API and database
 * (apps/api/test/e2e-stack): the system administrator starts a subscription for a tenant, previews and applies an upgrade, is refused a preview that went stale,
 * schedules a downgrade that lists the seats the new plan no longer holds, and cancels. The fixture tenant B is cleared of subscriptions before each case.
 */

const unique = (): string => Date.now().toString(36);
const DAY_MS = 86_400_000;

async function open(page: Page, screen: 'sas-07' | 'sas-08', user: string, tenantId: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/sas/${screen}?devUser=${user}&tenant=${tenantId}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** A published plan with a switch and a seat quota, sold in whole years. */
async function publishedPlan(code: string, price: string, seats: number): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
     values ($1, $2, 1, $3, 'Draft', '{ANNUAL,MONTHLY}', $4::numeric, 'NOT_SUBJECT', 'TERMS-E2E')`,
    [id, `${code}-${unique()}`, `Gói ${code} e2e`, price],
  );
  await sql(
    `insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, limit_value, grace_behavior, expired_behavior) values
       (gen_random_uuid(), $1, 'reporting', 'BOOLEAN', null, 'ALLOW', 'READ_ONLY'),
       (gen_random_uuid(), $1, 'member.seats', 'QUOTA', $2::numeric, 'READ_ONLY', 'DENY')`,
    [id, seats],
  );
  await sql("update machvon.product_plan_version set status = 'Published', published_by = gen_random_uuid(), published_at = now() where id = $1", [id]);
  return id;
}

const clear = (tenantId: string): Promise<unknown[]> => sql("update machvon.subscription set status = 'Cancelled' where tenant_id = $1", [tenantId]);
const versionsOf = async (tenantId: string): Promise<number> => Number((await sql<{ n: string }>('select count(*) as n from machvon.entitlement_version where tenant_id = $1', [tenantId]))[0]?.n);
const activeStaff = async (tenantId: string): Promise<number> =>
  Number((await sql<{ n: string }>("select count(*) as n from machvon.membership where tenant_id = $1 and status = 'Active' and membership_type = 'STAFF'", [tenantId]))[0]?.n);

interface Row {
  id: string;
  plan_version_id: string;
  status: string;
  version: string;
  pending_plan_version_id: string | null;
  cancel_at_period_end: boolean;
  current_period_start: string;
  current_period_end: string;
}
const liveOf = async (tenantId: string): Promise<Row | undefined> =>
  (
    await sql<Row>(
      `select id, plan_version_id, status, version::text as version, pending_plan_version_id, cancel_at_period_end, current_period_start::text as current_period_start, current_period_end::text as current_period_end
         from machvon.subscription where tenant_id = $1 and status in ('Trialing', 'Active', 'PastDue', 'Paused')`,
      [tenantId],
    )
  )[0];

/** What the proration is worth today, worked out apart from the code under test: whole VND, rounded down. */
function prorationFor(oldPrice: bigint, newPrice: bigint, start: string, end: string): bigint {
  const [from, until, today] = [Date.parse(start), Date.parse(end), Date.parse(new Date().toISOString().slice(0, 10))];
  const total = BigInt((until - from) / DAY_MS + 1);
  const remaining = total - BigInt(Math.round((today - from) / DAY_MS));
  return ((newPrice - oldPrice) * remaining) / total;
}

test.describe('SAS-07 subscription and SAS-08 change of plan', () => {
  test('starts a subscription for a tenant that has none, and shows it', async ({ page }) => {
    const tenantId = stackInfo().tenants.B;
    await clear(tenantId);
    const planId = await publishedPlan('start', '365000000', 50);
    await open(page, 'sas-07', 'sysAdmin', tenantId);
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.subscription.page.title'] })).toBeVisible();
    await expect(page.getByText(vi['sas.subscription.current.none'])).toBeVisible();

    const form = page.getByRole('form', { name: vi['sas.subscription.form.aria'] });
    // What breaks a rule of the form never leaves the browser.
    await form.getByRole('button', { name: vi['sas.subscription.form.submit.action'] }).click();
    await expect(form.getByText(vi['sas.subscription.field.required']).first()).toBeVisible();
    expect(await liveOf(tenantId)).toBeUndefined();

    await form.getByLabel(vi['sas.subscription.form.plan.label'], { exact: true }).selectOption(planId);
    await form.getByLabel(vi['sas.subscription.form.anchor.label'], { exact: true }).fill(new Date(Date.now() - 45 * DAY_MS).toISOString().slice(0, 10));
    await form.getByLabel(vi['sas.subscription.form.contract.label'], { exact: true }).fill('HD-E2E-001');
    await expect(form.getByLabel(vi['sas.subscription.form.plan.label'], { exact: true }).locator('option', { hasText: 'Gói start e2e' })).toHaveCount(1);
    const versions = await versionsOf(tenantId);
    await form.getByRole('button', { name: vi['sas.subscription.form.submit.action'] }).click();
    await expect(page.getByText(vi['sas.subscription.done.created'])).toBeVisible();

    const row = await liveOf(tenantId);
    expect(row).toMatchObject({ plan_version_id: planId, status: 'Active', version: '1' });
    expect(await versionsOf(tenantId)).toBe(versions + 1);
    const current = page.locator('[data-subscription-id]');
    await expect(current).toHaveAttribute('data-status', 'Active');
    await expect(current).toContainText('HD-E2E-001');
    await expect(current).toContainText(vi['sas.subscription.status.active']);
  });

  test('previews an upgrade, applies it against the preview, and is refused a preview that went stale (UAT-AC155)', async ({ page }) => {
    const tenantId = stackInfo().tenants.B;
    await clear(tenantId);
    const from = await publishedPlan('upgrade-from', '365000000', 50);
    const to = await publishedPlan('upgrade-to', '730000000', 100);
    const created = await sql<{ id: string }>(
      `insert into machvon.subscription (tenant_id, id, plan_version_id, cycle, billing_anchor, status, payment_terms, current_period_start, current_period_end)
       values ($1, gen_random_uuid(), $2, 'ANNUAL', (current_date - 45), 'Active', '{"due_days":30,"method":"BANK_TRANSFER"}'::jsonb, (current_date - 45), ((current_date - 45) + interval '1 year')::date - 1)
       returning id`,
      [tenantId, from],
    );
    const subscriptionId = created[0]?.id ?? '';
    const period = await liveOf(tenantId);
    const expected = prorationFor(365000000n, 730000000n, period?.current_period_start ?? '', period?.current_period_end ?? '').toString();

    await open(page, 'sas-08', 'sysAdmin', tenantId);
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.planChange.page.title'] })).toBeVisible();
    await page.getByLabel(vi['sas.planChange.field.target'], { exact: true }).selectOption(to);
    await expect(page.locator('input[name="plan-change-effective"][value="NOW"]')).toBeChecked();
    await page.getByRole('button', { name: vi['sas.planChange.preview.action'] }).click();
    const preview = page.getByTestId('preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('[data-proration]')).toHaveAttribute('data-proration', expected);
    await expect(preview).toContainText(vi['sas.planChange.violations.none']);

    // Something changes the entitlements of the tenant (an override is decided): the preview in hand is no longer true.
    await sql(
      `insert into machvon.entitlement_version (tenant_id, id, version_no, plan_version_id, features_json, entitlements_hash, cause, effective_from)
       values ($1, gen_random_uuid(), (select coalesce(max(version_no), 0) + 1 from machvon.entitlement_version where tenant_id = $1), $2, '[]'::jsonb, repeat('d', 64), 'OVERRIDE', now())`,
      [tenantId, from],
    );
    const apply = page.getByRole('form', { name: vi['sas.planChange.apply.aria'] });
    await apply.getByLabel(vi['sas.planChange.reason.label'], { exact: true }).fill('short');
    await apply.getByRole('button', { name: vi['sas.planChange.apply.action'] }).click();
    await expect(apply.getByText(vi['sas.planChange.reason.tooShort'])).toBeVisible();
    await apply.getByLabel(vi['sas.planChange.reason.label'], { exact: true }).fill('The customer asked for the larger plan.');
    await apply.getByRole('button', { name: vi['sas.planChange.apply.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['sas.planChange.problem.stale'] })).toBeVisible();
    await expect(page.getByTestId('preview')).toHaveCount(0);
    expect((await liveOf(tenantId))?.plan_version_id).toBe(from);

    // The preview made again is current: the change goes through.
    const versions = await versionsOf(tenantId);
    await page.getByRole('button', { name: vi['sas.planChange.preview.action'] }).click();
    await expect(page.getByTestId('preview')).toBeVisible();
    await apply.getByLabel(vi['sas.planChange.reason.label'], { exact: true }).fill('The customer asked for the larger plan.');
    await apply.getByRole('button', { name: vi['sas.planChange.apply.action'] }).click();
    await expect(page.getByText(vi['sas.planChange.done.notice'])).toBeVisible();
    expect(await liveOf(tenantId)).toMatchObject({ plan_version_id: to, version: '2' });
    expect(await versionsOf(tenantId)).toBe(versions + 1);
    const changes = await sql<{ proration_vnd: string; effective: string; applied: boolean }>('select trim_scale(proration_vnd)::text as proration_vnd, effective, applied_at is not null as applied from machvon.subscription_plan_change where subscription_id = $1', [subscriptionId]);
    expect(changes).toEqual([{ proration_vnd: expected, effective: 'NOW', applied: true }]);
    await expect(page.locator('tr[data-change-id]')).toHaveCount(1);
    await expect(page.locator('tr[data-change-id]')).toContainText(vi['sas.planChange.history.applied']);
  });

  test('schedules a downgrade at the next cycle, listing the seats the new plan no longer holds, and deletes nothing', async ({ page }) => {
    const tenantId = stackInfo().tenants.B;
    await clear(tenantId);
    const staff = await activeStaff(tenantId);
    expect(staff).toBeGreaterThanOrEqual(1);
    const big = await publishedPlan('down-big', '900000000', staff + 10);
    const small = await publishedPlan('down-small', '300000000', Math.max(staff - 1, 0));
    await sql(
      `insert into machvon.subscription (tenant_id, id, plan_version_id, cycle, billing_anchor, status, payment_terms, current_period_start, current_period_end)
       values ($1, gen_random_uuid(), $2, 'ANNUAL', (current_date - 10), 'Active', '{"due_days":30,"method":"BANK_TRANSFER"}'::jsonb, (current_date - 10), ((current_date - 10) + interval '1 year')::date - 1)`,
      [tenantId, big],
    );
    await open(page, 'sas-08', 'sysAdmin', tenantId);
    await page.getByLabel(vi['sas.planChange.field.target'], { exact: true }).selectOption(small);
    // A plan that costs less cannot take effect now, and the screen says so.
    await expect(page.locator('input[name="plan-change-effective"][value="NOW"]')).toBeDisabled();
    await expect(page.locator('input[name="plan-change-effective"][value="NEXT_CYCLE"]')).toBeChecked();
    await expect(page.getByText(vi['sas.planChange.effective.onlyNext'])).toBeVisible();
    await page.getByRole('button', { name: vi['sas.planChange.preview.action'] }).click();
    const preview = page.getByTestId('preview');
    await expect(preview.locator('[data-proration]')).toHaveAttribute('data-proration', '0');
    const row = preview.locator('tr[data-feature="member.seats"]');
    await expect(row).toContainText(String(staff));
    await expect(row).toContainText(String(Math.max(staff - 1, 0)));
    await expect(preview).toContainText(vi['sas.planChange.violations.rule']);

    const apply = page.getByRole('form', { name: vi['sas.planChange.apply.aria'] });
    await apply.getByLabel(vi['sas.planChange.reason.label'], { exact: true }).fill('The agency moves to the smaller plan.');
    await apply.getByRole('button', { name: vi['sas.planChange.apply.action'] }).click();
    await expect(page.getByText(vi['sas.planChange.done.notice'])).toBeVisible();
    expect(await liveOf(tenantId)).toMatchObject({ plan_version_id: big, pending_plan_version_id: small, version: '2' });
    expect(await activeStaff(tenantId)).toBe(staff);
    await expect(page.locator('[data-pending-plan]')).toBeVisible();
    await expect(page.locator('tr[data-change-id]')).toContainText(vi['sas.planChange.history.waiting']);
  });

  test('cancels a paid subscription at the end of its period, with a reason', async ({ page }) => {
    const tenantId = stackInfo().tenants.B;
    await clear(tenantId);
    const planId = await publishedPlan('cancel', '100000000', 50);
    await sql(
      `insert into machvon.subscription (tenant_id, id, plan_version_id, cycle, billing_anchor, status, payment_terms, current_period_start, current_period_end)
       values ($1, gen_random_uuid(), $2, 'ANNUAL', current_date, 'Active', '{"due_days":30,"method":"BANK_TRANSFER"}'::jsonb, current_date, (current_date + interval '1 year')::date - 1)`,
      [tenantId, planId],
    );
    await open(page, 'sas-07', 'sysAdmin', tenantId);
    await page.getByRole('button', { name: vi['sas.subscription.cancel.action'] }).click();
    const confirm = page.getByRole('form', { name: vi['sas.subscription.cancel.aria'] });
    await expect(confirm.getByText(vi['sas.subscription.cancel.rule.paid'])).toBeVisible();
    await confirm.getByLabel(vi['sas.subscription.cancel.reason.label'], { exact: true }).fill('short');
    await confirm.getByRole('button', { name: vi['sas.subscription.cancel.confirm.action'] }).click();
    await expect(confirm.getByText(vi['sas.subscription.cancel.reason.tooShort'])).toBeVisible();
    await confirm.getByLabel(vi['sas.subscription.cancel.reason.label'], { exact: true }).fill('The agency ended the contract.');
    await confirm.getByRole('button', { name: vi['sas.subscription.cancel.confirm.action'] }).click();
    await expect(page.getByText(vi['sas.subscription.done.cancelled'])).toBeVisible();
    expect(await liveOf(tenantId)).toMatchObject({ status: 'Active', cancel_at_period_end: true, version: '2' });
    await expect(page.getByRole('button', { name: vi['sas.subscription.cancel.action'] })).toHaveCount(0);
  });

  test('shows an operator who manages no billing the subscription and no way to change it', async ({ page }) => {
    const tenantId = stackInfo().tenants.B;
    await clear(tenantId);
    const planId = await publishedPlan('read-only', '1', 50);
    await sql(
      `insert into machvon.subscription (tenant_id, id, plan_version_id, cycle, billing_anchor, status, payment_terms, current_period_start, current_period_end)
       values ($1, gen_random_uuid(), $2, 'ANNUAL', current_date, 'Active', '{"due_days":30,"method":"BANK_TRANSFER"}'::jsonb, current_date, (current_date + interval '1 year')::date - 1)`,
      [tenantId, planId],
    );
    await open(page, 'sas-07', 'operator', tenantId);
    await expect(page.locator('[data-subscription-id]')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['sas.subscription.cancel.action'] })).toHaveCount(0);
    await open(page, 'sas-08', 'operator', tenantId);
    await expect(page.getByText(vi['sas.planChange.form.denied'])).toBeVisible();
  });
});
