/** The state of a fiscal year of the capital plan (ST-CAP-008, CAP 3.1 F6). A year without a control row is OPEN. */
export const YEAR_STATUSES = ['OPEN', 'SOFT_CLOSED', 'LOCKED'] as const;
export type YearStatus = (typeof YEAR_STATUSES)[number];
/** What a close can bring a year to. */
export const CLOSE_TARGETS = ['SOFT_CLOSED', 'LOCKED'] as const;
export type CloseTarget = (typeof CLOSE_TARGETS)[number];

export const MIN_CLOSE_REASON = 5;
export const MAX_CLOSE_REASON = 2000;
/** A year is reopened for a reason that can be read back (20 characters at least) and for a window of at most a week. */
export const MIN_REOPEN_REASON = 20;
export const MAX_REOPEN_REASON = 2000;
export const MIN_REOPEN_WINDOW_HOURS = 1;
export const MAX_REOPEN_WINDOW_HOURS = 168;
const HOUR_MS = 3_600_000;

/**
 * Whether a close may take a year from `current` to `target`: an open year may be soft-closed (the adjustment period) or locked outright, a soft-closed year may be locked, a locked year
 * is closed already and a soft-closed year is not soft-closed twice.
 */
export function closeAllowed(current: YearStatus, target: CloseTarget): boolean {
  if (current === 'OPEN') return true;
  return current === 'SOFT_CLOSED' && target === 'LOCKED';
}

export type ReopenIssueReason = 'REASON_LENGTH' | 'WINDOW_INVALID';

export interface ReopenIssue {
  field: 'reason' | 'window_hours';
  reason: ReopenIssueReason;
}

/** What is wrong with a request to reopen a locked year: a reason of 20 to 2000 characters and a window of 1 to 168 whole hours. */
export function reopenIssues(request: { reason: string; windowHours: number }): ReopenIssue[] {
  const issues: ReopenIssue[] = [];
  const reason = request.reason.trim();
  if (reason.length < MIN_REOPEN_REASON || reason.length > MAX_REOPEN_REASON) issues.push({ field: 'reason', reason: 'REASON_LENGTH' });
  if (!Number.isInteger(request.windowHours) || request.windowHours < MIN_REOPEN_WINDOW_HOURS || request.windowHours > MAX_REOPEN_WINDOW_HOURS) issues.push({ field: 'window_hours', reason: 'WINDOW_INVALID' });
  return issues;
}

/** The instant a reopening that starts at `now` ends. */
export function reopenedUntil(now: Date, windowHours: number): Date {
  return new Date(now.getTime() + windowHours * HOUR_MS);
}
