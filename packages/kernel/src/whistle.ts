import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import { addDays, daysBetween } from './monitoring-file.ts';

/**
 * The anonymous report channel and the gifts register (G4-12, should-have part, practice K17). Both are about integrity and both are pure rules over dates, states and values.
 *
 * The channel keeps no identity: a report is a text, a category and a day, nothing about the person (no address, no agent, no account), and the reporter is given a random access code once; only the hash of the code is
 * kept, so the person can come back to read the answers and add to the report without anyone knowing who they are. The days to acknowledge and to resolve are the governance rule `WHISTLE_RULE`, the gift declaration
 * time and the values are `GIFT_RULE`; both are UNVERIFIED and are the starting values the customer confirms.
 */

export const WHISTLE_RULE_TYPE = 'WHISTLE_RULE';
export const GIFT_RULE_TYPE = 'GIFT_RULE';

export interface WhistlePolicy {
  acknowledge_days: number;
  resolve_days: number;
  /** Reports one client may send in an hour. */
  rate_per_hour: number;
}

export const whistleDefaults = (): WhistlePolicy => ({ acknowledge_days: 7, resolve_days: 90, rate_per_hour: 5 });

function intIn(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new DomainError('VALIDATION_FAILED', 422, path);
  return value;
}

export function whistlePolicyOf(params: Readonly<Record<string, unknown>>): WhistlePolicy {
  const policy = { acknowledge_days: intIn(params.acknowledge_days, 1, 60, 'acknowledge_days'), resolve_days: intIn(params.resolve_days, 1, 730, 'resolve_days'), rate_per_hour: intIn(params.rate_per_hour, 1, 1000, 'rate_per_hour') };
  if (policy.acknowledge_days >= policy.resolve_days) throw new DomainError('VALIDATION_FAILED', 422, 'resolve_days');
  return policy;
}

export const WHISTLE_CATEGORIES = ['CORRUPTION', 'PROCUREMENT_IRREGULARITY', 'WASTE_OF_FUNDS', 'SAFETY', 'CONFLICT_OF_INTEREST', 'RETALIATION', 'OTHER'] as const;
export type WhistleCategory = (typeof WHISTLE_CATEGORIES)[number];
export const WHISTLE_STATUSES = ['RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'] as const;
export type WhistleStatus = (typeof WHISTLE_STATUSES)[number];
export type WhistleMove = 'ACKNOWLEDGE' | 'INVESTIGATE' | 'RESOLVE' | 'DISMISS';

const EDGES: Readonly<Record<WhistleStatus, Readonly<Partial<Record<WhistleMove, WhistleStatus>>>>> = {
  RECEIVED: { ACKNOWLEDGE: 'ACKNOWLEDGED', DISMISS: 'DISMISSED' },
  ACKNOWLEDGED: { INVESTIGATE: 'INVESTIGATING', DISMISS: 'DISMISSED' },
  INVESTIGATING: { RESOLVE: 'RESOLVED', DISMISS: 'DISMISSED' },
  RESOLVED: {},
  DISMISSED: {},
};

export function nextWhistleStatus(from: WhistleStatus, move: WhistleMove): WhistleStatus {
  const to = EDGES[from][move];
  if (to === undefined) throw new DomainError('WHISTLE_STATE_INVALID', 409, 'status');
  return to;
}

/** A resolution or a dismissal says why, in words the reporter can read. */
export function assertWhistleMove(input: { move: WhistleMove; note: string | null }): void {
  if ((input.move === 'RESOLVE' || input.move === 'DISMISS') && (input.note === null || input.note.trim().length < 10)) throw new DomainError('VALIDATION_FAILED', 422, 'note');
}

export const WHISTLE_TEXT_MIN = 20;
export const WHISTLE_TEXT_MAX = 8000;

/** What a report may carry: a category and a text of a sensible size. There is no field for a name, an address or a contact; the caller has no way to add one. */
export function assertWhistleInput(input: { category: string; text: string }): void {
  if (!(WHISTLE_CATEGORIES as readonly string[]).includes(input.category)) throw new DomainError('VALIDATION_FAILED', 422, 'category');
  const text = input.text.trim();
  if (text.length < WHISTLE_TEXT_MIN || text.length > WHISTLE_TEXT_MAX) throw new DomainError('VALIDATION_FAILED', 422, 'text');
}

/** 32 characters of an alphabet without look-alike letters give 160 bits: a code cannot be guessed, and it is shown once. */
export const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ACCESS_CODE_LENGTH = 32;

export function accessCodeFrom(bytes: Uint8Array): string {
  if (bytes.length < ACCESS_CODE_LENGTH) throw new DomainError('VALIDATION_FAILED', 422, 'bytes');
  let code = '';
  for (let index = 0; index < ACCESS_CODE_LENGTH; index += 1) code += ACCESS_CODE_ALPHABET[(bytes[index] as number) % ACCESS_CODE_ALPHABET.length];
  return code;
}

const CODE = new RegExp(`^[${ACCESS_CODE_ALPHABET}]{${ACCESS_CODE_LENGTH}}$`);
/** The code as the reporter types it: spaces and hyphens that a person adds for reading are dropped, letters are upper-cased. */
export const normalizeAccessCode = (typed: string): string => typed.replace(/[\s-]/g, '').toUpperCase();
export const isAccessCode = (value: string): boolean => CODE.test(value);
export const hashAccessCode = (code: string): string => createHash('sha256').update(`whistle-access:${code}`).digest('hex');

export interface WhistleClock {
  acknowledgeDueOn: string;
  resolveDueOn: string;
  acknowledgeState: 'DONE_ON_TIME' | 'DONE_LATE' | 'WAITING' | 'OVERDUE';
  resolveState: 'DONE_ON_TIME' | 'DONE_LATE' | 'WAITING' | 'OVERDUE';
}

/** The two clocks of a report: to acknowledge it and to settle it, counted in days from the day it was received. */
export function whistleClock(facts: { receivedOn: string; acknowledgedOn: string | null; closedOn: string | null }, today: string, policy: WhistlePolicy): WhistleClock {
  const acknowledgeDueOn = addDays(facts.receivedOn, policy.acknowledge_days);
  const resolveDueOn = addDays(facts.receivedOn, policy.resolve_days);
  const state = (due: string, doneOn: string | null): WhistleClock['acknowledgeState'] => (doneOn !== null ? (daysBetween(due, doneOn) > 0 ? 'DONE_LATE' : 'DONE_ON_TIME') : daysBetween(today, due) < 0 ? 'OVERDUE' : 'WAITING');
  return { acknowledgeDueOn, resolveDueOn, acknowledgeState: state(acknowledgeDueOn, facts.acknowledgedOn), resolveState: state(resolveDueOn, facts.closedOn) };
}

/** A handler who belongs to the unit that a report is about does not handle it (the same rule as the red flags: the involved never judge). */
export function assertHandlerIndependent(input: { handlerUnitIds: readonly string[]; subjectUnitId: string | null }): void {
  if (input.subjectUnitId !== null && input.handlerUnitIds.includes(input.subjectUnitId)) throw new DomainError('WHISTLE_HANDLER_INVOLVED', 403, 'handler');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Gifts.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface GiftPolicy {
  /** A gift is declared within this many days of the day it was received. */
  declare_within_days: number;
  /** A gift worth more than this (whole dong) is reviewed by a second person. */
  review_over_vnd: string;
  /** A gift worth more than this may not be kept: it is returned or handed to the unit. */
  keep_up_to_vnd: string;
}

export const giftDefaults = (): GiftPolicy => ({ declare_within_days: 5, review_over_vnd: '200000', keep_up_to_vnd: '1000000' });

export function giftPolicyOf(params: Readonly<Record<string, unknown>>): GiftPolicy {
  const money = (value: unknown, path: string): string => {
    if (typeof value !== 'string' || !/^[0-9]{1,18}$/.test(value)) throw new DomainError('VALIDATION_FAILED', 422, path);
    return value;
  };
  const policy = { declare_within_days: intIn(params.declare_within_days, 0, 60, 'declare_within_days'), review_over_vnd: money(params.review_over_vnd, 'review_over_vnd'), keep_up_to_vnd: money(params.keep_up_to_vnd, 'keep_up_to_vnd') };
  if (BigInt(policy.review_over_vnd) > BigInt(policy.keep_up_to_vnd)) throw new DomainError('VALIDATION_FAILED', 422, 'keep_up_to_vnd');
  return policy;
}

export const GIVER_KINDS = ['CONTRACTOR', 'SUPPLIER', 'OFFICIAL', 'COMMUNITY', 'OTHER'] as const;
export type GiverKind = (typeof GIVER_KINDS)[number];
export const GIFT_STATUSES = ['DECLARED', 'UNDER_REVIEW', 'CLOSED'] as const;
export type GiftStatus = (typeof GIFT_STATUSES)[number];
export const GIFT_OUTCOMES = ['KEPT', 'RETURNED', 'HANDED_TO_UNIT'] as const;
export type GiftOutcome = (typeof GIFT_OUTCOMES)[number];

export interface GiftReading {
  late: boolean;
  declareDueOn: string;
  needsReview: boolean;
  mayBeKept: boolean;
}

/** What the policy says of a gift: whether it was declared in time, whether a second person must look at it, and whether it may be kept at all. */
export function giftReading(facts: { receivedOn: string; declaredOn: string; valueVnd: string }, policy: GiftPolicy): GiftReading {
  const declareDueOn = addDays(facts.receivedOn, policy.declare_within_days);
  const value = BigInt(facts.valueVnd);
  return { late: daysBetween(declareDueOn, facts.declaredOn) > 0, declareDueOn, needsReview: value > BigInt(policy.review_over_vnd), mayBeKept: value <= BigInt(policy.keep_up_to_vnd) };
}

export function assertGiftInput(input: { giverName: string; giverKind: string; valueVnd: string; receivedOn: string; declaredOn: string; description: string }): void {
  if (input.giverName.trim() === '' || input.giverName.length > 200 || input.giverName !== input.giverName.trim()) throw new DomainError('VALIDATION_FAILED', 422, 'giver_name');
  if (!(GIVER_KINDS as readonly string[]).includes(input.giverKind)) throw new DomainError('VALIDATION_FAILED', 422, 'giver_kind');
  if (!/^[0-9]{1,18}$/.test(input.valueVnd)) throw new DomainError('VALIDATION_FAILED', 422, 'value_vnd');
  if (input.description.trim().length < 5 || input.description.length > 1000) throw new DomainError('VALIDATION_FAILED', 422, 'description');
  if (daysBetween(input.receivedOn, input.declaredOn) < 0) throw new DomainError('VALIDATION_FAILED', 422, 'received_on');
}

/**
 * The closing of a gift: the reviewer is not the person who received it; a gift over the keep line cannot be KEPT; a gift that needs a review is closed only from UNDER_REVIEW by that reviewer, and any other is closed
 * by a person who is not the recipient too. Every outcome says why.
 */
export function assertGiftClose(input: { outcome: GiftOutcome; reading: GiftReading; recipientId: string; reviewerId: string; note: string | null }): void {
  if (input.reviewerId === input.recipientId) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'reviewer');
  if (input.outcome === 'KEPT' && !input.reading.mayBeKept) throw new DomainError('GIFT_OUTCOME_REFUSED', 422, 'outcome');
  if (input.note === null || input.note.trim().length < 5) throw new DomainError('VALIDATION_FAILED', 422, 'note');
}
