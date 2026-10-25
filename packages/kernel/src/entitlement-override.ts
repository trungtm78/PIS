import { PLAN_FEATURE_CODES } from './plan-catalogue.ts';

/** An exception to the plan of one tenant, as it is asked for (SAS.md BR-SAS-10): a feature switched on or off, or given another limit, for a time. */
export interface OverrideRequest {
  featureCode: string;
  enabled: boolean;
  /** A non-negative decimal of at most six places, as text. */
  limitValue?: string | undefined;
  validFrom: Date;
  validUntil: Date;
  reason: string;
}

export type OverrideIssueReason =
  | 'FEATURE_UNKNOWN'
  | 'LIMIT_INVALID'
  | 'LIMIT_NEEDS_ENABLED'
  | 'WINDOW_INVALID'
  | 'ALREADY_ENDED'
  | 'STARTS_TOO_FAR_AHEAD'
  | 'TOO_LONG'
  | 'REASON_LENGTH';

export interface OverrideIssue {
  field: 'feature_code' | 'limit_value' | 'valid_from' | 'valid_until' | 'reason';
  reason: OverrideIssueReason;
}

/** An override is an exception for a time, never a way of life: a longer one is a plan. */
export const MAX_OVERRIDE_DAYS = 366;
/** An override cannot start further ahead than this: a decision that long in advance is not the decision of the day it takes effect. */
export const MAX_OVERRIDE_LEAD_DAYS = 90;
/** An override may start a little before the instant it is asked at (the clocks of the person and of the server differ). */
export const OVERRIDE_START_SKEW_MS = 5 * 60_000;
export const MIN_OVERRIDE_REASON = 10;
export const MAX_OVERRIDE_REASON = 2000;
const DAY_MS = 86_400_000;
const LIMIT_PATTERN = /^[0-9]{1,18}(\.[0-9]{1,6})?$/;

/**
 * What is wrong with a request for an override (422), in the order of the form. The feature must be one that the plans sell, a limit only goes with a feature that is
 * switched on, the window starts before it ends, ends in the future, lasts at most a year and starts at most 90 days ahead, and the reason says why in 10 to 2000
 * characters. An empty list is a request that may be put to a second administrator.
 */
export function overrideIssues(request: OverrideRequest, now: Date): OverrideIssue[] {
  const issues: OverrideIssue[] = [];
  if (!PLAN_FEATURE_CODES.has(request.featureCode)) issues.push({ field: 'feature_code', reason: 'FEATURE_UNKNOWN' });
  if (request.limitValue !== undefined) {
    if (!LIMIT_PATTERN.test(request.limitValue)) issues.push({ field: 'limit_value', reason: 'LIMIT_INVALID' });
    else if (!request.enabled) issues.push({ field: 'limit_value', reason: 'LIMIT_NEEDS_ENABLED' });
  }
  const [from, until] = [request.validFrom.getTime(), request.validUntil.getTime()];
  if (Number.isNaN(from) || Number.isNaN(until) || from >= until) issues.push({ field: 'valid_until', reason: 'WINDOW_INVALID' });
  else {
    if (until <= now.getTime()) issues.push({ field: 'valid_until', reason: 'ALREADY_ENDED' });
    else if (until - from > MAX_OVERRIDE_DAYS * DAY_MS) issues.push({ field: 'valid_until', reason: 'TOO_LONG' });
    if (from > now.getTime() + MAX_OVERRIDE_LEAD_DAYS * DAY_MS) issues.push({ field: 'valid_from', reason: 'STARTS_TOO_FAR_AHEAD' });
  }
  const reason = request.reason.trim();
  if (reason.length < MIN_OVERRIDE_REASON || reason.length > MAX_OVERRIDE_REASON) issues.push({ field: 'reason', reason: 'REASON_LENGTH' });
  return issues;
}
