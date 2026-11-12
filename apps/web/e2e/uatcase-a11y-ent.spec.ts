import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { apiCall } from './support/api.ts';
import { PHONE, horizontalOverflow, seriousViolations } from './support/axe-page.ts';
import { stackInfo } from './support/stack.ts';

/**
 * PWA A11Y: the ten screens of the installed manager application (PWA-01 to PWA-10) at 360 x 780 against the real stack of the enterprise edition: axe (colour contrast
 * included) finds no serious or critical violation and the page does not scroll sideways. The case of the ten screens is not closed by this file: it asks every touch target to be at least
 * 44 px, and the rendered boxes of the shell header, the "i" buttons of the figures and the fields of the settings are smaller (see the finding of the case); the gesture
 * clause is judged by src/pwa/uatcase-a11y.test.ts.
 */

const DAY = 86_400_000;
const day = (offset: number): string => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const NO_TASK = '00000000-0000-4000-8000-0000000000ff';

async function seedDirective(): Promise<string> {
  const unit = stackInfo().units.A['CB-SKHDT-QLDA'];
  const meeting = await apiCall('owner', 'POST', '/steering-meetings', { body: { meeting_date: day(-30), meeting_type: 'WEEKLY', title: 'Giao ban tuần về giải ngân', unit_id: unit } });
  expect(meeting.status, JSON.stringify(meeting.json)).toBe(200);
  const made = await apiCall('owner', 'POST', `/steering-meetings/${String(meeting.json.resource_id)}/directives`, { body: { scope_kind: 'UNIT', unit_id: unit, text: 'Hoàn thành thủ tục giải phóng mặt bằng.', assignee_unit_id: unit, due_on: day(-5) } });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  return String(made.json.resource_id);
}

async function open(page: Page, path: string): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=owner`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForLoadState('networkidle');
}

test.describe('PWA A11Y the manager application at 360 px', () => {
  let directiveId = '';
  test.beforeAll(async () => {
    directiveId = await seedDirective();
  });

  test('PWA A11Y PWA-01 to PWA-10 at 360 px have 0 serious or critical axe violations and do not scroll sideways', async ({ page }) => {
    const screens: Array<[string, string]> = [
      ['PWA-01', '/m'],
      ['PWA-02', '/m/approvals'],
      ['PWA-03', '/m/dashboard'],
      ['PWA-04', '/m/directives'],
      ['PWA-05', `/m/approvals/${NO_TASK}`],
      ['PWA-06', `/m/directives/${directiveId}`],
      ['PWA-07', '/m/settings'],
      ['PWA-08', '/m/dashboard/detail'],
      ['PWA-09', '/m/progress'],
      ['PWA-10', '/m/notifications'],
    ];
    for (const [screen, path] of screens) {
      await open(page, path);
      expect(await seriousViolations(page), screen).toEqual([]);
      expect(await horizontalOverflow(page), `${screen} scrolls sideways`).toBe(0);
    }
  });

  test('negative control: the axe check reports a button without a name', async ({ page }) => {
    await page.setContent('<main><h1>t</h1><button></button></main>');
    expect((await seriousViolations(page)).join(' ')).toContain('button-name');
  });
});
