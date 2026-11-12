import enterpriseOverlay from '../../src/editions/enterprise/overlay.vi.json' with { type: 'json' };
import vi from '../../src/i18n/vi.json' with { type: 'json' };

/**
 * The words of the edition under test, read from the catalogue that edition really uses. The web build reads `MACHVON_EDITION`, then `VITE_EDITION` (public when neither is set); the enterprise edition
 * puts its terminology overlay over the base catalogue, so a spec that expects a word the overlay replaces (the status of a request sent to the Treasury, the product name) must read it from here and not
 * from the base `vi.json` alone, or it asserts the public wording against an enterprise screen.
 *
 * This file is one of the seams that may import the enterprise overlay (`scripts/edition-check.mjs`, ENTERPRISE_SEAMS): the specs import it and never the overlay itself.
 */
export type EditionName = 'public' | 'enterprise';

/** The edition a run serves, as the stack and the browser build read it. */
export function editionOf(env: Record<string, string | undefined> = process.env): EditionName {
  return (env.MACHVON_EDITION ?? env.VITE_EDITION) === 'enterprise' ? 'enterprise' : 'public';
}

/** The base catalogue with the overlay of the edition over it: the overlay replaces words, it never adds a key (`overlay.enterprise.test.ts`). */
export function catalogueOf<T extends Readonly<Record<string, string>>>(edition: EditionName, base: T, overlay: Readonly<Record<string, string>>): T {
  return edition === 'enterprise' ? { ...base, ...overlay } : base;
}

/** The catalogue of the edition this run serves. */
export const terms: typeof vi = catalogueOf(editionOf(), vi, enterpriseOverlay);
