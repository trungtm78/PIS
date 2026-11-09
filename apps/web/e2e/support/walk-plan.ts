/**
 * Planning of the route walk (apps/web/e2e/route-walk.spec.ts): how many pages are open at once, how many routes one
 * browser walks before it is replaced, and which failures count as the machine's fault rather than the screen's.
 * Chrome's renderer memory grows over a walk of 812 pages; on a memory-constrained machine it ends in `Page crashed`
 * and `ERR_INSUFFICIENT_RESOURCES` for healthy screens, so the walk recycles its browser and retries those failures once.
 */

import { PUBLIC_EDITION_MANIFEST, resolveEdition, screenInEdition } from '@machvon/kernel/src/edition.ts';

/** Pages open at once in one browser. */
export const DEFAULT_WALK_PAGES = 3;
const MAX_WALK_PAGES = 4;
/** Routes one browser walks before it is closed and a fresh one takes over, releasing the renderer memory. */
export const ROUTES_PER_BROWSER = 25;
/** The run fails when more than this share of the pages needed a retry: a machine that degrades must be visible. */
export const MAX_RETRY_SHARE = 0.02;

// What a starved machine or a dying browser reports. A timeout is deliberately absent: a page that never renders is a defect.
const INFRASTRUCTURE_FAILURES: readonly RegExp[] = [
  /Page crashed/i,
  /ERR_INSUFFICIENT_RESOURCES/,
  /ERR_ABORTED/,
  /ERR_FAILED/,
  /chrome-error:\/\//,
  /Target page, context or browser has been closed/i,
  /Target closed/i,
  /Browser has been closed/i,
];

/** Whether a load error was caused by the machine (retry it once in a fresh browser) and not by the screen. */
export function isInfrastructureFailure(message: string | undefined): boolean {
  if (message === undefined || message === '') return false;
  return INFRASTRUCTURE_FAILURES.some((pattern) => pattern.test(message));
}

/** Splits routes into consecutive batches of `size` (the last one may be shorter). */
export function batchesOf<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('batch size must be a whole number of at least 1');
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size));
  return batches;
}

/** `E2E_WALK_PAGES`: pages open at once (1 to 4; the dev server hands out every module as a request and starves the browser beyond that). */
export function parseWalkPages(value: string | undefined): number {
  const text = (value ?? '').trim();
  if (text === '') return DEFAULT_WALK_PAGES;
  const pages = Number(text);
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_WALK_PAGES) {
    throw new RangeError(`E2E_WALK_PAGES must be a whole number from 1 to ${MAX_WALK_PAGES}, got "${text}"`);
  }
  return pages;
}

/** How many of the walked pages needed a retry. */
export function summariseRetries(entries: readonly { retries?: number }[]): { retried: number; total: number } {
  return { retried: entries.filter((entry) => (entry.retries ?? 0) > 0).length, total: entries.length };
}

/** Whether so many pages needed a retry that the machine, not luck, is the story. */
export function retryShareExceeded(summary: { retried: number; total: number }): boolean {
  if (summary.total === 0) return summary.retried > 0;
  return summary.retried / summary.total > MAX_RETRY_SHARE;
}

// The tenant plane and the control plane are different audiences: a control-plane screen opened by a tenant user answers 403,
// which Chrome logs as a console error, so the walk opens each screen as the kind of person who has it.
const CONTROL_PLANE_MODULES: ReadonlySet<string> = new Set(['SAS']);

/** The development user (`?devUser=`) that opens the route in the walk. */
export function devUserFor(route: { module: string }): 'owner' | 'sysAdmin' {
  return CONTROL_PLANE_MODULES.has(route.module) ? 'sysAdmin' : 'owner';
}

const ABSENT_ESTIMATE = /\/api\/disbursement-forecasts\?project_id=/;
// The leadership dashboard of the enterprise edition answers 404 RESOURCE_NOT_FOUND while no enterprise snapshot is frozen; its panel shows "no snapshot yet" (LeaderPanel).
const ABSENT_LEADER_BOARD = /\/api\/leader\/rates(\?|$)/;
// The cross-total control of DIS-26 answers 404 for a snapshot that is not there for the caller; the screen reads that as "no control for this snapshot" (`useControl`) and shows its empty state.
const ABSENT_CONTROL = /\/api\/period-snapshots\/[0-9a-f-]{36}\/cross-total$/;
// The area of the contractor portal answers 403 PORTAL_CONTRACTOR_REQUIRED to a member who is not a guest contractor; its screens show the denied state saying the area is for contractor accounts (portal-ui).
const CONTRACTOR_AREA = /\/api\/portal\//;

/**
 * Whether a console error is the browser noting an answer that the product specifies for the kind of person the walk opens the screen as, and that the screen shows as a state of its own:
 * 404 for a project that has no line in the latest frozen snapshot (DIS: no estimate, docs/dis-forecast.md), 404 for the leadership dashboard before an enterprise snapshot is frozen, 404 for the cross-total control of a snapshot that is not there for the caller, and 403
 * for the contractor portal opened by a member who is not a contractor. It is not a defect of the screen; any other 4xx or 5xx still is.
 */
export function isExpectedAbsence(text: string, url: string): boolean {
  if (/status of 404/.test(text)) return ABSENT_ESTIMATE.test(url) || ABSENT_LEADER_BOARD.test(url) || ABSENT_CONTROL.test(url);
  if (/status of 403/.test(text)) return CONTRACTOR_AREA.test(url);
  return false;
}

/** The routes that exist in the edition under test (`MACHVON_EDITION`, public when unset): the public build opens none of the routes of the enterprise-only modules, so walking them there would walk its "not found" page. */
export function routesOfEdition<T extends { id: string; module: string }>(routes: readonly T[], env: Readonly<Record<string, string | undefined>>): T[] {
  if (resolveEdition(env) !== 'public') return [...routes];
  return routes.filter((route) => screenInEdition(PUBLIC_EDITION_MANIFEST, route));
}

// The console says so when the machine has no socket buffer left: the browser then fails to load the files of a page that is healthy.
const MACHINE_CONSOLE_ERRORS: readonly RegExp[] = [/ERR_NO_BUFFER_SPACE/, /ERR_INSUFFICIENT_RESOURCES/, /ERR_NETWORK_IO_SUSPENDED/];

/** Whether a page failed because of the machine: the load error or a console error is one that a starved machine produces (retry it once in a fresh browser). */
export function failedByTheMachine(loadError: string | undefined, consoleErrors: readonly string[]): boolean {
  return isInfrastructureFailure(loadError) || consoleErrors.some((message) => MACHINE_CONSOLE_ERRORS.some((pattern) => pattern.test(message)));
}
