import { hasControlChar, hasControlCharExceptWhitespace } from './control-chars.ts';
import { DomainError } from './errors.ts';
import { egpDayOf } from './egp.ts';
import { FEED_CONNECTOR_CODE, FEED_LAYOUT_VERSION, feedAcceptance } from './finance-feed-model.ts';
import type { FeedAcceptance } from './finance-feed-model.ts';
import { feedGeneratorParamsOf } from './finance-feed-generator.ts';
import type { FeedGeneratorParams } from './finance-feed-generator.ts';
import type { AdapterStatus } from './connector.ts';

/**
 * The management of the connection `fin.sotaichinh` (lane FEED-1): the pure rules that the store and the controllers apply and the tests pin. Nothing here reads the database or the network. The connection can be
 * switched off with a reason, the generator has a life (start, stop, reseed, tick), a project code of the feed is mapped to one of ours by one person and approved by another, and every difference between the feed
 * and our own figures has an owner and a resolution, never settled by one of the people who made the figures.
 */

export const FEED_MIN_REASON = 10;
export const FEED_MAX_REASON = 2000;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The text of a reason as it is kept: trimmed, at least the minimum, no control character, at most 2000. 422 `VALIDATION_FAILED` naming the field. */
export function feedReasonOf(value: unknown, field = 'reason', min: number = FEED_MIN_REASON): string {
  if (typeof value !== 'string') throw invalid(field);
  const text = value.trim();
  if (text.length < min || text.length > FEED_MAX_REASON || hasControlCharExceptWhitespace(text)) throw invalid(field);
  return text;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The connection and the generator.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const FEED_GENERATOR_STATES = ['STOPPED', 'RUNNING'] as const;
export type FeedGeneratorState = (typeof FEED_GENERATOR_STATES)[number];

export interface FeedConnectionState {
  enabled: boolean;
  version: number;
  generatorState: FeedGeneratorState;
  /** Raised by every reseed: the records of the generator of an earlier epoch are replaced, never mixed with the new ones. */
  generatorEpoch: number;
  /** The month the generator has reached (1 to 12), or null before its first start. */
  generatorMonth: number | null;
}

/** Switching the connection: both directions need a reason, and a move to the state it is already in is refused (422 `enabled`), so an audit row always means a change. */
export function feedConnectionMove(current: Pick<FeedConnectionState, 'enabled'>, target: { enabled: unknown; reason: unknown }): { enabled: boolean; reason: string } {
  if (typeof target.enabled !== 'boolean') throw invalid('enabled');
  if (target.enabled === current.enabled) throw invalid('enabled');
  return { enabled: target.enabled, reason: feedReasonOf(target.reason) };
}

/** Records are taken only while the connection is on (409 `FEED_CONNECTION_DISABLED`); a dry run is allowed either way. */
export function assertFeedApplyAllowed(connection: Pick<FeedConnectionState, 'enabled'>): void {
  if (!connection.enabled) throw new DomainError('FEED_CONNECTION_DISABLED', 409, 'connection');
}

export const FEED_GENERATOR_ACTIONS = ['START', 'STOP', 'RESEED', 'TICK'] as const;
export type FeedGeneratorAction = (typeof FEED_GENERATOR_ACTIONS)[number];

export interface FeedGeneratorDecision {
  state: FeedGeneratorState;
  epoch: number;
  /** The parameters the generator runs with after the move (null for a stop, which keeps the old ones). */
  params: FeedGeneratorParams | null;
  reason: string;
  /** Whether the move produces records (a start, a reseed, a tick). */
  produces: boolean;
}

/**
 * The life of the generator, in the order a control screen offers it. START needs the connection on and the generator stopped; STOP needs it running; RESEED (a new seed, a new epoch) works in either state and
 * leaves the state as it is; TICK advances the data by one month and needs it running and a month left (409 `FEED_GENERATOR_STATE_INVALID`, detail `state`, `year_complete` or `connection`). A reason is
 * always required (10 characters).
 */
export function feedGeneratorMove(
  current: FeedConnectionState,
  step: { action: FeedGeneratorAction; reason: unknown; body: Readonly<Record<string, unknown>>; today: string; stored: FeedGeneratorParams | null },
): FeedGeneratorDecision {
  if (!(FEED_GENERATOR_ACTIONS as readonly string[]).includes(step.action)) throw invalid('action');
  const state = (detail: string): DomainError => new DomainError('FEED_GENERATOR_STATE_INVALID', 409, detail);
  const reason = feedReasonOf(step.reason);
  switch (step.action) {
    case 'START': {
      if (!current.enabled) throw state('connection');
      if (current.generatorState === 'RUNNING') throw state('state');
      return { state: 'RUNNING', epoch: current.generatorEpoch + 1, params: feedGeneratorParamsOf(step.body, step.today), reason, produces: true };
    }
    case 'STOP': {
      if (current.generatorState !== 'RUNNING') throw state('state');
      return { state: 'STOPPED', epoch: current.generatorEpoch, params: null, reason, produces: false };
    }
    case 'RESEED': {
      if (!current.enabled) throw state('connection');
      if (step.body.seed === undefined) throw invalid('seed');
      const base = step.stored === null ? {} : { fiscal_year: step.stored.fiscalYear, current_month: step.stored.currentMonth, project_count: step.stored.projectCount };
      return { state: current.generatorState, epoch: current.generatorEpoch + 1, params: feedGeneratorParamsOf({ ...base, ...step.body }, step.today), reason, produces: true };
    }
    case 'TICK': {
      if (!current.enabled) throw state('connection');
      if (current.generatorState !== 'RUNNING' || step.stored === null) throw state('state');
      if (step.stored.currentMonth >= 12) throw state('year_complete');
      return { state: 'RUNNING', epoch: current.generatorEpoch, params: { ...step.stored, currentMonth: step.stored.currentMonth + 1 }, reason, produces: true };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Health: the age of the last run against the rule CONNECTOR_FRESHNESS, code FIN_FEED.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const FEED_FRESHNESS_RULE_TYPE = 'CONNECTOR_FRESHNESS';
export const FEED_FRESHNESS_RULE_CODE = 'FIN_FEED';
export const FEED_POLICY_RULE_TYPE = 'FINANCE_FEED_POLICY';
export const FEED_POLICY_RULE_CODE = 'DEFAULT';

export interface FeedFreshnessParams {
  max_age_hours: number;
  warn_after_hours: number;
  stale_severity: 'URGENT' | 'ACTION' | 'WATCH';
  figures_blocked_when_stale: boolean;
}

/** The params of the freshness rule as numbers; anything else is 422 `GOVERNANCE_RULE_PARAMS_INVALID` naming the field, so the caller refuses to compute instead of guessing. */
export function feedFreshnessParamsOf(params: Readonly<Record<string, unknown>>): FeedFreshnessParams {
  const hours = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
    return value;
  };
  const severity = params.stale_severity;
  if (severity !== 'URGENT' && severity !== 'ACTION' && severity !== 'WATCH') throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'stale_severity');
  if (typeof params.figures_blocked_when_stale !== 'boolean') throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'figures_blocked_when_stale');
  return { max_age_hours: hours(params.max_age_hours, 'max_age_hours'), warn_after_hours: hours(params.warn_after_hours, 'warn_after_hours'), stale_severity: severity, figures_blocked_when_stale: params.figures_blocked_when_stale };
}

export type FeedHealthStatus = 'NEVER_RECEIVED' | 'FRESH' | 'AGING' | 'STALE';

export interface FeedConnectorHealth {
  status: FeedHealthStatus;
  ageHours: number | null;
  adapterStatus: AdapterStatus;
  layoutVersion: string;
  acceptance: FeedAcceptance;
  /** FEED_STALE while STALE, at the severity of the rule; none otherwise. A connection never used raises nothing but says so. */
  alert: { code: 'FEED_STALE'; severity: FeedFreshnessParams['stale_severity'] } | null;
  figuresBlocked: boolean;
}

/**
 * Formula: age = now - the time the last run was applied (any channel). FRESH up to `warn_after_hours`, AGING up to `max_age_hours`, STALE beyond, NEVER_RECEIVED when nothing has been taken. A stale or never-used
 * feed is shown as it is, never as "no data".
 */
export function feedConnectorHealth(input: { lastRunAt: Date | null; now: Date; params: FeedFreshnessParams; adapterStatus?: AdapterStatus; layoutVersion?: string }): FeedConnectorHealth {
  const layoutVersion = input.layoutVersion ?? FEED_LAYOUT_VERSION;
  const base = { adapterStatus: input.adapterStatus ?? ('PROPOSED' as AdapterStatus), layoutVersion, acceptance: feedAcceptance(layoutVersion) };
  if (input.lastRunAt === null) return { ...base, status: 'NEVER_RECEIVED', ageHours: null, alert: null, figuresBlocked: false };
  const age = Math.max(0, (input.now.getTime() - input.lastRunAt.getTime()) / 3_600_000);
  const status: FeedHealthStatus = age <= input.params.warn_after_hours ? 'FRESH' : age <= input.params.max_age_hours ? 'AGING' : 'STALE';
  const stale = status === 'STALE';
  return { ...base, status, ageHours: Math.round(age * 10) / 10, alert: stale ? { code: 'FEED_STALE', severity: input.params.stale_severity } : null, figuresBlocked: stale && input.params.figures_blocked_when_stale };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The policy of the feed: tolerance, large difference, reporting deadline.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface FeedPolicy {
  /** A figure differs when it is off by more than this percent of ours. */
  tolerance_pct: number;
  /** A difference is large when it is off by more than this percent of ours (raises FEED_DISCREPANCY_LARGE). */
  large_discrepancy_pct: number;
  /** Days after the end of a month by which a unit must have reported. */
  report_due_days: number;
  /** Days an owner has to settle a difference. */
  difference_due_days: number;
}

export const FEED_POLICY_DEFAULTS: FeedPolicy = { tolerance_pct: 0.5, large_discrepancy_pct: 5, report_due_days: 5, difference_due_days: 7 };

export function feedPolicyOf(params: Readonly<Record<string, unknown>>): FeedPolicy {
  const number = (value: unknown, field: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
    return value;
  };
  const policy: FeedPolicy = {
    tolerance_pct: number(params.tolerance_pct, 'tolerance_pct', 0, 100),
    large_discrepancy_pct: number(params.large_discrepancy_pct, 'large_discrepancy_pct', 0, 1000),
    report_due_days: number(params.report_due_days, 'report_due_days', 0, 60),
    difference_due_days: number(params.difference_due_days, 'difference_due_days', 1, 90),
  };
  if (policy.tolerance_pct > policy.large_discrepancy_pct) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'tolerance_pct');
  return policy;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The mapping of a project code of the feed to one of ours: who proposes, who decides.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const FEED_MAPPING_STATUSES = ['PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED'] as const;
export type FeedMappingStatus = (typeof FEED_MAPPING_STATUSES)[number];
export type FeedMappingMove = 'APPROVE' | 'REJECT' | 'RETIRE';

export const FEED_MAPPING_MOVES: Readonly<Record<FeedMappingMove, { from: FeedMappingStatus; to: FeedMappingStatus }>> = {
  APPROVE: { from: 'PROPOSED', to: 'ACTIVE' },
  REJECT: { from: 'PROPOSED', to: 'REJECTED' },
  RETIRE: { from: 'ACTIVE', to: 'RETIRED' },
};

/** Applies a move to a mapping. A mapping not in the state the move starts from is 409 `FEED_MAPPING_STATE_INVALID`; the person who proposed it does not approve or reject it (403 `SELF_APPROVAL_DENIED`). */
export function feedMappingMove(mapping: { status: FeedMappingStatus; proposedBy: string }, step: { move: FeedMappingMove; actorId: string; reason: unknown }): { to: FeedMappingStatus; reason: string } {
  const edge = FEED_MAPPING_MOVES[step.move];
  if (edge === undefined) throw invalid('move');
  if (mapping.status !== edge.from) throw new DomainError('FEED_MAPPING_STATE_INVALID', 409, 'status');
  if (step.move !== 'RETIRE' && mapping.proposedBy === step.actorId) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
  return { to: edge.to, reason: feedReasonOf(step.reason) };
}

export interface FeedMappingRequest {
  ourCode: string;
  externalCode: string;
  validFrom: string | null;
  validUntil: string | null;
  method: 'MANUAL' | 'EXACT_CODE';
}

const FEED_CODE_MAX = 100;

/** The request of a hand-made proposal, judged field by field (422 `VALIDATION_FAILED` naming the field). A feed project code is mapped to one of our projects by its code. */
export function feedMappingRequestOf(body: Readonly<Record<string, unknown>>): FeedMappingRequest {
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string') throw invalid(field);
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > FEED_CODE_MAX || hasControlChar(trimmed)) throw invalid(field);
    return trimmed;
  };
  const day = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    const parsed = typeof value === 'string' ? egpDayOf(value) : undefined;
    if (parsed === undefined) throw invalid(field);
    return parsed;
  };
  const validFrom = day(body.valid_from, 'valid_from');
  const validUntil = day(body.valid_until, 'valid_until');
  if (validFrom !== null && validUntil !== null && validUntil <= validFrom) throw invalid('valid_until');
  return { ourCode: text(body.our_code, 'our_code'), externalCode: text(body.external_code, 'external_code'), validFrom, validUntil, method: 'MANUAL' };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The comparison of the feed with our own figures, and what a person does about a difference.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The three figures of a project and a year that the feed and we both hold. */
export const FEED_DIFFERENCE_FIELDS = ['PLAN_VS_DIS', 'DISBURSED_VS_DIS', 'DISBURSED_VS_TREASURY'] as const;
export type FeedDifferenceField = (typeof FEED_DIFFERENCE_FIELDS)[number];

export interface FeedOwnFigures {
  /** The plan of the year in the DIS snapshot in force; null when we have none. */
  planDis: string | null;
  /** The cumulative disbursement reported in the same snapshot. */
  disbursedDis: string | null;
  /** The disbursement of the year confirmed by the Treasury statements. */
  disbursedTreasury: string | null;
}

export interface FeedFieldDifference {
  field: FeedDifferenceField;
  kind: 'VALUE_MISMATCH' | 'MISSING_OURS';
  feed: string;
  ours: string | null;
  /** feed minus ours, exact. */
  delta: string | null;
  /** The absolute delta as a percent of ours, two decimals; null when ours is zero or missing. */
  deltaPct: string | null;
  large: boolean;
}

const cents = (amount: string): bigint => {
  const [integer = '0', fraction = ''] = amount.split('.');
  return BigInt(`${integer}${fraction.padEnd(2, '0').slice(0, 2)}`);
};
const amountText = (value: bigint): string => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = absolute % 100n;
  const body = fraction === 0n ? `${absolute / 100n}` : `${absolute / 100n}.${String(fraction).padStart(2, '0').replace(/0+$/, '')}`;
  return negative ? `-${body}` : body;
};

/** Percent with two decimals of `part` over `whole` (both exact hundredths), rounded half up, as a number of hundredths of a percent. */
const hundredthsOfPercent = (part: bigint, whole: bigint): bigint => (part * 20_000n + whole) / (whole * 2n);

/**
 * Compares the feed's figures of a project and a year with ours, field by field. A figure we do not have is not compared (it is not a difference: we cannot say who is right), except a plan we lack while the feed
 * has one (MISSING_OURS). A difference exists when |feed - ours| is more than `tolerance_pct` of ours (any difference when ours is zero); it is LARGE above `large_discrepancy_pct` (always when ours is zero).
 * `compared` counts the figures that were compared, the denominator of the discrepancy rate.
 */
export function diffFeedFigures(input: { feed: { plan: string; disbursed: string }; ours: FeedOwnFigures; policy: Pick<FeedPolicy, 'tolerance_pct' | 'large_discrepancy_pct'> }): { differences: FeedFieldDifference[]; compared: number } {
  const differences: FeedFieldDifference[] = [];
  let compared = 0;
  const tolerance = BigInt(Math.round(input.policy.tolerance_pct * 100));
  const large = BigInt(Math.round(input.policy.large_discrepancy_pct * 100));
  const check = (field: FeedDifferenceField, feed: string, ours: string | null, missingIsDifference: boolean): void => {
    if (ours === null) {
      if (missingIsDifference && cents(feed) > 0n) {
        compared += 1;
        differences.push({ field, kind: 'MISSING_OURS', feed, ours: null, delta: null, deltaPct: null, large: true });
      }
      return;
    }
    compared += 1;
    const delta = cents(feed) - cents(ours);
    if (delta === 0n) return;
    const absolute = delta < 0n ? -delta : delta;
    const base = cents(ours);
    if (base === 0n) {
      differences.push({ field, kind: 'VALUE_MISMATCH', feed, ours, delta: amountText(delta), deltaPct: null, large: true });
      return;
    }
    const pct = hundredthsOfPercent(absolute, base < 0n ? -base : base);
    if (pct <= tolerance) return;
    const text = `${pct / 100n}.${String(pct % 100n).padStart(2, '0')}`;
    differences.push({ field, kind: 'VALUE_MISMATCH', feed, ours, delta: amountText(delta), deltaPct: text, large: pct > large });
  };
  check('PLAN_VS_DIS', input.feed.plan, input.ours.planDis, true);
  check('DISBURSED_VS_DIS', input.feed.disbursed, input.ours.disbursedDis, false);
  check('DISBURSED_VS_TREASURY', input.feed.disbursed, input.ours.disbursedTreasury, false);
  return { differences, compared };
}

/** How a person settles a difference: take the figure of the feed, keep ours and tell the Finance Department, contest the feed with the Finance Department, or leave it with a reason and a review day. */
export const FEED_RESOLUTION_KINDS = ['ACCEPT_FEED', 'KEEP_OURS', 'DISPUTE', 'WAIVE'] as const;
export type FeedResolutionKind = (typeof FEED_RESOLUTION_KINDS)[number];
export const FEED_RESOLUTION_MIN_REASON: Readonly<Record<FeedResolutionKind, number>> = { ACCEPT_FEED: 10, KEEP_OURS: 10, DISPUTE: 20, WAIVE: 20 };
export const FEED_WAIVER_MAX_DAYS = 365;

export interface FeedDifferenceItem {
  feedProjectCode: string;
  fiscalYear: number;
  field: FeedDifferenceField;
  kind: FeedFieldDifference['kind'];
  feed: string;
  ours: string | null;
  delta: string | null;
  deltaPct: string | null;
  large: boolean;
  state: 'OPEN' | 'RESOLVED';
  /** The person accountable for settling it. Never one of the people who made the figures. */
  ownerId: string;
  /** The people who loaded the feed's records and who made our figure: none of them may settle the item. */
  makerIds: readonly string[];
  openedAt: string;
  dueAt: string;
  resolution: { kind: FeedResolutionKind; resolvedById: string; resolvedAt: string; reason: string; evidenceRef: string | null; reviewOn: string | null } | null;
}

/** The first of the candidates (in the order of preference) who is not a maker; undefined when every candidate is. */
export const pickFeedDifferenceOwner = (candidates: readonly string[], makerIds: readonly string[]): string | undefined => candidates.find((candidate) => !makerIds.includes(candidate));

/** One OPEN item for each difference, every one with an owner. The owner is never a maker (422 `owner_id`) and the due time is after the opening (`due_at`). */
export function openFeedDifferences(input: { feedProjectCode: string; fiscalYear: number; differences: readonly FeedFieldDifference[]; ownerId: string; makerIds: readonly string[]; openedAt: Date; dueAt: Date }): FeedDifferenceItem[] {
  if (input.ownerId.trim() === '' || input.makerIds.includes(input.ownerId)) throw invalid('owner_id');
  if (!(input.dueAt.getTime() > input.openedAt.getTime())) throw invalid('due_at');
  return input.differences.map((difference) => ({
    feedProjectCode: input.feedProjectCode,
    fiscalYear: input.fiscalYear,
    ...difference,
    state: 'OPEN' as const,
    ownerId: input.ownerId,
    makerIds: [...input.makerIds],
    openedAt: input.openedAt.toISOString(),
    dueAt: input.dueAt.toISOString(),
    resolution: null,
  }));
}

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/**
 * Settles an item. Refusals, in order: already settled (409 `FEED_DIFFERENCE_STATE_INVALID`); the person made the figures or loaded the records (403 `SELF_APPROVAL_DENIED`); a reason shorter than the kind needs,
 * a WAIVE without a review day inside a year, a DISPUTE without a reference (422 `VALIDATION_FAILED` naming `reason`, `review_on` or `evidence_ref`). The audit event (ADM-11) is written by the store.
 */
export function resolveFeedDifference(item: FeedDifferenceItem, resolution: { kind: FeedResolutionKind; resolvedById: string; at: Date; reason: string; evidenceRef?: string | null; reviewOn?: string | null }): FeedDifferenceItem {
  if (item.state !== 'OPEN') throw new DomainError('FEED_DIFFERENCE_STATE_INVALID', 409, 'state', { extensions: { state: item.state } });
  if (!(FEED_RESOLUTION_KINDS as readonly string[]).includes(resolution.kind)) throw invalid('kind');
  if (item.makerIds.includes(resolution.resolvedById)) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'resolved_by');
  const reason = resolution.reason.trim();
  if (reason.length < FEED_RESOLUTION_MIN_REASON[resolution.kind] || reason.length > 1000 || hasControlCharExceptWhitespace(reason)) throw invalid('reason');
  const evidence = resolution.evidenceRef === undefined || resolution.evidenceRef === null || resolution.evidenceRef.trim() === '' ? null : resolution.evidenceRef.trim();
  if (resolution.kind === 'DISPUTE' && evidence === null) throw invalid('evidence_ref');
  if (evidence !== null && (evidence.length > 200 || hasControlChar(evidence))) throw invalid('evidence_ref');
  let reviewOn: string | null = null;
  if (resolution.kind === 'WAIVE') {
    const day = resolution.reviewOn === undefined || resolution.reviewOn === null ? undefined : egpDayOf(resolution.reviewOn);
    const today = resolution.at.toISOString().slice(0, 10);
    if (day === undefined || day <= today || dayNumber(day) - dayNumber(today) > FEED_WAIVER_MAX_DAYS) throw invalid('review_on');
    reviewOn = day;
  }
  return { ...item, state: 'RESOLVED', resolution: { kind: resolution.kind, resolvedById: resolution.resolvedById, resolvedAt: resolution.at.toISOString(), reason, evidenceRef: evidence, reviewOn } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Alerts and indicators.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const FEED_ALERT_CODES = ['FEED_STALE', 'FEED_UNIT_LATE', 'FEED_DISCREPANCY_LARGE'] as const;
export type FeedAlertCode = (typeof FEED_ALERT_CODES)[number];

/** The codes of the KPI register for the data quality of the feed. */
export const FEED_KPI_CODES = { completeness: 'FEED_COMPLETENESS', timeliness: 'FEED_TIMELINESS', discrepancy: 'FEED_DISCREPANCY_RATE' } as const;

export interface FeedAlert {
  code: FeedAlertCode;
  severity: 'URGENT' | 'ACTION' | 'WATCH';
  /** What the alert is about: the connection, a unit, a difference. */
  subject: string;
}

/** The alerts that stand now: the feed is stale (severity of the rule), a unit is late (WATCH), a difference above the large line is open (ACTION). A connection that was switched off raises none: it chose to stop. */
export function feedAlertsFor(input: { enabled: boolean; health: FeedConnectorHealth; lateUnits: readonly string[]; largeOpenDifferences: readonly string[] }): FeedAlert[] {
  if (!input.enabled) return [];
  const alerts: FeedAlert[] = [];
  if (input.health.alert !== null) alerts.push({ code: 'FEED_STALE', severity: input.health.alert.severity, subject: FEED_CONNECTOR_CODE });
  for (const unit of input.lateUnits) alerts.push({ code: 'FEED_UNIT_LATE', severity: 'WATCH', subject: unit });
  for (const difference of input.largeOpenDifferences) alerts.push({ code: 'FEED_DISCREPANCY_LARGE', severity: 'ACTION', subject: difference });
  return alerts;
}
