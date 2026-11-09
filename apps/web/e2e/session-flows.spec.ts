import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * The real sign-in in a browser: the application redirects to the test identity provider the API stack runs
 * (authorization code flow with PKCE), comes back on the callback address, shows the memberships of the person as the
 * tenant chooser (IAM-04) and works with the tenant token the API issued. `?session=oidc` switches a development build
 * from the development session to the provider; every other flow keeps the development session.
 *
 * The fixture owner belongs to three tenants: Cao Bằng (Active), Lào Cai (Active) and Hà Giang (suspended for
 * non-payment, so a read-only session). The provider signs the person in at aal1; the owner role needs a second factor
 * to choose a tenant, which the provider grants when the request asks for `acr_values=aal2`.
 */

const ADM_01 = '/adm/adm-01';

async function openSignIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${ADM_01}?session=oidc`);
}

async function signIn(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: vi['states.signedOut.title'] })).toBeVisible();
  await page.getByRole('button', { name: vi['session.oidc.signIn.action'] }).click();
  await page.waitForURL(/\/iam\/iam-04/);
  await expect(page.getByRole('heading', { level: 1, name: vi['iam.tenantChooser.page.title'] })).toBeVisible();
}

const chooseButton = (page: Page, name: string) => page.getByRole('button', { name: vi['iam.tenantChooser.select.label'].replace('{name}', name) });

/** Chooses a tenant; the first choice of a session at aal1 is refused with MFA_REQUIRED and goes through the provider once more. */
async function choose(page: Page, name: string): Promise<void> {
  await chooseButton(page, name).click();
  await expect(page.getByRole('alertdialog', { name: vi['adm.roles.stepUp.title'] })).toBeVisible();
  await page.getByRole('button', { name: vi['adm.roles.stepUp.confirm.action'] }).click();
  await page.waitForURL(/\/iam\/iam-04\?next=/);
  await expect(page.getByRole('heading', { level: 1, name: vi['iam.tenantChooser.page.title'] })).toBeVisible();
  await chooseButton(page, name).click();
}

function claimsOf(request: Request): Record<string, unknown> {
  const bearer = request.headers().authorization ?? '';
  return JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

test.describe('sign in with the identity provider and choose a tenant (IAM-04)', () => {
  test('the owner signs in, gives the second factor, chooses Cao Bằng and works with the tenant token', async ({ page }) => {
    const { tenants } = stackInfo();
    const reads: Request[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes('/api/resources/organization_unit')) reads.push(request);
    });

    const earlier = (await sql<{ id: string }>('select id from machvon.user_session where tenant_id = $1 and membership_id = $2', [tenants.A, membershipOf('owner')])).map((row) => row.id);
    await openSignIn(page);
    await signIn(page);

    // The chooser lists the memberships from the API: a card per tenant, the suspended one offered read-only.
    await expect(page.locator('article[data-tenant-id]')).toHaveCount(3);
    await expect(page.locator(`article[data-tenant-id="${tenants.A}"]`)).toHaveAttribute('data-selectability', 'selectable');
    await expect(page.locator(`article[data-tenant-id="${tenants.B}"]`)).toHaveAttribute('data-selectability', 'selectable');
    await expect(page.locator(`article[data-tenant-id="${tenants.C}"]`)).toHaveAttribute('data-selectability', 'readOnly');
    await expect(page.locator(`article[data-tenant-id="${tenants.C}"]`)).toContainText(vi['iam.tenantChooser.readOnly.note']);

    await choose(page, 'Cao Bằng');
    // The person lands on the screen they came for, with the data of the chosen tenant.
    await page.waitForURL(new RegExp(`${ADM_01}`));
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.orgUnit.page.title'] })).toBeVisible();
    // The unit flows of the same run add units to this tenant, so the seeded ones are looked for by code, not counted.
    await expect(page.getByRole('tree').getByRole('treeitem').filter({ hasText: 'CB-SKHDT-QLDA' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: vi['adm.orgUnit.create.action'] })).toBeVisible();

    // What the API saw was a real tenant token of Cao Bằng, issued after the second factor.
    const claims = claimsOf(reads[reads.length - 1] as Request);
    expect(claims).toMatchObject({ tid: tenants.A, mid: membershipOf('owner'), mode: 'FULL', acr: 'aal2' });
    // Sessions of the owner that earlier specs of the same run left behind (the manager application signs in as the owner too) are not this sign-in's.
    const sessions = await sql<{ assurance_level: string; revoked_at: string | null }>(
      'select assurance_level, revoked_at from machvon.user_session where tenant_id = $1 and membership_id = $2 and id <> all($3::uuid[])',
      [tenants.A, membershipOf('owner'), earlier],
    );
    expect(sessions).toEqual([{ assurance_level: 'aal2', revoked_at: null }]);
  });

  test('the suspended tenant opens in read-only mode: the data is there, the way to change it is not (AC-ST-IAM-003-3)', async ({ page }) => {
    const { tenants } = stackInfo();
    const reads: Request[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes('/api/resources/organization_unit')) reads.push(request);
    });

    await openSignIn(page);
    await signIn(page);
    await choose(page, 'Hà Giang');

    await page.waitForURL(new RegExp(`${ADM_01}`));
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.orgUnit.page.title'] })).toBeVisible();
    await expect(page.getByRole('tree').getByRole('treeitem')).toHaveCount(2);
    await expect(page.getByRole('button', { name: vi['adm.orgUnit.create.action'] })).toHaveCount(0);
    expect(claimsOf(reads[reads.length - 1] as Request)).toMatchObject({ tid: tenants.C, mode: 'READ_ONLY' });
  });

  test('a person who is not signed in sees only the way in, and a refusal of the provider answer shows the callback error', async ({ page }) => {
    await openSignIn(page);
    await expect(page.getByRole('button', { name: vi['session.oidc.signIn.action'] })).toBeVisible();
    await expect(page.getByRole('tree')).toHaveCount(0);

    // An answer that does not belong to any sign-in this browser started is refused without saying why.
    await page.goto('/auth/callback?code=forged&state=forged');
    await expect(page.getByRole('alert')).toContainText(vi['session.oidc.callback.error.title']);
    await expect(page.getByRole('alert')).not.toContainText('forged');
  });
});
