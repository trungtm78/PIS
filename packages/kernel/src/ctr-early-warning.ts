import { claimDueOn, claimAmountOf, claimDaysOf, claimTextOf } from './ctr-claim.ts';
import type { DeadlineState, ClaimPeriodBasis } from './ctr-claim.ts';
import { addDecimal } from './decimal.ts';
import { daysBetweenDays, isDay } from './directive.ts';
import { DomainError } from './errors.ts';
import { assertFourEyes } from './four-eyes.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * The early-warning register of a contract (roadmap G1-15, contract module CTR, `docs/ctr-early-warning.md`). In the FIDIC and NEC family of contracts a party that sees something that may delay the work, raise its price
 * or lower its quality gives the other a warning at once, and the two review the open warnings together: the register is first issued shortly after the contract starts, is reviewed in a meeting at a fixed rhythm, and is
 * issued again shortly after each meeting. This is not the disbursement warning of DIS (`early_warning`, HOME-06), which watches the money against a plan; it is a register the parties of one contract keep together.
 *
 * Everything is pure: the days are Vietnam calendar days (`YYYY-MM-DD`), the policy and the calendar come in as arguments. The rhythm (first issue within 7 days, a meeting every 14, a re-issue within 7 days after a
 * meeting) is the policy `EARLY_WARNING_POLICY`, a starting value flagged unverified until the tenant approves its own, never a constant of a screen. A year without a published working calendar never gives a guessed day
 * when the policy counts working days (`CALENDAR_UNAVAILABLE`).
 */

/** Who raised the warning: any party of the contract can. */
export const EW_PARTIES = ['OWNER', 'CONTRACTOR', 'SUPERVISOR', 'DESIGNER', 'OTHER'] as const;
export type EwParty = (typeof EW_PARTIES)[number];

export const EW_CATEGORIES = ['TIME', 'COST', 'QUALITY', 'SAFETY', 'SCOPE', 'LEGAL', 'ENVIRONMENT', 'OTHER'] as const;
export type EwCategory = (typeof EW_CATEGORIES)[number];

export const EW_LIKELIHOODS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type EwLikelihood = (typeof EW_LIKELIHOODS)[number];

/** RAISED: given, not yet assessed. ASSESSED: an owner, a likelihood and the expected impact are on record. MITIGATING: at least one action is agreed. The three closed states say how it ended. */
export const EW_STATUSES = ['RAISED', 'ASSESSED', 'MITIGATING', 'CLOSED_RESOLVED', 'CLOSED_MATERIALISED', 'CLOSED_WITHDRAWN'] as const;
export type EwStatus = (typeof EW_STATUSES)[number];
export const EW_CLOSED_STATUSES: readonly EwStatus[] = ['CLOSED_RESOLVED', 'CLOSED_MATERIALISED', 'CLOSED_WITHDRAWN'];
export const isEwOpen = (status: EwStatus): boolean => !EW_CLOSED_STATUSES.includes(status);

export const EW_CLOSE_OUTCOMES = ['RESOLVED', 'MATERIALISED', 'WITHDRAWN'] as const;
export type EwCloseOutcome = (typeof EW_CLOSE_OUTCOMES)[number];

export const EW_ACTION_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const;
export type EwActionStatus = (typeof EW_ACTION_STATUSES)[number];

/** What the meeting concluded about one warning. */
export const EW_REVIEW_OUTCOMES = ['NO_CHANGE', 'UPDATED', 'ACTION_AGREED', 'CLOSURE_PROPOSED', 'ESCALATED'] as const;
export type EwReviewOutcome = (typeof EW_REVIEW_OUTCOMES)[number];

export const EW_ISSUE_KINDS = ['INITIAL', 'AFTER_MEETING', 'PERIODIC'] as const;
export type EwIssueKind = (typeof EW_ISSUE_KINDS)[number];

/** What a warning that came true became: a change order or a claim of the same contract. */
export const EW_MATERIALISED_INTO = ['CHANGE_REQUEST', 'CLAIM'] as const;
export type EwMaterialisedInto = (typeof EW_MATERIALISED_INTO)[number];

export const MAX_EW_TITLE = 200;
export const MAX_EW_TEXT = 2000;
export const MAX_EW_DAYS = 3650;
export const MIN_EW_REASON = 10;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

// -- The policy -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EarlyWarningPolicy {
  /** The register is first issued within this many days of the start of the contract. */
  initialIssueWithinDays: number;
  /** The parties meet to review the register at least every this many days. */
  meetingEveryDays: number;
  /** The register is issued again within this many days after a meeting. */
  reissueWithinDaysAfterMeeting: number;
  /** A deadline is "approaching" this many calendar days before its day. */
  approachDays: number;
  basis: ClaimPeriodBasis;
}

/** One week for the first issue, two weeks between meetings, one week to re-issue (the research of the roadmap for NEC-style contracts); not a rule of law and not the number of any contract. */
export const EARLY_WARNING_POLICY_DEFAULTS: EarlyWarningPolicy = { initialIssueWithinDays: 7, meetingEveryDays: 14, reissueWithinDaysAfterMeeting: 7, approachDays: 3, basis: 'CALENDAR_DAYS' };
export const EARLY_WARNING_POLICY_RULE_TYPE = 'EARLY_WARNING_POLICY';
export const EARLY_WARNING_POLICY_DEFAULT_CODE = 'DEFAULT';

export function parseEarlyWarningPolicy(raw: unknown): EarlyWarningPolicy {
  const bad = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('params');
  const input = raw as Record<string, unknown>;
  const allowed = ['initial_issue_within_days', 'meeting_every_days', 'reissue_within_days_after_meeting', 'approach_days', 'basis'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw bad(key);
  const days = (key: string, max: number): number => {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw bad(key);
    return value;
  };
  if (input.basis !== 'CALENDAR_DAYS' && input.basis !== 'WORKING_DAYS') throw bad('basis');
  return {
    initialIssueWithinDays: days('initial_issue_within_days', 90),
    meetingEveryDays: days('meeting_every_days', 180),
    reissueWithinDaysAfterMeeting: days('reissue_within_days_after_meeting', 90),
    approachDays: days('approach_days', 30),
    basis: input.basis,
  };
}

// -- Judging what a person records ------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface NewWarningInput {
  title: unknown;
  description: unknown;
  category: unknown;
  raisedByParty: unknown;
  raisedOn: unknown;
}

export interface NewWarning {
  title: string;
  description: string;
  category: EwCategory;
  raisedByParty: EwParty;
  raisedOn: string;
}

/** Judges a new warning: words, a category, the party that raises it and the day it was raised (not in the future). */
export function validateNewWarning(input: NewWarningInput, today: string): NewWarning {
  if (!EW_CATEGORIES.includes(input.category as EwCategory)) throw invalid('category');
  if (!EW_PARTIES.includes(input.raisedByParty as EwParty)) throw invalid('raised_by_party');
  if (!isDay(input.raisedOn) || input.raisedOn > today) throw invalid('raised_on');
  return {
    title: claimTextOf(input.title, 'title', MAX_EW_TITLE),
    description: claimTextOf(input.description, 'description', MAX_EW_TEXT),
    category: input.category as EwCategory,
    raisedByParty: input.raisedByParty as EwParty,
    raisedOn: input.raisedOn,
  };
}

export interface AssessmentInput {
  ownerMembershipId: unknown;
  likelihood: unknown;
  expectedTimeDays?: unknown;
  expectedCostVnd?: unknown;
  noImpactExpected?: unknown;
}

export interface Assessment {
  ownerMembershipId: string;
  likelihood: EwLikelihood;
  expectedTimeDays: number | null;
  expectedCostVnd: string | null;
  noImpactExpected: boolean;
}

/** The expected impact on time and cost is stated (a number of days, an amount, or an explicit "no impact expected"); a warning is never assessed with the impact left blank. */
export function validateAssessment(input: AssessmentInput): Assessment {
  if (!isUuid(input.ownerMembershipId)) throw invalid('owner_membership_id');
  if (!EW_LIKELIHOODS.includes(input.likelihood as EwLikelihood)) throw invalid('likelihood');
  const timeDays = claimDaysOf(input.expectedTimeDays, 'expected_time_days');
  const cost = claimAmountOf(input.expectedCostVnd, 'expected_cost_vnd');
  const none = input.noImpactExpected === true;
  if (input.noImpactExpected !== undefined && typeof input.noImpactExpected !== 'boolean') throw invalid('no_impact_expected');
  if (none && (timeDays !== null || cost !== null)) throw invalid('no_impact_expected');
  if (!none && timeDays === null && cost === null) throw invalid('expected_time_days');
  return { ownerMembershipId: input.ownerMembershipId.toLowerCase(), likelihood: input.likelihood as EwLikelihood, expectedTimeDays: timeDays, expectedCostVnd: cost, noImpactExpected: none };
}

export interface ActionInput {
  description: unknown;
  ownerMembershipId: unknown;
  dueOn: unknown;
}

export interface NewAction {
  description: string;
  ownerMembershipId: string;
  dueOn: string;
}

/** A mitigation action has words, a person who answers for it and a due day that is not in the past. */
export function validateAction(input: ActionInput, today: string): NewAction {
  if (!isUuid(input.ownerMembershipId)) throw invalid('owner_membership_id');
  if (!isDay(input.dueOn) || input.dueOn < today) throw invalid('due_on');
  return { description: claimTextOf(input.description, 'description'), ownerMembershipId: input.ownerMembershipId.toLowerCase(), dueOn: input.dueOn };
}

/** The status after an assessment: a raised warning becomes assessed, the others keep their state (a re-assessment changes the figures, not the state). A closed warning is not assessed (409). */
export function statusAfterAssessment(status: EwStatus): EwStatus {
  if (!isEwOpen(status)) throw new DomainError('EARLY_WARNING_STATE_INVALID', 409, 'status');
  return status === 'RAISED' ? 'ASSESSED' : status;
}

/** Actions are agreed on an assessed warning (409 `EARLY_WARNING_STATE_INVALID` for a raised one: nobody answers for it yet); the first action makes it MITIGATING. */
export function statusAfterAction(status: EwStatus): EwStatus {
  if (status === 'RAISED' || !isEwOpen(status)) throw new DomainError('EARLY_WARNING_STATE_INVALID', 409, 'status');
  return 'MITIGATING';
}

export interface ClosureInput {
  outcome: unknown;
  reason: unknown;
  materialisedInto?: unknown;
  materialisedId?: unknown;
}

export interface Closure {
  outcome: EwCloseOutcome;
  status: Extract<EwStatus, 'CLOSED_RESOLVED' | 'CLOSED_MATERIALISED' | 'CLOSED_WITHDRAWN'>;
  reason: string;
  materialisedInto: EwMaterialisedInto | null;
  materialisedId: string | null;
}

const CLOSED_STATUS: Readonly<Record<EwCloseOutcome, Closure['status']>> = { RESOLVED: 'CLOSED_RESOLVED', MATERIALISED: 'CLOSED_MATERIALISED', WITHDRAWN: 'CLOSED_WITHDRAWN' };

/**
 * Judges a closure. It always has a reason. A warning that came true (MATERIALISED) names the change order or the claim it became; the others name nothing. A warning is RESOLVED only when no mitigation action is still
 * open (409 `EARLY_WARNING_ACTIONS_OPEN`) and by somebody other than the person who answers for it (403 `SELF_APPROVAL_DENIED`): the owner of the mitigation cannot also certify that the risk is gone.
 */
export function validateClosure(input: ClosureInput, status: EwStatus, openActions: number, ownerMembershipId: string | null, actor: string): Closure {
  if (!isEwOpen(status)) throw new DomainError('EARLY_WARNING_STATE_INVALID', 409, 'status');
  if (!EW_CLOSE_OUTCOMES.includes(input.outcome as EwCloseOutcome)) throw invalid('outcome');
  const outcome = input.outcome as EwCloseOutcome;
  // Only a warning that was assessed can be resolved or become a change or a claim: until then nobody answers for it and nothing is known of its impact. A warning that was raised in error is withdrawn.
  if (status === 'RAISED' && outcome !== 'WITHDRAWN') throw new DomainError('EARLY_WARNING_STATE_INVALID', 409, 'status');
  if (typeof input.reason !== 'string' || input.reason.trim().length < MIN_EW_REASON || input.reason.trim().length > MAX_EW_TEXT) throw invalid('reason');
  let materialisedInto: EwMaterialisedInto | null = null;
  let materialisedId: string | null = null;
  if (outcome === 'MATERIALISED') {
    if (!EW_MATERIALISED_INTO.includes(input.materialisedInto as EwMaterialisedInto)) throw invalid('materialised_into');
    if (!isUuid(input.materialisedId)) throw invalid('materialised_id');
    materialisedInto = input.materialisedInto as EwMaterialisedInto;
    materialisedId = input.materialisedId.toLowerCase();
  } else if ((input.materialisedInto !== undefined && input.materialisedInto !== null) || (input.materialisedId !== undefined && input.materialisedId !== null)) throw invalid('materialised_into');
  if (outcome === 'RESOLVED') {
    if (openActions > 0) throw new DomainError('EARLY_WARNING_ACTIONS_OPEN', 409, 'actions');
    if (ownerMembershipId !== null) assertFourEyes(ownerMembershipId, actor);
  }
  return { outcome, status: CLOSED_STATUS[outcome], reason: input.reason.trim(), materialisedInto, materialisedId };
}

export interface MeetingReviewInput {
  warningId: unknown;
  outcome: unknown;
  note?: unknown;
}

export interface MeetingInput {
  heldOn: unknown;
  attendees: unknown;
  notes?: unknown;
  reviews: unknown;
}

export interface MeetingReview {
  warningId: string;
  outcome: EwReviewOutcome;
  note: string | null;
}

export interface NewMeeting {
  heldOn: string;
  attendees: string;
  notes: string | null;
  reviews: MeetingReview[];
}

/**
 * Judges a meeting: a day not in the future and not before the contract's start (when known), who attended, and a review of every warning that is open (a meeting that skips an open warning did not review the register,
 * so the list must name each exactly once). `openWarnings` is the ids of the warnings open on the day; a review of a warning not in it is refused.
 */
export function validateMeeting(input: MeetingInput, openWarnings: readonly string[], today: string, startOn: string | null, lastMeetingOn: string | null): NewMeeting {
  if (!isDay(input.heldOn) || input.heldOn > today || (startOn !== null && input.heldOn < startOn) || (lastMeetingOn !== null && input.heldOn <= lastMeetingOn)) throw invalid('held_on');
  const attendees = claimTextOf(input.attendees, 'attendees');
  const notes = input.notes === undefined || input.notes === null ? null : claimTextOf(input.notes, 'notes');
  if (!Array.isArray(input.reviews)) throw invalid('reviews');
  const open = new Set(openWarnings.map((id) => id.toLowerCase()));
  const seen = new Set<string>();
  const reviews: MeetingReview[] = [];
  for (const [index, entry] of (input.reviews as unknown[]).entries()) {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    if (!isUuid(item.warning_id)) throw invalid(`reviews[${index}].warning_id`);
    const id = item.warning_id.toLowerCase();
    if (!open.has(id) || seen.has(id)) throw invalid(`reviews[${index}].warning_id`);
    if (!EW_REVIEW_OUTCOMES.includes(item.outcome as EwReviewOutcome)) throw invalid(`reviews[${index}].outcome`);
    const note = item.note === undefined || item.note === null ? null : claimTextOf(item.note, `reviews[${index}].note`);
    seen.add(id);
    reviews.push({ warningId: id, outcome: item.outcome as EwReviewOutcome, note });
  }
  if (seen.size !== open.size) throw invalid('reviews');
  return { heldOn: input.heldOn, attendees, notes, reviews };
}

// -- The clocks of the register ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export const REGISTER_CLOCK_CODES = ['INITIAL_ISSUE', 'MEETING', 'REISSUE'] as const;
export type RegisterClockCode = (typeof REGISTER_CLOCK_CODES)[number];

export interface RegisterClock {
  code: RegisterClockCode;
  state: DeadlineState;
  startedOn: string | null;
  dueOn: string | null;
  doneOn: string | null;
  daysLeft: number | null;
  periodDays: number;
  basis: ClaimPeriodBasis;
  /** The meeting a re-issue belongs to. */
  meetingId: string | null;
}

export interface MeetingFacts {
  id: string;
  heldOn: string;
  /** The day the register was issued again for this meeting, or null while it is not. */
  reissuedOn: string | null;
}

function clock(
  code: RegisterClockCode,
  period: number,
  startedOn: string | null,
  doneOn: string | null,
  today: string,
  policy: EarlyWarningPolicy,
  calendars: WorkCalendarSource | undefined,
  meetingId: string | null,
): RegisterClock {
  const shell = { code, startedOn, doneOn, periodDays: period, basis: policy.basis, meetingId };
  if (startedOn === null) return { ...shell, state: 'NOT_STARTED', dueOn: null, daysLeft: null };
  const dueOn = claimDueOn(calendars, startedOn, period, policy.basis);
  if (dueOn === undefined) return { ...shell, state: 'CALENDAR_UNAVAILABLE', dueOn: null, daysLeft: null };
  if (doneOn !== null) return { ...shell, state: doneOn <= dueOn ? 'MET' : 'MET_LATE', dueOn, daysLeft: null };
  const daysLeft = daysBetweenDays(today, dueOn);
  return { ...shell, state: daysLeft < 0 ? 'MISSED' : daysLeft <= policy.approachDays ? 'APPROACHING' : 'RUNNING', dueOn, daysLeft };
}

export interface RegisterClockInput {
  /** The contract is in force (a register of a contract that has not begun, or has ended, keeps no rhythm). */
  active: boolean;
  /** The day the contract began (its effective date); null when it has none yet. */
  startOn: string | null;
  firstIssueOn: string | null;
  lastMeetingOn: string | null;
  /** The meeting the next re-issue is owed for: the latest. */
  latestMeeting: MeetingFacts | null;
}

export interface RegisterClocks {
  initial: RegisterClock;
  meeting: RegisterClock;
  reissue: RegisterClock | null;
}

/**
 * The three clocks of a contract's register: the first issue (from the start of the contract), the next meeting (from the latest meeting, or from the start when none was held), and the re-issue owed for the
 * latest meeting. The meeting clock has no "done": holding the meeting starts the next one. A contract that is not in force keeps no rhythm: all three are `NOT_STARTED`.
 */
export function earlyWarningClocks(input: RegisterClockInput, today: string, policy: EarlyWarningPolicy, calendars: WorkCalendarSource | undefined): RegisterClocks {
  const start = input.active ? input.startOn : null;
  const initial = clock('INITIAL_ISSUE', policy.initialIssueWithinDays, start, input.firstIssueOn, today, policy, calendars, null);
  const meeting = clock('MEETING', policy.meetingEveryDays, start === null ? null : (input.lastMeetingOn ?? start), null, today, policy, calendars, null);
  const reissue = input.latestMeeting === null ? null : clock('REISSUE', policy.reissueWithinDaysAfterMeeting, input.latestMeeting.heldOn, input.latestMeeting.reissuedOn, today, policy, calendars, input.latestMeeting.id);
  return { initial, meeting, reissue };
}

/** Every meeting whose re-issue is missing, with its clock, so the alert centre can raise one item per meeting that was left without it (only the ones approaching or past their day). */
export function reissuesOwed(meetings: readonly MeetingFacts[], today: string, policy: EarlyWarningPolicy, calendars: WorkCalendarSource | undefined): RegisterClock[] {
  return meetings
    .filter((meeting) => meeting.reissuedOn === null)
    .map((meeting) => clock('REISSUE', policy.reissueWithinDaysAfterMeeting, meeting.heldOn, null, today, policy, calendars, meeting.id))
    .filter((entry) => entry.state === 'APPROACHING' || entry.state === 'MISSED');
}

/** What kind of issue a register issue is: the first one is INITIAL; one that follows a meeting names it (AFTER_MEETING); any other is PERIODIC. */
export function issueKindOf(issuesBefore: number, meetingId: string | null): EwIssueKind {
  if (meetingId !== null) return 'AFTER_MEETING';
  return issuesBefore === 0 ? 'INITIAL' : 'PERIODIC';
}

/** The register is issued on a day not in the future and not before the contract began, nor before the meeting it follows (422 on `issued_on`). */
export function assertIssueDay(issuedOn: unknown, today: string, startOn: string | null, meetingHeldOn: string | null): string {
  if (!isDay(issuedOn) || issuedOn > today || (startOn !== null && issuedOn < startOn) || (meetingHeldOn !== null && issuedOn < meetingHeldOn)) throw invalid('issued_on');
  return issuedOn;
}

// -- Alerts ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const EW_ALERT_KINDS = ['EW_REGISTER_OVERDUE', 'EW_MEETING_OVERDUE', 'EW_ACTION_OVERDUE'] as const;
export type EwAlertKind = (typeof EW_ALERT_KINDS)[number];

export interface EwAlert {
  kind: EwAlertKind;
  facet: 'DUE_SOON' | 'OVERDUE';
  dueOn: string;
  code: RegisterClockCode | 'ACTION';
}

/** The alert of a register clock: a first issue, a meeting or a re-issue that is approaching or past its day; a clock that is met, running far ahead, not started or without a calendar raises none. */
export function registerClockAlert(entry: RegisterClock): EwAlert | null {
  if (entry.dueOn === null || (entry.state !== 'APPROACHING' && entry.state !== 'MISSED')) return null;
  return { kind: entry.code === 'MEETING' ? 'EW_MEETING_OVERDUE' : 'EW_REGISTER_OVERDUE', facet: entry.state === 'MISSED' ? 'OVERDUE' : 'DUE_SOON', dueOn: entry.dueOn, code: entry.code };
}

/** A mitigation action that is still open past its day (a day of its own, always to be acted on; there is no early facet: the owner chose the date). */
export function actionAlert(status: EwActionStatus, dueOn: string, today: string): EwAlert | null {
  return status === 'OPEN' && dueOn < today ? { kind: 'EW_ACTION_OVERDUE', facet: 'OVERDUE', dueOn, code: 'ACTION' } : null;
}

// -- Report hooks ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface WarningFacts {
  id: string;
  code: string;
  status: EwStatus;
  category: EwCategory;
  raisedByParty: EwParty;
  likelihood: EwLikelihood | null;
  ownerMembershipId: string | null;
  expectedTimeDays: number | null;
  expectedCostVnd: string | null;
  noImpactExpected: boolean;
  openActions: number;
  overdueActions: number;
  raisedOn: string;
  version: number;
}

export interface WarningSummary {
  total: number;
  open: number;
  byStatus: Record<EwStatus, number>;
  byCategory: Record<EwCategory, number>;
  byParty: Record<EwParty, number>;
  /** Open warnings nobody answers for, and open warnings that were never assessed. */
  withoutOwner: number;
  unassessed: number;
  /** The impact the open warnings expect together: exact decimal string in VND, and days. A warning with no figure adds nothing (and is counted in `impactUnknown`). */
  exposureCostVnd: string;
  exposureTimeDays: number;
  impactUnknown: number;
  overdueActions: number;
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

/** The register of a contract added up (a read hook for the reports of CA-3): counts by state, category and party, what nobody owns, and the impact the open warnings expect together. */
export function earlyWarningSummary(rows: readonly WarningFacts[]): WarningSummary {
  const summary: WarningSummary = {
    total: 0,
    open: 0,
    byStatus: zero(EW_STATUSES),
    byCategory: zero(EW_CATEGORIES),
    byParty: zero(EW_PARTIES),
    withoutOwner: 0,
    unassessed: 0,
    exposureCostVnd: '0',
    exposureTimeDays: 0,
    impactUnknown: 0,
    overdueActions: 0,
  };
  for (const row of rows) {
    summary.total += 1;
    summary.byStatus[row.status] += 1;
    summary.byCategory[row.category] += 1;
    summary.byParty[row.raisedByParty] += 1;
    if (!isEwOpen(row.status)) continue;
    summary.open += 1;
    summary.overdueActions += row.overdueActions;
    if (row.ownerMembershipId === null) summary.withoutOwner += 1;
    if (row.status === 'RAISED') summary.unassessed += 1;
    if (row.expectedCostVnd !== null) summary.exposureCostVnd = addDecimal(summary.exposureCostVnd, row.expectedCostVnd);
    if (row.expectedTimeDays !== null) summary.exposureTimeDays += row.expectedTimeDays;
    if (row.expectedCostVnd === null && row.expectedTimeDays === null && !row.noImpactExpected) summary.impactUnknown += 1;
  }
  return summary;
}

/** The text a register issue is hashed over: one line per warning in code order, with what a reader of the issued register relies on (state, likelihood, impact, owner, open actions, version). */
export function registerIssueText(rows: readonly WarningFacts[]): string {
  return [...rows]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((row) => [row.code, row.status, row.likelihood ?? '', row.expectedTimeDays ?? '', row.expectedCostVnd ?? '', row.noImpactExpected ? 'NONE' : '', row.ownerMembershipId ?? '', row.openActions, row.version].join('|'))
    .join('\n');
}
