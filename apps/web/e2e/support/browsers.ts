/**
 * The browser engines of the web checks. By default one engine runs (Google Chrome where it is installed, the engine the baseline PNGs were rendered with). `E2E_BROWSERS` (a comma list of
 * `chromium`, `firefox`, `webkit`, `edge`) turns the run into one Playwright project per engine: Chromium keeps the whole suite and the channel, the other engines run the cross-browser smoke subset
 * (`CROSS_BROWSER_SMOKE`), because the pixel baselines and the route walk are for the baseline engine and the full suite on three engines would triple the run. `E2E_BROWSER_SCOPE=full`
 * gives every engine the whole suite (a release candidate run, or a debugging session). `edge` is Microsoft Edge (YCK.01 names it): the Chromium engine through the `msedge` channel, which
 * Playwright installs with `playwright install msedge`; it runs the smoke subset like the other engines, because the pixel baselines are those of the default Chrome.
 */

export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type Engine = (typeof ENGINES)[number];
/** What `E2E_BROWSERS` may name: the three Playwright engines and Edge, which is an engine (Chromium) with a channel. */
export const BROWSERS = [...ENGINES, 'edge'] as const;
export type Browser = (typeof BROWSERS)[number];
/** The channel of Playwright that starts Microsoft Edge. */
export const EDGE_CHANNEL = 'msedge';

/**
 * The specs that run on every engine: the real sign-in (redirects, PKCE, storage and cookies differ most between engines), a list and form screen of the administration, a project screen with its form,
 * and the accessibility check. Names are relative to the test directory.
 */
export const CROSS_BROWSER_SMOKE: readonly string[] = ['session-flows.spec.ts', 'adm-flows.spec.ts', 'prj-flows.spec.ts', 'a11y.spec.ts'];

/** The specs that are for the baseline engine only: their expectations are pixels or a walk of every route. */
export const BASELINE_ONLY: readonly string[] = ['visual.spec.ts', 'route-walk.spec.ts'];

export class BrowserSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSelectionError';
  }
}

/** The engines asked for, in the order of `ENGINES`, each once. Nothing set means the single default run (an empty list). An unknown name is an error, never ignored. */
export function selectedEngines(env: Record<string, string | undefined> = process.env): Browser[] {
  const raw = env.E2E_BROWSERS;
  if (raw === undefined || raw.trim() === '') return [];
  const names = raw.split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== '');
  const unknown = names.filter((name) => !(BROWSERS as readonly string[]).includes(name));
  if (unknown.length > 0) throw new BrowserSelectionError(`unknown browser engine ${unknown.join(', ')}; use ${BROWSERS.join(', ')}`);
  return BROWSERS.filter((engine) => names.includes(engine));
}

export interface BrowserProject {
  name: string;
  testMatch: string | string[];
  testIgnore?: string[];
  use: { browserName: Engine; channel?: string };
}

/**
 * The Playwright projects for the engines asked for. Chromium runs everything with the channel of the default run; firefox and webkit run the smoke subset, or everything with
 * `E2E_BROWSER_SCOPE=full` (the specs of the baseline engine stay out of those runs either way). A run without `E2E_BROWSERS` has no projects.
 */
export function browserProjects(env: Record<string, string | undefined>, channel: string | undefined): BrowserProject[] {
  const full = env.E2E_BROWSER_SCOPE === 'full';
  return selectedEngines(env).map((engine) => {
    if (engine === 'edge') return { name: 'edge', testMatch: full ? '**/*.spec.ts' : CROSS_BROWSER_SMOKE.map((name) => `**/${name}`), testIgnore: engineIgnore(engine), use: { browserName: 'chromium', channel: EDGE_CHANNEL } };
    if (engine === 'chromium') return { name: 'chromium', testMatch: '**/*.spec.ts', use: { browserName: 'chromium', ...(channel === undefined ? {} : { channel }) } };
    return { name: engine, testMatch: full ? '**/*.spec.ts' : CROSS_BROWSER_SMOKE.map((name) => `**/${name}`), testIgnore: engineIgnore(engine), use: { browserName: engine } };
  });
}

/** The spec files the other engines must not run (pixel baselines and the route walk), as `testIgnore` patterns. */
export const engineIgnore = (engine: Browser): string[] => (engine === 'chromium' ? [] : BASELINE_ONLY.map((name) => `**/${name}`));
