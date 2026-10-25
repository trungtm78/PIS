import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql, stackInfo } from './support/stack.ts';

/**
 * SAS-12, SAS-13, SAS-14, SAS-15 and SAS-16 (issue a license, read it, renew it, suspend, reinstate and revoke it, and read its history) in a real browser against the real
 * API and database (apps/api/test/e2e-stack). The stack signs with a key of its own that lives in the process. Every flow
 * works on a tenant of its own with an entitlement version, so the fixture tenants the other specs read keep their state.
 */

const DAY_MS = 86_400_000;
const REASON = 'The contract was terminated by the agency.';
const unique = (): string => `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const dateIn = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

/** An Active tenant of its own with the first entitlement version, as the provisioning saga leaves it. */
async function licensableTenant(): Promise<{ id: string; code: string }> {
  const code = `license-${unique()}`;
  const rows = await sql<{ id: string }>(
    "insert into machvon.tenant (id, code, name, status, placement_id, region) select gen_random_uuid(), $1, $1, 'Active', id, 'vn-north' from machvon.placement limit 1 returning id",
    [code],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no placement to put the tenant on');
  await sql(
    "insert into machvon.entitlement_version (tenant_id, id, version_no, plan_version_id, features_json, entitlements_hash, cause, effective_from) values ($1, gen_random_uuid(), 1, $2, '[]'::jsonb, repeat('a', 64), 'PROVISIONING', now())",
    [id, stackInfo().planVersionId],
  );
  return { id, code };
}

interface LicenseRow {
  id: string;
  serial: string;
  status: string;
  status_reason: string | null;
  version: string;
  signed_claims: string;
}

const licensesOf = (tenantId: string): Promise<LicenseRow[]> =>
  sql<LicenseRow>('select id, serial, status, status_reason, version::text as version, signed_claims from machvon.license_revision where tenant_id = $1 order by revision, serial', [tenantId]);

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function issueLicense(page: Page, tenantId: string, overrides: { from?: string; until?: string; grace?: string } = {}): Promise<void> {
  await open(page, `/sas/sas-12?tenant=${tenantId}`, 'sysAdmin');
  await expect(page.getByLabel(vi['sas.licenseIssue.entitlement.label'], { exact: true })).toHaveValue(vi['sas.licenseIssue.entitlement.current'].replace('{version}', '1'));
  await page.getByLabel(vi['sas.licenseIssue.validFrom.label'], { exact: true }).fill(overrides.from ?? dateIn(-1));
  await page.getByLabel(vi['sas.licenseIssue.validUntil.label'], { exact: true }).fill(overrides.until ?? dateIn(365));
  await page.getByLabel(vi['sas.licenseIssue.graceUntil.label'], { exact: true }).fill(overrides.grace ?? dateIn(395));
  await page.getByRole('button', { name: vi['sas.licenseIssue.submit.action'] }).click();
}

test.describe('SAS-12 issue, SAS-13 detail and SAS-15 suspend, reinstate and revoke a license', () => {
  test('a system administrator issues a license, reads it, suspends it, reinstates it and revokes it, and every step is on record', async ({ page }) => {
    const { id: tenantId } = await licensableTenant();
    await open(page, `/sas/sas-12?tenant=${tenantId}`, 'sysAdmin');
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.licenseIssue.page.title'] })).toBeVisible();

    // A window that ends before it starts never leaves the browser.
    await page.getByLabel(vi['sas.licenseIssue.validFrom.label'], { exact: true }).fill(dateIn(10));
    await page.getByLabel(vi['sas.licenseIssue.validUntil.label'], { exact: true }).fill(dateIn(5));
    await page.getByLabel(vi['sas.licenseIssue.graceUntil.label'], { exact: true }).fill(dateIn(40));
    await page.getByRole('button', { name: vi['sas.licenseIssue.submit.action'] }).click();
    await expect(page.getByText(vi['sas.licenseIssue.problem.window'])).toBeVisible();
    expect(await licensesOf(tenantId)).toHaveLength(0);

    await page.getByLabel(vi['sas.licenseIssue.validFrom.label'], { exact: true }).fill(dateIn(-1));
    await page.getByLabel(vi['sas.licenseIssue.validUntil.label'], { exact: true }).fill(dateIn(365));
    await page.getByLabel(vi['sas.licenseIssue.graceUntil.label'], { exact: true }).fill(dateIn(395));
    await page.getByLabel(vi['sas.licenseIssue.seats.label'], { exact: true }).fill('25');
    await page.getByRole('button', { name: vi['sas.licenseIssue.submit.action'] }).click();
    await expect(page.getByText(vi['sas.licenseIssue.accepted.link'])).toBeVisible();
    const issued = await licensesOf(tenantId);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ status: 'Issued', version: '1' });
    expect(issued[0]?.signed_claims.split('.')).toHaveLength(3);

    // The detail: the server judges the window by its own clock (Active), the signature verifies with the registered key.
    await page.getByRole('link', { name: vi['sas.licenseIssue.accepted.link'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.licenseDetail.page.title'] })).toBeVisible();
    await expect(page.getByText(issued[0]?.serial ?? 'missing', { exact: true })).toBeVisible();
    await expect(page.locator('[data-license-status="Active"]')).toHaveText(vi['sas.license.status.active']);
    await expect(page.locator('[data-signature-check="VALID"]')).toHaveText(vi['sas.license.signature.valid']);

    // Suspend: the reason needs 10 characters, then one command with the version the screen showed.
    await page.getByRole('link', { name: vi['sas.licenseDetail.actions.change'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.licenseAction.page.title'] })).toBeVisible();
    await page.getByLabel(vi['sas.licenseAction.field.reason'], { exact: true }).fill('too short');
    await page.getByRole('button', { name: vi['sas.licenseAction.submit.action'].replace('{action}', vi['sas.licenseAction.action.suspend']) }).click();
    await expect(page.getByText(vi['sas.licenseAction.reason.tooShort'])).toBeVisible();
    expect((await licensesOf(tenantId))[0]?.status).toBe('Issued');
    await page.getByLabel(vi['sas.licenseAction.field.reason'], { exact: true }).fill(REASON);
    await page.getByRole('button', { name: vi['sas.licenseAction.submit.action'].replace('{action}', vi['sas.licenseAction.action.suspend']) }).click();
    await expect(page.getByText(vi['sas.licenseAction.done.notice'].replace('{action}', vi['sas.licenseAction.action.suspend']).replace('{version}', '2'))).toBeVisible();
    expect((await licensesOf(tenantId))[0]).toMatchObject({ status: 'Suspended', status_reason: REASON, version: '2' });
    expect(await sql("select count(*)::int as n from machvon.audit_event where tenant_id = $1 and action = 'license.suspended' and outcome = 'SUCCESS' and reason = $2", [tenantId, REASON])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.license.suspended.v1'", [tenantId])).toEqual([{ n: 1 }]);

    // The screen now offers what a suspended license allows: reinstate (first) or revoke.
    await expect(page.getByRole('radio', { name: vi['sas.licenseAction.action.reinstate'] })).toBeChecked();
    await expect(page.getByRole('radio', { name: vi['sas.licenseAction.action.suspend'] })).toHaveCount(0);
    await page.getByLabel(vi['sas.licenseAction.field.reason'], { exact: true }).fill(REASON);
    await page.getByRole('button', { name: vi['sas.licenseAction.submit.action'].replace('{action}', vi['sas.licenseAction.action.reinstate']) }).click();
    await expect(page.getByText(vi['sas.licenseAction.done.notice'].replace('{action}', vi['sas.licenseAction.action.reinstate']).replace('{version}', '3'))).toBeVisible();
    expect((await licensesOf(tenantId))[0]).toMatchObject({ status: 'Active', status_reason: null, version: '3' });

    // Revoke is for good: it needs the confirmation, then no action is left.
    await page.getByRole('radio', { name: vi['sas.licenseAction.action.revoke'] }).check();
    await page.getByLabel(vi['sas.licenseAction.field.reason'], { exact: true }).fill(REASON);
    await page.getByRole('button', { name: vi['sas.licenseAction.submit.action'].replace('{action}', vi['sas.licenseAction.action.revoke']) }).click();
    await expect(page.getByText(vi['sas.licenseAction.revoke.unconfirmed'])).toBeVisible();
    expect((await licensesOf(tenantId))[0]?.status).toBe('Active');
    await page.getByLabel(vi['sas.licenseAction.revoke.confirm']).check();
    await page.getByRole('button', { name: vi['sas.licenseAction.submit.action'].replace('{action}', vi['sas.licenseAction.action.revoke']) }).click();
    await expect(page.getByText(vi['sas.licenseAction.none.notice'].replace('{status}', vi['sas.license.status.revoked']))).toBeVisible();
    expect((await licensesOf(tenantId))[0]).toMatchObject({ status: 'Revoked', status_reason: REASON, version: '4' });
    expect((await sql<{ action: string }>("select action from machvon.audit_event where tenant_id = $1 and action like 'license.%' and outcome = 'SUCCESS' order by occurred_at", [tenantId])).map((row) => row.action)).toEqual([
      'license.issued',
      'license.suspended',
      'license.reinstated',
      'license.revoked',
    ]);

    await page.getByRole('link', { name: vi['sas.licenseAction.done.link'] }).click();
    await expect(page.locator('[data-license-status="Revoked"]')).toHaveText(vi['sas.license.status.revoked']);
    await expect(page.getByText(vi['sas.licenseDetail.actions.none'])).toBeVisible();
  });

  test('a system administrator renews a license: revision 2 takes its place, revision 1 is kept as Superseded, both signatures verify and the history shows the chain (AC-ST-SAS-014-1, AC-ST-SAS-014-3, UAT-AC160, UI-SAS-14, UI-SAS-16)', async ({ page }) => {
    const { id: tenantId } = await licensableTenant();
    await issueLicense(page, tenantId);
    await expect(page.getByText(vi['sas.licenseIssue.accepted.link'])).toBeVisible();
    const [first] = await licensesOf(tenantId);
    await open(page, `/sas/sas-13?license=${first?.id}`, 'sysAdmin');
    await page.getByRole('link', { name: vi['sas.licenseDetail.actions.renew'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.licenseRenew.page.title'] })).toBeVisible();
    await expect(page.getByTestId('current')).toContainText(first?.serial ?? 'missing');

    // An end that is not later than the current one never leaves the browser.
    await page.getByLabel(vi['sas.licenseRenew.field.validUntil'], { exact: true }).fill(dateIn(100));
    await page.getByLabel(vi['sas.licenseRenew.field.graceUntil'], { exact: true }).fill(dateIn(130));
    await page.getByLabel(vi['sas.licenseRenew.field.reason'], { exact: true }).fill(REASON);
    await page.getByRole('button', { name: vi['sas.licenseRenew.submit.action'] }).click();
    await expect(page.getByText(vi['sas.licenseRenew.problem.notLater'])).toBeVisible();
    expect(await licensesOf(tenantId)).toHaveLength(1);

    await page.getByLabel(vi['sas.licenseRenew.field.validUntil'], { exact: true }).fill(dateIn(730));
    await page.getByLabel(vi['sas.licenseRenew.field.graceUntil'], { exact: true }).fill(dateIn(760));
    await page.getByLabel(vi['sas.licenseRenew.field.seats'], { exact: true }).fill('40');
    await page.getByRole('button', { name: vi['sas.licenseRenew.submit.action'] }).click();
    await expect(page.getByTestId('renewed')).toContainText(vi['sas.licenseRenew.done.notice'].replace('{version}', '1'));
    const chain = await sql<{ revision: number; status: string; supersedes_id: string | null; seats: number | null }>(
      'select revision, status, supersedes_id, seats from machvon.license_revision where tenant_id = $1 order by revision',
      [tenantId],
    );
    expect(chain).toEqual([
      { revision: 1, status: 'Superseded', supersedes_id: null, seats: null },
      { revision: 2, status: 'Issued', supersedes_id: first?.id, seats: 40 },
    ]);
    expect(await sql("select count(*)::int as n from machvon.audit_event where tenant_id = $1 and action = 'license.renewed' and outcome = 'SUCCESS' and reason = $2", [tenantId, REASON])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.license.renewed.v1'", [tenantId])).toEqual([{ n: 1 }]);

    // The history: both revisions in order, the second in force and replacing the first, both signatures true.
    await page.getByRole('link', { name: vi['sas.licenseRenew.done.link'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.licenseHistory.page.title'] })).toBeVisible();
    const items = page.locator('[data-testid="chain"] li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).locator('[data-license-status="Superseded"]')).toHaveText(vi['sas.license.status.superseded']);
    await expect(items.nth(1).locator('[data-license-status="Active"]')).toHaveText(vi['sas.license.status.active']);
    await expect(items.nth(1).getByTestId('current-mark')).toContainText(vi['sas.licenseHistory.current.label']);
    await expect(items.nth(1).getByTestId('supersedes')).toHaveText(vi['sas.licenseHistory.supersedes.text'].replace('{revision}', '1'));
    await expect(page.locator('[data-signature-check="VALID"]')).toHaveCount(2);
    await expect(page.getByTestId('slo')).toContainText(vi['sas.licenseHistory.slo.text']);
    await expect(items.nth(1).getByRole('link', { name: vi['sas.licenseHistory.renew.action'] })).toBeVisible();
    await expect(items.nth(0).getByRole('link', { name: vi['sas.licenseHistory.renew.action'] })).toHaveCount(0);
  });

  test('a platform operator reads the history of a tenant and has no way to renew a license (UI-SAS-14, UI-SAS-16)', async ({ page }) => {
    const { id: tenantId } = await licensableTenant();
    await issueLicense(page, tenantId);
    await expect(page.getByText(vi['sas.licenseIssue.accepted.link'])).toBeVisible();
    const [license] = await licensesOf(tenantId);
    await open(page, `/sas/sas-16?tenant=${tenantId}`, 'operator');
    await expect(page.locator('[data-testid="chain"] li')).toHaveCount(1);
    await expect(page.getByRole('link', { name: vi['sas.licenseHistory.renew.action'] })).toHaveCount(0);
    await open(page, `/sas/sas-14?license=${license?.id}`, 'operator');
    await expect(page.getByText(vi['sas.licenseRenew.readOnly.notice'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['sas.licenseRenew.submit.action'] })).toBeDisabled();
    expect(await licensesOf(tenantId)).toHaveLength(1);
  });

  test('a window that overlaps a license of the tenant is refused on its field and keeps what was typed', async ({ page }) => {
    const { id: tenantId } = await licensableTenant();
    await issueLicense(page, tenantId);
    await expect(page.getByText(vi['sas.licenseIssue.accepted.link'])).toBeVisible();
    expect(await licensesOf(tenantId)).toHaveLength(1);

    await page.getByLabel(vi['sas.licenseIssue.tenant.label'], { exact: true }).selectOption(tenantId);
    await page.getByLabel(vi['sas.licenseIssue.validFrom.label'], { exact: true }).fill(dateIn(100));
    await page.getByLabel(vi['sas.licenseIssue.validUntil.label'], { exact: true }).fill(dateIn(500));
    await page.getByLabel(vi['sas.licenseIssue.graceUntil.label'], { exact: true }).fill(dateIn(530));
    await page.getByRole('button', { name: vi['sas.licenseIssue.submit.action'] }).click();
    await expect(page.locator('[data-field="valid_from"] .field-error')).toHaveText(vi['sas.license.error.rangeInvalid']);
    await expect(page.getByLabel(vi['sas.licenseIssue.validUntil.label'], { exact: true })).toHaveValue(dateIn(500));
    expect(await licensesOf(tenantId)).toHaveLength(1);
  });

  test('a platform operator reads the licenses of a tenant and has no way to issue or change one', async ({ page }) => {
    const { id: tenantId } = await licensableTenant();
    await issueLicense(page, tenantId);
    await expect(page.getByText(vi['sas.licenseIssue.accepted.link'])).toBeVisible();
    const [license] = await licensesOf(tenantId);

    await open(page, `/sas/sas-13?tenant=${tenantId}`, 'operator');
    const row = page.locator('tr', { hasText: license?.serial ?? 'missing' });
    await expect(row).toBeVisible();
    await expect(row.getByText(vi['sas.license.signature.valid'])).toBeVisible();
    await row.getByRole('link', { name: vi['sas.licenseDetail.open.action'] }).click();
    await expect(page.getByText(vi['sas.licenseDetail.readOnly.notice'])).toBeVisible();
    await expect(page.getByRole('link', { name: vi['sas.licenseDetail.actions.change'] })).toHaveCount(0);

    await open(page, `/sas/sas-12?tenant=${tenantId}`, 'operator');
    await expect(page.getByText(vi['sas.licenseIssue.readOnly.notice'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['sas.licenseIssue.submit.action'] })).toHaveCount(0);
  });

  test('a tenant user is refused the licenses of the control plane', async ({ page }) => {
    const { id: tenantId } = await licensableTenant();
    await open(page, `/sas/sas-13?tenant=${tenantId}`, 'owner');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
  });
});
