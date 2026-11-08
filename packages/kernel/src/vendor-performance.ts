import { DomainError } from './errors.ts';
import { nextReviewOn } from './vendor-risk.ts';

/**
 * The performance of a contractor over its contracts (VND-2, research V4; docs/vendor-controls.md section 8). The rating itself is proposed from the data, told to the contractor, answered inside the response window
 * and adopted by a second person by CA-3 (`ctr-performance-rating.ts`, table `contract_rating_proposal`; the window is the rule `EGP_POSTING_DEADLINES` code `CONTRACTOR_RESPONSE`, one source for the 20 days). This
 * module adds what the vendor side needs on top of it: the **publication** of an adopted rating on the national system no later than 6 months after the contract ends (the obligation `CONTRACTOR_PERFORMANCE` of
 * EGP-2 is the duty; the record here is the receipt, posted by somebody other than the person who adopted the rating), the time the investor has to examine an answer of the contractor and to update the rating when it
 * is right (Điều 20 NĐ 214/2025: the contractor answers in 20 days and a correct answer must be put into the data), the count of **consecutive poor ratings** (a plan to remedy at the second, a suggestion for the
 * debarment register at the third, never an action) and the window of past ratings a selection may look at. Rule `VENDOR_PERFORMANCE`, flagged unverified. Pure.
 */

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

export const VENDOR_PERFORMANCE_RULE_TYPE = 'VENDOR_PERFORMANCE';

export interface PerformancePolicy {
  /** Months after the end of the contract by which the rating is published (the research reads 6 months). */
  publish_within_months: number;
  remind_before_days: number;
  /** Days the investor has to examine an answer of the contractor after it is received and update the rating if it is right (our own choice, the same 20 days). */
  review_response_days: number;
  /** Consecutive POOR ratings that ask for a plan to remedy, and that suggest a case in the debarment register. */
  poor_streak_remedy: number;
  poor_streak_restriction: number;
  /** Years a selection may look back: the usual, and for construction (the research reads the US 3 and 6 years as starting values). */
  retrospect_years: number;
  retrospect_years_construction: number;
}

export const PERFORMANCE_POLICY_DEFAULTS: PerformancePolicy = { publish_within_months: 6, remind_before_days: 30, review_response_days: 20, poor_streak_remedy: 2, poor_streak_restriction: 3, retrospect_years: 3, retrospect_years_construction: 6 };

export function performancePolicyOf(params: unknown): PerformancePolicy {
  if (!isRecord(params)) throw invalid('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
    return value;
  };
  const policy: PerformancePolicy = {
    publish_within_months: whole('publish_within_months', 1, 60),
    remind_before_days: whole('remind_before_days', 0, 180),
    review_response_days: whole('review_response_days', 1, 180),
    poor_streak_remedy: whole('poor_streak_remedy', 1, 20),
    poor_streak_restriction: whole('poor_streak_restriction', 1, 20),
    retrospect_years: whole('retrospect_years', 1, 30),
    retrospect_years_construction: whole('retrospect_years_construction', 1, 30),
  };
  if (policy.poor_streak_restriction < policy.poor_streak_remedy) throw invalid('poor_streak_restriction');
  return policy;
}

export type PublicationClock = 'ON_TIME' | 'DUE_SOON' | 'OVERDUE' | 'MET' | 'MET_LATE';

/** The last day an adopted rating may be published: the policy months after the day the contract ended (or was handed over). */
export const publicationDueOn = (contractEndedOn: string, policy: PerformancePolicy): string => nextReviewOn(contractEndedOn, policy.publish_within_months);

/** Where the publication stands on a day: MET or MET_LATE once posted (by the day of the posting), else OVERDUE after the due day, DUE_SOON within the reminder days, else ON_TIME. The due day itself is still in time. */
export function publicationClock(input: { dueOn: string; postedOn: string | null; today: string }, policy: PerformancePolicy): PublicationClock {
  if (input.postedOn !== null) return input.postedOn <= input.dueOn ? 'MET' : 'MET_LATE';
  if (input.today > input.dueOn) return 'OVERDUE';
  return dayNumber(input.dueOn) - dayNumber(input.today) <= policy.remind_before_days ? 'DUE_SOON' : 'ON_TIME';
}

export type ResponseReviewClock = 'NOT_ANSWERED' | 'WITHIN_REVIEW' | 'DUE_SOON' | 'OVERDUE' | 'CLOSED';

/**
 * The time the investor has to examine the answer of the contractor: from the day the answer was received, `review_response_days`; CLOSED once the rating is adopted (with or without a change); OVERDUE after the last
 * day. A rating whose contractor did not answer needs no review (NOT_ANSWERED).
 */
export function responseReviewClock(input: { answeredOn: string | null; adopted: boolean; today: string }, policy: PerformancePolicy): ResponseReviewClock {
  if (input.answeredOn === null) return 'NOT_ANSWERED';
  if (input.adopted) return 'CLOSED';
  const dueNumber = dayNumber(input.answeredOn) + policy.review_response_days;
  const left = dueNumber - dayNumber(input.today);
  if (left < 0) return 'OVERDUE';
  return left <= Math.min(5, policy.review_response_days) ? 'DUE_SOON' : 'WITHIN_REVIEW';
}

export const RATINGS_IN_ORDER = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR'] as const;
export type PerformanceRating = (typeof RATINGS_IN_ORDER)[number];

export interface RatedContract {
  contractId: string;
  /** The day the rating was adopted (the order of the history). */
  adoptedOn: string;
  rating: PerformanceRating;
  /** The overall score, two decimals, or null. */
  score: string | null;
  construction: boolean;
}

/** Consecutive POOR ratings from the latest backwards (a rating that is not POOR ends the streak). */
export function poorStreak(history: readonly RatedContract[]): number {
  const latestFirst = [...history].sort((a, b) => b.adoptedOn.localeCompare(a.adoptedOn) || a.contractId.localeCompare(b.contractId));
  let streak = 0;
  for (const one of latestFirst) {
    if (one.rating !== 'POOR') break;
    streak += 1;
  }
  return streak;
}

export type StreakSuggestion = 'NONE' | 'REMEDY_PLAN' | 'PROPOSE_RESTRICTION';

/** What a streak asks of people: nothing; a plan to remedy (an agreed list of actions) at the second poor rating; a case for the debarment register at the third (a proposal a person may open: never opened here). */
export function streakSuggestion(streak: number, policy: PerformancePolicy): StreakSuggestion {
  if (streak >= policy.poor_streak_restriction) return 'PROPOSE_RESTRICTION';
  if (streak >= policy.poor_streak_remedy) return 'REMEDY_PLAN';
  return 'NONE';
}

/** The ratings a selection may look at on a day: those adopted within the years of the policy (more for construction). */
export function withinRetrospect(history: readonly RatedContract[], today: string, policy: PerformancePolicy): RatedContract[] {
  return history.filter((one) => {
    const years = one.construction ? policy.retrospect_years_construction : policy.retrospect_years;
    return one.adoptedOn >= nextReviewOn(today, -years * 12);
  });
}

export const PERFORMANCE_PUBLICATION_KINDS = ['INITIAL', 'UPDATE_AFTER_WARRANTY', 'UPDATE_AFTER_RESPONSE'] as const;
export type PerformancePublicationKind = (typeof PERFORMANCE_PUBLICATION_KINDS)[number];

/** The posting of a rating on the national system: by somebody other than the person who adopted the rating (403 `SELF_APPROVAL_DENIED`), with the receipt the network gave (3 to 100 characters); an update after the warranty or after a correct answer of the contractor is a new record that supersedes the one before. */
export function assertPublication(input: { kind: string; receipt: string; postedBy: string; adoptedBy: string }): PerformancePublicationKind {
  if (!(PERFORMANCE_PUBLICATION_KINDS as readonly string[]).includes(input.kind)) throw invalid('kind');
  const receipt = input.receipt.trim();
  if (receipt.length < 3 || receipt.length > 100) throw invalid('receipt');
  if (input.postedBy === input.adoptedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  return input.kind as PerformancePublicationKind;
}
