import { DomainError } from './errors.ts';
import { validateDelegationContent } from './adm-delegation.ts';
import type { DelegationRequest } from './adm-delegation.ts';
import { permissionMatches } from './permission.ts';
import { validatePeriodCodes } from './iam-period-scope.ts';

/**
 * The permanent (standing) delegation of approval authority (IAM-2): an ongoing handing over of business permissions that, unlike the time-boxed delegation (at most 90 days), has no end date of its own but must say under
 * which condition it ends and must be reviewed by its delegator by a review date, at most a year ahead. The review date is the date until which it works: a delegation that is not reviewed in time stops working at that
 * instant, exactly like a time-boxed one that ran out. What the delegation hands over (the permissions, the scope) is judged by the same rules as the time-boxed one; this is the part that needs no data.
 */

/** The longest time between two reviews, and from the start to the first. */
export const STANDING_REVIEW_MAX_DAYS = 365;
/** The latest end a standing delegation with a fixed end date can have, counted from its start (five years). */
export const STANDING_END_MAX_DAYS = 1826;
/** A review that falls due within this many days is announced to the delegator. */
export const STANDING_REVIEW_WARNING_DAYS = 14;
/** The shortest text of an end condition: a delegation must say in words when it ends. */
export const END_CONDITION_TEXT_MIN = 10;
export const END_CONDITION_TEXT_MAX = 500;
/**
 * How a standing delegation ends besides the review: `SOURCE_HOLDS` when the delegator no longer holds the authority (automatic, as for every delegation), `UNTIL_EVENT` when a named event happens (ended by the delegator or an
 * administrator, who records the event as the reason), `UNTIL_DATE` at a fixed date (automatic).
 */
export const END_CONDITION_KINDS = ['SOURCE_HOLDS', 'UNTIL_EVENT', 'UNTIL_DATE'] as const;
export type EndConditionKind = (typeof END_CONDITION_KINDS)[number];
export type StandingEndReason = 'REVIEW_LAPSED' | 'END_CONDITION_MET';

const DAY_MS = 86_400_000;
const START_SLACK_MS = 5 * 60_000;

export interface StandingDelegationRequest extends Pick<DelegationRequest, 'permissions' | 'scopeKind' | 'scopeRefIds' | 'validFrom'> {
  /** The date of the first review: the delegation works until then. */
  reviewDueAt: Date;
  endConditionKind: string;
  endConditionText: string;
  /** The fixed end of an `UNTIL_DATE` delegation; null for the other kinds. */
  endOn: Date | null;
  /** The report periods it is limited to; absent when it is not limited. */
  periodCodes?: readonly string[] | undefined;
}

export interface StandingDelegationDefect {
  field: string;
  code:
    | 'REQUIRED'
    | 'MALFORMED'
    | 'DUPLICATE'
    | 'WILDCARD'
    | 'ADMINISTRATIVE'
    | 'UNSUPPORTED'
    | 'OVERLAP'
    | 'TOO_MANY'
    | 'IN_THE_PAST'
    | 'BEFORE_START'
    | 'TOO_LONG'
    | 'ALREADY_ENDED'
    | 'REVIEW_AFTER_END'
    | 'NOT_ALLOWED';
}

/** Every defect of a request for a standing delegation, in the order of the fields; none when it is valid. */
export function validateStandingDelegation(request: StandingDelegationRequest, now: Date): StandingDelegationDefect[] {
  const defects: StandingDelegationDefect[] = [];
  const add = (field: string, code: StandingDelegationDefect['code']): void => void defects.push({ field, code });
  const from = request.validFrom.getTime();
  const review = request.reviewDueAt.getTime();
  if (from < now.getTime() - START_SLACK_MS) add('valid_from', 'IN_THE_PAST');
  if (review <= from) add('review_due_at', 'BEFORE_START');
  else if (review - from > STANDING_REVIEW_MAX_DAYS * DAY_MS) add('review_due_at', 'TOO_LONG');
  else if (review <= now.getTime()) add('review_due_at', 'ALREADY_ENDED');
  defects.push(...validateDelegationContent(request));
  if (request.periodCodes !== undefined) defects.push(...validatePeriodCodes(request.periodCodes));
  const text = request.endConditionText.trim();
  if (!(END_CONDITION_KINDS as readonly string[]).includes(request.endConditionKind)) add('end_condition_kind', 'UNSUPPORTED');
  if (text.length < END_CONDITION_TEXT_MIN) add('end_condition_text', 'REQUIRED');
  else if (text.length > END_CONDITION_TEXT_MAX) add('end_condition_text', 'TOO_LONG');
  if (request.endConditionKind === 'UNTIL_DATE') {
    if (request.endOn === null) add('end_on', 'REQUIRED');
    else if (request.endOn.getTime() <= from) add('end_on', 'BEFORE_START');
    else if (request.endOn.getTime() - from > STANDING_END_MAX_DAYS * DAY_MS) add('end_on', 'TOO_LONG');
    else if (review > request.endOn.getTime()) add('review_due_at', 'REVIEW_AFTER_END');
  } else if (request.endOn !== null) {
    add('end_on', 'NOT_ALLOWED');
  }
  return defects;
}

/** 422 `DELEGATION_INVALID` naming the first field, with every defect as a member of the problem. */
export function assertValidStandingDelegation(request: StandingDelegationRequest, now: Date): void {
  const defects = validateStandingDelegation(request, now);
  if (defects.length > 0) throw new DomainError('DELEGATION_INVALID', 422, defects[0]?.field, { extensions: { defects } });
}

/**
 * Whether a review that moves the date of the next review to `nextDueAt` is valid: the date moves forward, stays within a year of now, and does not pass a fixed end. The delegator reviews while the delegation still
 * works; one that has stopped is not revived (a new delegation is made).
 */
export function validateReview(current: { validUntil: Date; endOn: Date | null }, nextDueAt: Date, now: Date): StandingDelegationDefect[] {
  const defects: StandingDelegationDefect[] = [];
  const add = (field: string, code: StandingDelegationDefect['code']): void => void defects.push({ field, code });
  if (now.getTime() >= current.validUntil.getTime()) add('review_due_at', 'ALREADY_ENDED');
  else if (nextDueAt.getTime() <= current.validUntil.getTime()) add('review_due_at', 'BEFORE_START');
  else if (nextDueAt.getTime() - now.getTime() > STANDING_REVIEW_MAX_DAYS * DAY_MS) add('review_due_at', 'TOO_LONG');
  else if (current.endOn !== null && nextDueAt.getTime() > current.endOn.getTime()) add('review_due_at', 'REVIEW_AFTER_END');
  return defects;
}

/** 422 `DELEGATION_INVALID` for a review that is not valid. */
export function assertValidReview(current: { validUntil: Date; endOn: Date | null }, nextDueAt: Date, now: Date): void {
  const defects = validateReview(current, nextDueAt, now);
  if (defects.length > 0) throw new DomainError('DELEGATION_INVALID', 422, defects[0]?.field, { extensions: { defects } });
}

/** Why a standing delegation is over at `now`, or null while it works: a fixed end that has come is the end condition, otherwise the review date that passed is a lapsed review. */
export function standingEndReason(delegation: { validUntil: Date; endOn: Date | null }, now: Date): StandingEndReason | null {
  if (delegation.endOn !== null && now.getTime() >= delegation.endOn.getTime()) return 'END_CONDITION_MET';
  return now.getTime() >= delegation.validUntil.getTime() ? 'REVIEW_LAPSED' : null;
}

/** Whether the review falls due within the warning window while the delegation still works. */
export function reviewDueSoon(validUntil: Date, now: Date, days: number = STANDING_REVIEW_WARNING_DAYS): boolean {
  const left = validUntil.getTime() - now.getTime();
  return left > 0 && left <= days * DAY_MS;
}

/** One handing over of authority between two persons (not memberships: a person with two memberships is one node). */
export interface DelegationEdge {
  delegatorUser: string;
  delegateUser: string;
  permissions: readonly string[];
}

const overlaps = (left: readonly string[], right: readonly string[]): boolean =>
  left.some((held) => right.some((other) => permissionMatches(held, other) || permissionMatches(other, held)));

/**
 * The loop a new delegation would close, as the persons along it, or null when it closes none. A delegation from A to B closes a loop when B already hands to A (directly or through others) a permission that A's
 * delegation hands over too: authority that goes round is authority nobody holds, and it lets two people approve each other's work. A delegation to oneself is the shortest loop. The search is over the delegations
 * that work now, in the order of the persons, so the same data always gives the same path.
 */
export function findDelegationCycle(edges: readonly DelegationEdge[], candidate: DelegationEdge): string[] | null {
  if (candidate.delegatorUser === candidate.delegateUser) return [candidate.delegatorUser, candidate.delegateUser];
  const relevant = edges.filter((edge) => overlaps(edge.permissions, candidate.permissions)).sort((a, b) => (a.delegatorUser === b.delegatorUser ? a.delegateUser.localeCompare(b.delegateUser) : a.delegatorUser.localeCompare(b.delegatorUser)));
  const visited = new Set<string>();
  const walk = (user: string, path: string[]): string[] | null => {
    if (user === candidate.delegatorUser) return [...path, user];
    if (visited.has(user)) return null;
    visited.add(user);
    for (const edge of relevant) {
      if (edge.delegatorUser !== user) continue;
      const found = walk(edge.delegateUser, [...path, user]);
      if (found !== null) return found;
    }
    return null;
  };
  const back = walk(candidate.delegateUser, []);
  return back === null ? null : [candidate.delegatorUser, ...back];
}

/** 403 `DELEGATION_CYCLE_DENIED` when the delegation would close a loop; the loop is a member of the problem as persons are not named: only its length. */
export function assertNoDelegationCycle(edges: readonly DelegationEdge[], candidate: DelegationEdge): void {
  const cycle = findDelegationCycle(edges, candidate);
  if (cycle !== null) throw new DomainError('DELEGATION_CYCLE_DENIED', 403, 'delegate_membership_id', { extensions: { cycle_length: cycle.length - 1 } });
}
