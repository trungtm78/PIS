import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql, stackInfo } from './support/stack.ts';

/**
 * SAS-25, the entitlement overrides of a tenant (ST-SAS-009), in a real browser against the real API and database (apps/api/test/e2e-stack): a System Admin asks for
 * an override and is offered nothing to decide on their own request; a second administrator approves it, and the table of entitlements shows the feature with the
 * override as its source; either ends it. The reader of the platform sees the overrides and can do nothing to them. The overrides of the fixture tenant A are ended
 * before each case: an override is never deleted.
 */

const MARKER = 'e2e override: pilot of the analysis feature';
const REQUESTER = '00000000-0000-4000-8000-0000000000e9';
const APPROVER = '00000000-0000-4000-8000-0000000000eb';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const local = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString().slice(0, 16);

async function open(page: Page, user: string, tenantId: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`/sas/sas-25?devUser=${user}&tenant=${tenantId}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const clear = (tenantId: string): Promise<unknown[]> =>
  sql("update machvon.entitlement_override set status = 'Revoked' where tenant_id = $1 and reason = $2 and status in ('PendingApproval', 'Active')", [tenantId, MARKER]);

interface Row {
  id: string;
  status: string;
  version: string;
  requested_by: string;
  approved_by: string | null;
  enabled: boolean;
}
const rowsOf = (tenantId: string): Promise<Row[]> =>
  sql<Row>('select id, status, version::text as version, requested_by, approved_by, enabled from machvon.entitlement_override where tenant_id = $1 and reason = $2 order by valid_from desc, id desc', [tenantId, MARKER]);
/** The request the case has just made: the only one waiting (the ones of the cases before ended). */
const waitingOf = async (tenantId: string): Promise<Row | undefined> => (await rowsOf(tenantId)).find((row) => row.status === 'PendingApproval');
const versionsOf = async (tenantId: string): Promise<number> => Number((await sql<{ n: string }>('select count(*) as n from machvon.entitlement_version where tenant_id = $1', [tenantId]))[0]?.n);

async function ask(page: Page): Promise<void> {
  const form = page.getByRole('form', { name: vi['sas.overrides.form.aria'] });
  await form.getByLabel(vi['sas.overrides.field.feature'], { exact: true }).selectOption('ai.analysis');
  await form.getByLabel(vi['sas.overrides.field.enabled']).check();
  await form.getByLabel(vi['sas.overrides.field.from']).fill(local(-HOUR_MS));
  await form.getByLabel(vi['sas.overrides.field.until']).fill(local(7 * DAY_MS));
  await form.getByLabel(vi['sas.overrides.field.reason']).fill(MARKER);
  await form.getByRole('button', { name: vi['sas.overrides.request.action'] }).click();
}

async function decide(page: Page, rowId: string, action: 'approve' | 'reject' | 'revoke', reason: string): Promise<void> {
  const labels = { approve: vi['sas.overrides.approve.action'], reject: vi['sas.overrides.reject.action'], revoke: vi['sas.overrides.revoke.action'] };
  const confirm = { approve: vi['sas.overrides.decision.confirm.approve'], reject: vi['sas.overrides.decision.confirm.reject'], revoke: vi['sas.overrides.decision.confirm.revoke'] };
  await page.locator(`tr[data-override-id="${rowId}"]`).getByRole('button', { name: labels[action] }).click();
  const form = page.getByRole('form', { name: vi['sas.overrides.decision.aria'] });
  await form.getByLabel(vi['sas.overrides.decision.reason']).fill(reason);
  await form.getByRole('button', { name: confirm[action] }).click();
}

test.describe('SAS-25 entitlement overrides', () => {
  test.beforeEach(async () => {
    await clear(stackInfo().tenants.A);
  });
  test.afterAll(async () => {
    await clear(stackInfo().tenants.A);
  });

  test('one administrator asks, a second one approves, the table shows the override as the source, and either may end it (UAT-AC157, UAT-AC158)', async ({ browser }) => {
    const tenantId = stackInfo().tenants.A;
    const versionsBefore = await versionsOf(tenantId);

    const first = await (await browser.newContext()).newPage();
    await open(first, 'sysAdmin', tenantId);
    await expect(first.getByRole('heading', { level: 2, name: vi['sas.overrides.title'] })).toBeVisible();
    await ask(first);
    await expect(first.getByText(vi['sas.overrides.done.requested'])).toBeVisible();
    const asked = await waitingOf(tenantId);
    expect(asked).toMatchObject({ status: 'PendingApproval', requested_by: REQUESTER, approved_by: null, enabled: true, version: '1' });
    const row = first.locator(`tr[data-override-id="${asked?.id}"]`);
    await expect(row).toHaveAttribute('data-status', 'PendingApproval');
    await expect(row).toContainText(vi['sas.overrides.status.pending']);
    await expect(row).toContainText(vi['sas.overrides.people.requested'].replace('{person}', vi['sas.overrides.people.you']));
    // The one who asked is offered nothing to decide, only to withdraw.
    await expect(row.getByRole('button', { name: vi['sas.overrides.approve.action'] })).toHaveCount(0);
    await expect(row.getByRole('button', { name: vi['sas.overrides.reject.action'] })).toHaveCount(0);
    await expect(row.getByText(vi['sas.overrides.self.notice'])).toBeVisible();
    expect(await versionsOf(tenantId)).toBe(versionsBefore);

    const second = await (await browser.newContext()).newPage();
    await open(second, 'billingAdmin', tenantId);
    const theirs = second.locator(`tr[data-override-id="${asked?.id}"]`);
    await expect(theirs.getByRole('button', { name: vi['sas.overrides.approve.action'] })).toBeVisible();
    await decide(second, asked?.id ?? '', 'approve', 'Đã kiểm tra, cho chạy thử tính năng phân tích');
    await expect(second.getByText(vi['sas.overrides.done.approved'])).toBeVisible();
    await expect(theirs).toHaveAttribute('data-status', 'Active');
    await expect(theirs).toContainText(vi['sas.overrides.status.active']);
    await expect(theirs).toContainText(vi['sas.overrides.people.approved'].replace('{person}', vi['sas.overrides.people.you']));
    const approved = (await rowsOf(tenantId)).find((row) => row.id === asked?.id);
    expect(approved).toMatchObject({ status: 'Active', approved_by: APPROVER, requested_by: REQUESTER, version: '2' });
    expect(await versionsOf(tenantId)).toBe(versionsBefore + 1);
    // The table of entitlements above reads the override as the source of the feature.
    await expect(second.locator('tr[data-feature="ai.analysis"]')).toContainText(vi['sas.entitlements.source.override']);

    // The first administrator sees the decision and ends the override.
    await first.reload();
    await first.waitForSelector('tr[data-override-id]');
    await expect(first.locator(`tr[data-override-id="${asked?.id}"]`)).toHaveAttribute('data-status', 'Active');
    await decide(first, asked?.id ?? '', 'revoke', 'Hết đợt chạy thử tính năng phân tích');
    await expect(first.getByText(vi['sas.overrides.done.revoked'])).toBeVisible();
    await expect(first.locator(`tr[data-override-id="${asked?.id}"]`)).toHaveAttribute('data-status', 'Revoked');
    expect((await rowsOf(tenantId)).find((row) => row.id === asked?.id)).toMatchObject({ status: 'Revoked', approved_by: APPROVER, version: '3' });
    expect(await versionsOf(tenantId)).toBe(versionsBefore + 2);
    await expect(first.locator('tr[data-feature="ai.analysis"]')).toContainText(vi['sas.entitlements.source.plan']);
    await first.context().close();
    await second.context().close();
  });

  test('the second administrator may reject a request, which tells the tenant nothing', async ({ browser }) => {
    const tenantId = stackInfo().tenants.A;
    const versionsBefore = await versionsOf(tenantId);
    const first = await (await browser.newContext()).newPage();
    await open(first, 'sysAdmin', tenantId);
    await ask(first);
    await expect(first.getByText(vi['sas.overrides.done.requested'])).toBeVisible();
    const asked = await waitingOf(tenantId);
    const second = await (await browser.newContext()).newPage();
    await open(second, 'billingAdmin', tenantId);
    await decide(second, asked?.id ?? '', 'reject', 'Chưa đủ căn cứ để mở tính năng phân tích');
    await expect(second.getByText(vi['sas.overrides.done.rejected'])).toBeVisible();
    await expect(second.locator(`tr[data-override-id="${asked?.id}"]`)).toHaveAttribute('data-status', 'Rejected');
    expect((await rowsOf(tenantId)).find((row) => row.id === asked?.id)).toMatchObject({ status: 'Rejected', approved_by: null });
    expect(await versionsOf(tenantId)).toBe(versionsBefore);
    await first.context().close();
    await second.context().close();
  });

  test('a request is checked before it is sent', async ({ page }) => {
    const tenantId = stackInfo().tenants.A;
    // The ones that ended in the cases before stay (an override is never deleted): the check is that no new one appears.
    const before = (await rowsOf(tenantId)).length;
    await open(page, 'sysAdmin', tenantId);
    const form = page.getByRole('form', { name: vi['sas.overrides.form.aria'] });
    await form.getByRole('button', { name: vi['sas.overrides.request.action'] }).click();
    await expect(form.getByText(vi['sas.overrides.fieldError.reasonLength'])).toBeVisible();
    await expect(form.getByText(vi['sas.overrides.fieldError.required']).first()).toBeVisible();
    expect(await rowsOf(tenantId)).toHaveLength(before);
  });

  test('a reader of the platform sees the overrides and has nothing to ask for or decide', async ({ page }) => {
    const tenantId = stackInfo().tenants.A;
    await sql(
      `insert into machvon.entitlement_override (tenant_id, id, feature_code, enabled, reason, valid_from, valid_until, status, requested_by)
       values ($1, gen_random_uuid(), 'ai.analysis', true, $2, now() - interval '1 hour', now() + interval '7 days', 'PendingApproval', gen_random_uuid())`,
      [tenantId, MARKER],
    );
    await open(page, 'operator', tenantId);
    await expect(page.locator('tr[data-override-id]').first()).toBeVisible();
    await expect(page.getByRole('form', { name: vi['sas.overrides.form.aria'] })).toHaveCount(0);
    await expect(page.getByText(vi['sas.overrides.form.denied'])).toBeVisible();
    await expect(page.locator('tr[data-override-id]').getByRole('button')).toHaveCount(0);
  });
});
