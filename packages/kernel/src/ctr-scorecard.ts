import { DomainError } from './errors.ts';
import { asUuid } from './tenant-context.ts';

/**
 * The scorecard of a contractor and the log of its violations (ST-CTR-014, CTR 3.6, BR-CTR-11, UAT-AC315, UAT-PLAN-17). An evaluation gives five scores from 0 to 100; the overall score is their sum weighted by the rule `CTR.SCORECARD`,
 * rounded to two places, and the rating follows from the thresholds of the rule. A violation is recorded by one person and confirmed by another; a sanction needs a document of decision before it is confirmed. Pure functions of their input.
 */

export const EVALUATION_KINDS = ['PERIODIC', 'COMPLETION', 'TERMINATION'] as const;
export type EvaluationKind = (typeof EVALUATION_KINDS)[number];

export const RATINGS = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR'] as const;
export type Rating = (typeof RATINGS)[number];

export const CRITERIA = ['quality', 'schedule', 'safetyEnv', 'cooperation', 'financial'] as const;
export type Criterion = (typeof CRITERIA)[number];
export type Scores = Readonly<Record<Criterion, number>>;

/**
 * The rule `CTR.SCORECARD` as the tenant has it until the rule engine holds it (R-CTR-05): the weights are whole percents that add up to 100, and the ratings are the thresholds of the overall score, highest first.
 * The thresholds are an assumption awaiting the signature of the business owner (CXN-EXE-01), so the screen says so.
 */
export const SCORECARD_RULE = {
  key: 'CTR.SCORECARD',
  weightsPct: { quality: 30, schedule: 25, safetyEnv: 20, cooperation: 10, financial: 15 } as Scores,
  thresholds: [
    { min: 90, rating: 'EXCELLENT' },
    { min: 75, rating: 'GOOD' },
    { min: 60, rating: 'FAIR' },
  ] as ReadonlyArray<{ min: number; rating: Rating }>,
  awaitingConfirmation: true,
  cxn: 'CXN-EXE-01',
} as const;

export const VIOLATION_KINDS = ['DELAY', 'QUALITY', 'SAFETY', 'ENVIRONMENT', 'FALSE_DOCUMENT', 'ABANDONMENT', 'OTHER'] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];
export const SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const VIOLATION_SOURCES = ['CTR', 'QMS', 'PAY', 'ISS', 'AUD'] as const;
export type ViolationSource = (typeof VIOLATION_SOURCES)[number];
export const PENALTY_KINDS = ['NONE', 'WARNING', 'LIQUIDATED_DAMAGES', 'TERMINATION', 'DEBARMENT_PROPOSAL'] as const;
export type PenaltyKind = (typeof PENALTY_KINDS)[number];

export const PERIOD_LABEL_MAX = 40;
export const TEXT_MAX = 2000;
const AMOUNT_DIGITS_MAX = 24;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
function oneOf<T extends string>(values: readonly T[], raw: unknown, field: string): T {
  const found = values.find((value) => value === raw);
  if (found === undefined) throw invalid(field);
  return found;
}

function text(raw: unknown, field: string, max: number): string {
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (value === '' || value.length > max) throw invalid(field);
  return value;
}

function optionalText(raw: unknown, field: string, max: number): string | undefined {
  return raw === undefined ? undefined : text(raw, field, max);
}

function optionalId(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  const id = asUuid(raw);
  if (id === undefined) throw invalid(field);
  return id;
}

function score(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 100) throw invalid(field);
  return raw;
}

export interface EvaluationInput {
  kind: EvaluationKind;
  periodLabel: string;
  scores: Scores;
  remarks: string | undefined;
}

/** What an evaluation carries: its kind, the period it is for and the five scores. */
export function assertEvaluation(raw: {
  evaluation_kind?: unknown;
  period_label?: unknown;
  score_quality?: unknown;
  score_schedule?: unknown;
  score_safety_env?: unknown;
  score_cooperation?: unknown;
  score_financial?: unknown;
  remarks?: unknown;
}): EvaluationInput {
  return {
    kind: oneOf(EVALUATION_KINDS, raw.evaluation_kind, 'evaluation_kind'),
    periodLabel: text(raw.period_label, 'period_label', PERIOD_LABEL_MAX),
    scores: {
      quality: score(raw.score_quality, 'score_quality'),
      schedule: score(raw.score_schedule, 'score_schedule'),
      safetyEnv: score(raw.score_safety_env, 'score_safety_env'),
      cooperation: score(raw.score_cooperation, 'score_cooperation'),
      financial: score(raw.score_financial, 'score_financial'),
    },
    remarks: optionalText(raw.remarks, 'remarks', TEXT_MAX),
  };
}

/** The overall score in hundredths of a point: the scores times their whole-percent weights add up to exactly this, with no rounding at all. */
export const overallHundredths = (scores: Scores): number => CRITERIA.reduce((sum, criterion) => sum + scores[criterion] * SCORECARD_RULE.weightsPct[criterion], 0);

/** The overall score as the decimal text the table keeps, two places (`80.50`). */
export function overallScoreOf(scores: Scores): string {
  const hundredths = overallHundredths(scores);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

/** The rating of an overall score: the first threshold it reaches, `POOR` below all of them. */
export function ratingOf(scores: Scores): Rating {
  const hundredths = overallHundredths(scores);
  return SCORECARD_RULE.thresholds.find((threshold) => hundredths >= threshold.min * 100)?.rating ?? 'POOR';
}

/** The contract statuses a kind of evaluation may be made in (a contract that was never started has nothing to evaluate). */
export const EVALUATION_STATUSES: Readonly<Record<EvaluationKind, readonly string[]>> = {
  PERIODIC: ['ACTIVE', 'SUSPENDED', 'COMPLETED', 'TERMINATED', 'CLOSED'],
  COMPLETION: ['COMPLETED', 'CLOSED'],
  TERMINATION: ['TERMINATED', 'CLOSED'],
};

export function assertEvaluable(kind: EvaluationKind, contractStatus: string): void {
  if (!EVALUATION_STATUSES[kind].includes(contractStatus)) throw new DomainError('CONTRACT_STATE_INVALID', 409, 'evaluation_kind');
}

/** The contract statuses a violation may be recorded in: any contract that has started. */
export const VIOLATION_STATUSES: readonly string[] = ['ACTIVE', 'SUSPENDED', 'COMPLETED', 'TERMINATED', 'CLOSED'];

export function assertViolable(contractStatus: string): void {
  if (!VIOLATION_STATUSES.includes(contractStatus)) throw new DomainError('CONTRACT_STATE_INVALID', 409, 'id');
}

/** Whoever made an evaluation, or recorded a violation, does not approve or confirm it (403 `SELF_APPROVAL_DENIED`). */
export function assertNotTheAuthor(actor: string, author: string): void {
  if (actor === author) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'id');
}

function calendarDate(raw: unknown, field: string): string {
  const matched = typeof raw === 'string' ? DATE.exec(raw) : null;
  const [year, month, day] = matched === null ? [] : matched.slice(1, 4).map(Number);
  const date = matched === null ? undefined : new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  if (matched === null || date === undefined || date.getUTCFullYear() !== year || date.getUTCMonth() !== (month ?? 0) - 1 || date.getUTCDate() !== day) throw invalid(field);
  return matched[0];
}

export interface ViolationInput {
  kind: ViolationKind;
  severity: Severity;
  occurredOn: string;
  description: string;
  evidenceDocumentVersionId: string | undefined;
  sourceModule: ViolationSource;
  sourceRefId: string | undefined;
}

/**
 * What a violation carries. It happened on a day that is not after `today` (a Vietnam calendar day); one reported by another module names the record it came from, and one written here
 * is its own source. Its words and its evidence are the person's: they are stored, never copied into the trail.
 */
export function assertViolation(
  raw: { violation_kind?: unknown; severity?: unknown; occurred_on?: unknown; description?: unknown; evidence_document_version_id?: unknown; source_module?: unknown; source_ref_id?: unknown },
  today: string,
): ViolationInput {
  const occurredOn = calendarDate(raw.occurred_on, 'occurred_on');
  if (occurredOn > today) throw invalid('occurred_on');
  const sourceModule = raw.source_module === undefined ? 'CTR' : oneOf(VIOLATION_SOURCES, raw.source_module, 'source_module');
  const sourceRefId = optionalId(raw.source_ref_id, 'source_ref_id');
  if (sourceModule !== 'CTR' && sourceRefId === undefined) throw invalid('source_ref_id');
  return {
    kind: oneOf(VIOLATION_KINDS, raw.violation_kind, 'violation_kind'),
    severity: oneOf(SEVERITIES, raw.severity, 'severity'),
    occurredOn,
    description: text(raw.description, 'description', TEXT_MAX),
    evidenceDocumentVersionId: optionalId(raw.evidence_document_version_id, 'evidence_document_version_id'),
    sourceModule,
    sourceRefId,
  };
}

export interface ConfirmationInput {
  penaltyKind: PenaltyKind;
  penaltyAmountVnd: string;
  decisionDocumentVersionId: string | undefined;
}

/**
 * The sanction a violation is confirmed with. An amount is only for liquidated damages, where it is more than zero; every other sanction, and no sanction, carries none (422 on `penalty_amount_vnd`).
 */
export function assertConfirmation(raw: { penalty_kind?: unknown; penalty_amount_vnd?: unknown; decision_document_version_id?: unknown }): ConfirmationInput {
  const penaltyKind = oneOf(PENALTY_KINDS, raw.penalty_kind, 'penalty_kind');
  const amount = raw.penalty_amount_vnd === undefined ? '0' : raw.penalty_amount_vnd;
  if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount) || amount.length > AMOUNT_DIGITS_MAX) throw invalid('penalty_amount_vnd');
  const normalised = amount.replace(/^0+(?=\d)/, '');
  if ((penaltyKind === 'LIQUIDATED_DAMAGES') !== (normalised !== '0')) throw invalid('penalty_amount_vnd');
  return { penaltyKind, penaltyAmountVnd: normalised, decisionDocumentVersionId: optionalId(raw.decision_document_version_id, 'decision_document_version_id') };
}

/** A sanction is confirmed only with the document that decides it (422 `DECISION_DOCUMENT_REQUIRED`); a violation confirmed with no sanction needs none. */
export const needsDecisionDocument = (penaltyKind: PenaltyKind): boolean => penaltyKind !== 'NONE';
