import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql, stackInfo } from './support/stack.ts';

/**
 * SAS-11, the usage of the month (ST-SAS-010), in a real browser against the real API and database (apps/api/test/e2e-stack): the Billing Operator
 * (here the system administrator) picks a tenant and reads its counters against the limits of its plan, its seats and its latest events; the owner
 * of the tenant reads its own counters. The counters are written the way the metering writes them (the service that records events has its own tests:
 * apps/api/test/usage.test.ts), so the screen is judged on what the database holds.
 */

const unique = (): string => Date.now().toString(36);
const MARKER = 'e2e usage override';

async function open(page: Page, user: string, query = ''): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/sas/sas-11?devUser=${user}${query}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** Puts the counter of the month at a value and the plan limit of the messages at another: the screen shows what the tables say now. */
async function seedUsage(tenantId: string, messages: number, limit: number): Promise<{ eventKeys: string[] }> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  await sql(
    `insert into machvon.usage_counter (tenant_id, id, feature_code, window_start, window_end, used_value) values ($1, gen_random_uuid(), 'notification.messages', $2, $3, $4)
     on conflict (tenant_id, feature_code, window_start) do update set used_value = excluded.used_value`,
    [tenantId, start, end, messages],
  );
  // An override is never deleted: the one of an earlier case is revoked, and this case's own is the one in force.
  await sql(`update machvon.entitlement_override set status = 'Revoked' where tenant_id = $1 and reason = $2 and status = 'Active'`, [tenantId, MARKER]);
  await sql(
    `insert into machvon.entitlement_override (tenant_id, id, feature_code, enabled, limit_value, reason, valid_from, valid_until, status, requested_by, approved_by)
     values ($1, gen_random_uuid(), 'notification.campaign', true, $2, $3, now() - interval '1 hour', now() + interval '1 day', 'Active', gen_random_uuid(), gen_random_uuid())`,
    [tenantId, limit, MARKER],
  );
  const keys = [`e2e-zns-${unique()}`, `e2e-sms-${unique()}`];
  await sql(
    `insert into machvon.usage_meter_event (tenant_id, id, meter, external_event_key, quantity, occurred_at, source_reference, unit)
     values ($1, gen_random_uuid(), 'notification.zns', $2, 5, now() - interval '1 hour', 'campaign:e2e-1', 'message'),
            ($1, gen_random_uuid(), 'notification.sms', $3, 2, now() - interval '2 hours', 'campaign:e2e-2', 'message')`,
    [tenantId, keys[0], keys[1]],
  );
  return { eventKeys: keys };
}

const activeStaff = async (tenantId: string): Promise<number> =>
  Number((await sql<{ n: string }>("select count(*) as n from machvon.membership where tenant_id = $1 and status = 'Active' and membership_type = 'STAFF'", [tenantId]))[0]?.n);

test.describe('SAS-11 usage', () => {
  test('the Billing Operator reads the counters of a tenant against its plan, its seats and its latest events', async ({ page }) => {
    const tenantId = stackInfo().tenants.A;
    const { eventKeys } = await seedUsage(tenantId, 950, 1000);
    await open(page, 'sysAdmin', `&tenant=${tenantId}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.usage.page.title'] })).toBeVisible();

    const messages = page.locator('tr[data-counter="notification.messages"]');
    await expect(messages).toContainText(vi['sas.usage.counter.messages']);
    await expect(messages.locator('td').nth(2)).toHaveText('950');
    await expect(messages.locator('td').nth(3)).toHaveText('1000');
    await expect(messages).toHaveAttribute('data-level', 'near');
    await expect(messages).toContainText(vi['sas.usage.level.near']);
    await expect(messages).toContainText(vi['sas.usage.share.text'].replace('{percent}', '95'));
    // A counter that no plan limits is only reported, and says so.
    const bi = page.locator('tr[data-counter="bi.queries"]');
    await expect(bi).toContainText(vi['sas.usage.limit.none']);
    await expect(bi).toContainText(vi['sas.usage.level.none']);

    const staff = page.locator('tr[data-seat="staff"]');
    await expect(staff.locator('td').nth(1)).toHaveText(String(await activeStaff(tenantId)));

    const events = page.getByRole('table', { name: vi['sas.usage.events.title'] });
    for (const key of eventKeys) await expect(events.getByText(key)).toBeVisible();
    await expect(events).toContainText('campaign:e2e-1');
    await expect(events).toContainText(`5 ${vi['sas.usage.unit.message']}`);

    // The limit that is not reached by the plan but by an override is what the screen shows: over it, the counter says so.
    await seedUsage(tenantId, 1200, 1000);
    await page.reload();
    await expect(page.locator('tr[data-counter="notification.messages"]')).toHaveAttribute('data-level', 'over');
    await expect(page.locator('tr[data-counter="notification.messages"]')).toContainText(vi['sas.usage.level.over']);
  });

  test('the owner of a tenant reads its own counters and no events', async ({ page }) => {
    const tenantId = stackInfo().tenants.A;
    await seedUsage(tenantId, 400, 1000);
    await open(page, 'owner');
    await expect(page.locator('tr[data-counter="notification.messages"]').locator('td').nth(2)).toHaveText('400');
    await expect(page.locator('tr[data-counter="notification.messages"]')).toHaveAttribute('data-level', 'ok');
    await expect(page.getByLabel(vi['sas.usage.tenant.label'], { exact: true })).toHaveCount(0);
    await expect(page.getByText(vi['sas.usage.events.title'])).toHaveCount(0);
  });

  test('a member who may not read the subscription is refused', async ({ page }) => {
    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
  });
});
