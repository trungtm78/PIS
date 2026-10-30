import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql, stackInfo } from './support/stack.ts';

/**
 * SAS-22 (provisioning progress) in a real browser against the real API stack: a tenant whose subdomain another tenant already
 * holds fails at the DNS step with DOMAIN_TAKEN, the screen names the step and its code and keeps the finished steps, and once the
 * hostname is free the retry resumes at that step and the tenant becomes Active.
 */

const REASON = 'The hostname was released by the other tenant.';
const unique = (): string => `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const TIMEOUT = 60_000;

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function requestTenant(page: Page, code: string, subdomain: string): Promise<void> {
  await open(page, '/sas/sas-02', 'sysAdmin');
  await page.getByLabel(vi['sas.tenantCreate.name.label'], { exact: true }).fill(`Tenant ${code}`);
  await page.getByLabel(vi['sas.tenantCreate.owner.label'], { exact: true }).fill(`owner-${code}@example.org`);
  await page.getByLabel(vi['sas.tenantCreate.plan.label'], { exact: true }).fill(stackInfo().planVersionId);
  await page.getByLabel(vi['sas.tenantCreate.code.label'], { exact: true }).fill(code);
  await page.getByLabel(vi['sas.tenantCreate.rootUnit.label'], { exact: true }).fill(`Root ${code}`);
  await page.getByLabel(vi['sas.tenantCreate.subdomain.label'], { exact: true }).fill(subdomain);
  await page.getByRole('button', { name: vi['sas.tenantCreate.submit.action'] }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Requested' })).toBeVisible();
}

const statusOf = async (code: string): Promise<string | undefined> => (await sql<{ status: string }>('select status from machvon.tenant where code = $1', [code]))[0]?.status;

test.describe('SAS-22 provisioning progress', () => {
  test('a failed step is named with its code, finished steps are kept, and the retry resumes there until the tenant is Active', async ({ page }) => {
    const code = `prov-${unique()}`;
    const subdomain = `taken-${unique()}`;
    const hostname = `${subdomain}.machvon.vn`;
    // Another tenant holds the hostname: the DNS step is refused for good (DOMAIN_TAKEN), a refusal the saga does not retry.
    await sql("insert into machvon.tenant_domain (tenant_id, id, hostname, kind, status, tls_status, verified_at) values ($1, gen_random_uuid(), $2, 'PLATFORM_SUBDOMAIN', 'Active', 'Issued', now())", [stackInfo().tenants.A, hostname]);
    await requestTenant(page, code, subdomain);
    await expect.poll(() => statusOf(code), { timeout: TIMEOUT }).toBe('Failed');
    const id = (await sql<{ id: string }>('select id from machvon.tenant where code = $1', [code]))[0]?.id ?? '';

    await open(page, `/sas/sas-22?tenant=${id}`, 'sysAdmin');
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.provisioning.page.title'] })).toBeVisible();
    await expect(page.locator('[data-failed-step="DNS_SUBDOMAIN"]')).toHaveText(
      vi['sas.provisioning.failed.notice'].replace('{step}', vi['sas.tenants.step.dnsTls']).replace('{code}', 'DOMAIN_TAKEN'),
    );
    await expect(page.locator('tr[data-step="IDP_ORG"]')).toHaveAttribute('data-step-status', 'DONE');
    await expect(page.locator('tr[data-step="DNS_SUBDOMAIN"]')).toHaveAttribute('data-step-status', 'FAILED');
    await expect(page.locator('tr[data-step="STORAGE_PREFIX"]')).toHaveAttribute('data-step-status', 'PENDING');
    expect(await sql("select count(*)::int as n from machvon.license_revision where tenant_id = $1", [id])).toEqual([{ n: 0 }]);

    // A platform operator sees the same run and has no way to retry it.
    await open(page, `/sas/sas-22?tenant=${id}`, 'operator');
    await expect(page.getByText(vi['sas.provisioning.readOnly.notice'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['sas.tenants.retry.submit'] })).toHaveCount(0);

    // The hostname is free again: the retry starts attempt 2 at the failed step and the saga runs the rest.
    // A domain is released, never deleted: the other tenant gives the name up long enough ago for its hold of 90 days to be over.
    await sql("update machvon.tenant_domain set status = 'Revoked', revoked_at = now() - interval '91 days' where hostname = $1", [hostname]);
    await open(page, `/sas/sas-22?tenant=${id}`, 'sysAdmin');
    await page.getByLabel(vi['sas.tenants.retry.reason.label']).fill('too short');
    await page.getByRole('button', { name: vi['sas.tenants.retry.submit'] }).click();
    await expect(page.getByText(vi['sas.tenants.retry.reason.tooShort'])).toBeVisible();
    expect(await statusOf(code)).toBe('Failed');
    await page.getByLabel(vi['sas.tenants.retry.reason.label']).fill(REASON);
    await page.getByRole('button', { name: vi['sas.tenants.retry.submit'] }).click();
    await expect(page.getByText(vi['sas.provisioning.retry.started.notice'])).toBeVisible();
    await expect.poll(() => statusOf(code), { timeout: TIMEOUT }).toBe('Active');

    // The screen follows the run to its end on its own: every step DONE, the notice of an active tenant, attempt 2.
    await expect(page.getByText(vi['sas.provisioning.active.notice'])).toBeVisible({ timeout: TIMEOUT });
    await expect(page.locator('tr[data-step-status="DONE"]')).toHaveCount(11);
    await expect(page.getByText(vi['sas.provisioning.attempt.text'].replace('{attempt}', '2'))).toBeVisible();
    expect(await sql("select count(*)::int as n from machvon.license_revision where tenant_id = $1", [id])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from machvon.tenant_provisioning_run where tenant_id = $1", [id])).toEqual([{ n: 2 }]);
    // Steps that were DONE in attempt 1 were not run again: one attempt each.
    const second = await sql<{ steps_json: Record<string, { attempts: number }> }>('select steps_json from machvon.tenant_provisioning_run where tenant_id = $1 and attempt = 2', [id]);
    expect(second[0]?.steps_json.IDP_ORG?.attempts).toBe(1);
  });

  test('the detail of a tenant leads to its progress, and a tenant user is refused', async ({ page }) => {
    await open(page, `/sas/sas-03?tenant=${stackInfo().tenants.A}`, 'sysAdmin');
    await page.getByRole('link', { name: vi['sas.tenantDetail.provisioning.link'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.provisioning.page.title'] })).toBeVisible();
    await open(page, `/sas/sas-22?tenant=${stackInfo().tenants.A}`, 'owner');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
  });
});
