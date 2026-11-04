import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { RECIPIENT_MEMBERSHIP, membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * The ADM-01 and ADM-03 flows in a real browser against the real API and database (apps/api/test/e2e-stack): the
 * fixture users are picked with `?devUser=`, every request is authorised by the policy guard, and what the screens
 * changed is looked up in the database.
 */

/** The id of a seeded unit of tenant A by its code. */
function unitOf(code: string): string {
  const unit = stackInfo().units.A[code];
  if (unit === undefined) throw new Error(`seeded unit ${code} is missing`);
  return unit;
}
const unique = (): string => Date.now().toString(36).toUpperCase();

async function openScreen(page: Page, screen: 'adm-01' | 'adm-03', user: string, extraQuery = ''): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/adm/${screen}?devUser=${user}${extraQuery}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const unitRow = (code: string): Promise<{ id: string; parent_id: string | null; path: string; depth: number }[]> =>
  sql('select id, parent_id, path, depth from machvon.organization_unit where code = $1', [code]);

test.describe('ADM-01 organisation tree', () => {
  test('the tenant owner creates a unit, moves it under another and sees the tree follow', async ({ page }) => {
    const code = `E2E-${unique()}`;
    await openScreen(page, 'adm-01', 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.orgUnit.page.title'] })).toBeVisible();
    const tree = page.getByRole('tree');
    await expect(tree.getByRole('treeitem')).toHaveCount(5);

    await page.getByRole('button', { name: vi['adm.orgUnit.create.action'] }).click();
    await page.locator('#unit-name').fill('Đơn vị kiểm thử e2e');
    await page.locator('#unit-code').fill(code);
    await page.locator('#unit-parent').selectOption(unitOf('CB-HQ'));
    await page.getByRole('button', { name: vi['adm.orgUnit.create.submit'] }).click();
    await expect(page.getByRole('status').filter({ hasText: vi['adm.orgUnit.saved.notice'] })).toBeVisible();
    await expect(tree.getByRole('treeitem')).toHaveCount(6);
    expect((await unitRow(code))[0]?.parent_id).toBe(unitOf('CB-HQ'));

    await page.getByRole('button', { name: vi['adm.orgUnit.move.action'] }).click();
    await page.locator('#move-parent').selectOption(unitOf('CB-STC'));
    await page.locator('#move-reason').fill('chuyển sang Sở Tài chính để kiểm thử luồng');
    await page.getByRole('button', { name: vi['adm.orgUnit.move.submit'], exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: vi['adm.orgUnit.moved.notice'] })).toBeVisible();

    const moved = (await unitRow(code))[0];
    expect(moved?.parent_id).toBe(unitOf('CB-STC'));
    expect(moved?.path).toBe(`/${unitOf('CB-HQ')}/${unitOf('CB-STC')}/${moved?.id}/`);
    expect(moved?.depth).toBe(2);
    // The tree shows the unit under its new parent: a treeitem is a row whose children sit in the group it owns (aria-owns), the group is not nested in the row.
    const financeId = unitOf('CB-STC');
    await expect(tree.locator(`[role="treeitem"][data-unit-id="${financeId}"]`)).toHaveAttribute('aria-owns', `unit-group-${financeId}`);
    await expect(tree.locator(`#unit-group-${financeId}`).getByRole('treeitem').filter({ hasText: code })).toBeVisible();
  });

  test('a move that would create a cycle is refused on the field and changes nothing', async ({ page }) => {
    await openScreen(page, 'adm-01', 'owner');
    await page.getByRole('treeitem').filter({ hasText: 'CB-SKHDT-QLDA' }).getByText('CB-SKHDT-QLDA').first().click();
    // Select the parent unit CB-SKHDT: its own descendant CB-SKHDT-VP is a target the server must refuse.
    await page.getByRole('treeitem', { name: /^CB-SKHDT Sở Kế hoạch/ }).getByText('CB-SKHDT', { exact: true }).first().click();
    await page.getByRole('button', { name: vi['adm.orgUnit.move.action'] }).click();
    await page.locator('#move-parent').selectOption(unitOf('CB-SKHDT-VP'));
    await page.locator('#move-reason').fill('thử tạo vòng trong cây tổ chức');
    await page.getByRole('button', { name: vi['adm.orgUnit.move.submit'], exact: true }).click();
    await expect(page.locator('#move-parent-error')).toHaveText(vi['adm.orgUnit.error.cycle']);
    // The dialog and what the user typed survive the refusal, and the tree in the database is untouched.
    await expect(page.locator('#move-reason')).toHaveValue('thử tạo vòng trong cây tổ chức');
    expect((await unitRow('CB-SKHDT'))[0]?.parent_id).toBe(unitOf('CB-HQ'));
  });

  test('a unit administrator sees only their own subtree and is offered no destination outside it', async ({ page }) => {
    await openScreen(page, 'adm-01', 'unitAdmin');
    const tree = page.getByRole('tree');
    await expect(tree.getByRole('treeitem', { name: /^CB-SKHDT-QLDA/ })).toBeVisible();
    await expect(tree).toContainText('CB-SKHDT-VP');
    await expect(tree).not.toContainText('CB-STC');
    await expect(tree).not.toContainText('CB-HQ');

    await tree.getByText('CB-SKHDT-QLDA').click();
    await page.getByRole('button', { name: vi['adm.orgUnit.move.action'] }).click();
    const options = await page.locator('#move-parent option').allTextContents();
    expect(options.some((text) => text.includes('CB-STC'))).toBe(false);
    expect(options.some((text) => text.includes('CB-HQ'))).toBe(false);
    expect(options.some((text) => text.includes('CB-SKHDT-VP'))).toBe(true);
  });

  test('a read-only user sees the tree without any control that changes it', async ({ page }) => {
    await openScreen(page, 'adm-01', 'auditor');
    await expect(page.getByRole('tree').getByRole('treeitem')).not.toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['adm.orgUnit.create.action'] })).toHaveCount(0);
    await page.getByRole('tree').getByText('CB-STC').click();
    for (const name of [vi['adm.orgUnit.update.submit'], vi['adm.orgUnit.create.submit'], vi['adm.orgUnit.move.action']]) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
  });
});

test.describe('ADM-03 roles and grants', () => {
  test('a unit administrator grants a lower role inside their subtree, passing the step-up with the same idempotency key', async ({ page }) => {
    const keys: string[] = [];
    const statuses: number[] = [];
    page.on('request', (request: Request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/role-grants')) keys.push(request.headers()['idempotency-key'] ?? '');
    });
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && response.url().endsWith('/api/role-grants')) statuses.push(response.status());
    });

    await openScreen(page, 'adm-03', 'unitAdmin');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.roles.page.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['adm.roles.action.grant'] }).first().click();
    const dialog = page.getByRole('dialog', { name: vi['adm.roles.grant.dialog.title'] });
    await expect(dialog).toBeVisible();

    // The picker offers only what the server would accept: no role at or above the administrator's own rank.
    const offered = await dialog.locator('#grant-role option').allTextContents();
    expect(offered.some((text) => text.includes('E2E_READER'))).toBe(true);
    for (const forbidden of ['TENANT_OWNER', 'TENANT_ADMIN', 'SECURITY_ADMIN', 'UNIT_ADMIN']) {
      expect(offered.some((text) => text.includes(forbidden))).toBe(false);
    }

    await dialog.locator('#grant-member').fill(RECIPIENT_MEMBERSHIP);
    await dialog.locator('#grant-role').selectOption({ label: offered.find((text) => text.includes('E2E_READER')) ?? '' });
    await dialog.locator('#grant-scope').selectOption('UNIT_SUBTREE');
    await dialog.locator('textarea').first().fill(unitOf('CB-SKHDT-VP'));
    await dialog.getByLabel(vi['adm.roles.form.reason.label']).fill('cấp quyền đọc cho thành viên mới của phòng');
    await dialog.getByRole('button', { name: vi['adm.roles.grant.submit.action'] }).click();

    // The server asks for the second factor (aal2); the user confirms and the same attempt is sent again.
    const prompt = page.getByRole('alertdialog', { name: vi['adm.roles.stepUp.title'] });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: vi['adm.roles.stepUp.confirm.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: vi['adm.roles.notice.granted'] })).toBeVisible();

    expect(statuses).toEqual([403, 201]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe('');
    expect(keys[0]).toBe(keys[1]);
    const grants = await sql(
      `select g.id from machvon.role_grant g join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
        where g.membership_id = $1 and r.code = 'E2E_READER' and g.status = 'Active'`,
      [RECIPIENT_MEMBERSHIP],
    );
    expect(grants).toHaveLength(1);
    // Both attempts carried one key; only the second reached the command pipeline, so exactly one record exists, completed.
    const records = await sql<{ status: string }>("select status from machvon.idempotency_record where operation = 'grantRole' and subject_id = $1", [membershipOf('unitAdmin')]);
    expect(records.map((row) => row.status)).toEqual(['COMPLETED']);
  });

  test('a read-only user sees roles and grants but no control to change them', async ({ page }) => {
    await openScreen(page, 'adm-03', 'auditor');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.roles.page.title'] })).toBeVisible();
    await expect(page.getByRole('button', { name: vi['adm.roles.action.grant'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['adm.roles.action.create'] })).toHaveCount(0);
    // The grants of the tenant are listed (read), the role picker offers nothing to hand out.
    await expect(page.getByRole('row').filter({ hasText: 'E2E_READER' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: vi['adm.roles.grants.revoke.action'] })).toHaveCount(0);
  });

  test('a user without the right to read grants gets the denied state, not an empty list', async ({ page }) => {
    await openScreen(page, 'adm-03', 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByText(vi['adm.roles.grants.empty'])).toHaveCount(0);
  });
});

test.describe('tenant switch', () => {
  test('keeps the breadcrumb, the typed form value and the sidebar position while the theme changes', async ({ page }) => {
    await openScreen(page, 'adm-01', 'owner', '&tenants=2');
    await page.getByRole('button', { name: vi['adm.orgUnit.create.action'] }).click();
    await page.locator('#unit-name').fill('Đơn vị chưa lưu');
    const theme = page.locator('[data-mv-tenant-theme]');
    const before = { id: await theme.getAttribute('data-mv-theme-id'), version: await theme.getAttribute('data-mv-theme-version') };
    const breadcrumb = await page.locator('.workspace-breadcrumb').innerText();
    const sidebar = page.locator('.workspace-sidebar');
    await sidebar.evaluate((element) => {
      element.scrollTop = 40;
    });
    const scrolled = await sidebar.evaluate((element) => element.scrollTop);

    await page.getByLabel(vi['shell.tenant.switch.label']).selectOption({ label: 'Lào Cai' });
    await expect(theme).not.toHaveAttribute('data-mv-theme-id', before.id ?? '');
    expect(await theme.getAttribute('data-mv-theme-version')).not.toBe(before.version);
    expect(await page.locator('.workspace-breadcrumb').innerText()).toBe(breadcrumb);
    await expect(page.locator('#unit-name')).toHaveValue('Đơn vị chưa lưu');
    expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(scrolled);
  });
});
