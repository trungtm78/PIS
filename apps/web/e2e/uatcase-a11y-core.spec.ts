import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { seriousViolations } from './support/axe-page.ts';
import { WEB_ROUTES } from './support/web-routes.ts';
import { devUserFor } from './support/walk-plan.ts';

/**
 * UX01 (NFR-ACCESSIBILITY-01): the core flows of the application (the leader's home, the organisation, the members, the inbox, projects, reports and capital) at 390 px and
 * at 1280 px with 200 percent zoom keep every control named (axe: names of buttons, links, fields, images) and do not scroll sideways; the keyboard moves through each flow
 * without a trap; the two modal parts of the shell (the help drawer and the alert bell) take the focus in, hold it, give way to Escape and return the focus to the control that
 * opened them. What a screen reader says aloud is not judged here.
 */

const CORE_FLOWS = ['HOME-01', 'HOME-09', 'HOME-02', 'ADM-01', 'ADM-02', 'NOT-01', 'PRJ-01', 'DIS-01', 'CAP-01'];
const MAX_TABS = 90;

const pathOf = (id: string): string => {
  const route = WEB_ROUTES.find((candidate) => candidate.id === id);
  if (route === undefined) throw new Error(`route ${id} is not in the route table`);
  return `${route.path}?devUser=${devUserFor(route)}`;
};

async function openFlow(page: Page, id: string): Promise<void> {
  await page.goto(pathOf(id));
  await page.waitForSelector('.workspace-breadcrumb');
  await page.waitForLoadState('networkidle');
}

test.describe('UX01 the core flows', () => {
  for (const viewport of [
    { name: '390 px', width: 390, height: 844, scale: 1 },
    { name: '1280 px at 200 percent zoom', width: 640, height: 400, scale: 2 },
  ] as const) {
    test.describe(viewport.name, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.scale });
      test(`UX01 the core flows at ${viewport.name} name every control and do not scroll sideways`, async ({ page }) => {
        for (const id of CORE_FLOWS) {
          await openFlow(page, id);
          expect(await seriousViolations(page), `${id} at ${viewport.name}`).toEqual([]);
          const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
          expect(overflow, `${id} scrolls sideways by ${overflow} px`).toBe(0);
        }
      });
    });
  }

  test('UX01 the keyboard goes through each core flow without a trap: Tab keeps moving to new controls, and Shift+Tab goes back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const id of CORE_FLOWS) {
      await openFlow(page, id);
      const seen: string[] = [];
      let stuck = 0;
      for (let press = 0; press < MAX_TABS; press += 1) {
        await page.keyboard.press('Tab');
        const now = await page.evaluate(() => {
          const element = document.activeElement;
          if (element === null || element === document.body) return { where: 'body', segments: false };
          const path: string[] = [];
          for (let node: Element | null = element; node !== null && node !== document.body; node = node.parentElement) path.push(`${node.tagName}:${Array.from(node.parentElement?.children ?? []).indexOf(node)}`);
          // A native date or time field has parts (day, month, year) and Tab goes through each of them: that is the browser, not a trap.
          return { where: path.join('/'), segments: element instanceof HTMLInputElement && ['date', 'time', 'datetime-local', 'month', 'week'].includes(element.type) };
        });
        stuck = seen[seen.length - 1] === now.where ? stuck + 1 : 0;
        expect(stuck, `${id}: the focus stays on ${now.where} while Tab is pressed`).toBeLessThan(now.segments ? 6 : 2);
        seen.push(now.where);
      }
      const distinct = new Set(seen.filter((where) => where !== 'body'));
      expect(distinct.size, `${id}: Tab reached ${distinct.size} controls`).toBeGreaterThanOrEqual(8);
      // Shift+Tab leaves the control the walk ended on (a date field takes up to four presses for its parts) and goes to the one before it.
      const before = await page.evaluateHandle(() => document.activeElement);
      let left = false;
      for (let press = 0; press < 5 && !left; press += 1) {
        await page.keyboard.press('Shift+Tab');
        left = await page.evaluate((origin) => document.activeElement !== origin, before);
      }
      expect(left, `${id}: Shift+Tab goes back`).toBe(true);
    }
  });

  test('UX01 the help drawer and the alert bell are opened from the keyboard, hold the focus, are left with Escape, and give the focus back to the control that opened them', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openFlow(page, 'HOME-01');
    const openers = [page.getByRole('button', { name: vi['shell.help.open.label'] }), page.locator('button.mv-alert-bell')];
    for (const opener of openers) {
      await opener.focus();
      await page.keyboard.press('Enter');
      const dialog = page.locator('[role="dialog"][aria-modal="true"]').last();
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      // Tab and Shift+Tab stay inside while it is open: no way out except the ways that close it.
      for (let press = 0; press < 12; press += 1) {
        await page.keyboard.press(press % 4 === 3 ? 'Shift+Tab' : 'Tab');
        expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Tab left the dialog at press ${press}`).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  });

  test('negative control: the axe check reports a button without a name', async ({ page }) => {
    await page.setContent('<main><h1>t</h1><button></button></main>');
    expect((await seriousViolations(page)).join(' ')).toContain('button-name');
  });
});
