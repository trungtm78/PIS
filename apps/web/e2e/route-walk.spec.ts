import { chromium, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { WEB_ROUTES } from './support/web-routes.ts';
import { browserChannel } from './support/browser-channel.ts';
import { problemsOf, writeReportPart } from './support/report.ts';
import { selectRoutes } from './support/routes-filter.ts';
import { ROUTES_PER_BROWSER, batchesOf, devUserFor, isExpectedAbsence, isInfrastructureFailure, parseWalkPages, retryShareExceeded, summariseRetries } from './support/walk-plan.ts';
import type { RouteWalkEntry, WalkViewport } from './support/report.ts';

type WalkRoute = (typeof WEB_ROUTES)[number];

const VIEWPORTS: Record<WalkViewport, { width: number; height: number }> = {
  '1440': { width: 1440, height: 1000 },
  '390': { width: 390, height: 844 },
};
/** Hard ceiling for one route: navigation, first render and the checks. */
const PAGE_TIMEOUT_MS = 15_000;

interface WalkContext {
  baseURL: string;
  pages: number;
}

function failedEntry(route: WalkRoute, viewport: WalkViewport, message: string): RouteWalkEntry {
  const measured: Omit<RouteWalkEntry, 'problems'> = {
    id: route.id,
    path: route.path,
    viewport,
    sidebarGroup: false,
    breadcrumb: false,
    activeItem: false,
    consoleErrors: [],
    overflowPx: 0,
    loadError: message,
  };
  return { ...measured, problems: problemsOf(measured) };
}

async function measureRoute(page: Page, route: WalkRoute, viewport: WalkViewport): Promise<RouteWalkEntry> {
  const consoleErrors: string[] = [];
  const onConsole = (message: { type(): string; text(): string; location(): { url: string } }): void => {
    // A failed resource says only 404; the URL tells which one.
    if (message.type() !== 'error' || isExpectedAbsence(message.text(), message.location().url)) return;
    consoleErrors.push(`${message.text()} ${message.location().url}`.trim());
  };
  const onPageError = (error: Error): void => void consoleErrors.push(error.message);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  const measured: Omit<RouteWalkEntry, 'problems'> = {
    id: route.id,
    path: route.path,
    viewport,
    sidebarGroup: false,
    breadcrumb: false,
    activeItem: false,
    consoleErrors,
    overflowPx: 0,
  };
  try {
    await page.goto(`${route.path}?devUser=${devUserFor(route)}`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForSelector('.workspace-breadcrumb', { timeout: PAGE_TIMEOUT_MS });
    // Lazy screens and the dev session mount after the frame; let the network settle before counting errors.
    await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS });
    Object.assign(
      measured,
      await page.evaluate(() => ({
        sidebarGroup: document.querySelectorAll('.sidebar-section, .sidebar-destination').length > 0,
        breadcrumb: document.querySelector('.workspace-breadcrumb strong') !== null,
        activeItem: document.querySelector('.destination-active, .current-context-leaf, .sidebar [aria-current="page"]') !== null,
        overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      })),
    );
  } catch (error) {
    measured.loadError = error instanceof Error ? error.message.split('\n')[0] : String(error);
  }
  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  return { ...measured, problems: problemsOf(measured) };
}

async function closeQuietly(target: Page | BrowserContext | Browser): Promise<void> {
  try {
    await target.close();
  } catch (error) {
    // The browser may already be gone (that is what a crash looks like); closing is best effort, but say so.
    process.stderr.write(`close failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`);
  }
}

/** Walks routes in ONE fresh browser and context with `pages` pages at once. A page that failed for infrastructure reasons is replaced, so one crash does not poison the rest. */
async function walkInFreshBrowser(routes: readonly WalkRoute[], viewport: WalkViewport, walk: WalkContext): Promise<RouteWalkEntry[]> {
  const entries: RouteWalkEntry[] = [];
  let browser: Browser;
  let context: BrowserContext;
  try {
    browser = await chromium.launch({ channel: browserChannel() });
    context = await browser.newContext({ viewport: VIEWPORTS[viewport], baseURL: walk.baseURL, deviceScaleFactor: 1, locale: 'vi-VN' });
  } catch (error) {
    // The machine could not even start a browser: every route of the batch failed for infrastructure reasons.
    const reason = `Browser has been closed: launch failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
    return routes.map((route) => failedEntry(route, viewport, reason));
  }
  let next = 0;

  async function worker(): Promise<void> {
    let page: Page | undefined;
    for (;;) {
      const route = routes[next];
      next += 1;
      if (route === undefined) break;
      try {
        page ??= await context.newPage();
      } catch (error) {
        const reason = `Target page, context or browser has been closed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
        entries.push(failedEntry(route, viewport, reason));
        page = undefined;
        continue;
      }
      const entry = await measureRoute(page, route, viewport);
      entries.push(entry);
      if (isInfrastructureFailure(entry.loadError)) {
        await closeQuietly(page);
        page = undefined;
      }
    }
    if (page !== undefined) await closeQuietly(page);
  }

  await Promise.all(Array.from({ length: Math.min(walk.pages, routes.length) }, worker));
  await closeQuietly(context);
  await closeQuietly(browser);
  return entries;
}

/** One batch of routes in a fresh browser; the pages that failed because of the machine are walked once more, alone, in another fresh browser. */
async function walkBatch(routes: readonly WalkRoute[], viewport: WalkViewport, walk: WalkContext): Promise<RouteWalkEntry[]> {
  const first = await walkInFreshBrowser(routes, viewport, walk);
  const retryRoutes = routes.filter((route) => {
    const entry = first.find((candidate) => candidate.id === route.id);
    return entry !== undefined && isInfrastructureFailure(entry.loadError);
  });
  if (retryRoutes.length === 0) return first;
  const second = await walkInFreshBrowser(retryRoutes, viewport, { ...walk, pages: 1 });
  const retried = new Map(second.map((entry) => [entry.id, { ...entry, retries: 1 }]));
  return first.map((entry) => retried.get(entry.id) ?? entry);
}

test('every web route renders the shell without console errors or overflow, at 1440 and 390 px (AC-ST-KERNEL-111-1)', async () => {
  test.setTimeout(45 * 60_000);
  // `E2E_ROUTES=HOME-01,ADM-01` limits the walk (for a quick run); an id that is not in the table fails the run, because a
  // mistyped id would otherwise walk fewer pages, or none, and pass.
  const { selected: routes, unknown } = selectRoutes(WEB_ROUTES, process.env.E2E_ROUTES);
  if (unknown.length > 0 || routes.length === 0) {
    // No walk happened: a result left by an earlier run must not stand in for it.
    writeReportPart({ routeWalk: undefined });
    throw new Error(unknown.length > 0 ? `E2E_ROUTES names routes that are not in the route table: ${unknown.join(', ')}` : 'the route walk has no route to walk');
  }
  const baseURL = test.info().project.use.baseURL;
  if (baseURL === undefined) throw new Error('the Playwright config has no baseURL');
  const walk: WalkContext = { baseURL, pages: parseWalkPages(process.env.E2E_WALK_PAGES) };

  const entries: RouteWalkEntry[] = [];
  for (const viewport of ['1440', '390'] as const) {
    // A fresh browser every ROUTES_PER_BROWSER routes: Chrome's renderer memory grows over a long walk.
    for (const batch of batchesOf(routes, ROUTES_PER_BROWSER)) entries.push(...(await walkBatch(batch, viewport, walk)));
  }
  // By route id, the wide viewport first.
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : Number(b.viewport) - Number(a.viewport)));
  writeReportPart({ routeWalk: { routes: routes.length, entries } });

  const broken = entries.filter((entry) => entry.problems.length > 0);
  const summary = broken.map((entry) => `${entry.id}@${entry.viewport}: ${entry.problems.join('; ')}`);
  const retries = summariseRetries(entries);
  test.info().annotations.push({
    type: 'routes',
    description: `${routes.length} routes, ${entries.length} pages, ${broken.length} broken, ${retries.retried} retried in a fresh browser`,
  });
  if (broken.length > 0) throw new Error(`${broken.length} of ${entries.length} pages are broken:\n${summary.join('\n')}`);
  if (retryShareExceeded(retries)) {
    throw new Error(`${retries.retried} of ${retries.total} pages needed a retry in a fresh browser: the machine is short of resources (free memory and run again)`);
  }
});
