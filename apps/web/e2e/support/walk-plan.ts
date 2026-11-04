/**
 * Planning of the route walk (apps/web/e2e/route-walk.spec.ts): how many pages are open at once, how many routes one
 * browser walks before it is replaced, and which failures count as the machine's fault rather than the screen's.
 * Chrome's renderer memory grows over a walk of 812 pages; on a memory-constrained machine it ends in `Page crashed`
 * and `ERR_INSUFFICIENT_RESOURCES` for healthy screens, so the walk recycles its browser and retries those failures once.
 */

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

/**
 * Whether a console error is the browser noting a 404 that the product specifies: a project that has no line in the latest frozen snapshot has no
 * estimate, and DIS answers 404 for it (docs/dis-forecast.md). The screens of CAP show that as "no estimate"; it is not a defect of the screen.
 */
export function isExpectedAbsence(text: string, url: string): boolean {
  return /status of 404/.test(text) && ABSENT_ESTIMATE.test(url);
}
