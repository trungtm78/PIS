import { expect, test } from '@playwright/test';
import vi from '../../src/i18n/vi.json' with { type: 'json' };
import { Clip, loadFlow } from './recorder.ts';

/**
 * Clip 02 of the user guide: a project manager makes a new project in the stage CONCEPT. Everything is done through the screens, against the real API and
 * database: the project exists afterwards because the form made it, not because a script wrote it.
 */
const CODE = 'DA-DT205';
const NAME = 'Cải tạo, nâng cấp đường tỉnh 205, đoạn Km0 - Km12';
const TOTAL = '150000000000';

test('clip 02: create a project, read the suggested group, find it and open its workspace', async ({ browser }) => {
  test.setTimeout(600_000);
  const clip = new Clip(loadFlow('02-tao-du-an'), browser, undefined, process.env.HDSD_RECORD?.split(',').includes('02-tao-du-an') ?? true);
  const ui = await clip.open();
  const { page } = ui;
  const field = (label: string) => page.getByLabel(label, { exact: true });

  await clip.step('danh-sach-du-an', async () => {
    await page.goto('/prj/prj-01?devUser=projectManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.list.page.title'] })).toBeVisible();
    await ui.wait(800);
  });

  await clip.step('mo-bieu-mau', async () => {
    await ui.click(page.getByRole('link', { name: vi['prj.list.create.action'] }));
    await expect(page.getByRole('heading', { level: 1, name: vi['prj.create.page.title'] })).toBeVisible();
    await ui.point(field(vi['prj.form.code.label']));
  });

  await clip.step('kiem-tra-bat-buoc', async () => {
    await ui.click(page.getByRole('button', { name: vi['prj.create.submit.action'] }));
    await expect(page.locator('[data-field="project-code"]').getByText(vi['prj.field.required.error'])).toBeVisible();
    await ui.spot(page.locator('[data-field="project-code"]'), () => ui.wait(1500));
  });

  await clip.step('dien-thong-tin', async () => {
    await ui.type(field(vi['prj.form.code.label']), CODE);
    await ui.type(field(vi['prj.form.name.label']), NAME);
    await ui.point(field(vi['prj.form.owner.label']));
    await field(vi['prj.form.owner.label']).selectOption({ label: 'CB-SKHDT-QLDA · Ban Quản lý dự án' });
    await ui.point(field(vi['prj.form.area.label']));
    await field(vi['prj.form.area.label']).selectOption({ label: 'E2E_AREA_1 · Thành phố Cao Bằng' });
    await ui.point(field(vi['prj.form.sector.label']));
    await field(vi['prj.form.sector.label']).selectOption({ label: 'TRANSPORT · Giao thông' });
    await ui.type(field(vi['prj.form.total.label']), TOTAL);
  });

  await clip.step('ket-qua', async () => {
    await ui.click(page.getByRole('button', { name: vi['prj.create.submit.action'] }));
    const done = page.getByTestId('created');
    await expect(done).toBeVisible();
    await expect(done.getByText(vi['prj.create.done.text'])).toBeVisible();
    await expect(done.getByTestId('suggestion')).toContainText('B');
    await ui.spot(done, () => ui.wait(1500));
  });

  await clip.step('tim-trong-danh-sach', async () => {
    await page.goto('/prj/prj-01?devUser=projectManager');
    const row = page.locator('tr[data-project-id]', { hasText: CODE });
    await expect(row).toBeVisible();
    await ui.spot(row, () => ui.wait(900));
    await ui.type(field(vi['prj.list.query.label']), CODE.toLowerCase());
    await expect(page.locator('tr[data-project-id]')).toHaveCount(1);
  });

  await clip.step('khong-gian-du-an', async () => {
    await ui.click(page.locator('tr[data-project-id]', { hasText: CODE }).getByRole('link', { name: CODE }));
    await page.waitForURL(/\/prj\/prj-03/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await ui.wait(1500);
  });

  await clip.finish();
});
