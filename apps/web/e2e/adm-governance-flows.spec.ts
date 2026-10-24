import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * ADM-07 (working calendar) and ADM-15 (delegation-of-authority matrix) in a real browser against the real API and database
 * (apps/api/test/e2e-stack): the fixture users are picked with `?devUser=`, every request is authorised by the policy guard,
 * and what the screens changed is looked up in the database.
 */

/** The id of a seeded unit of tenant A by its code. */
function unitOf(code: string): string {
  const unit = stackInfo().units.A[code];
  if (unit === undefined) throw new Error(`seeded unit ${code} is missing`);
  return unit;
}
const unique = (): string => Date.now().toString(36).toUpperCase();

async function openScreen(page: Page, screen: 'adm-07' | 'adm-15', user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/adm/${screen}?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface CalendarRow {
  id: string;
  status: string;
  revision: number;
  published_by: string | null;
  holidays: Array<{ date: string; name: string }>;
  compensated_workdays: string[];
}

const calendarRows = (code: string): Promise<CalendarRow[]> =>
  sql('select id, status, revision, published_by, holidays, compensated_workdays from machvon.work_calendar_version where calendar_code = $1 order by revision', [code]);

test.describe('ADM-07 working calendar', () => {
  test('the owner marks a holiday and a compensated working day on the month grids, saves the draft, publishes it, and a second revision supersedes it', async ({ page }) => {
    const code = `E2E-CAL-${unique()}`;
    await openScreen(page, 'adm-07', 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.calendar.page.title'] })).toBeVisible();
    await expect(page.getByTestId('placeholder-note')).toBeVisible();

    const editor = page.getByTestId('editor');
    await editor.getByLabel(vi['adm.calendar.code.label'], { exact: true }).fill(code);
    await editor.getByLabel(vi['adm.calendar.year.label'], { exact: true }).fill('2026');
    await editor.getByLabel(vi['adm.calendar.basis.label'], { exact: true }).fill('Labour Code 2019 art. 112; notice of the e2e flow');
    await expect(editor.locator('table.cal-month')).toHaveCount(12);
    // 1 May 2026 is a Friday (worked): it becomes a holiday. 9 May is a Saturday (off): it becomes a compensated working day.
    await editor.locator('[data-date="2026-05-01"]').click();
    await editor.locator('[data-date="2026-05-09"]').click();
    await expect(editor.locator('[data-date="2026-05-01"]')).toHaveAttribute('data-kind', 'holiday');
    await expect(editor.locator('[data-date="2026-05-09"]')).toHaveAttribute('data-kind', 'compensated');
    // A holiday has a name before the draft is saved.
    await editor.getByRole('button', { name: vi['adm.calendar.draft.submit.action'] }).click();
    await expect(editor.getByText(vi['adm.calendar.field.nameRequired'])).toBeVisible();
    expect(await calendarRows(code)).toHaveLength(0);
    await editor.locator('#holiday-name-2026-05-01').fill('Quốc tế Lao động');
    await editor.getByRole('button', { name: vi['adm.calendar.draft.submit.action'] }).click();
    await expect(page.getByText(vi['adm.calendar.draft.accepted.notice'])).toBeVisible();

    const row = page.locator('tr[data-calendar-id]').filter({ hasText: code });
    await expect(row).toHaveAttribute('data-status', 'Draft');
    const [draft] = await calendarRows(code);
    expect(draft?.status).toBe('Draft');
    expect(draft?.holidays).toEqual([{ date: '2026-05-01', name: 'Quốc tế Lao động' }]);
    expect(draft?.compensated_workdays).toEqual(['2026-05-09']);

    await row.getByRole('button', { name: vi['adm.calendar.publish.action'] }).click();
    await page.getByRole('button', { name: vi['adm.calendar.publish.confirm.action'] }).click();
    await expect(page.getByText(vi['adm.calendar.field.required'])).toBeVisible();
    await page.getByLabel(vi['adm.calendar.publish.reason.label']).fill('The notice of the year is signed');
    await page.getByRole('button', { name: vi['adm.calendar.publish.confirm.action'] }).click();
    await expect(page.getByText(vi['adm.calendar.publish.accepted.notice'])).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'Published');
    const [published] = await calendarRows(code);
    expect(published?.status).toBe('Published');
    expect(published?.published_by).toBe(membershipOf('owner'));

    // The version in force is drawn with its compensated working day.
    await row.getByRole('button', { name: vi['adm.calendar.view.action'] }).click();
    const inView = page.getByTestId('version-in-view');
    await expect(inView.locator('[data-date="2026-05-09"]')).toHaveAttribute('data-kind', 'compensated');
    await expect(inView.locator('[data-date="2026-05-01"]')).toHaveAttribute('data-kind', 'holiday');

    // The next revision starts from the published one, drops the compensated day and supersedes it when published.
    await row.getByRole('button', { name: vi['adm.calendar.copy.action'] }).click();
    await editor.locator('[data-date="2026-05-09"]').click();
    await editor.getByRole('button', { name: vi['adm.calendar.draft.submit.action'] }).click();
    await expect(page.locator('tr[data-calendar-id]').filter({ hasText: code })).toHaveCount(2);
    const second = page.locator('tr[data-calendar-id][data-status="Draft"]').filter({ hasText: code });
    await second.getByRole('button', { name: vi['adm.calendar.publish.action'] }).click();
    await page.getByLabel(vi['adm.calendar.publish.reason.label']).fill('The compensated day was withdrawn');
    await page.getByRole('button', { name: vi['adm.calendar.publish.confirm.action'] }).click();
    await expect(page.locator('tr[data-calendar-id][data-status="Superseded"]').filter({ hasText: code })).toHaveCount(1);
    const rows = await calendarRows(code);
    expect(rows.map((entry) => [entry.revision, entry.status])).toEqual([
      [1, 'Superseded'],
      [2, 'Published'],
    ]);
    expect(rows[1]?.compensated_workdays).toEqual([]);
  });

  test('someone without the calendar permissions is refused the screen', async ({ page }) => {
    await openScreen(page, 'adm-07', 'auditor');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByTestId('editor')).toHaveCount(0);
  });
});

test.describe('ADM-15 delegation-of-authority matrix', () => {
  test('the owner writes the bands, sees the gap before submitting, a second person approves, and the preview names the approver of each amount', async ({ page }) => {
    const unit = unitOf('CB-HQ');
    const legalBasis = `E2E regulation ${unique()}/QD`;
    await openScreen(page, 'adm-15', 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.doa.page.title'] })).toBeVisible();

    const editor = page.getByTestId('editor');
    await editor.getByLabel(vi['adm.doa.effectiveFrom.label'], { exact: true }).fill('2030-01-01');
    await editor.getByLabel(vi['adm.doa.basis.label'], { exact: true }).fill(legalBasis);
    const cell = (label: string, row: number) => editor.getByLabel(label.replace('{row}', String(row)), { exact: true });
    await cell(vi['adm.doa.rule.documentType.row'], 1).fill('FX');
    await cell(vi['adm.doa.rule.unit.row'], 1).selectOption(unit);
    await cell(vi['adm.doa.rule.role.row'], 1).selectOption({ label: 'MEMBER' });
    await cell(vi['adm.doa.rule.max.row'], 1).fill('5000000000');
    await editor.getByRole('button', { name: vi['adm.doa.rules.add.action'] }).click();
    // The second band is made to start above where the first ends: the chart shows the gap, and the reason it cannot be submitted.
    await cell(vi['adm.doa.rule.min.row'], 2).fill('6000000000');
    await cell(vi['adm.doa.rule.role.row'], 2).selectOption({ label: 'BILLING_VIEWER' });
    await cell(vi['adm.doa.rule.levels.row'], 2).selectOption('2');
    await expect(editor.locator('.doa-seg[data-kind="gap"]')).toContainText(vi['adm.doa.chart.gap']);
    await expect(editor.getByTestId('blockers')).toContainText(vi['adm.doa.error.gap'].replace('{row}', '2'));
    await cell(vi['adm.doa.rule.min.row'], 2).fill('5000000000');
    await expect(editor.locator('.doa-seg[data-kind="gap"]')).toHaveCount(0);
    await expect(editor.getByTestId('blockers')).toContainText(vi['adm.doa.blockers.none']);

    await editor.getByRole('button', { name: vi['adm.doa.draft.save.action'] }).click();
    await expect(page.getByText(vi['adm.doa.draft.accepted.notice'])).toBeVisible();
    const [made] = await sql<{ id: string; status: string; created_by: string; last_edited_by: string }>(
      'select id, status, created_by, last_edited_by from machvon.doa_matrix_version where legal_basis_ref = $1',
      [legalBasis],
    );
    const id = made?.id ?? '';
    expect(made?.status).toBe('Draft');
    expect(made?.created_by).toBe(membershipOf('owner'));
    expect((await sql<{ n: string }>('select count(*)::text as n from machvon.doa_rule where matrix_version_id = $1', [id]))[0]?.n).toBe('2');
    const row = page.locator(`tr[data-matrix-id="${id}"]`);
    await expect(row).toHaveAttribute('data-status', 'Draft');

    await row.getByRole('button', { name: vi['adm.doa.submit.action'] }).click();
    await page.getByLabel(vi['adm.doa.panel.reason.label']).fill('Ready for the second person');
    await page.getByRole('button', { name: vi['adm.doa.panel.confirm.action'] }).click();
    await expect(row).toHaveAttribute('data-status', 'PendingApproval');
    // The owner wrote the matrix and holds the approval permission: the screen still offers no approval of their own work.
    await expect(row.getByRole('button', { name: vi['adm.doa.approve.action'] })).toBeDisabled();

    await openScreen(page, 'adm-15', 'doaChecker');
    const pending = page.locator(`tr[data-matrix-id="${id}"]`);
    await expect(pending.getByRole('button', { name: vi['adm.doa.approve.action'] })).toBeEnabled();
    await expect(page.getByRole('button', { name: vi['adm.doa.draft.save.action'] })).toHaveCount(0);
    await pending.getByRole('button', { name: vi['adm.doa.approve.action'] }).click();
    await page.getByLabel(vi['adm.doa.panel.reason.label']).fill('Checked against the regulation');
    await page.getByRole('button', { name: vi['adm.doa.panel.confirm.action'] }).click();
    await expect(page.getByText(vi['adm.doa.decision.accepted.notice'])).toBeVisible();
    await expect(pending).toHaveAttribute('data-status', 'Published');
    const [approved] = await sql<{ status: string; approved_by: string; published_at: string | null }>(
      'select status, approved_by, published_at::text as published_at from machvon.doa_matrix_version where id = $1',
      [id],
    );
    expect(approved?.status).toBe('Published');
    expect(approved?.approved_by).toBe(membershipOf('doaChecker'));
    expect(approved?.published_at).not.toBeNull();

    // The preview names who approves, at the edges of the bands.
    await openScreen(page, 'adm-15', 'owner');
    await page.locator(`tr[data-matrix-id="${id}"]`).getByRole('button', { name: vi['adm.doa.view.action'] }).click();
    const preview = page.getByTestId('preview');
    await preview.getByLabel(vi['adm.doa.preview.amount.label'], { exact: true }).fill('4999999999');
    await expect(page.getByTestId('preview-result')).toContainText('MEMBER, 1 cấp duyệt');
    await preview.getByLabel(vi['adm.doa.preview.amount.label'], { exact: true }).fill('5000000000');
    await expect(page.getByTestId('preview-result')).toContainText('BILLING_VIEWER, 2 cấp duyệt');
  });

  test('someone without the matrix permissions is refused the screen', async ({ page }) => {
    await openScreen(page, 'adm-15', 'auditor');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByTestId('editor')).toHaveCount(0);
  });
});
