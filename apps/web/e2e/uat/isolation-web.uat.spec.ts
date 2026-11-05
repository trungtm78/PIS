import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import vi from '../../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from '../support/stack.ts';

/**
 * UAT of the critical slice, area isolation-web: what a person sees and keeps in the browser when the tenant changes
 * (TC-UAT-NFR-TENANCY-07), the draft and the published theme of a tenant (TC-TH01, TC-TH05) and the deep link of a
 * notification of a record the person may not read (TC-NOT02). The API, the database and the web are the product's own.
 * The cases that need a Redis, a search or vector index, or the Flutter app, are in not-executed.isolation-web.json.
 */

const unique = (): string => `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

test.describe('isolation in the browser', () => {
  test('TC-TH01: a theme draft is kept for its own tenant only, and the published theme and the other people do not change', { tag: ['@P0', '@S1', '@isolation-web'] }, async ({ page }) => {
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
    const SYSTEM_ADMIN_MEMBERSHIP = membershipOf('sysAdmin');
    const { tenants } = stackInfo();

    /** A tenant of its own with a first published theme under a name of its own, so that no theme a fixture tenant shows is changed. */
    async function themedTenant(name: string): Promise<string> {
      const code = `th01-${unique()}`;
      const rows = await sql<{ id: string }>(
        "insert into machvon.tenant (id, code, name, status, placement_id, region) select gen_random_uuid(), $1, $1, 'Active', id, 'vn-north' from machvon.placement limit 1 returning id",
        [code],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('no placement to put the tenant on');
      await sql("insert into machvon.tenant_theme_version (tenant_id, version, config_json, config_hash, published_by) values ($1, 1, $2::jsonb, repeat('a', 64), $3)", [id, JSON.stringify({ ...SEED_THEME, name }), SYSTEM_ADMIN_MEMBERSHIP]);
      await sql('insert into machvon.tenant_theme_pointer (tenant_id, current_version) values ($1, 1)', [id]);
      return id;
    }

    interface PublishedState {
      versions: Array<{ tenant_id: string; version: string; config_hash: string; name: string }>;
      pointers: Array<{ tenant_id: string; current_version: string }>;
    }
    const publishedOf = async (ids: string[]): Promise<PublishedState> => ({
      versions: await sql("select tenant_id, version::text as version, config_hash, config_json->>'name' as name from machvon.tenant_theme_version where tenant_id = any($1::uuid[]) order by tenant_id, version", [ids]),
      pointers: await sql('select tenant_id, current_version::text as current_version from machvon.tenant_theme_pointer where tenant_id = any($1::uuid[]) order by tenant_id', [ids]),
    });
    const countOf = async (action: string, tenantId: string): Promise<number> => (await sql<{ n: number }>('select count(*)::int as n from machvon.audit_event where tenant_id = $1 and action = $2', [tenantId, action]))[0]?.n ?? 0;
    const field = (page: Page, key: string): Locator => page.getByLabel(vi[`sas.theme.field.${key}.label` as keyof typeof vi], { exact: true });
    const openTheme = async (user: string, tenantId?: string): Promise<void> => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`/sas/sas-04?devUser=${user}${tenantId === undefined ? '' : `&tenant=${tenantId}`}`);
      await page.waitForSelector('[data-screen-id], [role="alert"]');
    };

    const mark = unique();
    const nameX = `Tenant X ${mark}`;
    const nameY = `Tenant Y ${mark}`;
    const tenantX = await themedTenant(nameX);
    const tenantY = await themedTenant(nameY);
    const watched = [tenantX, tenantY, tenants.A, tenants.B];
    const before = await publishedOf(watched);
    const auditBefore = { y: await countOf('tenant.theme_draft.saved', tenantY), a: await countOf('tenant.theme_draft.saved', tenants.A) };

    // Step 1: the administrator changes the name and the colour of tenant X, saves the draft, reloads, and opens the preview for the web and the phone.
    const draftName = `Bản nháp ${mark}`;
    await openTheme('sysAdmin', tenantX);
    await expect(field(page, 'name')).toHaveValue(nameX);
    await field(page, 'name').fill(draftName);
    await field(page, 'primary').fill('#112233');
    await page.getByRole('button', { name: vi['sas.theme.save.action'] }).click();
    await expect(page.getByText(vi['sas.theme.status.saved.text'])).toBeVisible();
    await openTheme('sysAdmin', tenantX);
    await expect(field(page, 'name')).toHaveValue(draftName);
    await expect(field(page, 'primary')).toHaveValue('#112233');
    await expect(page.getByText(vi['sas.theme.preview.draft.label'])).toBeVisible();
    await expect(page.frameLocator('#tenant-theme-preview').locator('.cta')).toHaveCSS('background-color', 'rgb(17, 34, 51)');
    await page.getByLabel(vi['sas.theme.preview.platform.label']).selectOption('phone');
    await expect(page.frameLocator('#tenant-theme-preview').locator('.cta')).toHaveCSS('background-color', 'rgb(17, 34, 51)');

    // The draft is on record for tenant X alone.
    expect(await sql("select tenant_id, revision::text as revision, config_json->>'name' as name, config_json->>'primary' as primary_colour from machvon.tenant_theme_draft where tenant_id = any($1::uuid[])", [watched])).toEqual([
      { tenant_id: tenantX, revision: '1', name: draftName, primary_colour: '#112233' },
    ]);
    expect(await countOf('tenant.theme_draft.saved', tenantX)).toBe(1);
    expect(await countOf('tenant.theme_draft.saved', tenantY)).toBe(auditBefore.y);
    expect(await countOf('tenant.theme_draft.saved', tenants.A)).toBe(auditBefore.a);
    expect(await sql("select 1 from machvon.outbox_event where tenant_id = $1 and type = 'sas.theme.published.v1'", [tenantX])).toHaveLength(0);

    // Step 2: nothing published changed, for X or for anybody else (version rows, hashes and the pointer of each tenant).
    expect(await publishedOf(watched)).toEqual(before);

    // The other tenant sees its own theme, without the draft of X.
    await openTheme('sysAdmin', tenantY);
    await expect(field(page, 'name')).toHaveValue(nameY);
    await expect(field(page, 'primary')).toHaveValue(SEED_THEME.primary);

    // A person of tenant A reads the published theme of A: read-only, its own name, no draft of X anywhere.
    await openTheme('owner');
    await expect(page.getByText(vi['sas.theme.callout.readOnly.text'])).toBeVisible();
    await expect(field(page, 'name')).toBeDisabled();
    await expect(field(page, 'name')).toHaveValue('Cao Bằng');
    await expect(page.getByText(vi['sas.theme.tenant.version.text'].replace('{version}', before.pointers.find((row) => row.tenant_id === tenants.A)?.current_version ?? '0'))).toBeVisible();
    await expect(page.locator('body')).not.toContainText(draftName);
  });

  test('TC-TH05: the tenant gets its own theme and version, and a change of theme loses neither the breadcrumb, the form nor the place in the menu', { tag: ['@P0', '@S1', '@isolation-web'] }, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/adm/adm-01?devUser=owner&tenants=2');
    const theme = page.locator('[data-mv-tenant-theme]');
    const switcher = page.getByLabel(vi['shell.tenant.switch.label']);
    const breadcrumb = page.getByRole('navigation', { name: vi['shell.nav.breadcrumb.label'] });
    const sidebar = page.locator('#workspace-sidebar');
    const here = sidebar.locator('[aria-current="page"]');

    await expect(page.getByRole('heading', { level: 1, name: vi['adm.orgUnit.page.title'] })).toBeVisible();
    await expect(theme).toHaveAttribute('data-mv-theme-id', 'theme-cao-bang');
    await expect(theme).toHaveAttribute('data-mv-theme-version', '2');
    await page.getByRole('button', { name: vi['adm.orgUnit.create.action'] }).click();
    const typed = `Đơn vị đang nhập ${unique()}`;
    await page.locator('#unit-name').fill(typed);
    const crumbBefore = (await breadcrumb.textContent()) ?? '';
    const placeBefore = await here.first().innerText();
    await sidebar.evaluate((element) => {
      element.scrollTop = 40;
    });
    const scrolledBefore = await sidebar.evaluate((element) => element.scrollTop);

    // The theme changes: it is the theme and the version of the other tenant, and nothing the person was doing is lost.
    await switcher.selectOption({ label: 'Lào Cai' });
    await expect(theme).toHaveAttribute('data-mv-theme-id', 'theme-lao-cai');
    await expect(theme).toHaveAttribute('data-mv-theme-version', '5');
    await expect(breadcrumb).toHaveText(crumbBefore);
    await expect(page.locator('#unit-name')).toHaveValue(typed);
    await expect(here.first()).toHaveText(placeBefore);
    expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(scrolledBefore);

    // Route away and back: the breadcrumb is the same and the tenant keeps its own theme.
    await page.getByRole('link', { name: vi['shell.nav.tasks.label'] }).first().click();
    await expect(page).not.toHaveURL(/\/adm\/adm-01/);
    await page.goBack();
    await expect(page).toHaveURL(/\/adm\/adm-01/);
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.orgUnit.page.title'] })).toBeVisible();
    await expect(breadcrumb).toHaveText(crumbBefore);
    await expect(theme).toHaveAttribute('data-mv-theme-id', 'theme-lao-cai');
    await expect(theme).toHaveAttribute('data-mv-theme-version', '5');
    await expect(switcher).toHaveValue(stackInfo().tenants.B);
  });

  test('TC-NOT02: the link of a notification of a record the person may not read does not mark it read and does not show the record', { tag: ['@P0', '@S1', '@isolation-web'] }, async ({ page }) => {
    const tenantId = stackInfo().tenants.A;
    const owner = membershipOf('owner');
    const stranger = membershipOf('nobody');
    const ownerUnit = stackInfo().units.A['CB-SKHDT-QLDA'];
    const mark = unique().toUpperCase();
    const projectId = randomUUID();
    const projectCode = `E2E-NOT02-${mark}`;
    const projectName = `Dự án kín ${mark}`;
    const [workflow] = await sql<{ id: string }>("select id from machvon.workflow_version where tenant_id = $1 and kind = 'NOTIFICATION' limit 1", [tenantId]);
    const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [tenantId]);
    await sql(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [tenantId, projectId, projectCode, projectName, ownerUnit, area?.id],
    );

    /** A notification of the project for a member: its event on file names the project (the thing it is about) and the screen a link opens. */
    async function notify(recipient: string): Promise<string> {
      const eventId = randomUUID();
      const notificationId = randomUUID();
      await sql(
        `insert into machvon.outbox_event (tenant_id, id, aggregate_id, type, schema_version, payload, created_at, aggregate_type, aggregate_version, event_key, correlation_id)
         values ($1, $2, $3, 'e2e.not02.project_changed.v1', 1, $4::jsonb, now(), 'project', 1, $5, $6)`,
        [
          tenantId,
          eventId,
          projectId,
          JSON.stringify({ tenant_id: tenantId, notification: { resource: { type: 'project', id: projectId, ownerUnitId: ownerUnit, projectId }, deepLink: `/prj/prj-03/${projectId}` } }),
          `e2e-not02:${randomUUID()}`,
          randomUUID(),
        ],
      );
      await sql(
        `insert into machvon.notification_instance
           (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, event_version, priority, ack_required, channel_plan)
         values ($1, $2, $3, $4, $5, 'OPERATIONAL', $6, now() + interval '30 days', 'Delivered', 'e2e.not02.project_changed', 1, 'NORMAL', false, '{IN_APP}')`,
        [tenantId, notificationId, eventId, workflow?.id, recipient, `n1:${randomBytes(32).toString('hex')}`],
      );
      return notificationId;
    }
    const rowOf = async (id: string): Promise<{ status: string; read_at: string | null; version: string }> =>
      (await sql<{ status: string; read_at: string | null; version: string }>('select status, read_at::text as read_at, version::text as version from machvon.notification_instance where id = $1', [id]))[0] ?? { status: '', read_at: null, version: '' };
    const readEvents = async (id: string): Promise<number> => (await sql<{ n: number }>("select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = 'notification.read'", [id]))[0]?.n ?? 0;
    const open = async (id: string, user: string): Promise<void> => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`/r/${id}?devUser=${user}`);
      await expect(page).toHaveURL(new RegExp(`/not/not-02\\?id=${id}`));
      await expect(page.getByRole('heading', { level: 1, name: vi['not.detail.page.title'] })).toBeVisible();
    };

    const mine = await notify(owner);
    const hidden = await notify(stranger);
    const hiddenBefore = await rowOf(hidden);
    expect(hiddenBefore).toMatchObject({ status: 'Delivered', read_at: null });

    try {
      // A person who may read the record: the link shows what it is about, the notification is read once, and the read is on record (this shows the reading works at all).
      await open(mine, 'owner');
      await expect(page.getByRole('link', { name: vi['not.detail.link.open.action'] })).toBeVisible();
      await expect(page.getByText(vi['not.detail.status.read'], { exact: true })).toBeVisible();
      await expect.poll(async () => (await rowOf(mine)).read_at).not.toBeNull();
      expect(await readEvents(mine)).toBe(1);

      // A person who may not: the link answers that the content is not available, without the record, and nothing is marked read. The second visit proves the first one had time to write.
      await open(hidden, 'nobody');
      await expect(page.getByText(vi['not.detail.unavailable.body'])).toBeVisible();
      await open(hidden, 'nobody');
      await expect(page.getByText(vi['not.detail.unavailable.body'])).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: vi['notification.content.unavailable.title'] })).toBeVisible();
      await expect(page.getByRole('link', { name: vi['not.detail.link.open.action'] })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(projectCode);
      await expect(page.locator('body')).not.toContainText(projectName);
      await expect.soft(page.getByText(vi['not.detail.status.unread'], { exact: true })).toBeVisible();
      expect.soft(await rowOf(hidden)).toEqual(hiddenBefore);
      expect.soft(await readEvents(hidden)).toBe(0);
    } finally {
      await sql('delete from machvon.notification_instance where id = any($1::uuid[])', [[mine, hidden]]);
      await sql('delete from machvon.project where id = $1', [projectId]);
    }
  });
});
