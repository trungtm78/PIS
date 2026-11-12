import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { DESKTOP, PHONE, seriousViolations } from './support/axe-page.ts';

/**
 * UAT-HUB-A11-01: the three screens of the integration hub (HUB-01 catalogue, HUB-02 connector, HUB-03 incident log) against the real stack of the enterprise edition,
 * with connectors in each of the three states the case names (healthy, stale, failing). The statuses are read from the page as words, the detail tabs are driven with the keyboard.
 */

const HOUR = 3_600_000;
const iso = (ago: number): string => new Date(Date.now() - ago).toISOString();
const STATUS_TEXT = { HEALTHY: vi['hub.status.healthy'], STALE: vi['hub.status.stale'], FAILING: vi['hub.status.failing'] } as const;

interface Connector {
  code: string;
  status: string;
}

async function connectors(): Promise<Connector[]> {
  const reply = await apiCall('owner', 'GET', '/integration-hub/connectors');
  expect(reply.status).toBe(200);
  return reply.json.items as Connector[];
}

async function record(code: string, outcome: 'SUCCEEDED' | 'FAILED', agoMs: number): Promise<void> {
  const body = { kind: 'IMPORT', outcome, started_at: iso(agoMs + 60_000), finished_at: iso(agoMs), rows_total: 10, rows_applied: outcome === 'SUCCEEDED' ? 10 : 0, rows_rejected: 0, ...(outcome === 'FAILED' ? { error_code: 'E2E_SOURCE_DOWN' } : {}) };
  const reply = await apiCall('owner', 'POST', `/integration-hub/connectors/${code}/runs`, { body });
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
}

/** One connector in each state: the first connector that judges its age goes stale on an old success, the next one fails on three failed runs, the next one is healthy on a run of now. */
async function seedThreeStates(): Promise<Record<keyof typeof STATUS_TEXT, string>> {
  const found: Partial<Record<keyof typeof STATUS_TEXT, string>> = {};
  for (const { code } of await connectors()) {
    if (found.STALE === undefined) {
      await record(code, 'SUCCEEDED', 4000 * HOUR);
      if ((await connectors()).find((one) => one.code === code)?.status === 'STALE') found.STALE = code;
      continue;
    }
    if (found.FAILING === undefined) {
      for (let run = 3; run > 0; run -= 1) await record(code, 'FAILED', run * HOUR);
      if ((await connectors()).find((one) => one.code === code)?.status === 'FAILING') found.FAILING = code;
      continue;
    }
    await record(code, 'SUCCEEDED', HOUR / 4);
    if ((await connectors()).find((one) => one.code === code)?.status === 'HEALTHY') {
      found.HEALTHY = code;
      break;
    }
  }
  if (found.STALE === undefined || found.FAILING === undefined || found.HEALTHY === undefined) throw new Error(`the hub did not reach the three states: ${JSON.stringify(found)}`);
  return found as Record<keyof typeof STATUS_TEXT, string>;
}

async function open(page: Page, path: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=owner`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForLoadState('networkidle');
}

test.describe('UAT-HUB-A11-01 the integration hub screens', () => {
  let states: Record<keyof typeof STATUS_TEXT, string>;
  test.beforeAll(async () => {
    states = await seedThreeStates();
    // The failing connector opened an incident: the third screen has a row to be judged on.
    const incidents = await apiCall('owner', 'GET', '/integration-hub/incidents');
    expect((incidents.json.items as unknown[]).length).toBeGreaterThan(0);
  });

  for (const [name, size] of [['1280 px', DESKTOP], ['360 px', PHONE]] as const) {
    for (const [screen, path] of [['HUB-01', '/hub/hub-01'], ['HUB-03', '/hub/hub-03']] as const) {
      test(`UAT-HUB-A11-01 ${screen} at ${name} has 0 serious or critical axe violations`, async ({ page }) => {
        await open(page, path, size);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
    test(`UAT-HUB-A11-01 HUB-02 at ${name} has 0 serious or critical axe violations`, async ({ page }) => {
      await open(page, `/hub/hub-02?code=${states.FAILING}`, size);
      expect(await seriousViolations(page)).toEqual([]);
    });
  }

  test('UAT-HUB-A11-01 each of the three states is said in words, on the catalogue and on the detail, not by colour alone', async ({ page }) => {
    await open(page, '/hub/hub-01', DESKTOP);
    for (const status of ['HEALTHY', 'STALE', 'FAILING'] as const) {
      const row = page.getByTestId(`connector-${states[status]}`).locator('xpath=ancestor::tr');
      await expect(row.getByTestId(`status-${status}`)).toHaveText(STATUS_TEXT[status]);
    }
    for (const status of ['HEALTHY', 'STALE', 'FAILING'] as const) {
      await open(page, `/hub/hub-02?code=${states[status]}`, DESKTOP);
      await expect(page.getByTestId('connector-head').getByTestId(`status-${status}`)).toHaveText(STATUS_TEXT[status]);
    }
  });

  test('UAT-HUB-A11-01 the detail tabs follow the WAI-ARIA tabs pattern: one tab stop, arrow keys, Home and End move the selection and the focus', async ({ page }) => {
    await open(page, `/hub/hub-02?code=${states.HEALTHY}`, DESKTOP);
    const tabs = page.getByRole('tab');
    const count = await tabs.count();
    expect(count).toBe(7);
    // Roving tabindex: the selected tab is the only one in the Tab order.
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    await expect(page.locator('[role="tab"][tabindex="-1"]')).toHaveCount(count - 1);
    await tabs.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await tabs.nth(1).getAttribute('id') ?? '');
    await page.keyboard.press('End');
    await expect(tabs.nth(count - 1)).toBeFocused();
    await expect(tabs.nth(count - 1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tabs.nth(0)).toBeFocused();
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  });
});
