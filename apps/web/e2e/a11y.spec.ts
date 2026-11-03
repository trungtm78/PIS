import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { WEB_ROUTES } from './support/web-routes.ts';
import { devUserFor } from './support/walk-plan.ts';

const AXE_SOURCE = createRequire(import.meta.url).resolve('axe-core');
/** The core flows of the application: the leader's home, the organisation, the members, the inbox, projects, reports and capital. */
const CORE_FLOWS = ['HOME-01', 'HOME-09', 'HOME-02', 'ADM-01', 'ADM-02', 'NOT-01', 'PRJ-01', 'DIS-01', 'CAP-01'];
/** 390 px is a phone; 1280 px at 200 percent zoom lays the page out in 640 CSS px at twice the pixel density. */
const VIEWPORTS = [
  { name: '390 px', width: 390, height: 844, scale: 1 },
  { name: '1280 px at 200 percent zoom', width: 640, height: 400, scale: 2 },
  { name: '1280 px', width: 1280, height: 800, scale: 1 },
] as const;
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Violation {
  id: string;
  impact: string | null;
  nodes: Array<{ target: unknown[] }>;
}

const pathOf = (id: string): string => {
  const route = WEB_ROUTES.find((candidate) => candidate.id === id);
  if (route === undefined) throw new Error(`route ${id} is not in the route table`);
  return `${route.path}?devUser=${devUserFor(route)}`;
};

async function openRoute(page: Page, id: string): Promise<void> {
  await page.goto(pathOf(id));
  await page.waitForSelector('.workspace-breadcrumb');
  await page.waitForLoadState('networkidle');
}

/** Serious and critical violations of the page as it is rendered, colour contrast included (the component tests cannot compute it). */
async function seriousViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_SOURCE });
  const violations = await page.evaluate(
    async (tags) => {
      const axe = (window as unknown as { axe: { run(context: Document, options: object): Promise<{ violations: Violation[] }> } }).axe;
      return (await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] })).violations;
    },
    WCAG_TAGS,
  );
  return violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical').map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

for (const viewport of VIEWPORTS) {
  test.describe(`core flows at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.scale });

    for (const id of CORE_FLOWS) {
      test(`AC-ST-KERNEL-032-1 UAT-NFR-ACCESSIBILITY-01: ${id} at ${viewport.name} has 0 serious or critical axe violations and no horizontal scroll`, async ({ page }) => {
        await openRoute(page, id);
        expect(await seriousViolations(page)).toEqual([]);
        const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
        expect(overflow, `${id} scrolls sideways by ${overflow} px`).toBe(0);
      });
    }
  });
}
