import { expect, test } from '@playwright/test';
import vi from '../../src/i18n/vi.json' with { type: 'json' };
import { Clip, loadFlow } from './recorder.ts';

/**
 * Clip 01 of the user guide: signing in with the identity provider, choosing the tenant, the second factor, and the first look at the home screen.
 * It films the real sign-in (the provider of the e2e stack, the real API and database); nothing is staged.
 */
test('clip 01: sign in, choose the organisation and look at the home screen', async ({ browser }) => {
  test.setTimeout(300_000);
  const clip = new Clip(loadFlow('01-dang-nhap'), browser);
  const ui = await clip.open();
  const { page } = ui;

  await clip.step('mo-he-thong', async () => {
    await page.goto('/home/home-01?session=oidc');
    await expect(page.getByRole('button', { name: vi['session.oidc.signIn.action'] })).toBeVisible();
  });

  await clip.step('dang-nhap', async () => {
    await ui.click(page.getByRole('button', { name: vi['session.oidc.signIn.action'] }));
    await page.waitForURL(/\/iam\/iam-04/);
    await expect(page.getByRole('heading', { level: 1, name: vi['iam.tenantChooser.page.title'] })).toBeVisible();
  });

  await clip.step('chon-to-chuc', async () => {
    await expect(page.locator('article[data-tenant-id]')).toHaveCount(3);
    await ui.point(page.locator('article[data-tenant-id]').first());
  });

  await clip.step('xac-thuc-lan-hai', async () => {
    const choose = (name: string) => page.getByRole('button', { name: vi['iam.tenantChooser.select.label'].replace('{name}', name) });
    await ui.click(choose('Cao Bằng'));
    await expect(page.getByRole('alertdialog', { name: vi['adm.roles.stepUp.title'] })).toBeVisible();
    await ui.wait(1500);
    await ui.click(page.getByRole('button', { name: vi['adm.roles.stepUp.confirm.action'] }));
    await page.waitForURL(/\/iam\/iam-04\?next=/);
    await expect(page.getByRole('heading', { level: 1, name: vi['iam.tenantChooser.page.title'] })).toBeVisible();
    await ui.click(choose('Cao Bằng'));
  });

  await clip.step('man-hinh-chinh', async () => {
    await page.waitForURL(/\/home\/home-01/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await ui.wait(1200);
    const context = page.getByRole('heading', { name: 'Ngữ cảnh của số liệu' }).locator('xpath=ancestor::*[self::section or self::article or self::div][1]');
    await ui.spot(context, () => ui.point(context));
  });

  await clip.step('thuc-don', async () => {
    const nav = page.getByRole('navigation', { name: vi['shell.nav.main.label'] });
    await ui.spot(nav, () => ui.wait(500));
    await ui.point(page.getByRole('button', { name: vi['shell.nav.expand.label'].replace('{name}', 'Dự án') }));
  });

  await clip.step('goc-tren', async () => {
    await ui.spot(page.locator('.page-utilities'), () => ui.point(page.locator('#pin-current-screen')));
    await ui.point(page.locator('.account-link'));
  });

  await clip.finish();
});
