import { DomainError } from './errors.ts';
import { addWorkingTime } from './working-time.ts';
import type { WorkCalendarSource, WorkingInterval } from './working-time.ts';

/**
 * Absence, deputies and the coverage of whoever receives an alert (roadmap G2-7, research A8, docs/alert-governance.md). Every alert needs a person who is there to receive it. A person who is away declares the absence; a deputy takes
 * over the alerts of the absent person for a period, for all sources or for some, with the permission of a third person (the one who allows it is not the absent person and not the deputy: nobody approves a cover for themselves). The cover
 * routes attention only, never authority: what a deputy may decide in a module stays what that module grants them (an approval needs a delegation of ADM, which is checked there). A cover cannot loop (A covers B while B covers A), cannot be
 * deeper than the policy allows, and cannot be given to a deputy of lower rank than the person they stand in for. An absent person with nobody to cover is a gap that is detected, shown and counted, and their alerts fall to the line leadership.
 *
 * Everything here is pure: the policy (the governance rule `ABSENCE_POLICY`), the calendars and the clock come in as arguments.
 */

export const ABSENCE_RULE_TYPE = 'ABSENCE_POLICY';
export const ABSENCE_DEFAULT_CODE = 'DEFAULT';

export const ABSENCE_KINDS = ['LEAVE', 'SICK', 'MISSION', 'TRAINING', 'OTHER'] as const;
export type AbsenceKind = (typeof ABSENCE_KINDS)[number];

export const COVER_SCOPE_KINDS = ['ALL', 'SOURCES'] as const;
export type CoverScopeKind = (typeof COVER_SCOPE_KINDS)[number];

export type DeputyRankRule = 'AT_LEAST_PEER' | 'ANY';

export interface AbsencePolicy {
  /** The longest an absence may be declared for, and the longest a cover may last, in days. */
  max_absence_days: number;
  max_cover_days: number;
  /** A deputy of a deputy: how many hands an alert may pass through (1 means the deputy only, no deputy of a deputy). */
  max_chain_depth: number;
  /** The absence of a person with no cover in force is a gap once it has lasted this many working hours (the research: one working day). */
  uncovered_after_working_hours: number;
  /** An absence that starts within this many days and has no cover proposed is shown ahead of time. */
  warn_before_days: number;
  deputy_rank_rule: DeputyRankRule;
  /** A position (role in a unit) is backed up when this many people present hold it, or when its holders are covered. */
  min_role_holders: number;
  /** The lowest rank of a role that counts as a position that must be covered (line leadership and above). */
  position_min_rank: number;
}

/** Starting values of the research (SAP substitute, PagerDuty overrides, RACI delegation): 90 days is the limit the delegation of authority already has; one working day and two holders are the research's. Not legal numbers. */
export function absencePolicyDefaults(): AbsencePolicy {
  return { max_absence_days: 180, max_cover_days: 90, max_chain_depth: 2, uncovered_after_working_hours: 8, warn_before_days: 3, deputy_rank_rule: 'AT_LEAST_PEER', min_role_holders: 2, position_min_rank: 60 };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
}

/** The params of an `ABSENCE_POLICY` rule, checked: a rule that does not say all of it is refused rather than half applied. */
export function absencePolicyOf(params: unknown): AbsencePolicy {
  if (!isRecord(params)) throw invalid('params');
  const rule = params.deputy_rank_rule;
  if (rule !== 'AT_LEAST_PEER' && rule !== 'ANY') throw invalid('deputy_rank_rule');
  const policy: AbsencePolicy = {
    max_absence_days: whole(params.max_absence_days, 'max_absence_days', 1, 730),
    max_cover_days: whole(params.max_cover_days, 'max_cover_days', 1, 730),
    max_chain_depth: whole(params.max_chain_depth, 'max_chain_depth', 1, 5),
    uncovered_after_working_hours: whole(params.uncovered_after_working_hours, 'uncovered_after_working_hours', 1, 240),
    warn_before_days: whole(params.warn_before_days, 'warn_before_days', 0, 30),
    deputy_rank_rule: rule,
    min_role_holders: whole(params.min_role_holders, 'min_role_holders', 1, 10),
    position_min_rank: whole(params.position_min_rank, 'position_min_rank', 1, 99),
  };
  if (policy.max_cover_days > policy.max_absence_days) throw invalid('max_cover_days');
  return policy;
}

// -- Absences -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** A start this far in the past is the clock of the client, not an absence backdated (an absence that began this morning is declared this morning). */
const START_SLACK_MS = 24 * 3_600_000;

export interface AbsenceWindow {
  from: Date;
  until: Date;
}

export type AbsencePhase = 'SCHEDULED' | 'ACTIVE' | 'OVER';

/** Where an absence stands by the clock: before its first instant it is scheduled, inside its window it is on, from its last instant it is over. */
export function absencePhaseAt(window: AbsenceWindow, now: Date): AbsencePhase {
  if (now.getTime() >= window.until.getTime()) return 'OVER';
  return now.getTime() >= window.from.getTime() ? 'ACTIVE' : 'SCHEDULED';
}

export interface AbsenceDefect {
  field: string;
  code: 'REQUIRED' | 'MALFORMED' | 'BEFORE_START' | 'TOO_LONG' | 'IN_THE_PAST' | 'ALREADY_OVER' | 'UNSUPPORTED';
}

export interface AbsenceRequest extends AbsenceWindow {
  kind: string;
}

/** Every defect of a declared absence, in the order of the fields; none when it is valid. */
export function validateAbsence(request: AbsenceRequest, now: Date, policy: AbsencePolicy): AbsenceDefect[] {
  const defects: AbsenceDefect[] = [];
  const add = (field: string, code: AbsenceDefect['code']): void => void defects.push({ field, code });
  if (!(ABSENCE_KINDS as readonly string[]).includes(request.kind)) add('kind', 'UNSUPPORTED');
  const from = request.from.getTime();
  const until = request.until.getTime();
  if (Number.isNaN(from)) add('valid_from', 'MALFORMED');
  if (Number.isNaN(until)) add('valid_until', 'MALFORMED');
  if (Number.isNaN(from) || Number.isNaN(until)) return defects;
  if (from < now.getTime() - START_SLACK_MS) add('valid_from', 'IN_THE_PAST');
  if (until <= from) add('valid_until', 'BEFORE_START');
  else if (until - from > policy.max_absence_days * DAY_MS) add('valid_until', 'TOO_LONG');
  else if (until <= now.getTime()) add('valid_until', 'ALREADY_OVER');
  return defects;
}

export function assertValidAbsence(request: AbsenceRequest, now: Date, policy: AbsencePolicy): void {
  const defects = validateAbsence(request, now, policy);
  if (defects.length > 0) throw new DomainError('ALERT_ABSENCE_INVALID', 422, defects[0]?.field, { extensions: { defects } });
}

// -- Covers ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type CoverStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';

/** One cover as the rules read it. */
export interface CoverEdge {
  id: string;
  absentId: string;
  deputyId: string;
  from: Date;
  until: Date;
  status: CoverStatus;
  scopeKind: CoverScopeKind;
  sources: readonly string[];
}

export interface PersonFacts {
  id: string;
  /** The highest rank of the person's grants. */
  rank: number;
  /** The membership is in force now. */
  active: boolean;
}

export interface CoverRequest {
  deputyId: string;
  from: Date;
  until: Date;
  scopeKind: string;
  sources: readonly string[];
}

export interface CoverDefect {
  field: string;
  code: 'REQUIRED' | 'DUPLICATE' | 'SELF' | 'DEPUTY_INACTIVE' | 'OUTSIDE_ABSENCE' | 'BEFORE_START' | 'TOO_LONG' | 'IN_THE_PAST' | 'ALREADY_OVER' | 'RANK_BELOW' | 'UNSUPPORTED' | 'LOOP' | 'CHAIN_TOO_DEEP' | 'OVERLAP';
}

export interface CoverContext {
  policy: AbsencePolicy;
  now: Date;
  absent: PersonFacts;
  deputy: PersonFacts;
  absence: AbsenceWindow;
  /** The covers that are pending or approved (any person): the graph the loop and the depth are judged on. */
  existing: readonly CoverEdge[];
  /** The sources an alert can come from; the sources named by a cover must be among them. */
  knownSources: readonly string[];
}

const live = (cover: CoverEdge): boolean => cover.status === 'PENDING' || cover.status === 'APPROVED';
const overlaps = (left: AbsenceWindow, right: AbsenceWindow): boolean => left.from.getTime() < right.until.getTime() && right.from.getTime() < left.until.getTime();
const coversSource = (cover: Pick<CoverEdge, 'scopeKind' | 'sources'>, source: string): boolean => cover.scopeKind === 'ALL' || cover.sources.includes(source);

/** The longest run of hands an alert of `start` passes through, over the live covers that overlap `window` (a loop is reported as Infinity). */
function chainDepth(start: string, edges: readonly CoverEdge[], window: AbsenceWindow, seen: ReadonlySet<string> = new Set()): number {
  if (seen.has(start)) return Number.POSITIVE_INFINITY;
  const next = new Set(seen).add(start);
  let deepest = 0;
  for (const edge of edges) {
    if (edge.absentId !== start || !live(edge) || !overlaps(edge, window)) continue;
    deepest = Math.max(deepest, 1 + chainDepth(edge.deputyId, edges, window, next));
  }
  return deepest;
}

/** Every defect of a proposed cover, in the order of the fields; none when it is valid. The rules: a deputy other than the person, in force, of at least the rank, inside the absence, no loop, not too deep, no overlap for the same deputy. */
export function validateCover(request: CoverRequest, context: CoverContext): CoverDefect[] {
  const defects: CoverDefect[] = [];
  const add = (field: string, code: CoverDefect['code']): void => void defects.push({ field, code });
  const { policy, absent, deputy } = context;
  if (request.deputyId.toLowerCase() === absent.id.toLowerCase()) add('deputy_id', 'SELF');
  else if (!deputy.active) add('deputy_id', 'DEPUTY_INACTIVE');
  else if (policy.deputy_rank_rule === 'AT_LEAST_PEER' && deputy.rank < absent.rank) add('deputy_id', 'RANK_BELOW');
  const from = request.from.getTime();
  const until = request.until.getTime();
  if (until <= from) add('valid_until', 'BEFORE_START');
  else {
    if (from < context.absence.from.getTime() || until > context.absence.until.getTime()) add('valid_until', 'OUTSIDE_ABSENCE');
    if (until - from > policy.max_cover_days * DAY_MS) add('valid_until', 'TOO_LONG');
    if (until <= context.now.getTime()) add('valid_until', 'ALREADY_OVER');
  }
  if (request.scopeKind !== 'ALL' && request.scopeKind !== 'SOURCES') add('scope_kind', 'UNSUPPORTED');
  else if (request.scopeKind === 'SOURCES') {
    if (request.sources.length === 0) add('sources', 'REQUIRED');
    else if (new Set(request.sources).size !== request.sources.length) add('sources', 'DUPLICATE');
    else if (!request.sources.every((source) => context.knownSources.includes(source))) add('sources', 'UNSUPPORTED');
  } else if (request.sources.length > 0) add('sources', 'UNSUPPORTED');
  if (defects.some((defect) => defect.field === 'deputy_id' || defect.field === 'valid_until')) return defects;
  const window = { from: request.from, until: request.until };
  const scoped = { scopeKind: request.scopeKind as CoverScopeKind, sources: request.sources };
  // The same deputy for the same alerts over the same days is the same cover said twice.
  if (context.existing.some((cover) => live(cover) && cover.absentId === absent.id && cover.deputyId === deputy.id && overlaps(cover, window) && (scoped.scopeKind === 'ALL' || cover.scopeKind === 'ALL' || scoped.sources.some((source) => cover.sources.includes(source))))) add('deputy_id', 'OVERLAP');
  const proposed: CoverEdge = { id: 'proposed', absentId: absent.id, deputyId: deputy.id, from: request.from, until: request.until, status: 'PENDING', scopeKind: scoped.scopeKind, sources: scoped.sources };
  const edges = [...context.existing, proposed];
  const depth = chainDepth(absent.id, edges, window);
  if (!Number.isFinite(depth)) add('deputy_id', 'LOOP');
  else if (depth > policy.max_chain_depth) add('deputy_id', 'CHAIN_TOO_DEEP');
  return defects;
}

/** 422 `ALERT_COVER_INVALID` naming the first field, with every defect as a member of the problem. */
export function assertValidCover(request: CoverRequest, context: CoverContext): void {
  const defects = validateCover(request, context);
  if (defects.length > 0) throw new DomainError('ALERT_COVER_INVALID', 422, defects[0]?.field, { extensions: { defects } });
}

export type CoverMove = 'APPROVE' | 'REJECT' | 'REVOKE';

const MOVES: Readonly<Record<CoverMove, { from: readonly CoverStatus[]; to: CoverStatus }>> = {
  APPROVE: { from: ['PENDING'], to: 'APPROVED' },
  REJECT: { from: ['PENDING'], to: 'REJECTED' },
  REVOKE: { from: ['PENDING', 'APPROVED'], to: 'REVOKED' },
};

/**
 * The status after a move, or 409 `ALERT_COVER_STATE_INVALID` when the cover is not where the move starts. The person who allows a cover is a third person: not the one who proposed it, not the absent person and not the deputy
 * (403 SELF_APPROVAL_DENIED). Rejecting, like approving, is the act of that third person; revoking can be done by the absent person (they are back), by the deputy (they hand it back) or by a person who may allow covers.
 */
export function nextCoverStatus(current: CoverStatus, move: CoverMove, who: { actor: string; requester: string; absent: string; deputy: string }): CoverStatus {
  const step = MOVES[move];
  if (!step.from.includes(current)) throw new DomainError('ALERT_COVER_STATE_INVALID', 409, 'status');
  const actor = who.actor.toLowerCase();
  if ((move === 'APPROVE' || move === 'REJECT') && [who.requester, who.absent, who.deputy].some((person) => person.toLowerCase() === actor)) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  return step.to;
}

/** Whether a cover is in force now: allowed, and inside its window. */
export const coverInForce = (cover: CoverEdge, now: Date): boolean => cover.status === 'APPROVED' && cover.from.getTime() <= now.getTime() && now.getTime() < cover.until.getTime();

// -- Where an alert goes ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface AbsenceSpan extends AbsenceWindow {
  membershipId: string;
}

export type RouteVia = 'OWNER' | 'DEPUTY' | 'ORPHAN';
export type RouteReason = 'ABSENT_NO_COVER' | 'CHAIN_ABSENT' | 'LOOP' | 'TOO_DEEP' | 'OWNER_INACTIVE';

export interface RouteResult {
  recipient: string | null;
  via: RouteVia;
  /** The cover that routed it (the first of the chain), when it was routed. */
  coverId: string | null;
  /** The people the alert passed through, owner first. */
  chain: string[];
  reason: RouteReason | null;
}

export interface RouteInput {
  owner: string;
  /** The source of the alert (a cover for some sources does not route the others). */
  source: string;
  now: Date;
  policy: AbsencePolicy;
  absences: readonly AbsenceSpan[];
  covers: readonly CoverEdge[];
  /** The memberships that are not in force now (they have left): an alert owned by one is an orphan whatever the covers say. */
  inactive?: ReadonlySet<string>;
}

const absentNow = (person: string, absences: readonly AbsenceSpan[], now: Date): boolean => absences.some((span) => span.membershipId.toLowerCase() === person.toLowerCase() && absencePhaseAt(span, now) === 'ACTIVE');

/**
 * Who receives an alert that is the owner's now: the owner when they are present; a deputy when they are absent and a cover that is in force names the source (and so on up the chain, within the depth the policy gives, never twice
 * through the same person); nobody (an orphan) when the owner has left, when they are absent with no cover, when the deputy is absent too, or when the chain is a loop or too deep. An orphan climbs to the line leadership by the
 * escalation (`ORPHANED`), it is never dropped.
 */
export function routeAlert(input: RouteInput): RouteResult {
  const owner = input.owner;
  if (input.inactive?.has(owner) === true) return { recipient: null, via: 'ORPHAN', coverId: null, chain: [owner], reason: 'OWNER_INACTIVE' };
  const chain = [owner];
  let first: string | null = null;
  let current = owner;
  for (let hands = 0; ; hands += 1) {
    if (!absentNow(current, input.absences, input.now)) return { recipient: current, via: hands === 0 ? 'OWNER' : 'DEPUTY', coverId: first, chain, reason: null };
    if (hands >= input.policy.max_chain_depth) return { recipient: null, via: 'ORPHAN', coverId: first, chain, reason: 'TOO_DEEP' };
    const covers = input.covers.filter((cover) => cover.absentId.toLowerCase() === current.toLowerCase() && coverInForce(cover, input.now) && coversSource(cover, input.source) && input.inactive?.has(cover.deputyId) !== true).sort((left, right) => left.id.localeCompare(right.id, 'en'));
    // The deputy who is present comes first, so a deputy who is away does not hide a second one who is there.
    const deputy = covers.find((cover) => !absentNow(cover.deputyId, input.absences, input.now)) ?? covers[0];
    if (deputy === undefined) return { recipient: null, via: 'ORPHAN', coverId: first, chain, reason: hands === 0 ? 'ABSENT_NO_COVER' : 'CHAIN_ABSENT' };
    if (chain.some((person) => person.toLowerCase() === deputy.deputyId.toLowerCase())) return { recipient: null, via: 'ORPHAN', coverId: first, chain, reason: 'LOOP' };
    first ??= deputy.id;
    chain.push(deputy.deputyId);
    current = deputy.deputyId;
  }
}

// -- Gaps in coverage ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type CoverageGapKind = 'ABSENT_NO_COVER' | 'ABSENCE_STARTING_UNCOVERED';

export interface CoverageGap {
  kind: CoverageGapKind;
  membershipId: string;
  /** The absence it is about. */
  absenceId: string;
  /** When the gap began (the absence began, or the working-hours allowance ran out). */
  since: string;
}

export interface AbsenceFacts extends AbsenceSpan {
  id: string;
  /** When it was declared: an absence declared late is not a gap before it was known. */
  declaredAt: Date;
}

export interface GapInput {
  now: Date;
  policy: AbsencePolicy;
  absences: readonly AbsenceFacts[];
  covers: readonly CoverEdge[];
  calendars: WorkCalendarSource | undefined;
  intervals?: readonly WorkingInterval[] | undefined;
}

/**
 * The absences that are a gap now: an absence that is on, with no cover for all sources in force (an allowed cover; a cover still waiting for its allowance is not cover), for longer than the working-hours allowance of the policy since it began (or
 * was declared, whichever is later); and an absence that starts within the warning days and has no cover proposed. A year without a published calendar leaves the allowance uncounted: the absence is then a gap at once rather than a guess.
 */
export function detectCoverageGaps(input: GapInput): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const absence of input.absences) {
    const phase = absencePhaseAt(absence, input.now);
    if (phase === 'OVER') continue;
    if (phase === 'SCHEDULED') {
      const days = (absence.from.getTime() - input.now.getTime()) / DAY_MS;
      const proposed = input.covers.some((cover) => cover.absentId === absence.membershipId && live(cover) && overlaps(cover, absence));
      if (days <= input.policy.warn_before_days && !proposed) gaps.push({ kind: 'ABSENCE_STARTING_UNCOVERED', membershipId: absence.membershipId, absenceId: absence.id, since: absence.declaredAt.toISOString() });
      continue;
    }
    const allowed = input.covers.some((cover) => cover.absentId === absence.membershipId && coverInForce(cover, input.now) && cover.scopeKind === 'ALL');
    if (allowed) continue;
    const begun = new Date(Math.max(absence.from.getTime(), absence.declaredAt.getTime()));
    let since = begun;
    if (input.calendars !== undefined) {
      try {
        since = addWorkingTime(input.calendars, begun, { minutes: input.policy.uncovered_after_working_hours * 60 }, input.intervals);
      } catch (failure) {
        if (!(failure instanceof DomainError) || failure.code !== 'CALENDAR_NOT_EFFECTIVE') throw failure;
      }
    }
    if (since.getTime() <= input.now.getTime()) gaps.push({ kind: 'ABSENT_NO_COVER', membershipId: absence.membershipId, absenceId: absence.id, since: since.toISOString() });
  }
  return gaps;
}

// -- Coverage of positions ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A person who holds a role in a unit (a position is a role in a unit). */
export interface PositionHolder {
  roleCode: string;
  roleRank: number;
  unitId: string;
  membershipId: string;
  /** The membership is in force now and the person is not absent. */
  present: boolean;
  /** The person is away (or gone) and an allowed cover for all sources is in force. */
  coveredNow: boolean;
}

export type PositionState = 'PEER_BACKED' | 'COVERED' | 'SINGLE_POINT' | 'UNCOVERED';

export interface PositionCoverage {
  key: string;
  roleCode: string;
  unitId: string;
  holders: number;
  present: number;
  state: PositionState;
}

export interface CoverageSummary {
  positions: PositionCoverage[];
  /** How many positions are backed up (a peer who is there, or a cover in force), of how many; null when there are no positions (never 100 percent of nothing). */
  backedUp: number;
  total: number;
  percent: number | null;
}

/**
 * The coverage of the positions that matter (roles of the rank the policy gives and above): a position is backed up when the policy's number of holders is present, or when its holders are away and covered; it is a single point when the one
 * holder who is present has nobody beside them; it is uncovered when nobody holds it who is present and no cover is in force. The percent is not made up when there are no positions.
 */
export function positionCoverage(holders: readonly PositionHolder[], policy: AbsencePolicy): CoverageSummary {
  const groups = new Map<string, PositionHolder[]>();
  for (const holder of holders) {
    if (holder.roleRank < policy.position_min_rank) continue;
    const key = `${holder.roleCode}@${holder.unitId}`;
    groups.set(key, [...(groups.get(key) ?? []), holder]);
  }
  const positions: PositionCoverage[] = [];
  for (const [key, group] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0], 'en'))) {
    const present = group.filter((holder) => holder.present).length;
    const covered = group.some((holder) => !holder.present && holder.coveredNow);
    const state: PositionState = present >= policy.min_role_holders ? 'PEER_BACKED' : present === 0 ? (covered ? 'COVERED' : 'UNCOVERED') : covered ? 'COVERED' : 'SINGLE_POINT';
    const first = group[0] as PositionHolder;
    positions.push({ key, roleCode: first.roleCode, unitId: first.unitId, holders: new Set(group.map((holder) => holder.membershipId)).size, present, state });
  }
  const backedUp = positions.filter((position) => position.state === 'PEER_BACKED' || position.state === 'COVERED').length;
  return { positions, backedUp, total: positions.length, percent: positions.length === 0 ? null : Math.round((backedUp / positions.length) * 1000) / 10 };
}

/** The one series of a routing gap: its kind and the thing it is about (an absence, an item, a position). */
export const gapKey = (kind: string, subject: string): string => `GAP:${kind}:${subject}`.slice(0, 200);
