import { DomainError } from './errors.ts';
import { postingDeadline } from './egp.ts';
import type { EgpDeadlineUnit } from './egp.ts';
import { DEFAULT_WORKING_INTERVALS } from './working-time.ts';
import type { WorkCalendarContent, WorkCalendarSource, WorkingInterval } from './working-time.ts';

/**
 * The debarment register, the joint ventures and the ledger of bid-conduct events (VND-1, research V2 and V3; docs/vendor-management.md sections 5 to 7). A restriction on a contractor is the end of a case with a
 * workflow of its own: a proposal, a notice to the contractor, the contractor's answer, a decision of the person with authority within the time the law gives (15 days from the proposal; Điều 133 NĐ 214/2025), the
 * decision put into effect, and its end (it runs out, or it is lifted on an appeal). Every number here is a rule of governance (`VENDOR_DEBARMENT`, `VENDOR_DEBARMENT_PERIOD`, `VENDOR_REPUTATION`) flagged unverified until the
 * legal staff of the tenant confirm it against the Gazette; every time limit is counted by the working-time engine on the published calendar. Pure: the facts, the policy and the calendars come in as arguments.
 */

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// -- A clock that a person has to stop (decision in 15 days, a posting in 7 working days) -----------------------------------------------------------------------------------------------------

export type DeadlineClockState = 'ON_TIME' | 'DUE_SOON' | 'OVERDUE' | 'MET' | 'MET_LATE';

/**
 * Where a time limit stands. Open (`doneAt` none): OVERDUE past the due instant, DUE_SOON within `remindBeforeDays` of it, else ON_TIME. Done: MET when it was done at or before the due instant, else MET_LATE. Lateness
 * is a figure of the register (the share done in time), not an alert once the thing is done.
 */
export function deadlineClock(input: { dueAt: Date; doneAt: Date | null; now: Date; remindBeforeDays: number }): DeadlineClockState {
  if (input.doneAt !== null) return input.doneAt.getTime() <= input.dueAt.getTime() ? 'MET' : 'MET_LATE';
  if (input.now.getTime() > input.dueAt.getTime()) return 'OVERDUE';
  return input.dueAt.getTime() - input.now.getTime() <= input.remindBeforeDays * 86_400_000 ? 'DUE_SOON' : 'ON_TIME';
}

/** The instant a limit counted in days from `from` falls due, by the working-time engine (the day of the start is not counted; a limit in calendar days that ends on a day nobody works moves to the next working day). */
export function dueFrom(unit: EgpDeadlineUnit, amount: number, from: Date, calendars: WorkCalendarContent | WorkCalendarSource, intervals: readonly WorkingInterval[] = DEFAULT_WORKING_INTERVALS): Date {
  return postingDeadline({ unit, amount }, from, calendars, intervals);
}

// -- The debarment case ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const RESTRICTION_CASE_STATES = ['PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED', 'DECIDED', 'EFFECTIVE', 'EXPIRED', 'LIFTED', 'DISMISSED'] as const;
export type RestrictionCaseState = (typeof RESTRICTION_CASE_STATES)[number];
export const RESTRICTION_CASE_FINAL: readonly RestrictionCaseState[] = ['EXPIRED', 'LIFTED', 'DISMISSED'];

/** What started the case: an investor's proposal, a finding of an inspection or audit, the result of a petition, an import of the register of the national network (BID-24, `egp_record`), or a person's own initiative. */
export const RESTRICTION_TRIGGERS = ['INVESTOR_PROPOSAL', 'INSPECTION_CONCLUSION', 'AUDIT_CONCLUSION', 'PETITION_RESOLUTION', 'EGP_IMPORT', 'OWN_INITIATIVE'] as const;
export type RestrictionTrigger = (typeof RESTRICTION_TRIGGERS)[number];
export const RESTRICTION_DECISIONS = ['BAN', 'DISMISS'] as const;
export type RestrictionDecision = (typeof RESTRICTION_DECISIONS)[number];
/** How far a ban reaches: this tenant's own procurement, one province, the whole country (the counts of Điều 133 suggest the wider two; the decision and its scope are the authority's, never computed). */
export const RESTRICTION_SCOPES = ['TENANT', 'PROVINCE', 'NATIONWIDE'] as const;
export type RestrictionScope = (typeof RESTRICTION_SCOPES)[number];
export const RESPONSE_OUTCOMES = ['RESPONDED', 'NO_RESPONSE'] as const;
export type ResponseOutcome = (typeof RESPONSE_OUTCOMES)[number];

/** The rule `VENDOR_DEBARMENT`. */
export interface DebarmentPolicy {
  /** Days to decide, from the day the proposal is received. */
  decide_within_days: number;
  decide_day_unit: 'CALENDAR_DAYS' | 'WORKING_DAYS';
  /** Days the contractor has to answer a notice (our own choice: the texts read set none). */
  response_days: number;
  /** The decision clock warns this many days before its end. */
  remind_before_days: number;
  /** The number of decisions in force at which a ban by the province, and by the minister, may be proposed (Điều 133). */
  province_threshold: number;
  national_threshold: number;
  /** Bans that add up are capped at this many months. */
  cumulative_max_months: number;
  /** A violation older than this many years can no longer be proposed for a ban. */
  limitation_years: number;
  /** Violation groups for which only the member of a joint venture who committed it is banned (the rest of the members are not). */
  jv_exception_groups: string[];
}

/** The rule `VENDOR_DEBARMENT_PERIOD`, one code per group of violations: the shortest and the longest ban, in months. */
export interface DebarmentPeriod {
  min_months: number;
  max_months: number;
  /** The kinds of behaviour of the group, in words of the register (a note for the person who decides). */
  behaviours: string;
}

export interface RestrictionCaseFacts {
  state: RestrictionCaseState;
  proposedBy: string;
  receivedAt: Date;
  notifiedAt: Date | null;
  responseDueAt: Date | null;
  responseOutcome: ResponseOutcome | null;
  decision: RestrictionDecision | null;
  decidedBy: string | null;
  effectiveFrom: string | null;
  banMonths: number | null;
}

export type RestrictionCaseMove =
  | { move: 'SEND_NOTICE'; by: string; at: Date; responseDueAt: Date }
  | { move: 'RECORD_RESPONSE'; by: string; at: Date }
  | { move: 'CLOSE_NO_RESPONSE'; by: string; at: Date }
  | { move: 'DECIDE'; by: string; at: Date; decision: RestrictionDecision; effectiveFrom: string | null; banMonths: number | null }
  | { move: 'PUT_INTO_EFFECT'; by: string; at: Date; today: string }
  | { move: 'EXPIRE'; by: string; at: Date; today: string; effectiveUntil: string | null }
  | { move: 'LIFT'; by: string; at: Date }
  | { move: 'WITHDRAW'; by: string; at: Date };

export const RESTRICTION_CASE_MOVES: Readonly<Record<RestrictionCaseMove['move'], { from: readonly RestrictionCaseState[]; to: RestrictionCaseState }>> = {
  SEND_NOTICE: { from: ['PROPOSED'], to: 'NOTICE_SENT' },
  RECORD_RESPONSE: { from: ['NOTICE_SENT'], to: 'RESPONSE_RECEIVED' },
  CLOSE_NO_RESPONSE: { from: ['NOTICE_SENT'], to: 'RESPONSE_RECEIVED' },
  DECIDE: { from: ['RESPONSE_RECEIVED'], to: 'DECIDED' },
  PUT_INTO_EFFECT: { from: ['DECIDED'], to: 'EFFECTIVE' },
  EXPIRE: { from: ['EFFECTIVE'], to: 'EXPIRED' },
  LIFT: { from: ['DECIDED', 'EFFECTIVE'], to: 'LIFTED' },
  WITHDRAW: { from: ['PROPOSED', 'NOTICE_SENT', 'RESPONSE_RECEIVED'], to: 'DISMISSED' },
};

const caseState = (state: string): DomainError => new DomainError('RESTRICTION_CASE_STATE_INVALID', 409, 'status', { extensions: { status: state } });

/**
 * One move of a case. A move from a state it does not start from is 409 `RESTRICTION_CASE_STATE_INVALID`; the person who decides is not the person who proposed (403 `SELF_APPROVAL_DENIED`: what takes a contractor out of public
 * procurement is looked at by a second person); a notice needs its due instant after it is sent; an absent answer is closed only after the answer was due; a decision of BAN names its first day and months, a warning only its first
 * day, a dismissal nothing; a decision is put into effect on or after its first day; a ban ends only after its last day.
 */
export function moveRestrictionCase(facts: RestrictionCaseFacts, step: RestrictionCaseMove): RestrictionCaseFacts {
  const rule = RESTRICTION_CASE_MOVES[step.move];
  if (!rule.from.includes(facts.state)) throw caseState(facts.state);
  const to = rule.to;
  switch (step.move) {
    case 'SEND_NOTICE':
      if (step.responseDueAt.getTime() <= step.at.getTime()) throw invalid('response_due_at');
      return { ...facts, state: to, notifiedAt: step.at, responseDueAt: step.responseDueAt };
    case 'RECORD_RESPONSE':
      return { ...facts, state: to, responseOutcome: 'RESPONDED' };
    case 'CLOSE_NO_RESPONSE':
      if (facts.responseDueAt === null || step.at.getTime() <= facts.responseDueAt.getTime()) throw new DomainError('RESTRICTION_RESPONSE_WINDOW_OPEN', 409, 'status', { extensions: { response_due_at: facts.responseDueAt?.toISOString() ?? null } });
      return { ...facts, state: to, responseOutcome: 'NO_RESPONSE' };
    case 'DECIDE': {
      if (step.by === facts.proposedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
      if (step.decision === 'DISMISS') return { ...facts, state: 'DISMISSED', decision: 'DISMISS', decidedBy: step.by, effectiveFrom: null, banMonths: null };
      if (step.effectiveFrom === null || !/^\d{4}-\d{2}-\d{2}$/.test(step.effectiveFrom)) throw invalid('effective_from');
      if (step.banMonths === null || !Number.isInteger(step.banMonths) || step.banMonths < 1) throw invalid('ban_months');
      return { ...facts, state: to, decision: step.decision, decidedBy: step.by, effectiveFrom: step.effectiveFrom, banMonths: step.banMonths };
    }
    case 'PUT_INTO_EFFECT':
      if (facts.effectiveFrom === null || step.today < facts.effectiveFrom) throw new DomainError('RESTRICTION_NOT_YET_EFFECTIVE', 409, 'effective_from', { extensions: { effective_from: facts.effectiveFrom } });
      return { ...facts, state: to };
    case 'EXPIRE':
      if (step.effectiveUntil === null || step.today <= step.effectiveUntil) throw new DomainError('RESTRICTION_NOT_YET_ENDED', 409, 'effective_until', { extensions: { effective_until: step.effectiveUntil } });
      return { ...facts, state: to };
    case 'LIFT':
    case 'WITHDRAW':
      return { ...facts, state: to };
  }
}

/** The last day a ban applies: `months` after its first day, less one day (the last day is a day on which it still applies). A warning has none. */
export function banLastDay(effectiveFrom: string, months: number): string {
  const start = new Date(`${effectiveFrom}T00:00:00Z`);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const lastOfMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const end = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(start.getUTCDate(), lastOfMonth)) - 86_400_000;
  return new Date(end).toISOString().slice(0, 10);
}

/** The months a set of violation groups allow: from the longest of the shortest bans to the sum of the longest bans, capped at the cumulative maximum. */
export function banMonthsRange(groups: readonly string[], periods: Readonly<Record<string, DebarmentPeriod>>, policy: Pick<DebarmentPolicy, 'cumulative_max_months'>): { min: number; max: number } {
  if (groups.length === 0) throw invalid('violation_groups');
  let min = 0;
  let max = 0;
  for (const group of groups) {
    const period = periods[group];
    if (period === undefined) throw invalid('violation_groups');
    min = Math.max(min, period.min_months);
    max += period.max_months;
  }
  return { min, max: Math.min(max, policy.cumulative_max_months) };
}

/** A ban within the range its groups allow (422 `RESTRICTION_BAN_PERIOD_INVALID`, naming the range). */
export function assertBanPeriod(months: number, groups: readonly string[], periods: Readonly<Record<string, DebarmentPeriod>>, policy: Pick<DebarmentPolicy, 'cumulative_max_months'>): void {
  const range = banMonthsRange(groups, periods, policy);
  if (months < range.min || months > range.max) throw new DomainError('RESTRICTION_BAN_PERIOD_INVALID', 422, 'ban_months', { extensions: { min_months: range.min, max_months: range.max } });
}

/** A violation that is older than the limitation (in years, to the day of the proposal) can no longer be proposed for a ban (422 `RESTRICTION_CASE_TIME_BARRED`). */
export function assertWithinLimitation(violationOn: string, proposedOn: string, years: number): void {
  const [year, month, day] = violationOn.split('-').map(Number) as [number, number, number];
  const limit = new Date(Date.UTC(year + years, month - 1, day)).toISOString().slice(0, 10);
  if (proposedOn > limit) throw new DomainError('RESTRICTION_CASE_TIME_BARRED', 422, 'violation_on', { extensions: { limit_on: limit } });
}

export type EscalationSuggestion = 'NONE' | 'PROVINCE' | 'NATIONWIDE';

/** How many decisions in force a contractor holds and the wider ban that suggests (a suggestion for the authority, never a decision). */
export function escalationSuggestion(decisionsInForce: number, policy: Pick<DebarmentPolicy, 'province_threshold' | 'national_threshold'>): EscalationSuggestion {
  if (decisionsInForce >= policy.national_threshold) return 'NATIONWIDE';
  if (decisionsInForce >= policy.province_threshold) return 'PROVINCE';
  return 'NONE';
}

export interface JointVentureMemberFacts {
  contractorId: string;
  /** Percent of the venture the member holds. */
  sharePct: string;
  lead: boolean;
}

/**
 * The members a case against a joint venture reaches. Every member is banned (Điều 133); when every violation group of the case is one the policy lists as an exception, only the members named as having committed it.
 * An exception with nobody named is refused (422 `VALIDATION_FAILED`, `culpable_member_ids`): the register never guesses who is not to blame.
 */
export function ventureMembersReached(members: readonly JointVentureMemberFacts[], groups: readonly string[], culpableIds: readonly string[], policy: Pick<DebarmentPolicy, 'jv_exception_groups'>): string[] {
  const all = members.map((member) => member.contractorId);
  const exception = groups.length > 0 && groups.every((group) => policy.jv_exception_groups.includes(group));
  if (!exception) return all;
  if (culpableIds.length === 0 || culpableIds.some((id) => !all.includes(id))) throw invalid('culpable_member_ids');
  return [...culpableIds];
}

/** The shares of a joint venture are whole percent figures with at most two decimals adding up to exactly 100, with one lead (422 `JOINT_VENTURE_SHARES_INVALID`). */
export function assertVentureShares(members: readonly JointVentureMemberFacts[]): void {
  if (members.length < 2) throw new DomainError('JOINT_VENTURE_SHARES_INVALID', 422, 'members', { extensions: { reason: 'AT_LEAST_TWO_MEMBERS' } });
  const ids = new Set(members.map((member) => member.contractorId));
  if (ids.size !== members.length) throw new DomainError('JOINT_VENTURE_SHARES_INVALID', 422, 'members', { extensions: { reason: 'DUPLICATE_MEMBER' } });
  if (members.filter((member) => member.lead).length !== 1) throw new DomainError('JOINT_VENTURE_SHARES_INVALID', 422, 'members', { extensions: { reason: 'ONE_LEAD' } });
  let total = 0;
  for (const [index, member] of members.entries()) {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(member.sharePct) || Number(member.sharePct) <= 0 || Number(member.sharePct) > 100) throw new DomainError('JOINT_VENTURE_SHARES_INVALID', 422, `members[${index}].share_pct`, { extensions: { reason: 'SHARE_RANGE' } });
    total += Math.round(Number(member.sharePct) * 100);
  }
  if (total !== 10_000) throw new DomainError('JOINT_VENTURE_SHARES_INVALID', 422, 'members', { extensions: { reason: 'SHARES_NOT_100', total_pct: (total / 100).toFixed(2) } });
}

// -- Rules: reading the params ----------------------------------------------------------------------------------------------------------------------------------------------------------------

const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);

/** Reads the params of `VENDOR_DEBARMENT`; a parameter that does not fit is 422 `GOVERNANCE_RULE_PARAMS_INVALID` naming it. */
export function debarmentPolicyOf(params: unknown): DebarmentPolicy {
  if (!isRecord(params)) throw bad('params');
  const whole = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  const unit = params.decide_day_unit;
  if (unit !== 'CALENDAR_DAYS' && unit !== 'WORKING_DAYS') throw bad('decide_day_unit');
  const groups = params.jv_exception_groups;
  if (!Array.isArray(groups) || !groups.every((group) => typeof group === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(group))) throw bad('jv_exception_groups');
  const policy: DebarmentPolicy = {
    decide_within_days: whole('decide_within_days', 1, 365),
    decide_day_unit: unit,
    response_days: whole('response_days', 1, 90),
    remind_before_days: whole('remind_before_days', 0, 30),
    province_threshold: whole('province_threshold', 1, 100),
    national_threshold: whole('national_threshold', 1, 100),
    cumulative_max_months: whole('cumulative_max_months', 1, 600),
    limitation_years: whole('limitation_years', 1, 50),
    jv_exception_groups: groups as string[],
  };
  if (policy.national_threshold < policy.province_threshold) throw bad('national_threshold');
  return policy;
}

export function debarmentPeriodOf(params: unknown): DebarmentPeriod {
  if (!isRecord(params)) throw bad('params');
  const read = (field: string): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 600) throw bad(field);
    return value;
  };
  const behaviours = params.behaviours;
  if (typeof behaviours !== 'string' || behaviours.length === 0 || behaviours.length > 500) throw bad('behaviours');
  const period = { min_months: read('min_months'), max_months: read('max_months'), behaviours };
  if (period.max_months < period.min_months) throw bad('max_months');
  return period;
}

/** Starting values of the rule `VENDOR_DEBARMENT` (Điều 133 NĐ 214/2025, read from a summary and not checked against the Gazette; the response window is our own choice). */
export const DEBARMENT_POLICY_DEFAULTS: DebarmentPolicy = {
  decide_within_days: 15,
  decide_day_unit: 'CALENDAR_DAYS',
  response_days: 10,
  remind_before_days: 3,
  province_threshold: 3,
  national_threshold: 5,
  cumulative_max_months: 60,
  limitation_years: 10,
  jv_exception_groups: [],
};

export const DEBARMENT_GROUPS = ['GROUP_1', 'GROUP_2', 'GROUP_3'] as const;
export type DebarmentGroup = (typeof DEBARMENT_GROUPS)[number];

// -- The ledger of events of bid conduct (V3) -------------------------------------------------------------------------------------------------------------------------------------------------------

/** The behaviours that harm the reputation of a bidder (Điều 20.1-2 NĐ 214/2025, as read in the research): eight named and a ninth the law may add. */
export const REPUTATION_BEHAVIOURS = ['NOT_COMPARING_DOCUMENTS', 'NOT_NEGOTIATING', 'WINNING_WITHOUT_SIGNING', 'WITHDRAWING_AFTER_CLOSING', 'NO_BID_SECURITY', 'NO_PERFORMANCE_SECURITY', 'NO_AWARD_CONFIRMATION', 'NO_KEY_RESOURCES', 'OTHER_BY_LAW'] as const;
export type ReputationBehaviour = (typeof REPUTATION_BEHAVIOURS)[number];
export const REPUTATION_EVENT_STATES = ['RECORDED', 'POSTED', 'RETRACTED'] as const;
export type ReputationEventState = (typeof REPUTATION_EVENT_STATES)[number];

/** The rule `VENDOR_REPUTATION`: the bid security rises by a factor for a period after an event is on the list, and a winner confirms the award within a number of working days. */
export interface ReputationPolicy {
  bid_security_multiplier: number;
  multiplier_years: number;
  award_confirmation_working_days: number;
}

export interface ReputationEventFacts {
  id: string;
  state: ReputationEventState;
  postedOn: string | null;
}

export type ReputationMove = { move: 'POST'; by: string; at: Date; recordedBy: string; receipt: string } | { move: 'RETRACT'; by: string; at: Date; recordedBy: string; reason: string };

/**
 * One move of an event: RECORDED to POSTED (somebody other than the person who recorded it posts it on the national system and keeps the receipt) or to RETRACTED (a person other than the recorder says why the entry was wrong).
 * POSTED and RETRACTED are final: a posting that was wrong is answered by a new event, never an edit (409 `STAGE_TRANSITION_DENIED`).
 */
export function moveReputationEvent(state: ReputationEventState, step: ReputationMove): ReputationEventState {
  if (state !== 'RECORDED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { status: state } });
  if (step.by === step.recordedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  if (step.move === 'POST') {
    const receipt = step.receipt.trim();
    if (receipt.length < 3 || receipt.length > 100) throw invalid('receipt');
    return 'POSTED';
  }
  if (step.reason.trim().length < 20) throw invalid('reason');
  return 'RETRACTED';
}

export interface BidSecurityFactor {
  multiplier: number;
  /** The last day the factor applies; none when it does not. */
  until: string | null;
  eventIds: string[];
}

/** The factor on a bid security for a contractor that is on the list: the multiplier for `multiplier_years` from the day of the latest posting; 1 when no event is posted. A retracted event never counts. */
export function bidSecurityFactor(events: readonly ReputationEventFacts[], today: string, policy: ReputationPolicy): BidSecurityFactor {
  const live = events.filter((event) => event.state === 'POSTED' && event.postedOn !== null);
  let until: string | null = null;
  const ids: string[] = [];
  for (const event of live) {
    const postedOn = event.postedOn as string;
    const [year, month, day] = postedOn.split('-').map(Number) as [number, number, number];
    const end = new Date(Date.UTC(year + policy.multiplier_years, month - 1, day)).toISOString().slice(0, 10);
    if (end >= today) {
      ids.push(event.id);
      if (until === null || end > until) until = end;
    }
  }
  return ids.length === 0 ? { multiplier: 1, until: null, eventIds: [] } : { multiplier: policy.bid_security_multiplier, until, eventIds: ids };
}

export function reputationPolicyOf(params: unknown): ReputationPolicy {
  if (!isRecord(params)) throw bad('params');
  const read = (field: string, min: number, max: number): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw bad(field);
    return value;
  };
  return { bid_security_multiplier: read('bid_security_multiplier', 1, 20), multiplier_years: read('multiplier_years', 1, 20), award_confirmation_working_days: read('award_confirmation_working_days', 1, 30) };
}

/** Starting values (Điều 20 NĐ 214/2025: three times the bid security for two years; three working days to confirm an award), read from a summary and flagged unverified. */
export const REPUTATION_POLICY_DEFAULTS: ReputationPolicy = { bid_security_multiplier: 3, multiplier_years: 2, award_confirmation_working_days: 3 };

// -- The gates (V2: blocked at a bid, a result, the activation of a contract, a subcontract and a payment) -------------------------------------------------------------------------------

export const GATE_ACTIONS = ['BID_SUBMISSION', 'RESULT', 'CONTRACT_ACTIVATION', 'SUBCONTRACT', 'PAYMENT'] as const;
export type GateAction = (typeof GATE_ACTIONS)[number];
export const GATE_CHECKS = ['RESTRICTION', 'VERIFICATION', 'PROFILE', 'QUALIFICATION', 'PAYEE'] as const;
export type GateCheck = (typeof GATE_CHECKS)[number];

/**
 * Which checks each action asks. A restriction is asked everywhere and never relaxed: the law forbids dealing with a banned contractor. The others are asked where they matter: an unverified tax code stops a bid, a result
 * and a contract; the profile before a bid and a contract; the certificates when a contract is activated and a subcontractor is taken on; the account when money moves.
 */
export const GATE_CHECKS_BY_ACTION: Readonly<Record<GateAction, readonly GateCheck[]>> = {
  BID_SUBMISSION: ['RESTRICTION', 'VERIFICATION', 'PROFILE'],
  RESULT: ['RESTRICTION', 'VERIFICATION', 'PROFILE'],
  CONTRACT_ACTIVATION: ['RESTRICTION', 'VERIFICATION', 'PROFILE', 'QUALIFICATION'],
  SUBCONTRACT: ['RESTRICTION', 'VERIFICATION', 'QUALIFICATION'],
  PAYMENT: ['RESTRICTION', 'PAYEE'],
};

export const ENFORCEMENT_MODES = ['BLOCK', 'WARN'] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

/** The rule `VENDOR_GATE`: the modes of the checks a tenant may soften while its records are completed. A restriction and a verification are never in it. */
export interface GatePolicy {
  profile_enforcement: EnforcementMode;
  qualification_enforcement: EnforcementMode;
}

export function gatePolicyOf(params: unknown): GatePolicy {
  if (!isRecord(params)) throw bad('params');
  const read = (field: string): EnforcementMode => {
    const value = params[field];
    if (value !== 'BLOCK' && value !== 'WARN') throw bad(field);
    return value;
  };
  return { profile_enforcement: read('profile_enforcement'), qualification_enforcement: read('qualification_enforcement') };
}

/** Starting values: an incomplete profile and a missing certificate are shown as warnings until the tenant has completed its records and switches them to BLOCK (a rule version it approves, with its reason). */
export const GATE_POLICY_DEFAULTS: GatePolicy = { profile_enforcement: 'WARN', qualification_enforcement: 'WARN' };

/** The members a restriction may reach for an action: the contractor, the members of the joint venture it leads, and the parties of the contract. The union is the set the gate asks about. */
export function gateSubjects(contractorId: string, ventureMemberIds: readonly string[], partyIds: readonly string[]): string[] {
  return [...new Set([contractorId, ...ventureMemberIds, ...partyIds])];
}

// -- Alerts -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const VENDOR_ALERT_CODES = ['VENDOR_RESTRICTED_EXPOSURE', 'VENDOR_REPUTATION_POST', 'VENDOR_DEBARMENT_DECISION', 'VENDOR_PAYEE_ACCOUNT', 'VENDOR_QUALIFICATION_EXPIRY'] as const;
export type VendorAlertCode = (typeof VENDOR_ALERT_CODES)[number];

/** The severity of the facet of an alert; the alert centre reads this table, a tenant changes it on the alert type. */
export const VENDOR_FACET_SEVERITY: Readonly<Record<string, 'URGENT' | 'ACTION' | 'WATCH'>> = {
  EXPOSED: 'URGENT',
  DUE_SOON: 'ACTION',
  OVERDUE: 'URGENT',
  FIRST: 'WATCH',
  SECOND: 'ACTION',
  EXPIRED: 'URGENT',
  CHANGE_STALLED: 'ACTION',
  SHARED_ACCOUNT: 'URGENT',
  FINDING_STRONG: 'URGENT',
  FINDING_MEDIUM: 'ACTION',
  SIGNAL: 'WATCH',
  PENDING: 'ACTION',
  REVIEW_OVERDUE: 'ACTION',
  STREAK: 'WATCH',
};

/** The facet of an open time limit that raises an alert: DUE_SOON and OVERDUE; one that is on time or done raises none. */
export function clockAlertFacet(state: DeadlineClockState): 'DUE_SOON' | 'OVERDUE' | null {
  return state === 'DUE_SOON' ? 'DUE_SOON' : state === 'OVERDUE' ? 'OVERDUE' : null;
}
