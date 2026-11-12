import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { DESKTOP, PHONE, seriousViolations } from './support/axe-page.ts';
import { chooseOption, pressButton, startAtTitle, tabTo, typeDate, typeInto } from './support/keyboard.ts';
import { stackInfo } from './support/stack.ts';

/**
 * UAT-DIR-A11-01: the screens of the directive module against the real stack of the enterprise edition, with a directive that is past its due day.
 * Every screen is judged by axe at 1280 px and 360 px; the status of a directive is read from the page as words; assigning a directive and asking for more time are done with the keyboard alone, and a dialog gives the focus back to the button that opened it.
 */

const DAY = 86_400_000;
const day = (offset: number): string => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

interface Seeded {
  meetingId: string;
  overdueId: string;
  openId: string;
}

async function seed(): Promise<Seeded> {
  const unit = stackInfo().units.A['CB-SKHDT-QLDA'];
  expect(unit).toBeDefined();
  const meeting = await apiCall('owner', 'POST', '/steering-meetings', { body: { meeting_date: day(-30), meeting_type: 'WEEKLY', title: 'Giao ban tuần về giải ngân', unit_id: unit } });
  expect(meeting.status, JSON.stringify(meeting.json)).toBe(200);
  const meetingId = String(meeting.json.resource_id);
  const give = async (text: string, dueOn: string): Promise<string> => {
    const made = await apiCall('owner', 'POST', `/steering-meetings/${meetingId}/directives`, { body: { scope_kind: 'UNIT', unit_id: unit, text, assignee_unit_id: unit, due_on: dueOn } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    return String(made.json.resource_id);
  };
  return { meetingId, overdueId: await give('Hoàn thành thủ tục giải phóng mặt bằng.', day(-5)), openId: await give('Nộp báo cáo giải ngân tháng.', day(30)) };
}

async function open(page: Page, path: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=owner`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForLoadState('networkidle');
}

test.describe('UAT-DIR-A11-01 the directive screens', () => {
  let seeded: Seeded;
  test.beforeAll(async () => {
    seeded = await seed();
  });

  for (const [name, size] of [['1280 px', DESKTOP], ['360 px', PHONE]] as const) {
    test(`UAT-DIR-A11-01 DIR-01 to DIR-05 at ${name} have 0 serious or critical axe violations`, async ({ page }) => {
      const paths = {
        'DIR-01': '/dir/dir-01',
        'DIR-02': `/dir/dir-02?meeting=${seeded.meetingId}`,
        'DIR-03': '/dir/dir-03',
        'DIR-04': `/dir/dir-04?directive=${seeded.overdueId}`,
        'DIR-05': '/dir/dir-05',
      };
      for (const [screen, path] of Object.entries(paths)) {
        await open(page, path, size);
        expect(await seriousViolations(page), `${screen} at ${name}`).toEqual([]);
      }
    });
  }

  test('UAT-DIR-A11-01 the overdue state is said in words on the board and on the directive, never by colour alone', async ({ page }) => {
    await open(page, '/dir/dir-03', DESKTOP);
    const board = page.getByTestId('board');
    await expect(board).toContainText(vi['dir.status.overdue.label']);
    await open(page, `/dir/dir-04?directive=${seeded.overdueId}`, DESKTOP);
    await expect(page.getByRole('main').or(page.locator('[data-screen-id="DIR-04"]'))).toContainText(vi['dir.status.overdue.label']);
  });

  test('UAT-DIR-A11-01 a directive is given and more time is asked for with the keyboard alone, and the dialog returns the focus to the button that opened it', async ({ page }) => {
    // Giving a directive in a meeting: the button, the radio, the fields and the save are reached with Tab and filled with keys.
    await open(page, `/dir/dir-02?meeting=${seeded.meetingId}`, DESKTOP);
    await startAtTitle(page);
    await pressButton(page, page.getByRole('button', { name: vi['dir.meeting.add.action'] }));
    // The radios are one tab stop (the checked one); the arrow key moves to the other.
    await tabTo(page, page.getByRole('radio', { name: vi['dir.meeting.add.kind.project'] }));
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: vi['dir.meeting.add.kind.unit'] })).toBeChecked();
    await chooseOption(page, page.locator('#dir-add-unit'), (await page.locator('#dir-add-unit option').nth(1).textContent()) ?? '');
    await typeInto(page, page.locator('#dir-add-text'), 'Báo cáo tiến độ lên lãnh đạo.');
    await chooseOption(page, page.locator('#dir-add-assignee-unit'), (await page.locator('#dir-add-assignee-unit option').nth(1).textContent()) ?? '');
    await typeDate(page, page.locator('#dir-add-due'), day(20));
    await pressButton(page, page.getByRole('button', { name: vi['dir.meeting.add.submit.action'] }));
    await expect(page.getByTestId('message')).toHaveText(vi['dir.meeting.add.done.text']);

    // Asking for more time: the form, then the dialog; Escape leaves the dialog and the focus is back on the button that opened it.
    await open(page, `/dir/dir-04?directive=${seeded.openId}`, DESKTOP);
    await startAtTitle(page);
    await pressButton(page, page.locator('[data-action="extension"]'));
    await typeDate(page, page.locator('#dir-proposed'), day(37));
    const review = page.getByRole('button', { name: vi['dir.form.review.action'] });
    await pressButton(page, review);
    const dialog = page.getByRole('dialog', { name: vi['dir.confirm.extension.title'] });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(review).toBeFocused();
    await pressButton(page, review);
    await expect(dialog).toBeVisible();
    await page.keyboard.type('Cần thêm thời gian hoàn thiện hồ sơ.');
    await pressButton(page, dialog.getByRole('button', { name: vi['dir.confirm.extension.action'] }));
    await expect(page.getByTestId('message')).toHaveText(vi['dir.done.text']);
    await expect(page.getByTestId('pending-extension')).toBeVisible();

    // The person who recorded a directive is not offered the close (the server offers what the caller may do): the button is not on the page, the tests of the screen close it as a third person.
    await open(page, `/dir/dir-04?directive=${seeded.overdueId}`, DESKTOP);
    await expect(page.locator('[data-action="extension"]')).toBeVisible();
    await expect(page.locator('[data-action="close"]')).toHaveCount(0);
  });

  test('negative control: the axe check reports an image without a text alternative', async ({ page }) => {
    await page.setContent('<main><h1>t</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button style="width:10px;height:10px"></button></main>');
    expect((await seriousViolations(page)).join(' ')).toContain('image-alt');
  });
});
