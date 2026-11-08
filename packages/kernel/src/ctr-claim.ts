import { addWorkingDays } from './bid-workflow.ts';
import { addDaysTo, daysBetweenDays, isDay } from './directive.ts';
import { addDecimal, compareDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';
import { assertFourEyes } from './four-eyes.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * The claim register of a contract (roadmap G1-9, contract module CTR, `docs/ctr-claims.md`). A claim is a demand one side of a contract makes on the other because of an event (the contractor asks for more time or
 * money, the owner asks for delay damages, the cost of a defect or a set-off). Most contracts give each side a limited time to notify the claim and to detail it, and some say that a notice that comes late loses the
 * claim. The time limits are different in every contract and the kernel never assumes one: a contract without an approved term (`ClaimTerm`, entered from its clauses and approved by a second person) has NO limitation
 * clock, and says so (`NO_TERM`), instead of borrowing the numbers of an international form for a domestic contract. The numbers of the forms that are known (`CLAIM_TERM_TEMPLATES` in governance-rules) are examples a
 * person can copy into a proposal, flagged unverified, and are never applied by themselves.
 *
 * Everything here is pure: the days are Vietnam calendar days (`YYYY-MM-DD`), the calendar and the policy come in as arguments. A year without a published working calendar never gives a guessed day: a deadline that
 * is counted in working days is then `CALENDAR_UNAVAILABLE` (the same rule as the clocks of the alert centre, `work-clock.ts`). The day of the start is day 0: a limit of 28 days from 2026-03-01 ends on 2026-03-29,
 * and a deadline is missed only after its day has ended.
 */

export const CLAIM_SIDES = ['CONTRACTOR', 'OWNER'] as const;
export type ClaimSide = (typeof CLAIM_SIDES)[number];
export const isClaimSide = (value: unknown): value is ClaimSide => CLAIM_SIDES.includes(value as ClaimSide);

/** What a side may claim: the contractor for time and money, the owner for delay damages, the cost of a defect or a set-off against what is owed; `OTHER` for both. */
export const CLAIM_KINDS_BY_SIDE: Readonly<Record<ClaimSide, readonly string[]>> = {
  CONTRACTOR: ['EXTENSION_OF_TIME', 'ADDITIONAL_PAYMENT', 'TIME_AND_COST', 'OTHER'],
  OWNER: ['DELAY_DAMAGES', 'DEFECT_COST', 'SET_OFF', 'OTHER'],
};
export const CLAIM_KINDS = ['EXTENSION_OF_TIME', 'ADDITIONAL_PAYMENT', 'TIME_AND_COST', 'DELAY_DAMAGES', 'DEFECT_COST', 'SET_OFF', 'OTHER'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const claimKindAllowed = (side: ClaimSide, kind: unknown): kind is ClaimKind => typeof kind === 'string' && CLAIM_KINDS_BY_SIDE[side].includes(kind);

export const CONTRACT_CLAIM_STATUSES = ['EVENT_RECORDED', 'NOTICE_SERVED', 'PARTICULARS_SUBMITTED', 'RESPONDED', 'SETTLEMENT_PROPOSED', 'SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED'] as const;
export type ContractClaimStatus = (typeof CONTRACT_CLAIM_STATUSES)[number];
/** The states in which a claim can still move: the others are the end of the claim in this register (a referral goes on in a dispute procedure outside it). */
export const CLOSED_CLAIM_STATUSES: readonly ContractClaimStatus[] = ['SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED'];
export const isClaimOpen = (status: ContractClaimStatus): boolean => !CLOSED_CLAIM_STATUSES.includes(status);

/** The steps of the timeline of a claim: append-only, in the order they happened. */
export const CLAIM_STEP_KINDS = ['EVENT', 'NOTICE', 'PARTICULARS', 'RESPONSE', 'SETTLEMENT_PROPOSAL', 'SETTLEMENT_APPROVED', 'SETTLEMENT_REJECTED', 'WITHDRAWAL', 'REFERRAL', 'BAR_DECLARED', 'TERM_BOUND'] as const;
export type ClaimStepKind = (typeof CLAIM_STEP_KINDS)[number];
/** The steps a person records with a date of the contract world (a notice has the day it was served); the others are decisions of the register. */
export const RECORDED_STEP_KINDS = ['NOTICE', 'PARTICULARS', 'RESPONSE', 'SETTLEMENT_PROPOSAL', 'WITHDRAWAL', 'REFERRAL'] as const;
export type RecordedStepKind = (typeof RECORDED_STEP_KINDS)[number];

export const RESPONSE_DECISIONS = ['ACCEPTED', 'PARTLY_ACCEPTED', 'REJECTED', 'MORE_INFORMATION_REQUESTED'] as const;
export type ResponseDecision = (typeof RESPONSE_DECISIONS)[number];

export const CLAIM_PERIOD_BASES = ['CALENDAR_DAYS', 'WORKING_DAYS'] as const;
export type ClaimPeriodBasis = (typeof CLAIM_PERIOD_BASES)[number];

/** What the contract says happens to a claim whose notice or particulars come late. `NOT_STATED`: the clause gives a period and says nothing about the effect (the register shows the date and does not assume a bar). */
export const BAR_EFFECTS = ['BARS_CLAIM', 'REDUCES_RELIEF', 'NONE', 'NOT_STATED'] as const;
export type BarEffect = (typeof BAR_EFFECTS)[number];

export const PARTICULARS_FROM = ['AWARENESS', 'NOTICE'] as const;
export type ParticularsFrom = (typeof PARTICULARS_FROM)[number];

export const CLAIM_TERM_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type ClaimTermStatus = (typeof CLAIM_TERM_STATUSES)[number];

export const MAX_CLAIM_DAYS = 3650;
export const MIN_CLAIM_TEXT = 5;
export const MAX_CLAIM_TEXT = 2000;
export const MAX_CLAIM_TITLE = 200;
export const MAX_CLAUSE_REFERENCE = 200;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

// -- The term of a contract --------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The limits a contract gives one side's claims, as the clauses of the signed contract state them. A period that is `null` is a period the contract does not give. */
export interface ClaimTerm {
  claimantSide: ClaimSide;
  /** Days from the day the claimant became aware of the event to the day the notice must be served. */
  noticeDays: number | null;
  /** Days to detail the claim (a fully particularised claim), counted from `particularsFrom`. */
  particularsDays: number | null;
  /** Days the other side has to respond after the claimant's last submission. */
  responseDays: number | null;
  /** Days to settle after a response that accepts the claim in whole or in part. */
  settlementDays: number | null;
  basis: ClaimPeriodBasis;
  particularsFrom: ParticularsFrom;
  barEffect: BarEffect;
  /** The clause of the contract the periods come from (a person finds it again in the signed document). */
  clauseReference: string;
}

export interface ClaimTermInput {
  claimant_side?: unknown;
  notice_days?: unknown;
  particulars_days?: unknown;
  response_days?: unknown;
  settlement_days?: unknown;
  basis?: unknown;
  particulars_from?: unknown;
  bar_effect?: unknown;
  clause_reference?: unknown;
}

function periodOf(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CLAIM_DAYS) throw invalid(field);
  return value;
}

/** Judges a proposal of a term: a period is a whole number of days, at least one of them is given, the clause is named, and an effect that bars or reduces the claim needs a period it applies to. */
export function validateClaimTerm(input: ClaimTermInput): ClaimTerm {
  if (!isClaimSide(input.claimant_side)) throw invalid('claimant_side');
  const noticeDays = periodOf(input.notice_days, 'notice_days');
  const particularsDays = periodOf(input.particulars_days, 'particulars_days');
  const responseDays = periodOf(input.response_days, 'response_days');
  const settlementDays = periodOf(input.settlement_days, 'settlement_days');
  if (noticeDays === null && particularsDays === null && responseDays === null && settlementDays === null) throw invalid('notice_days');
  const basis = (input.basis ?? 'CALENDAR_DAYS') as ClaimPeriodBasis;
  if (!CLAIM_PERIOD_BASES.includes(basis)) throw invalid('basis');
  const particularsFrom = (input.particulars_from ?? 'NOTICE') as ParticularsFrom;
  if (!PARTICULARS_FROM.includes(particularsFrom)) throw invalid('particulars_from');
  const barEffect = (input.bar_effect ?? 'NOT_STATED') as BarEffect;
  if (!BAR_EFFECTS.includes(barEffect)) throw invalid('bar_effect');
  if ((barEffect === 'BARS_CLAIM' || barEffect === 'REDUCES_RELIEF') && noticeDays === null && particularsDays === null) throw invalid('bar_effect');
  if (particularsFrom === 'NOTICE' && particularsDays !== null && noticeDays === null) throw invalid('particulars_from');
  const clause = typeof input.clause_reference === 'string' ? input.clause_reference.trim() : '';
  if (clause.length < 3 || clause.length > MAX_CLAUSE_REFERENCE) throw invalid('clause_reference');
  return { claimantSide: input.claimant_side, noticeDays, particularsDays, responseDays, settlementDays, basis, particularsFrom, barEffect, clauseReference: clause };
}

/** The numbers of the term as the rule `CLAIM_TERM_TEMPLATE` and the screens read them (snake case, an absent period is left out). */
export function claimTermParams(term: ClaimTerm): Record<string, unknown> {
  const params: Record<string, unknown> = { basis: term.basis, particulars_from: term.particularsFrom, bar_effect: term.barEffect };
  if (term.noticeDays !== null) params.notice_days = term.noticeDays;
  if (term.particularsDays !== null) params.particulars_days = term.particularsDays;
  if (term.responseDays !== null) params.response_days = term.responseDays;
  if (term.settlementDays !== null) params.settlement_days = term.settlementDays;
  return params;
}

// -- The policy -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the alert centre uses (rule `CLAIM_POLICY`, code `DEFAULT`): how many days before a deadline it is shown as approaching. These are the register's own working numbers, not periods of any contract. */
export interface ClaimPolicy {
  /** A limitation date (notice, particulars) is "approaching" this many calendar days before its day. */
  approachDays: number;
  /** A response the owner owes, or a settlement, is "due soon" this many calendar days before its day. */
  responseApproachDays: number;
}

export const CLAIM_POLICY_DEFAULTS: ClaimPolicy = { approachDays: 7, responseApproachDays: 3 };
export const CLAIM_POLICY_RULE_TYPE = 'CLAIM_POLICY';
export const CLAIM_POLICY_DEFAULT_CODE = 'DEFAULT';
export const CLAIM_TERM_TEMPLATE_RULE_TYPE = 'CLAIM_TERM_TEMPLATE';

export function parseClaimPolicy(raw: unknown): ClaimPolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'params');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (key !== 'approach_days' && key !== 'response_approach_days') throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, key);
  const approach = input.approach_days;
  const response = input.response_approach_days;
  if (typeof approach !== 'number' || !Number.isInteger(approach) || approach < 1 || approach > 90) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'approach_days');
  if (typeof response !== 'number' || !Number.isInteger(response) || response < 1 || response > 90) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'response_approach_days');
  return { approachDays: approach, responseApproachDays: response };
}

// -- Deadlines --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const DEADLINE_CODES = ['NOTICE', 'PARTICULARS', 'RESPONSE', 'SETTLEMENT'] as const;
export type DeadlineCode = (typeof DEADLINE_CODES)[number];

/**
 * `NOT_DEFINED`: the contract gives no period for it (or the contract has no approved term); `NOT_STARTED`: what starts it has not happened; `NOT_APPLICABLE`: the claim ended without it;
 * `CALENDAR_UNAVAILABLE`: counted in working days and a year is not published.
 */
export type DeadlineState = 'NOT_DEFINED' | 'NOT_STARTED' | 'NOT_APPLICABLE' | 'CALENDAR_UNAVAILABLE' | 'RUNNING' | 'APPROACHING' | 'MET' | 'MET_LATE' | 'MISSED';

export interface Deadline {
  code: DeadlineCode;
  state: DeadlineState;
  startedOn: string | null;
  dueOn: string | null;
  doneOn: string | null;
  /** Calendar days from today to the due day (negative: days past it); null when there is no due day or it is done. */
  daysLeft: number | null;
  /** The period the term gives, and how it is counted. */
  periodDays: number | null;
  basis: ClaimPeriodBasis | null;
  /** Who owes the step: the claimant (notice, particulars), the other side (response) or both (settlement). */
  owedBy: 'CLAIMANT' | 'RECEIVER' | 'BOTH';
  /** The side of the register keeper owes it (the owner owes a response to a contractor claim and the notice of its own claims). */
  owedByOwner: boolean;
}

/** What the claim has done so far, as dates; the register keeper reads them off the steps. */
export interface ClaimFacts {
  claimantSide: ClaimSide;
  status: ContractClaimStatus;
  /** The day the claimant became aware of the event: the day the notice limit counts from. */
  awarenessOn: string;
  noticeOn: string | null;
  /** The first and the latest day the claim was detailed. */
  particularsOn: string | null;
  lastParticularsOn: string | null;
  /** The latest response, and its decision. */
  responseOn: string | null;
  responseDecision: ResponseDecision | null;
  /** The day of the latest response that accepted the claim in whole or in part: the settlement limit counts from it. */
  acceptedOn: string | null;
  settledOn: string | null;
}

const BAR_BEARING: readonly DeadlineCode[] = ['NOTICE', 'PARTICULARS'];
const OWED_BY: Readonly<Record<DeadlineCode, Deadline['owedBy']>> = { NOTICE: 'CLAIMANT', PARTICULARS: 'CLAIMANT', RESPONSE: 'RECEIVER', SETTLEMENT: 'BOTH' };

/** The day a count of `days` from `start` ends; `undefined` when working days are counted and the calendar of a year in between is not published. */
export function claimDueOn(calendars: WorkCalendarSource | undefined, start: string, days: number, basis: ClaimPeriodBasis): string | undefined {
  if (!isDay(start)) throw invalid('start');
  return basis === 'WORKING_DAYS' ? addWorkingDays(calendars, start, days) : addDaysTo(start, days);
}

function deadlineOf(
  code: DeadlineCode,
  term: ClaimTerm,
  claimantSide: ClaimSide,
  period: number | null,
  startedOn: string | null,
  doneOn: string | null,
  closed: boolean,
  today: string,
  approachDays: number,
  calendars: WorkCalendarSource | undefined,
): Deadline {
  const owedBy = OWED_BY[code];
  const owedByOwner = owedBy === 'BOTH' || (owedBy === 'CLAIMANT' && claimantSide === 'OWNER') || (owedBy === 'RECEIVER' && claimantSide === 'CONTRACTOR');
  const shell = { code, startedOn, doneOn, periodDays: period, basis: period === null ? null : term.basis, owedBy, owedByOwner };
  if (period === null) return { ...shell, state: 'NOT_DEFINED', dueOn: null, daysLeft: null };
  if (startedOn === null) return { ...shell, state: closed && doneOn === null ? 'NOT_APPLICABLE' : 'NOT_STARTED', dueOn: null, daysLeft: null };
  const dueOn = claimDueOn(calendars, startedOn, period, term.basis);
  if (dueOn === undefined) return { ...shell, state: 'CALENDAR_UNAVAILABLE', dueOn: null, daysLeft: null };
  if (doneOn !== null) return { ...shell, state: doneOn <= dueOn ? 'MET' : 'MET_LATE', dueOn, daysLeft: null };
  const daysLeft = daysBetweenDays(today, dueOn);
  if (closed) return { ...shell, state: 'NOT_APPLICABLE', dueOn, daysLeft: null };
  const state: DeadlineState = daysLeft < 0 ? 'MISSED' : daysLeft <= approachDays ? 'APPROACHING' : 'RUNNING';
  return { ...shell, state, dueOn, daysLeft };
}

const noTerm = (code: DeadlineCode, claimantSide: ClaimSide): Deadline => {
  const owedBy = OWED_BY[code];
  return { code, state: 'NOT_DEFINED', startedOn: null, dueOn: null, doneOn: null, daysLeft: null, periodDays: null, basis: null, owedBy, owedByOwner: owedBy === 'BOTH' || (owedBy === 'CLAIMANT' && claimantSide === 'OWNER') || (owedBy === 'RECEIVER' && claimantSide === 'CONTRACTOR') };
};

/**
 * The four deadlines of a claim by the term of its contract and what the claim has done. The notice runs from the day of awareness; the particulars from awareness or from the notice (as the term says); the
 * response from the latest detailed submission (from the notice when the term gives no particulars period); the settlement from the latest response that accepted. A claim without a term has all four `NOT_DEFINED`.
 */
export function claimDeadlines(facts: ClaimFacts, term: ClaimTerm | null, today: string, approachDays: number, calendars: WorkCalendarSource | undefined): Record<DeadlineCode, Deadline> {
  if (term === null) return { NOTICE: noTerm('NOTICE', facts.claimantSide), PARTICULARS: noTerm('PARTICULARS', facts.claimantSide), RESPONSE: noTerm('RESPONSE', facts.claimantSide), SETTLEMENT: noTerm('SETTLEMENT', facts.claimantSide) };
  const closed = !isClaimOpen(facts.status);
  const make = (code: DeadlineCode, period: number | null, startedOn: string | null, doneOn: string | null): Deadline => deadlineOf(code, term, facts.claimantSide, period, startedOn, doneOn, closed, today, approachDays, calendars);
  const particularsStart = term.particularsFrom === 'AWARENESS' ? facts.awarenessOn : facts.noticeOn;
  // The response clock starts when the claim is complete as far as the term asks: detailed when the term gives a particulars period, else with the notice.
  const submissionOn = term.particularsDays === null ? facts.noticeOn : facts.lastParticularsOn;
  const responseDone = facts.responseOn !== null && submissionOn !== null && facts.responseOn >= submissionOn ? facts.responseOn : null;
  return {
    NOTICE: make('NOTICE', term.noticeDays, facts.awarenessOn, facts.noticeOn),
    PARTICULARS: make('PARTICULARS', term.particularsDays, particularsStart, facts.particularsOn),
    RESPONSE: make('RESPONSE', term.responseDays, submissionOn, responseDone),
    SETTLEMENT: make('SETTLEMENT', term.settlementDays, facts.acceptedOn, facts.settledOn),
  };
}

/** Where a claim stands against the limits of its contract. `MISSED`: a notice or particulars day passed without the step (the register says so; whether the claim is lost is a decision, `BARRED`). */
export type LimitationStatus = 'NO_TERM' | 'NOT_DEFINED' | 'CALENDAR_UNAVAILABLE' | 'RUNNING' | 'APPROACHING' | 'MISSED' | 'MET' | 'MET_LATE' | 'BARRED' | 'CLOSED';

export interface Limitation {
  status: LimitationStatus;
  /** The earliest limitation date still ahead (or the earliest one missed), and which step it is. */
  dueOn: string | null;
  code: DeadlineCode | null;
  daysLeft: number | null;
  barEffect: BarEffect | null;
  /** The limitation steps whose day passed without the step. */
  missed: DeadlineCode[];
}

/** The limitation of a claim: only notice and particulars carry a bar, so only they count. */
export function claimLimitation(status: ContractClaimStatus, term: ClaimTerm | null, deadlines: Record<DeadlineCode, Deadline>): Limitation {
  const barEffect = term === null ? null : term.barEffect;
  if (status === 'TIME_BARRED') return { status: 'BARRED', dueOn: null, code: null, daysLeft: null, barEffect, missed: BAR_BEARING.filter((code) => deadlines[code].state === 'MISSED' || deadlines[code].state === 'MET_LATE') };
  if (term === null) return { status: 'NO_TERM', dueOn: null, code: null, daysLeft: null, barEffect, missed: [] };
  const bearing = BAR_BEARING.map((code) => deadlines[code]);
  const missed = bearing.filter((deadline) => deadline.state === 'MISSED').map((deadline) => deadline.code);
  const live = bearing.filter((deadline) => deadline.state === 'RUNNING' || deadline.state === 'APPROACHING' || deadline.state === 'MISSED').sort((left, right) => (left.dueOn ?? '').localeCompare(right.dueOn ?? ''));
  const first = live[0] ?? null;
  const shell = { dueOn: first?.dueOn ?? null, code: first?.code ?? null, daysLeft: first?.daysLeft ?? null, barEffect, missed };
  if (bearing.every((deadline) => deadline.state === 'NOT_DEFINED')) return { ...shell, status: 'NOT_DEFINED' };
  if (missed.length > 0) return { ...shell, status: 'MISSED' };
  if (!isClaimOpen(status) && first === null) return { ...shell, status: bearing.some((deadline) => deadline.state === 'MET_LATE') ? 'MET_LATE' : 'CLOSED' };
  if (bearing.some((deadline) => deadline.state === 'CALENDAR_UNAVAILABLE')) return { ...shell, status: 'CALENDAR_UNAVAILABLE' };
  if (live.some((deadline) => deadline.state === 'APPROACHING')) return { ...shell, status: 'APPROACHING' };
  if (live.length > 0) return { ...shell, status: 'RUNNING' };
  return { ...shell, status: bearing.some((deadline) => deadline.state === 'MET_LATE') ? 'MET_LATE' : 'MET' };
}

// -- Alerts -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const CLAIM_ALERT_KINDS = ['CLAIM_LIMITATION_APPROACHING', 'CLAIM_LIMITATION_MISSED', 'CLAIM_RESPONSE_DUE', 'CLAIM_SETTLEMENT_OVERDUE'] as const;
export type ClaimAlertKind = (typeof CLAIM_ALERT_KINDS)[number];

export interface ClaimAlert {
  kind: ClaimAlertKind;
  /** The facet the severity rules read: `APPROACHING`, `MISSED`, `DUE_SOON`, `OVERDUE`. */
  facet: 'APPROACHING' | 'MISSED' | 'DUE_SOON' | 'OVERDUE';
  code: DeadlineCode;
  dueOn: string;
  /** Whether the step is the register keeper's to take (the owner owes it). */
  owedByOwner: boolean;
}

/**
 * The alerts of an open claim. A limitation date the owner owes (its own claim) is shown from `approach_days` before it and as URGENT once it is missed; a limitation date the contractor owes is shown only
 * once it is missed (the owner must decide what the missed notice means: record it as late, or declare the claim barred) and never before. A response the owner owes to a contractor claim is shown from
 * `response_approach_days` before it and, once past, as overdue; a settlement past its day is overdue for both. A closed claim, a claim without a term and a deadline without a due day raise nothing.
 */
export function claimAlerts(status: ContractClaimStatus, deadlines: Record<DeadlineCode, Deadline>, policy: Pick<ClaimPolicy, 'responseApproachDays'>): ClaimAlert[] {
  if (!isClaimOpen(status)) return [];
  const alerts: ClaimAlert[] = [];
  for (const code of BAR_BEARING) {
    const deadline = deadlines[code];
    if (deadline.dueOn === null) continue;
    if (deadline.state === 'MISSED') alerts.push({ kind: 'CLAIM_LIMITATION_MISSED', facet: 'MISSED', code, dueOn: deadline.dueOn, owedByOwner: deadline.owedByOwner });
    else if (deadline.state === 'APPROACHING' && deadline.owedByOwner) alerts.push({ kind: 'CLAIM_LIMITATION_APPROACHING', facet: 'APPROACHING', code, dueOn: deadline.dueOn, owedByOwner: true });
  }
  const response = deadlines.RESPONSE;
  if (response.dueOn !== null && response.owedByOwner) {
    if (response.state === 'MISSED') alerts.push({ kind: 'CLAIM_RESPONSE_DUE', facet: 'OVERDUE', code: 'RESPONSE', dueOn: response.dueOn, owedByOwner: true });
    else if ((response.state === 'APPROACHING' || response.state === 'RUNNING') && response.daysLeft !== null && response.daysLeft <= policy.responseApproachDays) alerts.push({ kind: 'CLAIM_RESPONSE_DUE', facet: 'DUE_SOON', code: 'RESPONSE', dueOn: response.dueOn, owedByOwner: true });
  }
  const settlement = deadlines.SETTLEMENT;
  if (settlement.dueOn !== null && settlement.state === 'MISSED') alerts.push({ kind: 'CLAIM_SETTLEMENT_OVERDUE', facet: 'OVERDUE', code: 'SETTLEMENT', dueOn: settlement.dueOn, owedByOwner: true });
  return alerts;
}

// -- The state machine of a claim -----------------------------------------------------------------------------------------------------------------------------------------------------------

/** What a step may be recorded from, and where it leads. A step that is not on the table is 409 `CTR_CLAIM_STATE_INVALID`. */
const MOVES: Readonly<Record<ContractClaimStatus, Readonly<Partial<Record<ClaimStepKind, ContractClaimStatus>>>>> = {
  EVENT_RECORDED: { NOTICE: 'NOTICE_SERVED', WITHDRAWAL: 'WITHDRAWN', BAR_DECLARED: 'TIME_BARRED' },
  NOTICE_SERVED: { PARTICULARS: 'PARTICULARS_SUBMITTED', RESPONSE: 'RESPONDED', WITHDRAWAL: 'WITHDRAWN', BAR_DECLARED: 'TIME_BARRED' },
  PARTICULARS_SUBMITTED: { PARTICULARS: 'PARTICULARS_SUBMITTED', RESPONSE: 'RESPONDED', WITHDRAWAL: 'WITHDRAWN', BAR_DECLARED: 'TIME_BARRED' },
  RESPONDED: { PARTICULARS: 'PARTICULARS_SUBMITTED', SETTLEMENT_PROPOSAL: 'SETTLEMENT_PROPOSED', REFERRAL: 'REFERRED', WITHDRAWAL: 'WITHDRAWN', BAR_DECLARED: 'TIME_BARRED' },
  SETTLEMENT_PROPOSED: { SETTLEMENT_APPROVED: 'SETTLED', SETTLEMENT_REJECTED: 'RESPONDED', WITHDRAWAL: 'WITHDRAWN' },
  SETTLED: {},
  WITHDRAWN: {},
  REFERRED: {},
  TIME_BARRED: {},
};

/**
 * Where a step takes a claim. After a response, the claim can be detailed again only when the response asked for more information, can go to settlement only when the response accepted it (in whole or in part)
 * and can be referred only when it was refused (in whole or in part).
 */
export function claimNextStatus(status: ContractClaimStatus, step: ClaimStepKind, lastDecision: ResponseDecision | null): ContractClaimStatus {
  const next = MOVES[status][step];
  if (next === undefined) throw new DomainError('CTR_CLAIM_STATE_INVALID', 409, step);
  if (status === 'RESPONDED') {
    if (step === 'PARTICULARS' && lastDecision !== 'MORE_INFORMATION_REQUESTED') throw new DomainError('CTR_CLAIM_STATE_INVALID', 409, step);
    if (step === 'SETTLEMENT_PROPOSAL' && lastDecision !== 'ACCEPTED' && lastDecision !== 'PARTLY_ACCEPTED') throw new DomainError('CTR_CLAIM_STATE_INVALID', 409, step);
    if (step === 'REFERRAL' && lastDecision !== 'REJECTED' && lastDecision !== 'PARTLY_ACCEPTED') throw new DomainError('CTR_CLAIM_STATE_INVALID', 409, step);
  }
  return next;
}

/** The steps a person may record from a state (what the screen offers). */
export function claimAllowedSteps(status: ContractClaimStatus, lastDecision: ResponseDecision | null): ClaimStepKind[] {
  return (Object.keys(MOVES[status]) as ClaimStepKind[]).filter((step) => {
    try {
      claimNextStatus(status, step, lastDecision);
      return true;
    } catch {
      return false;
    }
  });
}

// -- Judging what a person records ------------------------------------------------------------------------------------------------------------------------------------------------------------

const AMOUNT = /^(0|[1-9]\d{0,22})$/;

/** A whole amount in VND, written as a decimal string (never a float); null when none is given. */
export function claimAmountOf(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !AMOUNT.test(value)) throw invalid(field);
  return value;
}

export function claimDaysOf(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_CLAIM_DAYS) throw invalid(field);
  return value;
}

export function claimTextOf(value: unknown, field: string, max: number = MAX_CLAIM_TEXT): string {
  if (typeof value !== 'string') throw invalid(field);
  const trimmed = value.trim();
  if (trimmed.length < MIN_CLAIM_TEXT || trimmed.length > max) throw invalid(field);
  return trimmed;
}

export interface NewClaimInput {
  claimantSide: unknown;
  kind: unknown;
  title: unknown;
  eventDescription: unknown;
  eventOn: unknown;
  awarenessOn: unknown;
  claimedAmountVnd?: unknown;
  claimedDays?: unknown;
}

export interface NewClaim {
  claimantSide: ClaimSide;
  kind: ClaimKind;
  title: string;
  eventDescription: string;
  eventOn: string;
  awarenessOn: string;
  claimedAmountVnd: string | null;
  claimedDays: number | null;
}

/** Judges a new claim: a side and a kind that go together, the day of the event and the day of awareness (not in the future, awareness not before the event), and the amount and days if known. */
export function validateNewClaim(input: NewClaimInput, today: string): NewClaim {
  if (!isClaimSide(input.claimantSide)) throw invalid('claimant_side');
  if (!claimKindAllowed(input.claimantSide, input.kind)) throw invalid('kind');
  if (!isDay(input.eventOn) || input.eventOn > today) throw invalid('event_on');
  if (!isDay(input.awarenessOn) || input.awarenessOn > today || input.awarenessOn < input.eventOn) throw invalid('awareness_on');
  return {
    claimantSide: input.claimantSide,
    kind: input.kind,
    title: claimTextOf(input.title, 'title', MAX_CLAIM_TITLE),
    eventDescription: claimTextOf(input.eventDescription, 'event_description'),
    eventOn: input.eventOn,
    awarenessOn: input.awarenessOn,
    claimedAmountVnd: claimAmountOf(input.claimedAmountVnd, 'claimed_amount_vnd'),
    claimedDays: claimDaysOf(input.claimedDays, 'claimed_days'),
  };
}

export interface ClaimStepInput {
  kind: unknown;
  occurredOn: unknown;
  note: unknown;
  /** RESPONSE only. */
  decision?: unknown;
  /** PARTICULARS and SETTLEMENT_PROPOSAL carry the figures. */
  claimedAmountVnd?: unknown;
  claimedDays?: unknown;
  settledAmountVnd?: unknown;
  grantedDays?: unknown;
}

export interface ClaimStepFigures {
  claimedAmountVnd: string | null;
  claimedDays: number | null;
  settledAmountVnd: string | null;
  grantedDays: number | null;
}

export interface RecordedStep {
  kind: RecordedStepKind;
  occurredOn: string;
  note: string;
  decision: ResponseDecision | null;
  figures: ClaimStepFigures;
}

/** What the claim holds before the step (to check the day and the figures against). */
export interface ClaimBefore {
  awarenessOn: string;
  /** The day of the latest step of the timeline. */
  lastStepOn: string;
  claimedAmountVnd: string | null;
  claimedDays: number | null;
}

/**
 * Judges a recorded step: a kind of those a person records, a day that is real, not in the future, not before awareness and not before the latest step (a timeline never runs backwards), words, a decision for a
 * response, and the figures where the step carries them (a settlement is at least one of an amount or days and never more than the claim asks for).
 */
export function validateRecordedStep(input: ClaimStepInput, before: ClaimBefore, today: string): RecordedStep {
  if (!RECORDED_STEP_KINDS.includes(input.kind as RecordedStepKind)) throw invalid('kind');
  const kind = input.kind as RecordedStepKind;
  if (!isDay(input.occurredOn) || input.occurredOn > today || input.occurredOn < before.awarenessOn || input.occurredOn < before.lastStepOn) throw invalid('occurred_on');
  const note = claimTextOf(input.note, 'note');
  let decision: ResponseDecision | null = null;
  if (kind === 'RESPONSE') {
    if (!RESPONSE_DECISIONS.includes(input.decision as ResponseDecision)) throw invalid('decision');
    decision = input.decision as ResponseDecision;
  } else if (input.decision !== undefined && input.decision !== null) throw invalid('decision');
  const figures: ClaimStepFigures = { claimedAmountVnd: null, claimedDays: null, settledAmountVnd: null, grantedDays: null };
  if (kind === 'PARTICULARS') {
    figures.claimedAmountVnd = claimAmountOf(input.claimedAmountVnd, 'claimed_amount_vnd');
    figures.claimedDays = claimDaysOf(input.claimedDays, 'claimed_days');
  } else if (kind === 'SETTLEMENT_PROPOSAL') {
    figures.settledAmountVnd = claimAmountOf(input.settledAmountVnd, 'settled_amount_vnd');
    figures.grantedDays = claimDaysOf(input.grantedDays, 'granted_days');
    if (figures.settledAmountVnd === null && figures.grantedDays === null) throw invalid('settled_amount_vnd');
    assertSettlementWithinClaim(figures, before.claimedAmountVnd, before.claimedDays);
  } else if ([input.claimedAmountVnd, input.claimedDays, input.settledAmountVnd, input.grantedDays].some((value) => value !== undefined && value !== null)) throw invalid('claimed_amount_vnd');
  return { kind, occurredOn: input.occurredOn, note, decision, figures };
}

/** A settlement never grants more than the claim asks for, in money or in days (422 `CLAIM_SETTLEMENT_EXCEEDS_CLAIM`); a figure the claim never stated is not a limit. */
export function assertSettlementWithinClaim(figures: Pick<ClaimStepFigures, 'settledAmountVnd' | 'grantedDays'>, claimedAmountVnd: string | null, claimedDays: number | null): void {
  if (figures.settledAmountVnd !== null && claimedAmountVnd !== null && compareDecimal(figures.settledAmountVnd, claimedAmountVnd) > 0) throw new DomainError('CLAIM_SETTLEMENT_EXCEEDS_CLAIM', 422, 'settled_amount_vnd');
  if (figures.grantedDays !== null && claimedDays !== null && figures.grantedDays > claimedDays) throw new DomainError('CLAIM_SETTLEMENT_EXCEEDS_CLAIM', 422, 'granted_days');
}

/** The approval of a settlement is by somebody other than the person who proposed it (403 `SELF_APPROVAL_DENIED`). */
export function assertSettlementDecider(proposedBy: string, actor: string): void {
  assertFourEyes(proposedBy, actor);
}

/** A claim is declared barred by somebody other than the person who registered it (403 `SELF_APPROVAL_DENIED`): a loss of right is not decided by the one who keeps the file. */
export function assertBarDecider(registeredBy: string, actor: string): void {
  assertFourEyes(registeredBy, actor);
}

/**
 * A bar is declared only when a limitation day has actually passed AND the term says that missing it bars the claim (409 `CLAIM_BAR_NOT_DUE`): the register never invents a bar, and a clause that only reduces the relief
 * or says nothing about the effect gives no ground for declaring the claim lost.
 */
export function assertBarDeclarable(limitation: Limitation): void {
  if (limitation.status !== 'MISSED' || limitation.missed.length === 0) throw new DomainError('CLAIM_BAR_NOT_DUE', 409, 'limitation');
  if (limitation.barEffect !== 'BARS_CLAIM') throw new DomainError('CLAIM_BAR_NOT_DUE', 409, 'bar_effect');
}

// -- Report hooks (CA-3 reads these; the reports themselves are another lane) -----------------------------------------------------------------------------------------------------------

/** One claim as a report reads it: the facts of its timeline, the term it is bound to and the figures. */
export interface ClaimReportInput {
  id: string;
  code: string;
  contractId: string;
  contractCode: string;
  title: string;
  kind: ClaimKind;
  facts: ClaimFacts;
  term: ClaimTerm | null;
  claimedAmountVnd: string | null;
  settledAmountVnd: string | null;
  claimedDays: number | null;
  grantedDays: number | null;
}

export interface ClaimReportRow extends ClaimReportInput {
  deadlines: Record<DeadlineCode, Deadline>;
  limitation: Limitation;
  open: boolean;
}

export interface ClaimReportTotals {
  count: number;
  open: number;
  byStatus: Record<ContractClaimStatus, number>;
  bySide: Record<ClaimSide, number>;
  byLimitation: Record<LimitationStatus, number>;
  /** Exact decimal strings in VND: what the claims ask for, what is settled, and what is still asked for by open claims. */
  claimedVnd: string;
  settledVnd: string;
  openClaimedVnd: string;
  /** Sum of days asked and granted. */
  claimedDays: number;
  grantedDays: number;
  /** Claims without an approved term: the register cannot say when they are time-barred. */
  withoutTerm: number;
}

const zeroCounts = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
export const LIMITATION_STATUSES: readonly LimitationStatus[] = ['NO_TERM', 'NOT_DEFINED', 'CALENDAR_UNAVAILABLE', 'RUNNING', 'APPROACHING', 'MISSED', 'MET', 'MET_LATE', 'BARRED', 'CLOSED'];

/** Reads each claim against its term on `today` (the deadlines and the limitation), and adds the register up: counts by state, side and limitation, and the money and days asked and granted. */
export function claimRegisterReport(inputs: readonly ClaimReportInput[], today: string, policy: Pick<ClaimPolicy, 'approachDays'>, calendars: WorkCalendarSource | undefined): { rows: ClaimReportRow[]; totals: ClaimReportTotals } {
  const totals: ClaimReportTotals = {
    count: 0,
    open: 0,
    byStatus: zeroCounts(CONTRACT_CLAIM_STATUSES),
    bySide: zeroCounts(CLAIM_SIDES),
    byLimitation: zeroCounts(LIMITATION_STATUSES),
    claimedVnd: '0',
    settledVnd: '0',
    openClaimedVnd: '0',
    claimedDays: 0,
    grantedDays: 0,
    withoutTerm: 0,
  };
  const rows = inputs.map((input): ClaimReportRow => {
    const deadlines = claimDeadlines(input.facts, input.term, today, policy.approachDays, calendars);
    const limitation = claimLimitation(input.facts.status, input.term, deadlines);
    const open = isClaimOpen(input.facts.status);
    totals.count += 1;
    if (open) totals.open += 1;
    totals.byStatus[input.facts.status] += 1;
    totals.bySide[input.facts.claimantSide] += 1;
    totals.byLimitation[limitation.status] += 1;
    if (input.term === null) totals.withoutTerm += 1;
    if (input.claimedAmountVnd !== null) {
      totals.claimedVnd = addDecimal(totals.claimedVnd, input.claimedAmountVnd);
      if (open) totals.openClaimedVnd = addDecimal(totals.openClaimedVnd, input.claimedAmountVnd);
    }
    if (input.settledAmountVnd !== null && input.facts.status === 'SETTLED') totals.settledVnd = addDecimal(totals.settledVnd, input.settledAmountVnd);
    totals.claimedDays += input.claimedDays ?? 0;
    if (input.facts.status === 'SETTLED') totals.grantedDays += input.grantedDays ?? 0;
    return { ...input, deadlines, limitation, open };
  });
  return { rows, totals };
}

export interface LimitationHorizonItem {
  claimId: string;
  claimCode: string;
  contractId: string;
  contractCode: string;
  claimantSide: ClaimSide;
  code: DeadlineCode;
  dueOn: string;
  /** Calendar days from today (negative: past). */
  daysLeft: number;
  state: DeadlineState;
  barEffect: BarEffect | null;
}

/**
 * The time-barred dates ahead (and the ones just missed), earliest first: for every open claim with a term, its notice and particulars days that are not yet done, up to `withinDays` ahead of `today`
 * (a missed day is always listed). The list a report of limitation is built on; a claim without a term has no date and is counted in `claimRegisterReport` as `withoutTerm`.
 */
export function limitationHorizon(rows: readonly ClaimReportRow[], today: string, withinDays: number): LimitationHorizonItem[] {
  const items: LimitationHorizonItem[] = [];
  for (const row of rows) {
    if (!row.open) continue;
    for (const code of BAR_BEARING) {
      const deadline = row.deadlines[code];
      if (deadline.dueOn === null || deadline.daysLeft === null) continue;
      if (deadline.state !== 'RUNNING' && deadline.state !== 'APPROACHING' && deadline.state !== 'MISSED') continue;
      if (deadline.daysLeft > withinDays) continue;
      items.push({ claimId: row.id, claimCode: row.code, contractId: row.contractId, contractCode: row.contractCode, claimantSide: row.facts.claimantSide, code, dueOn: deadline.dueOn, daysLeft: deadline.daysLeft, state: deadline.state, barEffect: row.term?.barEffect ?? null });
    }
  }
  return items.sort((left, right) => left.dueOn.localeCompare(right.dueOn) || left.claimCode.localeCompare(right.claimCode) || left.code.localeCompare(right.code));
}
