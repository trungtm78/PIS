import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

const AXE_SOURCE = createRequire(import.meta.url).resolve('axe-core');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** The two widths the accessibility cases of the enterprise screens name: a desktop and the phone of the PWA reference size. */
export const DESKTOP = { width: 1280, height: 800 } as const;
export const PHONE = { width: 360, height: 780 } as const;

interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: Array<{ target: unknown[] }>;
}

/** The serious and critical violations of the page as it is rendered (colour contrast included, which the component tests cannot compute), each as `rule: selector | selector`. */
export async function seriousViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_SOURCE });
  const violations = await page.evaluate(
    async (tags) => {
      const axe = (window as unknown as { axe: { run(context: Document, options: object): Promise<{ violations: AxeViolation[] }> } }).axe;
      return (await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] })).violations;
    },
    WCAG_TAGS,
  );
  return violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical').map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
}

/** How far the page scrolls sideways, in CSS pixels (0 when it does not). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
}
