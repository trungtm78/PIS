import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql, stackInfo } from './support/stack.ts';

/**
 * The control-plane screens (SAS-01, SAS-02, SAS-03, SAS-04, SAS-25) in a real browser against the real API and database
 * (apps/api/test/e2e-stack): fixture control users are picked with `?devUser=`, their tokens carry the control
 * audience and realm roles, and the saga runs behind the outbox relay over mock infrastructure ports. All eleven steps
 * run: a new tenant ends `Active` with its run `Succeeded`, its entitlements, pilot license, roles, root unit, theme and
 * the pending invitation of its owner.
 */

const unique = (): string => Date.now().toString(36);

async function openScreen(page: Page, screen: 'sas-01' | 'sas-02' | 'sas-03' | 'sas-25', user: string, extraQuery = ''): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/sas/${screen}?devUser=${user}${extraQuery}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const tenantRow = (code: string): Promise<{ id: string; status: string }[]> => sql('select id, status from machvon.tenant where code = $1', [code]);

test.describe('SAS-02 tenant creation and SAS-01 tenant list', () => {
  test('a system administrator requests a tenant and sees the saga run all eleven steps and the tenant become Active', async ({ page }) => {
    const code = `e2e-${unique()}`;
    await openScreen(page, 'sas-02', 'sysAdmin');
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.tenantCreate.page.title'] })).toBeVisible();

    // A code that breaks BR-SAS-01 never leaves the browser.
    await page.getByLabel(vi['sas.tenantCreate.code.label'], { exact: true }).fill('Bad_Code');
    await page.getByRole('button', { name: vi['sas.tenantCreate.submit.action'] }).click();
    await expect(page.getByText(vi['sas.tenantCreate.problem.pattern'])).toBeVisible();
    expect(await tenantRow('Bad_Code')).toHaveLength(0);

    await page.getByLabel(vi['sas.tenantCreate.name.label'], { exact: true }).fill('Tenant kiểm thử e2e');
    await page.getByLabel(vi['sas.tenantCreate.owner.label'], { exact: true }).fill('owner@example.org');
    await page.getByLabel(vi['sas.tenantCreate.plan.label'], { exact: true }).fill(stackInfo().planVersionId);
    await page.getByLabel(vi['sas.tenantCreate.code.label'], { exact: true }).fill(code);
    await page.getByLabel(vi['sas.tenantCreate.rootUnit.label'], { exact: true }).fill('Ủy ban nhân dân kiểm thử');
    await page.getByLabel(vi['sas.tenantCreate.subdomain.label'], { exact: true }).fill(code);
    await page.getByRole('button', { name: vi['sas.tenantCreate.submit.action'] }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Requested' })).toBeVisible();

    // The relay hands the event to the saga: the infrastructure steps run on the mock ports, then the data steps, and the tenant is Active after the last one.
    await expect
      .poll(async () => (await sql<{ status: string; run: string }>("select t.status, r.status as run from machvon.tenant t join machvon.tenant_provisioning_run r on r.tenant_id = t.id where t.code = $1", [code]))[0], { timeout: 60_000 })
      .toMatchObject({ status: 'Active', run: 'Succeeded' });
    const id = (await tenantRow(code))[0]?.id ?? '';
    const run = (await sql<{ steps_json: Record<string, { status: string }> }>('select steps_json from machvon.tenant_provisioning_run where tenant_id = $1', [id]))[0];
    for (const step of ['IDP_ORG', 'DNS_SUBDOMAIN', 'STORAGE_PREFIX', 'DB_PLACEMENT', 'RLS_SEED', 'ENTITLEMENT_V1', 'LICENSE_PILOT', 'ROLE_SEED', 'ROOT_UNIT', 'THEME_V1', 'OWNER_INVITE']) expect(run?.steps_json[step]?.status).toBe('DONE');
    expect(await sql("select edition, status from machvon.license_revision where tenant_id = $1", [id])).toEqual([{ edition: 'PILOT', status: 'Issued' }]);
    expect(await sql("select count(*)::int as n from machvon.organization_unit where tenant_id = $1 and code = 'ROOT'", [id])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from machvon.tenant_theme_version where tenant_id = $1", [id])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from machvon.membership_invitation where tenant_id = $1 and status = 'Pending'", [id])).toEqual([{ n: 1 }]);

    await page.goto('/sas/sas-01?devUser=sysAdmin');
    const row = page.locator('tr', { hasText: code });
    await expect(row).toBeVisible();
    await expect(row.getByText(vi['sas.tenants.status.active'])).toBeVisible();
  });

  test('the registered tenant is listed with its status and the code is refused a second time', async ({ page }) => {
    await openScreen(page, 'sas-01', 'sysAdmin');
    const row = page.locator('tr', { hasText: 'cao-bang' });
    await expect(row.getByText(vi['sas.tenants.status.active'])).toBeVisible();

    await openScreen(page, 'sas-02', 'sysAdmin');
    await page.getByLabel(vi['sas.tenantCreate.name.label'], { exact: true }).fill('Cao Bằng lần hai');
    await page.getByLabel(vi['sas.tenantCreate.owner.label'], { exact: true }).fill('second@example.org');
    await page.getByLabel(vi['sas.tenantCreate.plan.label'], { exact: true }).fill(stackInfo().planVersionId);
    await page.getByLabel(vi['sas.tenantCreate.code.label'], { exact: true }).fill('cao-bang');
    await page.getByLabel(vi['sas.tenantCreate.rootUnit.label'], { exact: true }).fill('Ủy ban nhân dân');
    await page.getByLabel(vi['sas.tenantCreate.subdomain.label'], { exact: true }).fill(`second-${unique()}`);
    await page.getByRole('button', { name: vi['sas.tenantCreate.submit.action'] }).click();
    const taken = page.getByText(vi['sas.tenantCreate.error.codeTaken']);
    await expect(taken).toBeVisible();
    await expect(page.getByLabel(vi['sas.tenantCreate.owner.label'], { exact: true })).toHaveValue('second@example.org');
    expect(await sql("select count(*)::int as n from machvon.tenant where lower(code) = 'cao-bang'")).toEqual([{ n: 1 }]);
  });

  test('a platform operator can read the registry but has no way to create a tenant', async ({ page }) => {
    await openScreen(page, 'sas-01', 'operator');
    await expect(page.locator('tr', { hasText: 'cao-bang' })).toBeVisible();
    await expect(page.getByRole('link', { name: vi['sas.tenants.create.action'] })).toHaveCount(0);

    await openScreen(page, 'sas-02', 'operator');
    await expect(page.getByText(vi['sas.tenantCreate.readOnly.notice'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['sas.tenantCreate.submit.action'] })).toHaveCount(0);
  });

  test('a tenant administrator is refused the control plane: the registry shows the denied state', async ({ page }) => {
    await openScreen(page, 'sas-01', 'owner');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
  });
});

test.describe('SAS-25 entitlements', () => {
  test('the control plane reads the entitlements of a registered tenant', async ({ page }) => {
    await openScreen(page, 'sas-25', 'sysAdmin', `&tenant=${stackInfo().tenants.A}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.entitlements.page.title'] })).toBeVisible();
    const reporting = page.locator('tr[data-feature="reporting"]');
    await expect(reporting.getByText(vi['sas.entitlements.feature.reporting'])).toBeVisible();
    const hash = await page.locator('[data-entitlements-hash]').textContent();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = await sql<{ entitlements_hash: string }>('select entitlements_hash from machvon.entitlement_version where tenant_id = $1 order by version_no desc limit 1', [stackInfo().tenants.A]);
    expect(stored[0]?.entitlements_hash).toBe(hash);
    await expect(page.locator('tr[data-feature="ai.analysis"]').getByText(vi['sas.entitlements.mode.denied'])).toBeVisible();
  });

  test('a tenant user reads the table of the own tenant', async ({ page }) => {
    await openScreen(page, 'sas-25', 'owner');
    await expect(page.locator('tr[data-feature="reporting"]')).toBeVisible();
  });
});

test.describe('SAS-03 tenant lifecycle', () => {
  const REASON = 'The invoice of September is 45 days overdue.';

  /** A tenant of its own in state Active, so the flows never touch the fixture tenants the other specs use. */
  async function activeTenant(): Promise<string> {
    const code = `life-${unique()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const rows = await sql<{ id: string }>(
      "insert into machvon.tenant (id, code, name, status, placement_id, region) select gen_random_uuid(), $1, $1, 'Active', id, 'vn-north' from machvon.placement limit 1 returning id",
      [code],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('no placement to put the tenant on');
    return id;
  }

  const stateOf = (id: string): Promise<{ status: string; lifecycle_reason: string | null; version: string }[]> =>
    sql('select status, lifecycle_reason, version::text as version from machvon.tenant where id = $1', [id]);

  test('a system administrator suspends a tenant with a reason and resumes it, and every step is on record', async ({ page }) => {
    const id = await activeTenant();
    await openScreen(page, 'sas-03', 'sysAdmin', `&tenant=${id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.tenantDetail.page.title'] })).toBeVisible();
    await expect(page.locator('[data-tenant-status="Active"]')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['sas.tenantDetail.resume.action'] })).toHaveCount(0);

    await page.getByRole('button', { name: vi['sas.tenantDetail.suspend.action'] }).click();
    const dialog = page.getByRole('dialog');
    // A reason that is too short never leaves the browser.
    await dialog.getByLabel(vi['sas.tenantDetail.reason.label']).fill('too short');
    await dialog.getByRole('button', { name: vi['sas.tenantDetail.suspend.confirm'] }).click();
    await expect(dialog.getByText(vi['sas.tenantDetail.reason.tooShort'])).toBeVisible();
    expect((await stateOf(id))[0]?.status).toBe('Active');

    await dialog.getByLabel(vi['sas.tenantDetail.reason.label']).fill(REASON);
    await dialog.getByRole('button', { name: vi['sas.tenantDetail.suspend.confirm'] }).click();
    await expect(page.getByRole('status').filter({ hasText: vi['sas.tenantDetail.done.suspended'].replace('{version}', '2') })).toBeVisible();
    await expect(page.locator('[data-tenant-status="Suspended"]')).toBeVisible();
    expect((await stateOf(id))[0]).toMatchObject({ status: 'Suspended', lifecycle_reason: 'NON_PAYMENT', version: '2' });
    expect(await sql("select reason from machvon.audit_event where tenant_id = $1 and action = 'tenant.suspended' and outcome = 'SUCCESS'", [id])).toEqual([{ reason: REASON }]);
    expect(await sql("select payload from machvon.outbox_event where tenant_id = $1 and type = 'sas.tenant.status_changed.v1'", [id])).toEqual([
      { payload: { tenant_id: id, from: 'Active', to: 'Suspended', reason_code: 'NON_PAYMENT' } },
    ]);

    await page.getByRole('button', { name: vi['sas.tenantDetail.resume.action'] }).click();
    await page.getByRole('dialog').getByLabel(vi['sas.tenantDetail.reason.label']).fill('The invoice was paid on 2026-10-20.');
    await page.getByRole('dialog').getByRole('button', { name: vi['sas.tenantDetail.resume.confirm'] }).click();
    await expect(page.locator('[data-tenant-status="Active"]')).toBeVisible();
    expect((await stateOf(id))[0]).toMatchObject({ status: 'Active', lifecycle_reason: null, version: '3' });
    expect(await sql("select count(*)::int as n from machvon.audit_event where tenant_id = $1 and action = 'tenant.resumed'", [id])).toEqual([{ n: 1 }]);
  });

  test('a suspension for a security incident names no access, and the dialog of a stale version tells the current one', async ({ page }) => {
    const id = await activeTenant();
    await openScreen(page, 'sas-03', 'sysAdmin', `&tenant=${id}`);
    await page.getByRole('button', { name: vi['sas.tenantDetail.suspend.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(vi['sas.tenantDetail.reasonCode.label']).selectOption('SECURITY_INCIDENT');
    await expect(dialog.getByText(vi['sas.tenantDetail.policy.noAccess'])).toBeVisible();
    await dialog.getByLabel(vi['sas.tenantDetail.reason.label']).fill(REASON);

    // Another operator changed the tenant while this dialog was open.
    await sql('update machvon.tenant set version = version + 1 where id = $1', [id]);
    await dialog.getByRole('button', { name: vi['sas.tenantDetail.suspend.confirm'] }).click();
    await expect(dialog.getByText(vi['sas.tenantCreate.error.conflict'].replace('{version}', '2'))).toBeVisible();
    await expect(dialog.getByLabel(vi['sas.tenantDetail.reason.label'])).toHaveValue(REASON);
    expect((await stateOf(id))[0]?.status).toBe('Active');
  });

  test('a platform operator reads the tenant and has no lifecycle control', async ({ page }) => {
    const id = await activeTenant();
    await openScreen(page, 'sas-03', 'operator', `&tenant=${id}`);
    await expect(page.locator('[data-tenant-status="Active"]')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['sas.tenantDetail.suspend.action'] })).toHaveCount(0);
    await expect(page.getByText(vi['sas.tenantDetail.lifecycle.readOnly.notice'])).toBeVisible();
  });
});

test.describe('SAS-04 tenant theme', () => {
  const REASON = 'The new colours failed the accessibility audit.';
  const SEED_THEME = {
    name: 'Cao Bằng',
    title: 'Hệ Thống Lý Dự Án Đầu Tư Công',
    subtitle: 'Không gian quản lý đầu tư công',
    header: 'Cổng quản lý đầu tư công',
    footer: '© 2026 · Thông tin thuộc phạm vi được phân quyền',
    address: 'Địa chỉ cơ quan · cập nhật theo tenant',
    email: 'hotro@donvi.example',
    phone: '',
    primary: '#b4233d',
    primaryText: '#ffffff',
    menu: '#ffffff',
    menuText: '#615b66',
    selected: '#fff0f2',
    selectedText: '#a11d37',
    headerBg: '#ffffff',
    headerText: '#514a56',
    footerBg: '#ffffff',
    footerText: '#68616c',
    background: '#f7f5f4',
    titleColor: '#29272d',
    logoAssetId: null,
  };
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const SYSTEM_ADMIN_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e9';

  /** A tenant of its own with the first published theme, so the flows never change the theme of a fixture tenant the other specs read. */
  async function themedTenant(): Promise<string> {
    const code = `theme-${unique()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const rows = await sql<{ id: string }>(
      "insert into machvon.tenant (id, code, name, status, placement_id, region) select gen_random_uuid(), $1, $1, 'Active', id, 'vn-north' from machvon.placement limit 1 returning id",
      [code],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('no placement to put the tenant on');
    await sql("insert into machvon.tenant_theme_version (tenant_id, version, config_json, config_hash, published_by) values ($1, 1, $2::jsonb, repeat('a', 64), $3)", [id, JSON.stringify(SEED_THEME), SYSTEM_ADMIN_MEMBERSHIP]);
    await sql('insert into machvon.tenant_theme_pointer (tenant_id, current_version) values ($1, 1)', [id]);
    return id;
  }

  const versionsOf = (id: string): Promise<{ version: string; source_version: string | null; reason: string | null }[]> =>
    sql('select version::text as version, source_version::text as source_version, reason from machvon.tenant_theme_version where tenant_id = $1 order by version', [id]);
  const pointerOf = async (id: string): Promise<string | undefined> => (await sql<{ v: string }>('select current_version::text as v from machvon.tenant_theme_pointer where tenant_id = $1', [id]))[0]?.v;

  async function openTheme(page: Page, user: string, tenantId?: string): Promise<void> {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/sas/sas-04?devUser=${user}${tenantId === undefined ? '' : `&tenant=${tenantId}`}`);
    await page.waitForSelector('[data-screen-id], [role="alert"]');
  }

  const field = (page: Page, key: string) => page.getByLabel(vi[`sas.theme.field.${key}.label` as keyof typeof vi], { exact: true });

  test('a system administrator edits the draft, reviews it, publishes it and restores the first version, and every step is on record', async ({ page }) => {
    const id = await themedTenant();
    await openTheme(page, 'sysAdmin', id);
    await expect(page.getByRole('heading', { level: 1, name: vi['sas.theme.page.title'] })).toBeVisible();
    await expect(field(page, 'name')).toHaveValue('Cao Bằng');

    // The draft shows in the frame only: the application around it keeps its own theme.
    const appThemeKeys = await page.locator('[data-mv-tenant-theme]').first().getAttribute('data-mv-theme-keys');
    await field(page, 'primary').fill('#112233');
    await expect(page.frameLocator('#tenant-theme-preview').locator('.cta')).toHaveCSS('background-color', 'rgb(17, 34, 51)');
    expect(await page.locator('[data-mv-tenant-theme]').first().getAttribute('data-mv-theme-keys')).toBe(appThemeKeys);
    expect(await sql('select 1 from machvon.tenant_theme_draft where tenant_id = $1', [id])).toHaveLength(0);

    await page.getByRole('button', { name: vi['sas.theme.save.action'] }).click();
    await expect(page.getByText(vi['sas.theme.status.saved.text'])).toBeVisible();
    expect(await sql("select revision::text as revision, config_json->>'primary' as primary_colour from machvon.tenant_theme_draft where tenant_id = $1", [id])).toEqual([{ revision: '1', primary_colour: '#112233' }]);
    expect(await pointerOf(id)).toBe('1');

    await page.getByRole('button', { name: vi['sas.theme.review.action'] }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(vi['sas.theme.review.changes.title'].replace('{count}', '1'))).toBeVisible();
    await expect(dialog.locator('tr[data-field="primary"]')).toContainText('#112233');
    await expect(dialog.getByRole('button', { name: vi['sas.theme.review.apply.confirm'] })).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: vi['sas.theme.review.apply.confirm'] }).click();
    // Publishing a theme is a step-up operation (aal2): the server asks for the second factor, the administrator confirms and the same review is sent again.
    const stepUp = page.getByRole('alertdialog', { name: vi['adm.roles.stepUp.title'] });
    await expect(stepUp).toBeVisible();
    await stepUp.getByRole('button', { name: vi['adm.roles.stepUp.confirm.action'] }).click();
    await expect(page.getByText(vi['sas.theme.status.published.text'].replace('{version}', '2'))).toBeVisible();
    expect(await versionsOf(id)).toEqual([
      { version: '1', source_version: null, reason: null },
      { version: '2', source_version: null, reason: null },
    ]);
    expect(await pointerOf(id)).toBe('2');
    expect((await sql<{ action: string }>('select action from machvon.audit_event where tenant_id = $1 order by occurred_at', [id])).map((row) => row.action)).toEqual(['tenant.theme_draft.saved', 'tenant.theme.reviewed', 'tenant.theme.published']);
    expect(await sql("select payload->>'version' as version from machvon.outbox_event where tenant_id = $1 and type = 'sas.theme.published.v1'", [id])).toEqual([{ version: '2' }]);

    // Restoring the first version makes version 3 from it and keeps version 2.
    await page.getByRole('button', { name: vi['sas.theme.history.restore.action'].replace('{version}', '1') }).click();
    const restore = page.getByRole('dialog');
    await restore.getByLabel(vi['sas.theme.review.reason.label']).fill('too short');
    await restore.getByRole('button', { name: vi['sas.theme.review.request.action'] }).click();
    await expect(restore.getByText(vi['sas.theme.review.reason.tooShort'])).toBeVisible();
    await restore.getByLabel(vi['sas.theme.review.reason.label']).fill(REASON);
    await restore.getByRole('button', { name: vi['sas.theme.review.request.action'] }).click();
    await restore.getByRole('checkbox').check();
    await restore.getByRole('button', { name: vi['sas.theme.review.restore.confirm'] }).click();
    await expect(page.getByText(vi['sas.theme.status.restored.text'].replace('{version}', '3'))).toBeVisible();
    expect(await versionsOf(id)).toEqual([
      { version: '1', source_version: null, reason: null },
      { version: '2', source_version: null, reason: null },
      { version: '3', source_version: '1', reason: REASON },
    ]);
    expect(await pointerOf(id)).toBe('3');
  });

  test('a pair under 4.5:1 is explained, cannot be saved and leaves no draft', async ({ page }) => {
    const id = await themedTenant();
    await openTheme(page, 'sysAdmin', id);
    await field(page, 'primary').fill('#8c8c8c');
    await field(page, 'primaryText').fill('#ffffff');
    await expect(page.locator('#theme-validation [data-issue="CONTRAST"]')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['sas.theme.save.action'] })).toBeDisabled();
    await expect(page.getByRole('button', { name: vi['sas.theme.review.action'] })).toBeDisabled();
    expect(await sql('select 1 from machvon.tenant_theme_draft where tenant_id = $1', [id])).toHaveLength(0);
  });

  test('a review that expired is refused in words and publishes nothing', async ({ page }) => {
    const id = await themedTenant();
    await openTheme(page, 'sysAdmin', id);
    await field(page, 'title').fill('Tiêu đề mới');
    await page.getByRole('button', { name: vi['sas.theme.review.action'] }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox')).toBeVisible();
    await sql("update machvon.tenant_theme_review set expires_at = now() - interval '1 second' where tenant_id = $1", [id]);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: vi['sas.theme.review.apply.confirm'] }).click();
    // Publishing a theme is a step-up operation (aal2): the server asks for the second factor, the administrator confirms and the same review is sent again.
    const stepUp = page.getByRole('alertdialog', { name: vi['adm.roles.stepUp.title'] });
    await expect(stepUp).toBeVisible();
    await stepUp.getByRole('button', { name: vi['adm.roles.stepUp.confirm.action'] }).click();
    await expect(dialog.getByText(vi['sas.theme.error.reviewInvalid.text'])).toBeVisible();
    expect(await versionsOf(id)).toHaveLength(1);
    await dialog.getByRole('button', { name: vi['sas.theme.error.reviewAgain.action'] }).click();
    await expect(dialog.getByRole('checkbox')).toBeVisible();
  });

  test('a logo travels as one multipart upload; a file that is not an image, and an oversized one, are refused', async ({ page }) => {
    const id = await themedTenant();
    await openTheme(page, 'sysAdmin', id);
    await field(page, 'logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.concat([PNG_SIGNATURE, Buffer.alloc(2048, 0x61)]) });
    await expect(page.getByText(vi['sas.theme.status.logoAdded.text'])).toBeVisible();
    const stored = await sql<{ mime: string; scan_status: string; size_bytes: string }>('select mime, scan_status, size_bytes::text as size_bytes from machvon.tenant_theme_asset where tenant_id = $1', [id]);
    expect(stored).toEqual([{ mime: 'image/png', scan_status: 'clean', size_bytes: '2056' }]);
    await page.getByRole('button', { name: vi['sas.theme.save.action'] }).click();
    await expect(page.getByText(vi['sas.theme.status.saved.text'])).toBeVisible();
    expect((await sql<{ logo: string | null }>("select config_json->>'logoAssetId' as logo from machvon.tenant_theme_draft where tenant_id = $1", [id]))[0]?.logo).not.toBeNull();

    // The server judges by the bytes: text that claims to be a PNG is refused, and nothing is stored for it.
    await field(page, 'logo').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
    await expect(page.getByText(vi['sas.theme.error.fileType.text'])).toBeVisible();
    await field(page, 'logo').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.concat([PNG_SIGNATURE, Buffer.alloc(1_500_000, 0x61)]) });
    await expect(page.getByText(vi['sas.theme.error.tooLarge.text'])).toBeVisible();
    expect(await sql('select 1 from machvon.tenant_theme_asset where tenant_id = $1', [id])).toHaveLength(1);
  });

  test('a tenant user sees the published theme read-only and has no control', async ({ page }) => {
    await openTheme(page, 'owner');
    await expect(page.getByText(vi['sas.theme.callout.readOnly.text'])).toBeVisible();
    await expect(field(page, 'name')).toBeDisabled();
    await expect(field(page, 'name')).toHaveValue('Cao Bằng');
    await expect(page.getByText(vi['sas.theme.preview.published.label'], { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: vi['sas.theme.save.action'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['sas.theme.review.action'] })).toHaveCount(0);
  });
});
