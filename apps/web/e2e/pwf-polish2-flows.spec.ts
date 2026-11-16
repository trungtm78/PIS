import { expect, test } from '@playwright/test';
import { apiCall } from './support/api.ts';
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * Polish of the quy trinh screens found by the review of the live server: the state badge of the step table of PWF-03 is whole at 1440 and 1280 px and the table scrolls inside its own region,
 * never the page. The person is `owner`; the project is made by the API the way PRJ-02 makes it.
 */

const PERSON = 'owner';
const today = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

async function runningProject(): Promise<{ id: string; taskId: string }> {
  const code = `E2E-POL2-${Date.now().toString(36).toUpperCase()}`;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [stackInfo().tenants.A]);
  const made = await apiCall(PERSON, 'POST', '/projects', {
    body: { code, name: `Dự án sửa giao diện ${code}`, owner_unit_id: stackInfo().units.A['CB-SKHDT-QLDA'], area_master_version_id: area?.id, total_investment_vnd: '150000000000', classification: 'INTERNAL', workflow: { planned_start_date: today(), facts: { project_group: 'B', funding_source: 'STATE_BUDGET' } } },
  });
  expect(made.status, JSON.stringify(made.json)).toBeLessThan(300);
  const [project] = await sql<{ id: string }>('select id from machvon.project where code = $1', [code]);
  if (project === undefined) throw new Error('the project was not made');
  // One task runs, so that the table shows the longest state word as well.
  let taskId = '';
  const listed = (await apiCall(PERSON, 'GET', `/projects/${project.id}/workflow/tasks?status=NOT_STARTED&limit=100`)).json as unknown as { items: Array<{ id: string; kind: string }> };
  for (const row of listed.items.filter((task) => task.kind !== 'MILESTONE').slice(0, 10)) {
    await apiCall(PERSON, 'POST', `/project-tasks/${row.id}/assignments`, { body: { membership_id: membershipOf(PERSON), role: 'RESPONSIBLE', valid_from: today(), share_pct: 100, reason: 'Giao việc cho người phụ trách trực tiếp theo phân công của dự án' } });
    const detail = (await apiCall(PERSON, 'GET', `/project-tasks/${row.id}`)).json as unknown as { version: number };
    if ((await apiCall(PERSON, 'POST', `/project-tasks/${row.id}/start`, { body: {}, version: detail.version })).status < 300) {
      taskId = row.id;
      break;
    }
  }
  return { id: project.id, taskId };
}

for (const width of [1440, 1280]) {
  test(`PWF-03 step table: the state badge is whole and the table scrolls inside its region at ${width} px`, async ({ page }) => {
    const { id } = await runningProject();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/pwf/pwf-03?id=${id}&devUser=${PERSON}`);
    const table = page.getByTestId('step-table');
    await expect(table).toBeVisible();
    const m = await table.evaluate((root) => {
      const scroll = root.querySelector('.ui-table-scroll') as HTMLElement;
      const box = scroll.getBoundingClientRect();
      const pills = [...root.querySelectorAll('td[data-label] .ui-pill')] as HTMLElement[];
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollClient: scroll.clientWidth,
        scrollWidth: scroll.scrollWidth,
        pills: pills.map((pill) => {
          const rect = pill.getBoundingClientRect();
          const cell = (pill.closest('td') as HTMLElement).getBoundingClientRect();
          return { text: pill.textContent, clippedByCell: rect.right - cell.right, textCut: pill.scrollWidth - pill.clientWidth, outsideRegion: rect.right - box.right };
        }),
      };
    });
    expect(m.pageOverflow).toBeLessThanOrEqual(0);
    for (const pill of m.pills) {
      expect(pill.textCut, pill.text ?? '').toBeLessThanOrEqual(0);
      // A badge may be further right than the region only by the region scrolling to it; it is never wider than its cell.
      expect(pill.clippedByCell, pill.text ?? '').toBeLessThanOrEqual(1);
    }
  });
}

// A screen of the governance pages (CAP-23, DIS-30 share the grid) at 390 px: its tables scroll in their own regions and the page never scrolls sideways.
for (const path of ['/cap/cap-23', '/dis/dis-30']) {
  test(`${path} does not scroll sideways at 390 px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${path}?devUser=${PERSON}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.workspace-breadcrumb');
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('PWF-04 at 900 px high: the bar of actions leaves room below what the page scrolls to', async ({ page }) => {
  const { id, taskId } = await runningProject();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/pwf/pwf-04?id=${taskId}&project=${id}&devUser=${PERSON}`);
  const bar = page.getByTestId('task-actions');
  await expect(bar).toBeVisible();
  const height = (await bar.boundingBox())?.height ?? 0;
  expect(height).toBeGreaterThan(0);
  const room = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom));
  expect(room).toBeGreaterThanOrEqual(height);
  // A block brought into view by the page (an anchor, a focus) ends above the bar.
  await page.locator('.pwft-block').last().evaluate((element) => element.scrollIntoView({ block: 'end' }));
  const [block, barBox] = await Promise.all([page.locator('.pwft-block').last().boundingBox(), bar.boundingBox()]);
  expect((block?.y ?? 0) + (block?.height ?? 0)).toBeLessThanOrEqual((barBox?.y ?? 0) + 1);
});
