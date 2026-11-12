import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { AXE_RULES, MIN_TEXT_PX, clausesOf, factsInPage, judgeScreen, operationMatchers, undecidedOf } from './support/screen-contract.ts';
import type { ApiCall, Finding, Observation, ScreenFacts } from './support/screen-contract.ts';
import { READER_KEY } from './support/screen-personas.ts';
import { WEB_ROUTES } from './support/web-routes.ts';
import { devUserFor, failedByTheMachine, isExpectedAbsence, routesOfEdition } from './support/walk-plan.ts';

/**
 * The screen contract of every screen of the edition under test (UAT cases TC-UI-<SCREEN> / design cases UI-<SCREEN>, design type `screen-contract`).
 * One test for each case, its id in the title, so that `npm run uat:run` and `npm run uat:evidence` match the result to the case. What the case asks
 * for is read from its own `expected` text (support/screen-contract.ts `clausesOf`) and decided by measuring the screen in the browser:
 *
 *  - the person the route walk uses opens the screen at 1440 and at 390 px: the page carries its screen id, shows no crash card, raises no uncaught error and no
 *    console error, does not scroll sideways, and every control has an accessible name (axe);
 *  - a person who may read everything and change nothing opens it: the screen offers no control that changes data (clause "no action outside the permission");
 *  - a member without any right opens it: where the API refuses with 403 the screen shows its denied state (clause "denied state and 403");
 *  - the fields of the catalogue, the order, the seven states and the design tokens, where the case says so.
 *
 * The table of the cases is `support/screen-contract-cases.json` (`node scripts/uat-screen-contract.mjs generate`). A screen the edition does not have is not walked:
 * its case is not in the plan of that edition.
 */

interface CaseRow {
  id: string;
  tc: string;
  screen: string;
  module: string;
  priority: string;
  expected: string;
}

const readJson = <T>(relative: string): T => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as T;
const ROWS = readJson<CaseRow[]>('./support/screen-contract-cases.json');
const CATALOGUE = new Map(readJson<Array<{ id: string; fields: string[]; kind: string; role: string }>>('../../../Design/MACHVON_Design/03_Engineering/screen_catalog.json').map((screen) => [screen.id, screen]));
const MATCHERS = operationMatchers(readJson<{ paths: Record<string, Record<string, unknown>> }>('../../../Design/MACHVON_Design/03_Engineering/openapi.json'));
const DENIED_TITLE = (readJson<Record<string, string>>('../src/i18n/vi.json')['states.denied.title'] ?? '').toString();
const AXE_SOURCE = createRequire(import.meta.url).resolve('axe-core');
/** Hard ceiling for one opening: navigation, first render and the measures (the route walk uses the same). */
const PAGE_TIMEOUT_MS = 15_000;
const WIDE = 1440;
const NARROW = 390;
/** The states a screen shows besides its data, and the key of the title of its card; `loading` has no card, its skeleton says it is busy. */
const FORCED_STATES = { loading: 'states.loading.label', empty: 'states.empty.title', error: 'states.error.title', denied: 'states.denied.title', expired: 'states.signedOut.title', offline: 'states.offline.title' } as const;
type ForcedState = keyof typeof FORCED_STATES;
const I18N = readJson<Record<string, string>>('../src/i18n/vi.json');
const STATE_TITLES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(FORCED_STATES).map(([state, key]) => [state, I18N[key] ?? '']));

const problemBody = (status: number, code: string): string => JSON.stringify({ type: `urn:machvon:error:${code}`, title: `error.${code}.title`, status, code, correlation_id: 'forced', correlationId: 'forced' });

/**
 * Forces a state on the screen itself, the way a person meets it: the API answers what makes the screen show that state (its lists emptied, a 500, a 403, a lapsed session, no network),
 * or answers late. The requests of the shell (the alert counts) and every change are left alone. The screen's own hooks and its own state card decide what is shown.
 */
async function forceState(page: Page, state: ForcedState): Promise<void> {
  // The address of the API only: the development server also serves modules of the application from /src/api/.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || new URL(request.url()).pathname.startsWith('/api/home/my-work')) return route.fallback();
    switch (state) {
      case 'loading':
        await new Promise((done) => setTimeout(done, 8000));
        return route.continue().catch(() => undefined);
      case 'empty': {
        // The real answer with its lists emptied: a detail keeps its shape (the empty state of a record screen is the screen opened with no record, see below).
        const response = await route.fetch();
        const body: unknown = await response.json().catch(() => undefined);
        const emptied = Array.isArray(body) ? [] : typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items) ? { ...body, items: [], total: 0, next_cursor: null } : body;
        return emptied === undefined ? route.fulfill({ response }) : route.fulfill({ response, json: emptied });
      }
      case 'error':
        return route.fulfill({ status: 500, contentType: 'application/problem+json', body: problemBody(500, 'INTERNAL_ERROR') });
      case 'denied':
        return route.fulfill({ status: 403, contentType: 'application/problem+json', body: problemBody(403, 'SCOPE_DENIED') });
      case 'expired':
        return route.fulfill({ status: 401, contentType: 'application/problem+json', body: problemBody(401, 'SESSION_EXPIRED') });
      case 'offline':
        return route.abort('internetdisconnected');
    }
  });
}

/** The installed application of the manager (PWA-nn) is a route of its own at `/m`; the route table holds only the stand-in of each screen. PWA-05 and PWA-06 (one approval task, one directive) are no route without a record. */
const PWA_PATHS: Readonly<Record<string, string>> = {
  'PWA-01': '/m',
  'PWA-02': '/m/approvals',
  'PWA-03': '/m/dashboard',
  'PWA-04': '/m/directives',
  'PWA-07': '/m/settings',
  'PWA-08': '/m/dashboard/detail',
  'PWA-09': '/m/progress',
  'PWA-10': '/m/notifications',
};
type OpenPage = (page: Page) => Promise<void>;
interface ObserveOptions {
  user: string;
  width: number;
  open: OpenPage;
  axe?: boolean;
  /** Measure as soon as the shell stands, without waiting for the network to rest (the loading state: the network is held on purpose). */
  immediate?: boolean;
}

/** The persona that only reads: the control plane screens (SAS) belong to a control-audience user, so theirs is the operator who holds one right to read. */
const readerOf = (route: { module: string }): string => (route.module === 'SAS' ? 'operator' : READER_KEY);

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_SOURCE });
  return page.evaluate(async (rules) => {
    const axe = (window as unknown as { axe: { run(context: Document, options: object): Promise<{ violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: unknown[] }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return result.violations.map((violation) => `${violation.id} (${violation.impact ?? 'n/a'}): ${violation.nodes.length} node(s), ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`);
  }, [...AXE_RULES]);
}

/**
 * Opens a page in a fresh context of the width and records what the page does and says (the console, the uncaught errors, the API calls) while `open` runs.
 * An opening that failed because the machine ran short of sockets or memory (the route walk's `failedByTheMachine`) is made once more in a fresh context; a screen that fails
 * for its own reasons is never retried away.
 */
async function observe(browser: Browser, baseURL: string, options: ObserveOptions): Promise<Observation> {
  const first = await observeOnce(browser, baseURL, options);
  return failedByTheMachine(first.loadError, first.consoleErrors) ? observeOnce(browser, baseURL, options) : first;
}

async function observeOnce(browser: Browser, baseURL: string, options: ObserveOptions): Promise<Observation> {
  const context = await browser.newContext({ viewport: { width: options.width, height: options.width >= 1000 ? 1000 : 844 }, baseURL, deviceScaleFactor: 1, locale: 'vi-VN' });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const pending: Array<Promise<void>> = [];
  const calls: ApiCall[] = [];
  page.on('console', (message) => {
    // A failed resource says only the status; the URL tells which one.
    if (message.type() === 'error' && !isExpectedAbsence(message.text(), message.location().url)) consoleErrors.push(`${message.text()} ${message.location().url}`.trim());
  });
  page.on('pageerror', (error) => void pageErrors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    const call: ApiCall = { method: response.request().method(), path: url.pathname.slice('/api'.length), status: response.status() };
    if (call.status >= 400) {
      call.expected = isExpectedAbsence(`status of ${call.status}`, response.url());
      pending.push(
        response
          .json()
          .then((body: unknown) => {
            const problem = typeof body === 'object' && body !== null && ['type', 'title', 'status', 'code', 'correlation_id'].every((key) => key in body);
            call.problem = problem;
            if (!problem) call.body = `missing ${['type', 'title', 'status', 'code', 'correlation_id'].filter((key) => typeof body !== 'object' || body === null || !(key in body)).join(', ')}; has ${typeof body === 'object' && body !== null ? Object.keys(body).join(', ') : typeof body}`;
          })
          .catch(() => {
            call.problem = false;
            call.body = 'no JSON body';
          }),
      );
    }
    calls.push(call);
  });
  let facts: ScreenFacts | undefined;
  let axe: string[] = [];
  let loadError: string | undefined;
  try {
    await options.open(page);
    if (options.immediate === true) await page.waitForTimeout(1500);
    else await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS });
    facts = await page.evaluate(factsInPage, MIN_TEXT_PX);
    if (options.axe === true) axe = await axeViolations(page);
  } catch (error) {
    loadError = error instanceof Error ? error.message.split('\n')[0] : String(error);
  }
  await Promise.all(pending);
  await context.close();
  const empty: ScreenFacts = { screenIds: [], notImplemented: false, crashed: false, busy: false, breadcrumb: false, title: '', overflowPx: 0, stateCards: [], hasContent: false, dataRows: false, formFields: false, writeActions: [], screenText: '', tokens: { primaryDefined: false, bodyFont: '', textBelowFloor: [], italicHeadings: [] } };
  return { user: options.user, width: options.width, facts: facts ?? empty, consoleErrors, pageErrors, calls, axe, ...(loadError === undefined ? {} : { loadError }) };
}

/** Opens a screen of the application as a development user: the route, the shell, then the network at rest. */
function openRoute(path: string, user: string, extra = ''): OpenPage {
  return async (page) => {
    await page.goto(`${path}?devUser=${user}${extra}`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForSelector('.workspace-breadcrumb', { timeout: PAGE_TIMEOUT_MS });
  };
}

/** The screens of one record whose route is a list's link: the address names the record (a connector code), so the test opens the list and follows its first link; the record comes from the seeded stack. */
const RECORD_SCREENS: Readonly<Record<string, { list: string; link: string }>> = {
  'HUB-02': { list: '/hub/hub-01', link: 'a[href^="/hub/hub-02?code="]' },
};

/** The address of a screen: its route (the installed application's for a PWA screen), or the first record of the list that leads to it. */
async function addressOf(browser: Browser, baseURL: string, route: { id: string; path: string }, user: string): Promise<string | undefined> {
  const record = RECORD_SCREENS[route.id];
  if (record === undefined) return PWA_PATHS[route.id] ?? route.path;
  const context = await browser.newContext({ baseURL, locale: 'vi-VN' });
  try {
    const page = await context.newPage();
    await openRoute(record.list, user)(page);
    await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS });
    return (await page.locator(record.link).first().getAttribute('href', { timeout: 3000 }).catch(() => null)) ?? undefined;
  } finally {
    await context.close();
  }
}

const journalOf = (value: object): void => {
  const out = process.env.SCREEN_CONTRACT_OUT;
  if (out !== undefined && out !== '') appendFileSync(out, `${JSON.stringify(value)}\n`);
};

const available = new Set(routesOfEdition(WEB_ROUTES, process.env).map((route) => route.id));
/** `SCREEN_CONTRACT_ONLY=TC-UI-ADM,TC-UI-PWA-01` limits the run to the cases whose id starts with one of the prefixes (a quick run; the plan is the whole table). */
const ONLY = (process.env.SCREEN_CONTRACT_ONLY ?? '').split(',').map((prefix) => prefix.trim()).filter((prefix) => prefix !== '');

test.describe('screen contract of the screens of the edition', () => {
  for (const row of ROWS) {
    const route = WEB_ROUTES.find((candidate) => candidate.id === row.screen);
    if (route === undefined || !available.has(route.id)) continue;
    if (ONLY.length > 0 && !ONLY.some((prefix) => row.tc.startsWith(prefix))) continue;
    const { clauses, unautomated } = clausesOf(row.expected);

    test(`${row.tc} ${row.screen} screen contract: ${clauses.join(', ')}`, async ({ browser, baseURL }) => {
      test.setTimeout(240_000);
      if (baseURL === undefined) throw new Error('the Playwright config has no baseURL');
      const user = devUserFor(route);
      // The route of the table; the installed application of the manager has routes of its own; a screen of one record opens the first record of its list.
      const address = await addressOf(browser, baseURL, route, user);
      if (address === undefined) throw new Error(`${row.screen}: the list that leads to the record (${RECORD_SCREENS[route.id]?.list ?? ''}) holds none in the seeded stack`);
      const [path = address, query] = address.split('?');
      const extra = query === undefined ? '' : `&${query}`;
      const wide = await observe(browser, baseURL, { user, width: WIDE, open: openRoute(path, user, extra), axe: clauses.includes('labels') });
      const narrow = await observe(browser, baseURL, { user, width: NARROW, open: openRoute(path, user, extra) });
      const reader = clauses.includes('permission') ? await observe(browser, baseURL, { user: readerOf(route), width: WIDE, open: openRoute(path, readerOf(route), extra) }) : undefined;
      const denied = clauses.includes('denied') ? await observe(browser, baseURL, { user: 'nobody', width: WIDE, open: openRoute(path, 'nobody', extra) }) : undefined;
      const states = clauses.includes('states')
        ? await Promise.all(
            (Object.keys(FORCED_STATES) as ForcedState[]).map(async (state) => ({
              state,
              observation: await observe(browser, baseURL, {
                user,
                width: NARROW,
                immediate: state === 'loading',
                open: async (page) => {
                  // A screen of one record is empty when it is opened with no record; its other states are forced on the record.
                  const noRecord = state === 'empty' && RECORD_SCREENS[route.id] !== undefined;
                  if (!noRecord) await forceState(page, state);
                  await openRoute(path, user, noRecord ? '' : extra)(page);
                },
              }),
            })),
          )
        : undefined;

      const contract = {
        screen: row.screen,
        clauses,
        fields: CATALOGUE.get(row.screen)?.fields ?? [],
        kind: CATALOGUE.get(row.screen)?.kind ?? '',
        role: CATALOGUE.get(row.screen)?.role ?? '',
        deniedTitle: DENIED_TITLE,
        wide,
        narrow,
        ...(reader === undefined ? {} : { reader }),
        ...(denied === undefined ? {} : { denied }),
        ...(states === undefined ? {} : { states, stateTitles: STATE_TITLES }),
        matchers: MATCHERS,
      };
      const findings: Finding[] = judgeScreen(contract);
      const notDecided = [...unautomated, ...undecidedOf(contract)];
      test.info().annotations.push({ type: 'clauses', description: clauses.join(', ') });
      test.info().annotations.push({ type: 'not-decided', description: notDecided.length === 0 ? 'none' : notDecided.join(' | ') });
      const state = wide.facts.stateCards.length > 0 ? `state card: ${wide.facts.stateCards[0]?.slice(0, 60) ?? ''}` : 'content';
      test.info().annotations.push({ type: 'shown', description: state });
      journalOf({ case: row.tc, screen: row.screen, clauses, unautomated: notDecided, shown: state, findings, requests: wide.calls.length, title: wide.facts.title });
      expect(findings.map((finding: Finding) => `[${finding.clause}] ${finding.detail}`), `${row.tc} ${row.screen}`).toEqual([]);
    });
  }
});

/**
 * Negative controls: the measures above can only be trusted if they can go red. A page that keeps the contract and a page built to break each clause the browser decides
 * are measured with the very same functions; the first must give no finding, the second one for each clause.
 */
const FIXTURE_HEAD = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>fixture</title><style>:root{--mv-color-primary:#007d77}body{font-family:"Be Vietnam Pro",sans-serif;font-size:14px}</style></head><body>';
const CLEAN_PAGE = `${FIXTURE_HEAD}<div class="workspace-breadcrumb"><strong>Mẫu</strong></div><section data-screen-id="NEG-01" aria-labelledby="screen-title"><h1 id="screen-title">Màn mẫu</h1><label for="name">Tên</label><input id="name"><button type="button" class="ui-button ui-button--outline">Xem</button></section></body></html>`;
const BROKEN_HEAD = '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>fixture</title></head><body>';
const BROKEN_PAGE = `${BROKEN_HEAD}<section><h1></h1><h2 style="font-style:italic">Chữ nghiêng</h2><p style="font-size:10px">chữ quá nhỏ</p><input type="text"><button type="button"></button><button type="button" class="ui-button ui-button--primary">Lưu</button><div class="card"><header><h2>Phần</h2><button type="button" class="ui-button ui-button--outline">Duyệt kỳ báo cáo</button></header></div><nav aria-label="phân trang"><button type="button" class="ui-button ui-button--primary">Lưu trong thanh điều hướng</button></nav><div style="width:2400px;height:10px"></div><script>console.error('fixture console error');setTimeout(function(){throw new Error('fixture uncaught error')},0)</script></section></body></html>`;

const NEGATIVE_CLAUSES = ['render', 'console', 'overflow', 'labels', 'permission', 'fields', 'order', 'tokens'] as const;

test.describe('screen contract negative controls', () => {
  test('screen-contract negative control: a page that keeps the contract has no finding', async ({ browser, baseURL }) => {
    if (baseURL === undefined) throw new Error('the Playwright config has no baseURL');
    const clean = await observe(browser, baseURL, { user: 'neg', width: WIDE, axe: true, open: (page) => page.setContent(CLEAN_PAGE) });
    const cleanNarrow = await observe(browser, baseURL, { user: 'neg', width: NARROW, open: (page) => page.setContent(CLEAN_PAGE) });
    const findings = judgeScreen({ screen: 'NEG-01', clauses: [...NEGATIVE_CLAUSES], fields: ['Tên'], kind: 'form', role: 'Chuyên viên', deniedTitle: DENIED_TITLE, wide: clean, narrow: cleanNarrow, reader: clean, matchers: MATCHERS });
    expect(findings.map((finding) => `[${finding.clause}] ${finding.detail}`)).toEqual([]);
  });

  test('screen-contract negative control: a page built to break the contract is red on every clause the browser decides', async ({ browser, baseURL }) => {
    if (baseURL === undefined) throw new Error('the Playwright config has no baseURL');
    const broken = await observe(browser, baseURL, { user: 'neg', width: WIDE, axe: true, open: (page) => page.setContent(BROKEN_PAGE) });
    const brokenNarrow = await observe(browser, baseURL, { user: 'neg', width: NARROW, open: (page) => page.setContent(BROKEN_PAGE) });
    const findings = judgeScreen({ screen: 'NEG-01', clauses: [...NEGATIVE_CLAUSES], fields: ['Tên', 'Mã'], kind: 'form', role: 'Chuyên viên', deniedTitle: DENIED_TITLE, wide: broken, narrow: brokenNarrow, reader: broken, matchers: MATCHERS });
    const red = new Set(findings.map((finding) => finding.clause));
    for (const clause of NEGATIVE_CLAUSES.filter((entry) => entry !== 'order')) expect(red.has(clause), `the clause ${clause} stayed green on a broken page: ${JSON.stringify(findings)}`).toBe(true);
    // Each finding names what is wrong, not just that something is.
    const text = findings.map((finding) => finding.detail).join('\n');
    expect(text).toContain('data-screen-id="NEG-01"');
    expect(text).toContain('fixture console error');
    expect(text).toContain('fixture uncaught error');
    expect(text).toContain('scrolls sideways');
    expect(text).toContain('button-name');
    expect(text).toContain('is offered "Lưu"');
    // A write in the header of a section card of the screen is no shell control; the one in a navigation landmark is left out on purpose.
    expect(text).toContain('is offered "Duyệt kỳ báo cáo"');
    expect(text).not.toContain('Lưu trong thanh điều hướng');
    expect(text).toContain('Mã');
    expect(text).toContain('Be Vietnam Pro');
    expect(text).toContain('--mv-color-primary');
    expect(text).toContain('under 12 px');
    expect(text).toContain('italic heading');
  });
});
