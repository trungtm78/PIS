import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql } from './support/stack.ts';

/**
 * DIS-14 (calendar of the reporting periods) in a real browser against the real API and database (apps/api/test/e2e-stack): the period manager
 * generates the weeks of a year from the reporting calendar of the master data, soft closes a period after its deadline, and a different person
 * who holds the lock permission locks it. A year is generated once, a period that is not due offers no soft close, and someone who only reads
 * the calendar has no button. What the screen changed is looked up in the database.
 */

/** A year in the past, so that every deadline of it has passed; the calendar of the master data is the baseline the stack applies. */
const PAST_YEAR = 2025;
/** A year in the future, so that no deadline of it has come. */
const FUTURE_YEAR = 2027;

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/dis/dis-14?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface PeriodRow {
  code: string;
  status: string;
  version: string;
  period_type: string;
  calendar_code: string;
  soft_closed: boolean;
  locked: boolean;
  locked_by: string | null;
}

const periodOf = async (id: string): Promise<PeriodRow | undefined> =>
  (
    await sql<PeriodRow>(
      `select code, status, version::text as version, period_type, calendar_code, soft_closed_at is not null as soft_closed, locked_at is not null as locked, locked_by
         from machvon.reporting_period where id = $1`,
      [id],
    )
  )[0];

const summaryOf = async (year: number): Promise<{ total: number; open: number; types: string[]; calendars: string[] }> => {
  const [row] = await sql<{ total: number; open: number; types: string[]; calendars: string[] }>(
    `select count(*)::int as total, (count(*) filter (where status = 'OPEN'))::int as open, array_agg(distinct period_type) as types, array_agg(distinct calendar_code) as calendars
       from machvon.reporting_period where fiscal_year = $1`,
    [year],
  );
  return row ?? { total: 0, open: 0, types: [], calendars: [] };
};

const chooseYear = (page: Page, year: number) => page.locator('#calendar-year').selectOption(String(year));
const generator = (page: Page): Locator => page.getByRole('form', { name: vi['dis.calendar.generate.title'] });
const generate = (page: Page, year: string) =>
  generator(page).getByLabel(vi['dis.calendar.generate.year.label'], { exact: true }).fill(year).then(() => generator(page).getByRole('button', { name: vi['dis.calendar.generate.submit.action'] }).click());

async function move(page: Page, id: string, action: 'softClose' | 'lock', reason: string): Promise<void> {
  const row = page.locator(`tr[data-period-id="${id}"]`);
  await row.locator(`[data-move="${action}"]`).click();
  const code = await row.getAttribute('data-period-code');
  const dialog = page.getByRole('dialog', { name: (action === 'softClose' ? vi['dis.calendar.softClose.dialog.title'] : vi['dis.calendar.lock.dialog.title']).replace('{code}', code ?? '') });
  await dialog.getByLabel(vi['dis.calendar.dialog.reason.label'], { exact: true }).fill(reason);
  await dialog.getByRole('button', { name: action === 'softClose' ? vi['dis.calendar.softClose.confirm.action'] : vi['dis.calendar.lock.confirm.action'] }).click();
}

test.describe('DIS-14 reporting period calendar', () => {
  test('the manager generates a year, soft closes a period after its deadline, a different person locks it, and a year is generated once; someone who only reads has no button (AC-ST-DIS-001-1, AC-ST-DIS-001-3, AC-ST-DIS-001-4)', async ({ page }) => {
    await open(page, 'periodManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['dis.calendar.page.title'] })).toBeVisible();

    // A year outside the supported range is stopped before it is sent.
    await generate(page, '1999');
    await expect(generator(page).getByText(vi['dis.calendar.field.invalidYear.error'])).toBeVisible();
    expect((await summaryOf(1999)).total).toBe(0);

    // The weeks of a past year come from the calendar in force; each keeps the version of the calendar it was generated from.
    expect((await summaryOf(PAST_YEAR)).total).toBe(0);
    await generate(page, String(PAST_YEAR));
    await expect(page.getByTestId('generated')).toHaveText(vi['dis.calendar.generate.done.notice'].replace('{year}', String(PAST_YEAR)));
    const generated = await summaryOf(PAST_YEAR);
    expect(generated.total).toBeGreaterThanOrEqual(52);
    expect(generated).toMatchObject({ open: generated.total, types: ['WEEK'], calendars: ['DEFAULT'] });
    // Every deadline is a Friday at 03:00 UTC (10:00 +07) and every period is bound to the version of the calendar it came from.
    expect(
      await sql(
        "select count(*)::int as n from machvon.reporting_period where fiscal_year = $1 and (extract(dow from deadline_at at time zone 'UTC') <> 5 or (deadline_at at time zone 'UTC')::time <> time '03:00' or calendar_version_id is null)",
        [PAST_YEAR],
      ),
    ).toEqual([{ n: 0 }]);
    await expect(page.locator('#calendar-year')).toHaveValue(String(PAST_YEAR));
    await expect(page.locator('tr[data-period-id]')).toHaveCount(generated.total);
    await expect(page.getByTestId('count')).toHaveText(vi['dis.calendar.count.text'].replace('{total}', String(generated.total)).replace('{open}', String(generated.total)).replace('{softClosed}', '0').replace('{locked}', '0'));

    // Generating the same year again is refused and writes nothing.
    await generate(page, String(PAST_YEAR));
    await expect(page.getByRole('alert').filter({ hasText: vi['dis.calendar.problem.overlap.error'] })).toBeVisible();
    expect((await summaryOf(PAST_YEAR)).total).toBe(generated.total);

    // The first week is past its deadline: the manager soft closes it for a stated reason, and holds no lock.
    const first = page.locator('tr[data-period-id]').first();
    const id = (await first.getAttribute('data-period-id')) ?? '';
    await expect(first).toHaveAttribute('data-status', 'OPEN');
    await expect(first.locator('[data-move="lock"]')).toHaveCount(0);
    await first.locator('[data-move="softClose"]').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: vi['dis.calendar.softClose.confirm.action'] }).click();
    await expect(dialog.getByText(vi['dis.calendar.field.required.error'])).toBeVisible();
    await dialog.getByLabel(vi['dis.calendar.dialog.reason.label'], { exact: true }).fill('ngắn');
    await dialog.getByRole('button', { name: vi['dis.calendar.softClose.confirm.action'] }).click();
    await expect(dialog.getByText(vi['dis.calendar.field.tooShort.error'])).toBeVisible();
    expect((await periodOf(id))?.status).toBe('OPEN');
    await dialog.getByRole('button', { name: vi['dis.calendar.dialog.cancel.action'] }).click();
    await move(page, id, 'softClose', 'Hết hạn nộp báo cáo tuần');
    await expect(first).toHaveAttribute('data-status', 'SOFT_CLOSED');
    await expect(first.locator('[data-move]')).toHaveCount(0);
    expect(await periodOf(id)).toMatchObject({ status: 'SOFT_CLOSED', version: '2', soft_closed: true, locked: false, locked_by: null, period_type: 'WEEK', calendar_code: 'DEFAULT' });
    expect(await sql("select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = 'dis.period_soft_closed' and reason = $2", [id, 'Hết hạn nộp báo cáo tuần'])).toEqual([{ n: 1 }]);

    // A different person locks it; they hold no soft close, so the periods that are still open offer them nothing.
    await open(page, 'periodLocker');
    await expect(generator(page)).toHaveCount(0);
    await chooseYear(page, PAST_YEAR);
    const row = page.locator(`tr[data-period-id="${id}"]`);
    await expect(row).toHaveAttribute('data-status', 'SOFT_CLOSED');
    await expect(page.locator('[data-move="softClose"]')).toHaveCount(0);
    await move(page, id, 'lock', 'Đã chốt số liệu của tuần');
    await expect(row).toHaveAttribute('data-status', 'LOCKED');
    await expect(row.locator('[data-move]')).toHaveCount(0);
    expect(await periodOf(id)).toMatchObject({ status: 'LOCKED', version: '3', soft_closed: true, locked: true, locked_by: membershipOf('periodLocker') });
    expect(await sql("select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = 'dis.period_locked' and reason = $2", [id, 'Đã chốt số liệu của tuần'])).toEqual([{ n: 1 }]);
    await expect(page.getByTestId('count')).toHaveText(vi['dis.calendar.count.text'].replace('{total}', String(generated.total)).replace('{open}', String(generated.total - 1)).replace('{softClosed}', '0').replace('{locked}', '1'));

    // The status filter narrows the list to the locked week.
    await page.locator('#calendar-status').selectOption('LOCKED');
    await expect(page.locator('tr[data-period-id]')).toHaveCount(1);
    await page.locator('#calendar-status').selectOption('SOFT_CLOSED');
    await expect(page.getByTestId('empty-periods')).toHaveText(vi['dis.calendar.noMatch.text']);

    // Someone who only reads sees the whole calendar and no button.
    await open(page, 'periodReader');
    await expect(generator(page)).toHaveCount(0);
    await chooseYear(page, PAST_YEAR);
    await expect(page.locator('tr[data-period-id]')).toHaveCount(generated.total);
    await expect(page.locator(`tr[data-period-id="${id}"]`)).toHaveAttribute('data-status', 'LOCKED');
    await expect(page.locator('[data-move]')).toHaveCount(0);
  });

  test('a period that is not due offers no soft close and says so, and someone without the read permission is refused the screen', async ({ page }) => {
    await open(page, 'periodManager');
    await generate(page, String(FUTURE_YEAR));
    await expect(page.getByTestId('generated')).toBeVisible();
    await chooseYear(page, FUTURE_YEAR);
    const first = page.locator('tr[data-period-id]').first();
    await expect(first).toHaveAttribute('data-status', 'OPEN');
    await expect(first.getByText(vi['dis.calendar.beforeDeadline.hint'])).toBeVisible();
    await expect(page.locator('[data-move]')).toHaveCount(0);
    expect((await summaryOf(FUTURE_YEAR)).open).toBe((await summaryOf(FUTURE_YEAR)).total);

    await open(page, 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-period-id]')).toHaveCount(0);
  });
});
