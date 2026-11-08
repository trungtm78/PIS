import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import { EVALUATION_STATUSES, RATINGS } from './ctr-scorecard.ts';
import type { EvaluationKind, Rating } from './ctr-scorecard.ts';
import { newRegisterRow, putRegisterCell, putRegisterContractIdentity, putRegisterFlag } from './ctr-register-reports.ts';
import type { RegisterContract, RegisterRow } from './ctr-register-reports.ts';
import { asUuid } from './tenant-context.ts';
import { nativeClock } from './work-clock.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * The rating of the performance of a contractor on a contract, in the manner of the CPARS of the United States federal government (CA-3, vendor research V4): a SCORE is proposed from the data the system already
 * holds (defects, days late, violations, obstacles, guarantees, payments, audit recoveries), the criteria and their weights are the rule `CONTRACT_PERFORMANCE_RATING` of the governance registry, the contractor is told and
 * has a window to answer (the 20 days of the e-GP rule CONTRACTOR_RESPONSE, counted by the work-clock engine), and a person other than the proposer adopts it into the evaluation of CTR-23. A criterion for which the data
 * do not exist has NO score and a named reason: it is never filled with zero, and an overall score is proposed only when enough criteria have data. Pure.
 */

export const RATING_RULE = 'CONTRACT_PERFORMANCE_RATING';
export const RATING_CRITERIA = ['quality', 'schedule', 'safety_env', 'cooperation', 'financial'] as const;
export type RatingCriterion = (typeof RATING_CRITERIA)[number];

export interface RatingParams {
  weight_quality_pct: number;
  weight_schedule_pct: number;
  weight_safety_env_pct: number;
  weight_cooperation_pct: number;
  weight_financial_pct: number;
  excellent_min: number;
  good_min: number;
  fair_min: number;
  min_criteria: number;
  min_observation_days: number;
  quality_penalty_critical: number;
  quality_penalty_major: number;
  quality_penalty_minor: number;
  quality_penalty_reopen: number;
  quality_closed_weight_pct: number;
  schedule_zero_score_days_late: number;
  safety_penalty_minor: number;
  safety_penalty_major: number;
  safety_penalty_critical: number;
  cooperation_penalty_overdue: number;
  cooperation_penalty_escalated: number;
  financial_guarantee_max_penalty: number;
  financial_overpaid_max_penalty: number;
  financial_audit_max_penalty: number;
}

/** Provisional values to be settled with the business owner and the audit (the weights and the lines are those of the scorecard of CTR-23); not law, flagged unverified on every screen. */
export function ratingDefaults(): RatingParams {
  return {
    weight_quality_pct: 30,
    weight_schedule_pct: 25,
    weight_safety_env_pct: 20,
    weight_cooperation_pct: 10,
    weight_financial_pct: 15,
    excellent_min: 90,
    good_min: 75,
    fair_min: 60,
    min_criteria: 3,
    min_observation_days: 90,
    quality_penalty_critical: 25,
    quality_penalty_major: 10,
    quality_penalty_minor: 3,
    quality_penalty_reopen: 5,
    quality_closed_weight_pct: 30,
    schedule_zero_score_days_late: 90,
    safety_penalty_minor: 5,
    safety_penalty_major: 15,
    safety_penalty_critical: 40,
    cooperation_penalty_overdue: 5,
    cooperation_penalty_escalated: 10,
    financial_guarantee_max_penalty: 30,
    financial_overpaid_max_penalty: 30,
    financial_audit_max_penalty: 20,
  };
}

const PARAM_KEYS = Object.keys(ratingDefaults()) as ReadonlyArray<keyof RatingParams>;
const problem = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);

/** The params of the rule, judged: every key is there and no other, whole numbers (the thresholds may have two decimals), the weights add up to 100 and the lines of the ratings go down. */
export function ratingParams(raw: unknown): RatingParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw problem('params');
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !(PARAM_KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) throw problem(unknown);
  for (const key of PARAM_KEYS) {
    const value = record[key];
    const decimal = key === 'excellent_min' || key === 'good_min' || key === 'fair_min';
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000 || (decimal ? Math.round(value * 100) / 100 !== value : !Number.isInteger(value))) throw problem(key);
  }
  const params = record as unknown as RatingParams;
  const total = params.weight_quality_pct + params.weight_schedule_pct + params.weight_safety_env_pct + params.weight_cooperation_pct + params.weight_financial_pct;
  if (total !== 100) throw problem('weight_quality_pct');
  for (const key of ['excellent_min', 'good_min', 'fair_min'] as const) if (params[key] > 100) throw problem(key);
  if (!(params.excellent_min >= params.good_min && params.good_min >= params.fair_min)) throw problem('good_min');
  if (params.min_criteria < 1 || params.min_criteria > 5) throw problem('min_criteria');
  if (params.schedule_zero_score_days_late < 1) throw problem('schedule_zero_score_days_late');
  if (params.quality_closed_weight_pct > 100) throw problem('quality_closed_weight_pct');
  return { ...params };
}

const WEIGHT: Readonly<Record<RatingCriterion, keyof RatingParams>> = {
  quality: 'weight_quality_pct',
  schedule: 'weight_schedule_pct',
  safety_env: 'weight_safety_env_pct',
  cooperation: 'weight_cooperation_pct',
  financial: 'weight_financial_pct',
};

// ---- the proposal -------------------------------------------------------------------------------------------------------------------------------------------------

export interface RatingInputs {
  asOf: string;
  contractStatus: string;
  signedOn: string | null;
  /** The day the contract ended (completed or terminated), or null while it is open. */
  endedOn: string | null;
  acceptedVnd: string;
  requestedVnd: string;
  paidVnd: string;
  daysLate: number | null;
  daysLateReason: string | null;
  guaranteeRequiredVnd: string | null;
  guaranteeValidVnd: string | null;
  defects: Array<{ severity: string; status: string; reopenCount: number }>;
  obstacles: Array<{ open: boolean; overdue: boolean; escalated: boolean }>;
  /** The confirmed violations of the contract (a violation that was only recorded is not a fact against the contractor). */
  violations: Array<{ kind: string; severity: string }>;
  auditRecommendedVnd: string;
  auditRecoveredVnd: string;
  auditFinancialCount: number;
}

export interface CriterionScore {
  /** A whole number from 0 to 100; null when the data do not exist (never 0). */
  score: number | null;
  reason: string | null;
  /** What the score was made of: the counts and the penalties, for the "i" and the trail. */
  readings: Record<string, number | string>;
}

export interface RatingProposal {
  criteria: Record<RatingCriterion, CriterionScore>;
  covered: number;
  /** The overall score with two decimals; null when fewer criteria than the rule asks have data. */
  overall: string | null;
  overallReason: string | null;
  rating: Rating | null;
  weights: Record<RatingCriterion, number>;
}

const clamp = (value: number): number => Math.max(0, Math.min(100, value));
const DAYS = /^(\d{4})-(\d{2})-(\d{2})/;
const dayNumber = (value: string): number => {
  const found = DAYS.exec(value);
  return found === null ? Number.NaN : Math.round(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])) / 86_400_000);
};
const bigOf = (value: string | null): bigint => (value === null ? 0n : BigInt(value));

/** `max x part / whole`, rounded half up, whole numbers; part is cut to [0, whole]. */
function share(max: number, part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const used = part > whole ? whole : part;
  return Number((BigInt(max) * used * 2n + whole) / (2n * whole));
}

const none = (reason: string, readings: Record<string, number | string> = {}): CriterionScore => ({ score: null, reason, readings });

function observed(inputs: RatingInputs, params: RatingParams): { days: number | null; enough: boolean } {
  if (inputs.signedOn === null) return { days: null, enough: false };
  const until = inputs.endedOn ?? inputs.asOf;
  const days = Math.max(0, dayNumber(until) - dayNumber(inputs.signedOn));
  return { days, enough: days >= params.min_observation_days };
}

const severityPenalty = (severity: string, critical: number, major: number, minor: number): number => (severity === 'CRITICAL' ? critical : severity === 'MAJOR' ? major : minor);

function qualityOf(inputs: RatingInputs, params: RatingParams): CriterionScore {
  if (bigOf(inputs.acceptedVnd) <= 0n && inputs.defects.length === 0) return none('NO_QUALITY_EVIDENCE');
  let penalty = 0;
  let open = 0;
  let closed = 0;
  let reopened = 0;
  for (const defect of inputs.defects) {
    const isOpen = defect.status !== 'VERIFIED' && defect.status !== 'CLOSED';
    const weight = isOpen ? 100 : params.quality_closed_weight_pct;
    penalty += (severityPenalty(defect.severity, params.quality_penalty_critical, params.quality_penalty_major, params.quality_penalty_minor) * weight) / 100;
    penalty += defect.reopenCount * params.quality_penalty_reopen;
    if (isOpen) open += 1;
    else closed += 1;
    reopened += defect.reopenCount;
  }
  const rounded = Math.round(penalty);
  return { score: clamp(100 - rounded), reason: null, readings: { open_defects: open, closed_defects: closed, reopen_total: reopened, penalty: rounded } };
}

function scheduleOf(inputs: RatingInputs, params: RatingParams): CriterionScore {
  if (inputs.daysLate === null) return none(inputs.daysLateReason ?? 'NO_ORIGINAL_DUE_DATE');
  const zero = params.schedule_zero_score_days_late;
  const late = Math.min(inputs.daysLate, zero);
  return { score: clamp(Math.round(((zero - late) * 100) / zero)), reason: null, readings: { days_late: inputs.daysLate, zero_score_at: zero } };
}

function safetyOf(inputs: RatingInputs, params: RatingParams): CriterionScore {
  const seen = observed(inputs, params);
  if (!seen.enough) return none(seen.days === null ? 'NO_OBSERVATION' : 'NOT_ENOUGH_OBSERVATION', { observed_days: seen.days ?? 0, required_days: params.min_observation_days });
  const relevant = inputs.violations.filter((violation) => violation.kind === 'SAFETY' || violation.kind === 'ENVIRONMENT');
  const penalty = relevant.reduce((acc, violation) => acc + severityPenalty(violation.severity, params.safety_penalty_critical, params.safety_penalty_major, params.safety_penalty_minor), 0);
  return { score: clamp(100 - penalty), reason: null, readings: { confirmed_violations: relevant.length, penalty, observed_days: seen.days ?? 0 } };
}

function cooperationOf(inputs: RatingInputs, params: RatingParams): CriterionScore {
  const seen = observed(inputs, params);
  if (!seen.enough) return none(seen.days === null ? 'NO_OBSERVATION' : 'NOT_ENOUGH_OBSERVATION', { observed_days: seen.days ?? 0, required_days: params.min_observation_days });
  const overdue = inputs.obstacles.filter((one) => one.open && one.overdue).length;
  const escalated = inputs.obstacles.filter((one) => one.open && one.escalated).length;
  const penalty = overdue * params.cooperation_penalty_overdue + escalated * params.cooperation_penalty_escalated;
  return { score: clamp(100 - penalty), reason: null, readings: { overdue_obstacles: overdue, escalated_obstacles: escalated, penalty, observed_days: seen.days ?? 0 } };
}

function financialOf(inputs: RatingInputs, params: RatingParams): CriterionScore {
  const required = bigOf(inputs.guaranteeRequiredVnd);
  const accepted = bigOf(inputs.acceptedVnd);
  const hasGuarantee = required > 0n;
  const hasPayments = accepted > 0n || bigOf(inputs.requestedVnd) > 0n;
  const hasAudit = inputs.auditFinancialCount > 0 && bigOf(inputs.auditRecommendedVnd) > 0n;
  if (!hasGuarantee && !hasPayments && !hasAudit) return none('NO_FINANCIAL_EVIDENCE');
  const guarantee = hasGuarantee ? share(params.financial_guarantee_max_penalty, required - bigOf(inputs.guaranteeValidVnd), required) : 0;
  const over = accepted > 0n ? share(params.financial_overpaid_max_penalty, bigOf(inputs.paidVnd) - accepted, accepted) : 0;
  const audit = hasAudit ? share(params.financial_audit_max_penalty, bigOf(inputs.auditRecommendedVnd) - bigOf(inputs.auditRecoveredVnd), bigOf(inputs.auditRecommendedVnd)) : 0;
  return { score: clamp(100 - guarantee - over - audit), reason: null, readings: { guarantee_penalty: guarantee, overpaid_penalty: over, audit_penalty: audit } };
}

/** The suggested kind of evaluation for the status of a contract. */
export const ratingKindOf = (status: string): EvaluationKind => (status === 'COMPLETED' || status === 'CLOSED' ? 'COMPLETION' : status === 'TERMINATED' ? 'TERMINATION' : 'PERIODIC');

/** Whether a contract of this status can be rated at all (the statuses a periodic evaluation may be made in). */
export const isRatableStatus = (status: string): boolean => EVALUATION_STATUSES.PERIODIC.includes(status);

/** The proposal from the data: the score of each criterion that has data, the overall score of those (their weights taken in proportion), and the rating by the lines of the rule. */
export function proposeRating(inputs: RatingInputs, params: RatingParams): RatingProposal {
  const criteria: Record<RatingCriterion, CriterionScore> = {
    quality: qualityOf(inputs, params),
    schedule: scheduleOf(inputs, params),
    safety_env: safetyOf(inputs, params),
    cooperation: cooperationOf(inputs, params),
    financial: financialOf(inputs, params),
  };
  const weights = Object.fromEntries(RATING_CRITERIA.map((criterion) => [criterion, params[WEIGHT[criterion]] as number])) as Record<RatingCriterion, number>;
  const present = RATING_CRITERIA.filter((criterion) => criteria[criterion].score !== null);
  if (present.length < params.min_criteria) return { criteria, covered: present.length, overall: null, overallReason: 'NOT_ENOUGH_CRITERIA', rating: null, weights };
  const weighted = present.reduce((acc, criterion) => acc + (criteria[criterion].score as number) * weights[criterion], 0);
  const whole = present.reduce((acc, criterion) => acc + weights[criterion], 0);
  if (whole === 0) return { criteria, covered: present.length, overall: null, overallReason: 'NOT_ENOUGH_CRITERIA', rating: null, weights };
  const hundredths = Math.floor((weighted * 100 * 2 + whole) / (2 * whole));
  const line = (min: number): boolean => hundredths >= Math.round(min * 100);
  const rating: Rating = line(params.excellent_min) ? 'EXCELLENT' : line(params.good_min) ? 'GOOD' : line(params.fair_min) ? 'FAIR' : 'POOR';
  return { criteria, covered: present.length, overall: `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`, overallReason: null, rating, weights };
}

/** The digest of what a proposal was made from (the inputs and the params), so the same figures are provably the same and a change of data is provably a change. */
export function ratingDigest(inputs: RatingInputs, params: RatingParams): string {
  return createHash('sha256').update(JSON.stringify({ inputs, params })).digest('hex');
}

// ---- the life of a proposal ---------------------------------------------------------------------------------------------------------------------------------

export const RATING_STATES = ['PROPOSED', 'NOTIFIED', 'RESPONDED', 'ADOPTED', 'WITHDRAWN'] as const;
export type RatingState = (typeof RATING_STATES)[number];
export type RatingMove = 'NOTIFY' | 'RESPOND' | 'ADOPT' | 'WITHDRAW';

export interface RatingMoveContext {
  actor: string;
  proposedBy: string;
  now: Date;
  /** The end of the response window; null until the contractor is notified. */
  dueAt: Date | null;
}

/**
 * The next state of a proposal. Whoever proposed it does not notify the contractor and does not adopt it (403 SELF_APPROVAL_DENIED: what leaves the agency under its name is looked at by a second person). The contractor is told
 * once; its answer is taken while the proposal is NOTIFIED (late or not: the lateness is a figure); the proposal is adopted after the answer, or after the window ended with none (409 RATING_RESPONSE_WINDOW_OPEN before that).
 */
export function moveRating(state: RatingState, move: RatingMove, context: RatingMoveContext): RatingState {
  const refuse = (): DomainError => new DomainError('RATING_STATE_INVALID', 409, 'state');
  switch (move) {
    case 'NOTIFY':
      if (state !== 'PROPOSED') throw refuse();
      if (context.actor === context.proposedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'id');
      return 'NOTIFIED';
    case 'RESPOND':
      if (state !== 'NOTIFIED') throw refuse();
      return 'RESPONDED';
    case 'ADOPT':
      if (state !== 'RESPONDED' && state !== 'NOTIFIED') throw refuse();
      if (context.actor === context.proposedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'id');
      if (state === 'NOTIFIED' && (context.dueAt === null || context.now.getTime() <= context.dueAt.getTime())) throw new DomainError('RATING_RESPONSE_WINDOW_OPEN', 409, 'id');
      return 'ADOPTED';
    case 'WITHDRAW':
      if (state !== 'PROPOSED') throw refuse();
      return 'WITHDRAWN';
  }
}

export type ResponseClockStatus = 'RUNNING' | 'NEAR' | 'ANSWERED_IN_TIME' | 'ANSWERED_LATE' | 'LAPSED';

export interface ResponseClock {
  status: ResponseClockStatus;
  dueAt: string;
  basis: 'WORKING_TIME' | 'CALENDAR_UNAVAILABLE';
}

/** The window of the contractor: an answer inside it is on time, one after it is late; with no answer the clock of the work-clock engine says running, near (within the hours given) or lapsed. */
export function ratingResponseClock(input: { notifiedAt: Date; dueAt: Date; respondedAt: Date | null; now: Date; calendars: WorkCalendarSource | undefined; nearWorkingHours?: number }): ResponseClock {
  const due = input.dueAt.toISOString();
  if (input.respondedAt !== null) return { status: input.respondedAt.getTime() <= input.dueAt.getTime() ? 'ANSWERED_IN_TIME' : 'ANSWERED_LATE', dueAt: due, basis: input.calendars === undefined ? 'CALENDAR_UNAVAILABLE' : 'WORKING_TIME' };
  const clock = nativeClock({ startedAt: input.notifiedAt, dueAt: input.dueAt, now: input.now, pauses: [], calendars: input.calendars, nearWorkingHours: input.nearWorkingHours ?? 24 });
  return { status: clock.resolve.state === 'BREACHED' ? 'LAPSED' : clock.near ? 'NEAR' : 'RUNNING', dueAt: clock.resolve.due_at ?? due, basis: clock.basis };
}

// ---- what a command carries ----------------------------------------------------------------------------------------------------------------------------------

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const text = (raw: unknown, field: string, min: number, max: number): string => {
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (value.length < min || value.length > max) throw invalid(field);
  return value;
};
const optionalText = (raw: unknown, field: string, min: number, max: number): string | undefined => (raw === undefined ? undefined : text(raw, field, min, max));
const optionalId = (raw: unknown, field: string): string | undefined => {
  if (raw === undefined) return undefined;
  const id = asUuid(raw);
  if (id === undefined) throw invalid(field);
  return id;
};
const KINDS: readonly string[] = ['PERIODIC', 'COMPLETION', 'TERMINATION'];

export interface RatingProposalInput {
  kind: EvaluationKind | undefined;
  periodLabel: string;
  note: string | undefined;
}

export function assertRatingProposal(raw: { evaluation_kind?: unknown; period_label?: unknown; note?: unknown }): RatingProposalInput {
  if (raw.evaluation_kind !== undefined && (typeof raw.evaluation_kind !== 'string' || !KINDS.includes(raw.evaluation_kind))) throw invalid('evaluation_kind');
  return { kind: raw.evaluation_kind as EvaluationKind | undefined, periodLabel: text(raw.period_label, 'period_label', 1, 40), note: optionalText(raw.note, 'note', 1, 2000) };
}

export interface RatingNotifyInput {
  note: string | undefined;
  letterDocumentVersionId: string | undefined;
}

export const assertRatingNotify = (raw: { note?: unknown; letter_document_version_id?: unknown }): RatingNotifyInput => ({ note: optionalText(raw.note, 'note', 1, 2000), letterDocumentVersionId: optionalId(raw.letter_document_version_id, 'letter_document_version_id') });

export const RESPONSE_KINDS = ['ACCEPT', 'DISPUTE', 'NO_COMMENT'] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

export interface RatingResponseInput {
  kind: ResponseKind;
  text: string | undefined;
  receivedOn: string;
  evidenceDocumentVersionId: string | undefined;
}

/** What the contractor said and when it arrived: a dispute states its grounds (20 characters), the day is not in the future. */
export function assertRatingResponse(raw: { response_kind?: unknown; response_text?: unknown; received_on?: unknown; evidence_document_version_id?: unknown }, today: string): RatingResponseInput {
  const kind = (RESPONSE_KINDS as readonly unknown[]).includes(raw.response_kind) ? (raw.response_kind as ResponseKind) : undefined;
  if (kind === undefined) throw invalid('response_kind');
  const receivedOn = typeof raw.received_on === 'string' && DAYS.test(raw.received_on) && !Number.isNaN(dayNumber(raw.received_on)) ? raw.received_on.slice(0, 10) : undefined;
  if (receivedOn === undefined || receivedOn > today) throw invalid('received_on');
  const words = kind === 'DISPUTE' ? text(raw.response_text, 'response_text', 20, 4000) : optionalText(raw.response_text, 'response_text', 1, 4000);
  return { kind, text: words, receivedOn, evidenceDocumentVersionId: optionalId(raw.evidence_document_version_id, 'evidence_document_version_id') };
}

export interface RatingAdoptInput {
  note: string | undefined;
  overrides: Partial<Record<RatingCriterion, { score: number; reason: string }>>;
}

/** The adoption may fill a criterion that has NO data with a score and its reason (20 characters); it may never replace a score that the data gave. */
export function assertRatingAdoption(raw: { note?: unknown; overrides?: unknown }): RatingAdoptInput {
  const overrides: RatingAdoptInput['overrides'] = {};
  if (raw.overrides !== undefined) {
    if (typeof raw.overrides !== 'object' || raw.overrides === null || Array.isArray(raw.overrides)) throw invalid('overrides');
    for (const [key, value] of Object.entries(raw.overrides as Record<string, unknown>)) {
      if (!(RATING_CRITERIA as readonly string[]).includes(key)) throw invalid(`overrides.${key}`);
      const entry = value as { score?: unknown; reason?: unknown } | null;
      if (typeof entry !== 'object' || entry === null || typeof entry.score !== 'number' || !Number.isInteger(entry.score) || entry.score < 0 || entry.score > 100) throw invalid(`overrides.${key}.score`);
      overrides[key as RatingCriterion] = { score: entry.score, reason: text(entry.reason, `overrides.${key}.reason`, 20, 2000) };
    }
  }
  return { note: optionalText(raw.note, 'note', 1, 2000), overrides };
}

/** The five whole scores of the evaluation of CTR-23 from a proposal: the data-backed ones as they are, a missing one only from an override (422 RATING_INCOMPLETE naming the criterion when it has neither). */
export function adoptionScores(proposal: RatingProposal, overrides: RatingAdoptInput['overrides']): Record<RatingCriterion, number> {
  const scores = {} as Record<RatingCriterion, number>;
  for (const criterion of RATING_CRITERIA) {
    const given = proposal.criteria[criterion].score;
    const override = overrides[criterion];
    if (given !== null && override !== undefined) throw invalid(`overrides.${criterion}`);
    const value = given ?? override?.score;
    if (value === undefined) throw new DomainError('RATING_INCOMPLETE', 422, criterion);
    scores[criterion] = value;
  }
  return scores;
}

// ---- the row of the report ------------------------------------------------------------------------------------------------------------------------------------

export interface RatingProposalSummary {
  id: string;
  state: RatingState;
  kind: EvaluationKind;
  periodLabel: string;
  responseDueAt: string | null;
  respondedAt: string | null;
}

export interface OfficialRating {
  rating: Rating;
  overallScore: string;
}

const SCORE_COLUMN: Readonly<Record<RatingCriterion, string>> = {
  quality: 'score_quality',
  schedule: 'score_schedule',
  safety_env: 'score_safety_env',
  cooperation: 'score_cooperation',
  financial: 'score_financial',
};

/** One row of the rating report: the proposal from the data on the as-of day (the live figures), where the latest stored proposal stands, and the official rating of CTR-23. */
export function ratingRow(contract: RegisterContract, inputs: RatingInputs, params: RatingParams, latest: RatingProposalSummary | null, official: OfficialRating | null, now: Date): RegisterRow {
  const row = newRegisterRow(contract, contract.id);
  putRegisterContractIdentity(row, contract);
  const proposal = proposeRating(inputs, params);
  putRegisterCell(row, 'rating_kind', ratingKindOf(contract.status));
  for (const criterion of RATING_CRITERIA) {
    const found = proposal.criteria[criterion];
    putRegisterCell(row, SCORE_COLUMN[criterion], found.score === null ? null : `${found.score}.00`, found.reason);
  }
  putRegisterCell(row, 'overall_score', proposal.overall, proposal.overallReason);
  putRegisterCell(row, 'proposed_rating', proposal.rating, proposal.overallReason);
  putRegisterCell(row, 'criteria_covered', proposal.covered);
  putRegisterFlag(row, 'scored', proposal.overall !== null, 'NOT_ENOUGH_CRITERIA');
  putRegisterCell(row, 'rating_status', latest?.state ?? 'NONE');
  putRegisterCell(row, 'response_due_on', latest?.responseDueAt === undefined || latest.responseDueAt === null ? null : latest.responseDueAt.slice(0, 10), latest === null ? 'NO_PROPOSAL' : 'NOT_NOTIFIED');
  const open = latest !== null && latest.state === 'NOTIFIED' && latest.responseDueAt !== null;
  const left = open ? Math.floor((Date.parse(latest.responseDueAt as string) - now.getTime()) / 86_400_000) : null;
  putRegisterCell(row, 'response_days_left', left === null || left < 0 ? null : left, latest === null ? 'NO_PROPOSAL' : left !== null ? 'WINDOW_LAPSED' : 'NOT_OPEN');
  const judgedAnswer = latest !== null && latest.responseDueAt !== null && (latest.respondedAt !== null || now.getTime() > Date.parse(latest.responseDueAt));
  putRegisterFlag(row, 'responded_in_time', judgedAnswer ? latest.respondedAt !== null && Date.parse(latest.respondedAt) <= Date.parse(latest.responseDueAt as string) : null, latest === null ? 'NO_PROPOSAL' : 'WINDOW_RUNNING');
  putRegisterCell(row, 'official_rating', official?.rating ?? null, 'NO_PROPOSAL');
  putRegisterCell(row, 'official_score', official?.overallScore ?? null, 'NO_PROPOSAL');
  row.groups.proposed_rating = proposal.rating ?? 'NONE';
  row.groups.rating_status = latest?.state ?? 'NONE';
  return row;
}

export { RATINGS as RATING_LEVELS };
