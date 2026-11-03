import axe from 'axe-core';
import type { Result } from 'axe-core';

/** The WCAG 2.2 AA rules (ST-KERNEL-032, NFR-ACCESSIBILITY-01). */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * The violations of serious or critical impact that axe-core finds under `scope`. Two rules are left out here because a DOM without layout and without a canvas cannot
 * compute them (the colour contrast, and the match of a visible label with the accessible name, which measures icon fonts); the browser run (`apps/web/e2e/a11y.spec.ts`) checks both on the rendered pages.
 */
export async function seriousViolations(scope: Element | Document): Promise<Result[]> {
  const results = await axe.run(scope, { runOnly: { type: 'tag', values: WCAG_TAGS }, rules: { 'color-contrast': { enabled: false }, 'label-content-name-mismatch': { enabled: false } }, resultTypes: ['violations'] });
  return results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
}

/** What a violation says, short enough to read in a failed test: the rule and the elements it found. */
export const describeViolations = (violations: readonly Result[]): string[] => violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
