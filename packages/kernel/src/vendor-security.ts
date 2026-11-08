import { DomainError } from './errors.ts';
import { bidSecurityFactor } from './vendor-restriction.ts';
import type { BidSecurityFactor, ReputationEventFacts, ReputationPolicy, ReputationBehaviour } from './vendor-restriction.ts';

/**
 * The bid security of a bidder (VND-2, research V10; docs/vendor-controls.md section 5): a guarantee letter, an insurance bond or a deposit that the bidder lodges with its bid. It is **received** by one person,
 * **confirmed with the issuer** by another (a letter that nobody confirmed with the bank counts for nothing), and ends **released** (the bid lost or the contract was signed), **expired**, or **forfeited**. A forfeiture is
 * proposed by one person and decided by another, on a decision paper, for one of the reasons the law names; it is the fact that the ledger of bid conduct of VND-1 looks at (Điều 20.2: withdrawing after closing, refusing
 * to sign, no performance security). The amount a package asks is multiplied by the factor of VND-1 (3 times for a contractor with a posted event within the 2 years). Pure; the numbers are the rule `VENDOR_BID_SECURITY`.
 */

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const real = (day: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

export const VENDOR_BID_SECURITY_RULE_TYPE = 'VENDOR_BID_SECURITY';

export interface BidSecurityPolicy {
  /** The guarantee must hold at least this many days past the day the bid is valid until (the research reads the usual 30 days). */
  validity_margin_days: number;
  /** The warning days before the end of a confirmed security that still matters. */
  first_warning_days: number;
  second_warning_days: number;
  /** A security whose amount is below the amount asked is refused (BLOCK) or only warned about (WARN). */
  amount_below_enforcement: 'BLOCK' | 'WARN';
  /** Whether a security must be confirmed with the issuer before the bid is opened. */
  require_confirmation: boolean;
}

export const BID_SECURITY_POLICY_DEFAULTS: BidSecurityPolicy = { validity_margin_days: 30, first_warning_days: 15, second_warning_days: 7, amount_below_enforcement: 'BLOCK', require_confirmation: true };

export function bidSecurityPolicyOf(params: unknown): BidSecurityPolicy {
  if (!isRecord(params)) throw invalid('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
    return value;
  };
  const policy: BidSecurityPolicy = {
    validity_margin_days: whole('validity_margin_days', 0, 365),
    first_warning_days: whole('first_warning_days', 0, 365),
    second_warning_days: whole('second_warning_days', 0, 365),
    amount_below_enforcement: params.amount_below_enforcement === 'WARN' ? 'WARN' : params.amount_below_enforcement === 'BLOCK' ? 'BLOCK' : (() => { throw invalid('amount_below_enforcement'); })(),
    require_confirmation: typeof params.require_confirmation === 'boolean' ? params.require_confirmation : (() => { throw invalid('require_confirmation'); })(),
  };
  if (policy.second_warning_days > policy.first_warning_days) throw invalid('second_warning_days');
  return policy;
}

export const SECURITY_KINDS = ['BANK_GUARANTEE', 'INSURANCE_BOND', 'CASH_DEPOSIT'] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];

export const SECURITY_STATES = ['RECEIVED', 'CONFIRMED', 'REJECTED', 'FORFEIT_PROPOSED', 'FORFEITED', 'RELEASED', 'EXPIRED'] as const;
export type SecurityState = (typeof SECURITY_STATES)[number];
export const SECURITY_FINAL: readonly SecurityState[] = ['REJECTED', 'FORFEITED', 'RELEASED', 'EXPIRED'];

export type SecurityMove = 'CONFIRM' | 'REJECT' | 'PROPOSE_FORFEIT' | 'WITHDRAW_FORFEIT' | 'DECIDE_FORFEIT' | 'RELEASE' | 'EXPIRE';

/** Why a security is forfeited: each is a behaviour the law names (Điều 20 and the bidding documents); the last two words of the code map to the behaviour of the ledger of VND-1. */
export const FORFEIT_REASONS = ['WITHDREW_AFTER_CLOSING', 'WITHDREW_BEFORE_VALIDITY_END', 'REFUSED_TO_SIGN', 'NO_PERFORMANCE_SECURITY', 'FALSE_DECLARATION', 'OTHER_BY_BIDDING_DOCUMENT'] as const;
export type ForfeitReason = (typeof FORFEIT_REASONS)[number];

/** The behaviour of the ledger of bid conduct that a forfeiture reason is (a hook: the posting is a decision of the investor representative, never automatic). */
export const FORFEIT_BEHAVIOUR: Readonly<Record<ForfeitReason, ReputationBehaviour | null>> = {
  WITHDREW_AFTER_CLOSING: 'WITHDRAWING_AFTER_CLOSING',
  WITHDREW_BEFORE_VALIDITY_END: 'WITHDRAWING_AFTER_CLOSING',
  REFUSED_TO_SIGN: 'WINNING_WITHOUT_SIGNING',
  NO_PERFORMANCE_SECURITY: 'NO_PERFORMANCE_SECURITY',
  FALSE_DECLARATION: null,
  OTHER_BY_BIDDING_DOCUMENT: null,
};

export interface SecurityMoveContext {
  actor: string;
  /** Who received the security. */
  receivedBy: string;
  /** Who proposed the forfeiture, once proposed. */
  forfeitProposedBy: string | null;
}

/**
 * The state machine: RECEIVED -> CONFIRMED (a person other than the receiver, with the reference the issuer gave) or REJECTED; CONFIRMED -> FORFEIT_PROPOSED -> FORFEITED (a person other than the proposer) or back to
 * CONFIRMED (the proposal withdrawn or the decision refused); CONFIRMED or RECEIVED -> RELEASED or EXPIRED. A final state has no move (409 `STAGE_TRANSITION_DENIED`).
 */
export function moveSecurity(state: SecurityState, move: SecurityMove, context: SecurityMoveContext): SecurityState {
  const deny = (): never => {
    throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { status: state, move } });
  };
  switch (move) {
    case 'CONFIRM':
      if (state !== 'RECEIVED') return deny();
      if (context.actor === context.receivedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
      return 'CONFIRMED';
    case 'REJECT':
      if (state !== 'RECEIVED') return deny();
      if (context.actor === context.receivedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
      return 'REJECTED';
    case 'PROPOSE_FORFEIT':
      return state === 'CONFIRMED' ? 'FORFEIT_PROPOSED' : deny();
    case 'WITHDRAW_FORFEIT':
      return state === 'FORFEIT_PROPOSED' ? 'CONFIRMED' : deny();
    case 'DECIDE_FORFEIT':
      if (state !== 'FORFEIT_PROPOSED') return deny();
      if (context.actor === context.forfeitProposedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
      return 'FORFEITED';
    case 'RELEASE':
      return state === 'CONFIRMED' || state === 'RECEIVED' ? 'RELEASED' : deny();
    case 'EXPIRE':
      return state === 'CONFIRMED' || state === 'RECEIVED' ? 'EXPIRED' : deny();
    default:
      return deny();
  }
}

/** The decision of a forfeiture needs a decision paper and a reason of 20 characters (REASON_REQUIRED); the proposal names one of the reasons of the law. */
export function assertForfeiture(input: { reason: string; text: string; documentId: string | undefined }): ForfeitReason {
  if (!(FORFEIT_REASONS as readonly string[]).includes(input.reason)) throw invalid('reason_code');
  if (input.text.trim().length < 20) throw new DomainError('REASON_REQUIRED', 422, 'reason');
  if (input.documentId === undefined) throw invalid('decision_document_id');
  return input.reason as ForfeitReason;
}

// -- What a package asks, and what was lodged -------------------------------------------------------------------------------------------------------------------------------------------------

export interface SecurityRequirement {
  /** The amount the package asks of a normal bidder, in dong. */
  baseAmount: number;
  /** The last day the bid is valid (the day of the bid opening plus the validity the bidding documents state). */
  bidValidUntil: string;
}

export interface SecurityRequired {
  amount: number;
  factor: number;
  /** Why the factor applies (the posted event ids of the ledger of VND-1), empty at factor 1. */
  basis: BidSecurityFactor;
  mustHoldUntil: string;
}

/** The security a bidder must lodge: the base amount times the factor of its reputation (a posted event within the years of the rule), held until the margin past the validity of the bid. */
export function requiredSecurity(requirement: SecurityRequirement, events: readonly ReputationEventFacts[], today: string, reputation: ReputationPolicy, policy: BidSecurityPolicy): SecurityRequired {
  if (!Number.isSafeInteger(requirement.baseAmount) || requirement.baseAmount < 0) throw invalid('base_amount');
  if (!real(requirement.bidValidUntil)) throw invalid('bid_valid_until');
  const basis = bidSecurityFactor(events, today, reputation);
  const until = new Date(Date.parse(`${requirement.bidValidUntil}T00:00:00Z`) + policy.validity_margin_days * 86_400_000).toISOString().slice(0, 10);
  return { amount: requirement.baseAmount * basis.multiplier, factor: basis.multiplier, basis, mustHoldUntil: until };
}

export interface LodgedSecurity {
  id: string;
  state: SecurityState;
  amount: number;
  validUntil: string;
  confirmed: boolean;
}

export const SECURITY_GAPS = ['MISSING', 'NOT_CONFIRMED', 'AMOUNT_BELOW', 'VALIDITY_SHORT', 'EXPIRED', 'FORFEITED', 'REJECTED'] as const;
export type SecurityGap = (typeof SECURITY_GAPS)[number];

export interface SecurityAssessment {
  /** True when the security lodged meets what is required (the one that came closest decides). */
  satisfied: boolean;
  gaps: SecurityGap[];
  /** BLOCK when a gap the rule enforces is open; WARN for a softened one; NONE when satisfied. */
  enforcement: 'NONE' | 'WARN' | 'BLOCK';
  shortfall: number;
}

/** Judges what a bidder lodged against what the package requires on a day. A security that is not confirmed satisfies nothing when the rule requires confirmation; the amount gap is softened by the rule only. */
export function assessSecurity(required: SecurityRequired, lodged: readonly LodgedSecurity[], today: string, policy: BidSecurityPolicy): SecurityAssessment {
  const usable = lodged.filter((one) => one.state !== 'REJECTED' && one.state !== 'RELEASED');
  if (usable.length === 0) return { satisfied: false, gaps: [lodged.some((one) => one.state === 'REJECTED') ? 'REJECTED' : 'MISSING'], enforcement: 'BLOCK', shortfall: required.amount };
  let best: SecurityAssessment | undefined;
  for (const one of usable) {
    const gaps: SecurityGap[] = [];
    if (one.state === 'FORFEITED' || one.state === 'FORFEIT_PROPOSED') gaps.push('FORFEITED');
    if (one.state === 'EXPIRED' || one.validUntil < today) gaps.push('EXPIRED');
    if (policy.require_confirmation && !one.confirmed) gaps.push('NOT_CONFIRMED');
    if (one.amount < required.amount) gaps.push('AMOUNT_BELOW');
    if (one.validUntil < required.mustHoldUntil) gaps.push('VALIDITY_SHORT');
    const hard = gaps.filter((gap) => gap !== 'AMOUNT_BELOW' || policy.amount_below_enforcement === 'BLOCK');
    const enforcement: SecurityAssessment['enforcement'] = gaps.length === 0 ? 'NONE' : hard.length > 0 ? 'BLOCK' : 'WARN';
    const candidate: SecurityAssessment = { satisfied: gaps.length === 0, gaps, enforcement, shortfall: Math.max(0, required.amount - one.amount) };
    if (best === undefined || candidate.gaps.length < best.gaps.length) best = candidate;
  }
  return best as SecurityAssessment;
}

export type SecurityExpiryFacet = 'EXPIRED' | 'SECOND' | 'FIRST' | null;

/** The warning of a security that still matters (received or confirmed): first window, second window, or past its last day. */
export function securityExpiryFacet(input: { state: SecurityState; validUntil: string }, today: string, policy: BidSecurityPolicy): SecurityExpiryFacet {
  if (input.state !== 'CONFIRMED' && input.state !== 'RECEIVED') return null;
  const left = dayNumber(input.validUntil) - dayNumber(today);
  if (left < 0) return 'EXPIRED';
  if (left <= policy.second_warning_days) return 'SECOND';
  if (left <= policy.first_warning_days) return 'FIRST';
  return null;
}

/** Checks a security as it is received: a kind, a positive whole amount, an issuer and a number, a last day that is a real day and not before the day it was issued. */
export function assertSecurityEntry(input: { kind: string; amount: number; issuer: string; number: string; issuedOn: string; validUntil: string }): void {
  if (!(SECURITY_KINDS as readonly string[]).includes(input.kind)) throw invalid('kind');
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw invalid('amount');
  if (input.issuer.trim().length < 2 || input.issuer.length > 300) throw invalid('issuer');
  if (input.number.trim().length < 1 || input.number.length > 100) throw invalid('security_no');
  if (!real(input.issuedOn)) throw invalid('issued_on');
  if (!real(input.validUntil) || input.validUntil < input.issuedOn) throw invalid('valid_until');
}
