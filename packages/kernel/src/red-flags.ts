import { DomainError } from './errors.ts';

/**
 * Red flags of procurement (GOV-10, roadmap G4-3): twelve indicators of the Open Contracting Partnership catalogue (OCP, "Red flags in public procurement", 2024; the ids R0xx are the ones of that catalogue) that can be computed
 * from the data of the bids (BID) and the contracts (CTR), judged on plain facts. The registry is OPEN: a lane that has other data (the vendor side, VND) registers its own indicator with `registerRedFlagIndicator`
 * and its formula, source, as-of day and legal status come with it. A red flag is a signal for the auditors to look at, ranked so that the investigation starts where the signals pile up: it is never a conclusion, never
 * shown to the people who took part in the procurement, never shown to the contractors. An indicator whose input is not there says `NOT_COMPUTABLE` and names what is missing; it never says "clear" for want of data.
 */

export const RED_FLAG_RULE_TYPE = 'RED_FLAG_RULE';
export const RED_FLAG_RANKING_RULE_TYPE = 'RED_FLAG_RANKING';

export type RedFlagSubjectType = 'PACKAGE' | 'CONTRACT';

/** The facts of one procurement package and of the contract that came out of it. Money is whole dong as text; a fact that is not there is `null`, never zero. */
export interface RedFlagFacts {
  packageCode: string;
  /** The selection method of the package (`OPEN_BIDDING`, `DIRECT_APPOINTMENT`, ...). */
  method: string | null;
  /** The estimate of the package (its budget). */
  estimateVnd: string | null;
  /** How many bidders handed in a proposal, and the prices they offered. */
  bidderCount: number | null;
  bidPricesVnd: readonly string[] | null;
  /** The price of the award and the value of the contract now and at signing. */
  awardPriceVnd: string | null;
  contractValueVnd: string | null;
  contractOriginalValueVnd: string | null;
  approvedChangeCount: number | null;
  /** The largest cumulative increase of the price by approved changes, in percent of the original value. */
  maxCumulativeVariationPct: number | null;
  /** Days from the publication of the invitation to the closing of the bids. */
  tenderPeriodDays: number | null;
  /** The packages of the same project and kind that were bought without open competition in the window of the rule, each under the threshold: how many and their sum. */
  splitCount: number | null;
  splitTotalVnd: string | null;
  /** The packages of the same unit that were directly awarded in the window with an estimate just under the threshold. */
  nearThresholdDirectAwards: number | null;
  /** The winner (or a bidder) was under a restriction on taking part when the bids were handed in or the award was made. */
  restrictedBidderCount: number | null;
}

export interface IndicatorParams {
  threshold?: number;
  threshold_vnd?: string;
  margin_pct?: number;
  min_count?: number;
  window_days?: number;
  weight: number;
  enabled: boolean;
}

export type IndicatorStatus = 'FIRED' | 'CLEAR' | 'NOT_COMPUTABLE';

export interface IndicatorReading {
  code: string;
  ocpId: string;
  status: IndicatorStatus;
  /** The number the indicator measured, and the number it was compared with. */
  value: number | null;
  threshold: number | null;
  weight: number;
  /** For `NOT_COMPUTABLE`: the facts that are missing. */
  missing: string[];
}

export interface RedFlagIndicator {
  code: string;
  ocpId: string;
  /** The data the indicator reads, in words of the data model (shown on the registry screen). */
  dataSources: string[];
  /** Whether the indicator reads the data of the vendor side (VND) rather than BID and CTR. */
  vendorSide: boolean;
  evaluate(facts: RedFlagFacts, params: IndicatorParams): Omit<IndicatorReading, 'code' | 'ocpId' | 'weight'>;
}

const big = (value: string | null): bigint | null => (value === null || !/^-?\d+$/.test(value) ? null : BigInt(value));
const ratioPct = (part: bigint, whole: bigint): number => Number((part * 100_000n) / whole) / 1000;
const COMPETITIVE = new Set(['OPEN_BIDDING', 'LIMITED_BIDDING', 'COMPETITIVE_QUOTATION']);
const DIRECT = new Set(['DIRECT_APPOINTMENT', 'DIRECT_PURCHASE']);

const missing = (...facts: string[]): { status: IndicatorStatus; value: null; threshold: null; missing: string[] } => ({ status: 'NOT_COMPUTABLE', value: null, threshold: null, missing: facts });
const read = (fired: boolean, value: number, threshold: number): { status: IndicatorStatus; value: number; threshold: number; missing: string[] } => ({ status: fired ? 'FIRED' : 'CLEAR', value, threshold, missing: [] });

/** The twelve indicators. Each reads only the facts it names; a threshold comes from its rule (the registry holds starting values, not confirmed). */
const BUILT_IN: readonly RedFlagIndicator[] = [
  {
    code: 'SPLIT_PROCUREMENT',
    ocpId: 'R011',
    dataSources: ['BID packages of the same project and kind', 'BID selection method', 'BID estimate'],
    vendorSide: false,
    evaluate: (facts, params) => {
      const total = big(facts.splitTotalVnd);
      const limit = big(params.threshold_vnd ?? null);
      if (facts.splitCount === null || total === null) return missing('splitCount', 'splitTotalVnd');
      if (limit === null) return missing('threshold_vnd');
      return read(facts.splitCount >= (params.min_count ?? 2) && total >= limit, Number(total), Number(limit));
    },
  },
  {
    code: 'THRESHOLD_MANIPULATION',
    ocpId: 'R002',
    dataSources: ['BID estimate', 'the threshold of the rule'],
    vendorSide: false,
    evaluate: (facts, params) => {
      const estimate = big(facts.estimateVnd);
      const limit = big(params.threshold_vnd ?? null);
      if (estimate === null) return missing('estimateVnd');
      if (limit === null) return missing('threshold_vnd');
      const margin = params.margin_pct ?? 5;
      const floor = (limit * BigInt(Math.round((100 - margin) * 100))) / 10_000n;
      return read(estimate >= floor && estimate < limit, Number(estimate), Number(limit));
    },
  },
  {
    code: 'NEAR_THRESHOLD_DIRECT_AWARDS',
    ocpId: 'R055',
    dataSources: ['BID packages of the same unit awarded by direct appointment', 'BID estimate'],
    vendorSide: false,
    evaluate: (facts, params) => {
      if (facts.nearThresholdDirectAwards === null) return missing('nearThresholdDirectAwards');
      const min = params.min_count ?? 3;
      return read(facts.nearThresholdDirectAwards >= min, facts.nearThresholdDirectAwards, min);
    },
  },
  {
    code: 'DIRECT_AWARD_THEN_CHANGE',
    ocpId: 'R054',
    dataSources: ['BID selection method', 'CTR value at signing', 'CTR value now', 'the threshold of the rule'],
    vendorSide: false,
    evaluate: (facts, params) => {
      if (facts.method === null) return missing('method');
      if (!DIRECT.has(facts.method)) return read(false, 0, 0);
      const original = big(facts.contractOriginalValueVnd);
      const now = big(facts.contractValueVnd);
      const limit = big(params.threshold_vnd ?? null);
      if (original === null || now === null) return missing('contractOriginalValueVnd', 'contractValueVnd');
      if (limit === null) return missing('threshold_vnd');
      return read(original < limit && now >= limit, Number(now), Number(limit));
    },
  },
  {
    code: 'AWARD_VS_FINAL_PRICE_GAP',
    ocpId: 'R059',
    dataSources: ['BID award price', 'CTR value now'],
    vendorSide: false,
    evaluate: (facts, params) => {
      const award = big(facts.awardPriceVnd);
      const now = big(facts.contractValueVnd);
      if (award === null || now === null) return missing('awardPriceVnd', 'contractValueVnd');
      if (award <= 0n) return missing('awardPriceVnd');
      const gap = ratioPct(now - award, award);
      return read(gap >= (params.threshold ?? 10), gap, params.threshold ?? 10);
    },
  },
  {
    code: 'ADDENDUM_PRICE_INCREASE',
    ocpId: 'R069',
    dataSources: ['CTR approved changes', 'CTR value at signing'],
    vendorSide: false,
    evaluate: (facts, params) => {
      if (facts.maxCumulativeVariationPct === null) return missing('maxCumulativeVariationPct');
      return read(facts.maxCumulativeVariationPct >= (params.threshold ?? 10), facts.maxCumulativeVariationPct, params.threshold ?? 10);
    },
  },
  {
    code: 'CONTRACT_AMENDED',
    ocpId: 'R064',
    dataSources: ['CTR approved changes'],
    vendorSide: false,
    evaluate: (facts, params) => {
      if (facts.approvedChangeCount === null) return missing('approvedChangeCount');
      const min = params.min_count ?? 3;
      return read(facts.approvedChangeCount >= min, facts.approvedChangeCount, min);
    },
  },
  {
    code: 'SINGLE_BIDDER',
    ocpId: 'R018',
    dataSources: ['BID proposals handed in', 'BID selection method'],
    vendorSide: false,
    evaluate: (facts) => {
      if (facts.method === null || facts.bidderCount === null) return missing(...(facts.method === null ? ['method'] : []), ...(facts.bidderCount === null ? ['bidderCount'] : []));
      if (!COMPETITIVE.has(facts.method)) return read(false, facts.bidderCount, 1);
      return read(facts.bidderCount === 1, facts.bidderCount, 1);
    },
  },
  {
    code: 'SHORT_TENDER_PERIOD',
    ocpId: 'R003',
    dataSources: ['BID milestones: invitation published, bid closing', 'BID selection method'],
    vendorSide: false,
    evaluate: (facts, params) => {
      if (facts.method === null || facts.tenderPeriodDays === null) return missing(...(facts.method === null ? ['method'] : []), ...(facts.tenderPeriodDays === null ? ['tenderPeriodDays'] : []));
      const days = params.threshold ?? 10;
      if (!COMPETITIVE.has(facts.method)) return read(false, facts.tenderPeriodDays, days);
      return read(facts.tenderPeriodDays < days, facts.tenderPeriodDays, days);
    },
  },
  {
    code: 'AWARD_AT_OR_ABOVE_ESTIMATE',
    ocpId: 'R031',
    dataSources: ['BID award price', 'BID estimate'],
    vendorSide: false,
    evaluate: (facts, params) => {
      const award = big(facts.awardPriceVnd);
      const estimate = big(facts.estimateVnd);
      if (award === null || estimate === null) return missing('awardPriceVnd', 'estimateVnd');
      if (estimate <= 0n) return missing('estimateVnd');
      const share = ratioPct(award, estimate);
      return read(share >= (params.threshold ?? 99), share, params.threshold ?? 99);
    },
  },
  {
    code: 'DEBARRED_BIDDER',
    ocpId: 'R046',
    dataSources: ['BID contractor restrictions', 'BID proposals handed in'],
    vendorSide: false,
    evaluate: (facts) => {
      if (facts.restrictedBidderCount === null) return missing('restrictedBidderCount');
      return read(facts.restrictedBidderCount >= 1, facts.restrictedBidderCount, 1);
    },
  },
  {
    code: 'IDENTICAL_BID_PRICES',
    ocpId: 'R028',
    dataSources: ['BID proposals: offered prices'],
    vendorSide: false,
    evaluate: (facts) => {
      const prices = facts.bidPricesVnd;
      if (prices === null) return missing('bidPricesVnd');
      const counts = new Map<string, number>();
      for (const price of prices) counts.set(price, (counts.get(price) ?? 0) + 1);
      const most = Math.max(0, ...counts.values());
      return read(prices.length >= 2 && most >= 2, most, 2);
    },
  },
];

const REGISTRY = new Map<string, RedFlagIndicator & Provenance>();

export interface Provenance {
  formula: string;
  source: string;
  asOf: string;
  legalStatus: 'VERIFIED' | 'UNVERIFIED';
}

/** The provenance of the built-in indicators: the formula in words of the user, the catalogue they come from, the day they were taken and that nobody confirmed the numbers. */
export interface IndicatorInput extends RedFlagIndicator, Provenance {}

/** Registers an indicator; a code is registered once. The vendor-side lanes call this with their own facts reader; the indicator keeps its own provenance. */
export function registerRedFlagIndicator(indicator: IndicatorInput): void {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(indicator.code)) throw new Error(`red flag registry: ${indicator.code} is not an indicator code`);
  if (REGISTRY.has(indicator.code)) throw new Error(`red flag registry: ${indicator.code} is already registered`);
  if (indicator.formula.trim().length < 8 || indicator.source.trim().length < 3) throw new Error(`red flag registry: ${indicator.code} lacks formula or source`);
  REGISTRY.set(indicator.code, indicator);
}

export const registeredRedFlagIndicators = (): Array<RedFlagIndicator & Provenance> => [...REGISTRY.values()];
export const redFlagIndicator = (code: string): (RedFlagIndicator & Provenance) | undefined => REGISTRY.get(code);

/** Registers the twelve built-in indicators with their provenance (the texts come from the caller: the kernel catalogue of messages); idempotent. */
export function registerBuiltInRedFlagIndicators(provenance: (code: string) => Provenance): void {
  for (const indicator of BUILT_IN) if (!REGISTRY.has(indicator.code)) registerRedFlagIndicator({ ...indicator, ...provenance(indicator.code) });
}

export const BUILT_IN_RED_FLAG_CODES: readonly string[] = BUILT_IN.map((indicator) => indicator.code);
export const BUILT_IN_OCP_IDS: Readonly<Record<string, string>> = Object.fromEntries(BUILT_IN.map((indicator) => [indicator.code, indicator.ocpId]));

/** Evaluates every enabled indicator on the facts of one subject. `rules` gives the params of each code (the rule in force); a code without a rule is not evaluated. */
export function evaluateRedFlags(facts: RedFlagFacts, rules: ReadonlyMap<string, IndicatorParams>): IndicatorReading[] {
  const readings: IndicatorReading[] = [];
  for (const indicator of REGISTRY.values()) {
    const params = rules.get(indicator.code);
    if (params === undefined || !params.enabled) continue;
    readings.push({ code: indicator.code, ocpId: indicator.ocpId, weight: params.weight, ...indicator.evaluate(facts, params) });
  }
  return readings;
}

export type RedFlagBand = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface RankingParams {
  medium_from: number;
  high_from: number;
}

export const rankingDefaults = (): RankingParams => ({ medium_from: 3, high_from: 6 });

export interface Score {
  /** The sum of the weights of the indicators that fired. */
  score: number;
  band: RedFlagBand;
  fired: string[];
  /** Indicators that could not be computed: the score is a lower bound while there are any. */
  notComputable: string[];
}

/** The score of a subject: the sum of the weights of what fired, and where it stands. It orders the work of the auditors; it says nothing about guilt. */
export function scoreOf(readings: readonly IndicatorReading[], ranking: RankingParams): Score {
  const fired = readings.filter((reading) => reading.status === 'FIRED');
  const score = fired.reduce((sum, reading) => sum + reading.weight, 0);
  const band: RedFlagBand = score === 0 ? 'NONE' : score >= ranking.high_from ? 'HIGH' : score >= ranking.medium_from ? 'MEDIUM' : 'LOW';
  return { score, band, fired: fired.map((reading) => reading.code), notComputable: readings.filter((reading) => reading.status === 'NOT_COMPUTABLE').map((reading) => reading.code) };
}

/** The order in which the auditors look: the highest score first, then the one that has waited longest, then the code (a stable order). */
export function compareFindings(left: { score: number; firstFlaggedAt: string; subjectCode: string }, right: { score: number; firstFlaggedAt: string; subjectCode: string }): number {
  return right.score - left.score || left.firstFlaggedAt.localeCompare(right.firstFlaggedAt) || left.subjectCode.localeCompare(right.subjectCode, 'en');
}

// -- the review of a finding ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type RedFlagStatus = 'NEW' | 'IN_REVIEW' | 'CLEAR_PROPOSED' | 'CLEARED' | 'REFERRED';
export const RED_FLAG_STATUSES: readonly RedFlagStatus[] = ['NEW', 'IN_REVIEW', 'CLEAR_PROPOSED', 'CLEARED', 'REFERRED'];
export type RedFlagMove = 'TAKE' | 'PROPOSE_CLEAR' | 'CONFIRM_CLEAR' | 'REJECT_CLEAR' | 'REFER';

const MOVES: Readonly<Record<RedFlagMove, { from: RedFlagStatus; to: RedFlagStatus; reason: boolean }>> = {
  TAKE: { from: 'NEW', to: 'IN_REVIEW', reason: false },
  PROPOSE_CLEAR: { from: 'IN_REVIEW', to: 'CLEAR_PROPOSED', reason: true },
  CONFIRM_CLEAR: { from: 'CLEAR_PROPOSED', to: 'CLEARED', reason: false },
  REJECT_CLEAR: { from: 'CLEAR_PROPOSED', to: 'IN_REVIEW', reason: true },
  REFER: { from: 'IN_REVIEW', to: 'REFERRED', reason: true },
};

/**
 * The status after a move. Taking, proposing, referring and sending back need the one who acts to be an auditor with the right (judged by the caller); clearing needs two: the one who proposes it and a different one who
 * confirms it (403 SELF_APPROVAL_DENIED). A move that does not start from the status of the finding is 409 RED_FLAG_STATE_INVALID; a move that carries a decision needs its reason (422 VALIDATION_FAILED on `reason`).
 */
export function nextRedFlagStatus(current: RedFlagStatus, move: RedFlagMove, input: { actor: string; proposer: string | null; reason?: string | null }): RedFlagStatus {
  const step = MOVES[move];
  if (current !== step.from) throw new DomainError('RED_FLAG_STATE_INVALID', 409, 'status');
  if (step.reason && (input.reason === undefined || input.reason === null || input.reason.trim().length < 5)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  if (move === 'CONFIRM_CLEAR' && input.proposer !== null && input.actor === input.proposer) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  return step.to;
}

/** Whether a rescan reopens a finding that was cleared: an indicator fired that was not among those the cleared decision looked at, or the score rose above the one that was cleared. */
export function reopensAfterRescan(previous: { fired: readonly string[]; score: number }, next: { fired: readonly string[]; score: number }): boolean {
  return next.fired.some((code) => !previous.fired.includes(code)) || next.score > previous.score;
}

/** Whether a person who took part in the procurement (and so must not see its red flags) is among `involved`. */
export const isInvolved = (membershipId: string, involved: ReadonlySet<string>): boolean => involved.has(membershipId.toLowerCase());
