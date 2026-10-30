import { ApiError } from '@machvon/api-client';

/** Permission of the screen (x-permission in openapi.json). */
export const READ_PERMISSION = 'contractor.performance.read';

export const TEXT_MAX = 2000;
export const PERIOD_MAX = 40;
export const EVALUATION_KINDS = ['PERIODIC', 'COMPLETION', 'TERMINATION'] as const;
export type EvaluationKind = (typeof EVALUATION_KINDS)[number];
export const RATINGS = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR'] as const;
export type Rating = (typeof RATINGS)[number];
export const EVALUATION_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'SUPERSEDED'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];
export const CRITERIA = ['quality', 'schedule', 'safetyEnv', 'cooperation', 'financial'] as const;
export type Criterion = (typeof CRITERIA)[number];
export const VIOLATION_KINDS = ['DELAY', 'QUALITY', 'SAFETY', 'ENVIRONMENT', 'FALSE_DOCUMENT', 'ABANDONMENT', 'OTHER'] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];
export const SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const PENALTY_KINDS = ['NONE', 'WARNING', 'LIQUIDATED_DAMAGES', 'TERMINATION', 'DEBARMENT_PROPOSAL'] as const;
export type PenaltyKind = (typeof PENALTY_KINDS)[number];
export const VIOLATION_STATUSES = ['RECORDED', 'CONFIRMED', 'APPEALED', 'REVOKED'] as const;
export type ViolationStatus = (typeof VIOLATION_STATUSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT = /^[0-9]{1,24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(values: readonly T[], raw: unknown): T | undefined => values.find((value) => value === raw);

export type Scores = Readonly<Record<Criterion, number>>;

export interface Rule {
  key: string;
  weights: Scores;
  thresholds: ReadonlyArray<{ min: number; rating: Rating }>;
  awaitingConfirmation: boolean;
}

export interface ContractOption {
  id: string;
  code: string;
  status: string;
  mayEvaluate: boolean;
  mayRecord: boolean;
}

export interface EvaluationLine {
  id: string;
  contractId: string;
  contractCode: string;
  kind: EvaluationKind;
  periodLabel: string;
  revision: number;
  scores: Scores;
  overallScore: string;
  rating: Rating;
  status: EvaluationStatus;
  remarks: string | undefined;
  approvalNote: string | undefined;
  createdAt: string;
  canApprove: boolean;
  version: number;
}

export interface ViolationLine {
  id: string;
  contractId: string;
  contractCode: string;
  kind: ViolationKind;
  severity: Severity;
  occurredOn: string;
  description: string;
  penaltyKind: PenaltyKind;
  penaltyAmountVnd: string;
  decisionDocumentVersionId: string | undefined;
  status: ViolationStatus;
  canConfirm: boolean;
  version: number;
}

export interface Scorecard {
  contractor: { id: string; legalName: string };
  contracts: ContractOption[];
  evaluations: EvaluationLine[];
  violations: ViolationLine[];
  summary: { approvedCount: number; averageOverallScore: string | undefined; confirmed: Record<Severity, number>; evaluationCount: number; violationCount: number };
  rule: Rule;
}

function toScores(raw: unknown): Scores | undefined {
  if (!isRecord(raw)) return undefined;
  const [quality, schedule, safetyEnv, cooperation, financial] = [raw.quality, raw.schedule, raw.safety_env, raw.cooperation, raw.financial];
  if (![quality, schedule, safetyEnv, cooperation, financial].every((score) => typeof score === 'number')) return undefined;
  return { quality: quality as number, schedule: schedule as number, safetyEnv: safetyEnv as number, cooperation: cooperation as number, financial: financial as number };
}

function toRule(raw: unknown): Rule | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.thresholds)) return undefined;
  const weights = toScores(raw.weights_pct);
  if (weights === undefined) return undefined;
  const thresholds = raw.thresholds.flatMap((threshold) => {
    const rating = isRecord(threshold) ? oneOf(RATINGS, threshold.rating) : undefined;
    return isRecord(threshold) && rating !== undefined && typeof threshold.min === 'number' ? [{ min: threshold.min, rating }] : [];
  });
  return { key: text(raw.key) ?? '', weights, thresholds, awaitingConfirmation: raw.awaiting_confirmation === true };
}

function toEvaluation(raw: unknown): EvaluationLine | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const kind = oneOf(EVALUATION_KINDS, raw.evaluation_kind);
  const rating = oneOf(RATINGS, raw.rating);
  const status = oneOf(EVALUATION_STATUSES, raw.status);
  const scores = toScores(raw.scores);
  if (kind === undefined || rating === undefined || status === undefined || scores === undefined) return undefined;
  return {
    id: raw.id,
    contractId: text(raw.contract_id) ?? '',
    contractCode: text(raw.contract_code) ?? '',
    kind,
    periodLabel: text(raw.period_label) ?? '',
    revision: count(raw.revision),
    scores,
    overallScore: text(raw.overall_score) ?? '0.00',
    rating,
    status,
    remarks: text(raw.remarks),
    approvalNote: text(raw.approval_note),
    createdAt: text(raw.created_at) ?? '',
    canApprove: isRecord(raw.allowed) && raw.allowed.approve === true,
    version: count(raw.version),
  };
}

function toViolation(raw: unknown): ViolationLine | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const kind = oneOf(VIOLATION_KINDS, raw.violation_kind);
  const severity = oneOf(SEVERITIES, raw.severity);
  const penaltyKind = oneOf(PENALTY_KINDS, raw.penalty_kind);
  const status = oneOf(VIOLATION_STATUSES, raw.status);
  if (kind === undefined || severity === undefined || penaltyKind === undefined || status === undefined) return undefined;
  return {
    id: raw.id,
    contractId: text(raw.contract_id) ?? '',
    contractCode: text(raw.contract_code) ?? '',
    kind,
    severity,
    occurredOn: text(raw.occurred_on) ?? '',
    description: text(raw.description) ?? '',
    penaltyKind,
    penaltyAmountVnd: text(raw.penalty_amount_vnd) ?? '0',
    decisionDocumentVersionId: text(raw.decision_document_version_id),
    status,
    canConfirm: isRecord(raw.allowed) && raw.allowed.confirm === true,
    version: count(raw.version),
  };
}

function toContract(raw: unknown): ContractOption | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const allowed = isRecord(raw.allowed) ? raw.allowed : {};
  return { id: raw.id, code: text(raw.code) ?? '', status: text(raw.status) ?? '', mayEvaluate: allowed.evaluate === true, mayRecord: allowed.record_violation === true };
}

export function toScorecard(raw: unknown): Scorecard | undefined {
  if (!isRecord(raw) || !isRecord(raw.contractor) || typeof raw.contractor.id !== 'string' || !Array.isArray(raw.evaluations) || !Array.isArray(raw.violations) || !Array.isArray(raw.contracts)) return undefined;
  const rule = toRule(raw.rule);
  if (rule === undefined) return undefined;
  const summary = isRecord(raw.summary) ? raw.summary : {};
  const confirmed = isRecord(summary.confirmed_violations) ? summary.confirmed_violations : {};
  return {
    contractor: { id: raw.contractor.id, legalName: text(raw.contractor.legal_name) ?? '' },
    contracts: raw.contracts.flatMap((contract) => toContract(contract) ?? []),
    evaluations: raw.evaluations.flatMap((line) => toEvaluation(line) ?? []),
    violations: raw.violations.flatMap((line) => toViolation(line) ?? []),
    summary: { approvedCount: count(summary.approved_count), averageOverallScore: text(summary.average_overall_score), confirmed: { MINOR: count(confirmed.MINOR), MAJOR: count(confirmed.MAJOR), CRITICAL: count(confirmed.CRITICAL) }, evaluationCount: count(summary.evaluation_count), violationCount: count(summary.violation_count) },
    rule,
  };
}

/** The overall score and the rating the rule gives to five scores: the same sum the server makes, in hundredths of a point, so the preview of the form is the figure that will be kept. */
export function previewOf(scores: Scores, rule: Rule): { overall: string; rating: Rating } {
  const hundredths = CRITERIA.reduce((sum, criterion) => sum + scores[criterion] * rule.weights[criterion], 0);
  const rating = rule.thresholds.find((threshold) => hundredths >= threshold.min * 100)?.rating ?? 'POOR';
  return { overall: `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`, rating };
}

export interface ContractorChoice {
  id: string;
  name: string;
  contracts: number;
}

/** The contractors the picker offers: the ones that hold a contract the caller reads. */
export function toContractorChoices(raw: unknown): ContractorChoice[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  return raw.items.flatMap((item) => (isRecord(item) && typeof item.id === 'string' ? [{ id: item.id, name: text(item.legal_name) ?? item.id, contracts: count(item.contract_count) }] : []));
}

/** A range of days is right when it is empty at either end or its start is not after its end. */
export const rangeProblem = (range: { from: string; to: string }): boolean => range.from !== '' && range.to !== '' && range.from > range.to;

// ---- forms --------------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'uuid' | 'tooLong' | 'score' | 'amount' | 'day' | 'future';

export interface EvaluateForm {
  contractId: string;
  kind: EvaluationKind;
  period: string;
  scores: Readonly<Record<Criterion, string>>;
  remarks: string;
}

export const emptyEvaluation = (contractId: string): EvaluateForm => ({ contractId, kind: 'PERIODIC', period: '', scores: { quality: '', schedule: '', safetyEnv: '', cooperation: '', financial: '' }, remarks: '' });

/** The scores of the form as numbers, when every one is a whole number from 0 to 100. */
export function scoresOf(form: EvaluateForm): Scores | undefined {
  const parsed = CRITERIA.map((criterion) => (/^\d{1,3}$/.test(form.scores[criterion].trim()) ? Number(form.scores[criterion].trim()) : -1));
  if (parsed.some((score) => score < 0 || score > 100)) return undefined;
  const [quality, schedule, safetyEnv, cooperation, financial] = parsed as [number, number, number, number, number];
  return { quality, schedule, safetyEnv, cooperation, financial };
}

export type EvaluateProblems = Partial<Record<'contractId' | 'period' | 'remarks' | Criterion, FormProblem>>;

export function validateEvaluation(form: EvaluateForm): EvaluateProblems {
  const problems: EvaluateProblems = {};
  if (form.contractId === '') problems.contractId = 'required';
  const period = form.period.trim();
  if (period === '') problems.period = 'required';
  else if (period.length > PERIOD_MAX) problems.period = 'tooLong';
  for (const criterion of CRITERIA) if (!/^\d{1,3}$/.test(form.scores[criterion].trim()) || Number(form.scores[criterion].trim()) > 100) problems[criterion] = 'score';
  if (form.remarks.trim().length > TEXT_MAX) problems.remarks = 'tooLong';
  return problems;
}

export function evaluationBody(form: EvaluateForm): Record<string, unknown> {
  const score = (criterion: Criterion): number => Number(form.scores[criterion].trim());
  const remarks = form.remarks.trim();
  return {
    evaluation_kind: form.kind,
    period_label: form.period.trim(),
    score_quality: score('quality'),
    score_schedule: score('schedule'),
    score_safety_env: score('safetyEnv'),
    score_cooperation: score('cooperation'),
    score_financial: score('financial'),
    ...(remarks === '' ? {} : { remarks }),
  };
}

export const approvalBody = (note: string): Record<string, unknown> => (note.trim() === '' ? {} : { note: note.trim() });
export const approvalProblem = (note: string): FormProblem | undefined => (note.trim().length > TEXT_MAX ? 'tooLong' : undefined);

export interface RecordForm {
  contractId: string;
  kind: ViolationKind;
  severity: Severity;
  occurredOn: string;
  description: string;
  evidence: string;
}

export const emptyViolation = (contractId: string): RecordForm => ({ contractId, kind: 'DELAY', severity: 'MINOR', occurredOn: '', description: '', evidence: '' });

export type RecordProblems = Partial<Record<'contractId' | 'occurredOn' | 'description' | 'evidence', FormProblem>>;

/** What is wrong with a violation before it is sent; `today` is the day of the person, since a violation has not happened on a day to come. */
export function validateViolation(form: RecordForm, today: string): RecordProblems {
  const problems: RecordProblems = {};
  if (form.contractId === '') problems.contractId = 'required';
  const day = form.occurredOn.trim();
  if (day === '') problems.occurredOn = 'required';
  else if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) problems.occurredOn = 'day';
  else if (day > today) problems.occurredOn = 'future';
  const description = form.description.trim();
  if (description === '') problems.description = 'required';
  else if (description.length > TEXT_MAX) problems.description = 'tooLong';
  if (form.evidence.trim() !== '' && !UUID.test(form.evidence.trim())) problems.evidence = 'uuid';
  return problems;
}

export function violationBody(form: RecordForm): Record<string, unknown> {
  const evidence = form.evidence.trim();
  return { violation_kind: form.kind, severity: form.severity, occurred_on: form.occurredOn.trim(), description: form.description.trim(), ...(evidence === '' ? {} : { evidence_document_version_id: evidence.toLowerCase() }) };
}

export interface ConfirmForm {
  penaltyKind: PenaltyKind;
  amount: string;
  decision: string;
}

/** The form opens with the sanction the violation already carries (a termination suggests one) and the document it already rests on. */
export const emptyConfirmation = (line: ViolationLine): ConfirmForm => ({ penaltyKind: line.penaltyKind, amount: line.penaltyAmountVnd === '0' ? '' : line.penaltyAmountVnd, decision: line.decisionDocumentVersionId ?? '' });

export type ConfirmProblems = Partial<Record<'amount' | 'decision', FormProblem>>;

/** A sanction needs the document that decides it; an amount belongs to liquidated damages alone, and there it is more than zero. */
export function validateConfirmation(form: ConfirmForm): ConfirmProblems {
  const problems: ConfirmProblems = {};
  const amount = form.amount.trim();
  if (form.penaltyKind === 'LIQUIDATED_DAMAGES') {
    if (amount === '') problems.amount = 'required';
    else if (!AMOUNT.test(amount) || /^0+$/.test(amount)) problems.amount = 'amount';
  }
  const decision = form.decision.trim();
  if (decision !== '' && !UUID.test(decision)) problems.decision = 'uuid';
  else if (decision === '' && form.penaltyKind !== 'NONE') problems.decision = 'required';
  return problems;
}

export function confirmationBody(form: ConfirmForm): Record<string, unknown> {
  const decision = form.decision.trim();
  return {
    penalty_kind: form.penaltyKind,
    ...(form.penaltyKind === 'LIQUIDATED_DAMAGES' ? { penalty_amount_vnd: form.amount.trim().replace(/^0+(?=\d)/, '') } : {}),
    ...(decision === '' ? {} : { decision_document_version_id: decision.toLowerCase() }),
  };
}

// ---- refusals -----------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'selfApproval'
  | 'duplicate'
  | 'evaluationState'
  | 'violationState'
  | 'contractState'
  | 'decisionRequired'
  | 'notClean'
  | 'versionConflict'
  | 'validation'
  | 'denied'
  | 'notFound'
  | 'session'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, Problem>> = {
  SELF_APPROVAL_DENIED: 'selfApproval',
  EVALUATION_DUPLICATE: 'duplicate',
  EVALUATION_STATE_INVALID: 'evaluationState',
  VIOLATION_STATE_INVALID: 'violationState',
  CONTRACT_STATE_INVALID: 'contractState',
  DECISION_DOCUMENT_REQUIRED: 'decisionRequired',
  DOCUMENT_NOT_CLEAN: 'notClean',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export const describeProblem = (error: unknown): Problem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

/** The error the screen shows for a read: one that has nothing loaded shows any error; one that has something shows only a refusal and keeps what it has through a break in the network. */
export const shownError = (error: unknown, loaded: boolean): unknown => {
  if (error === null || error === undefined) return undefined;
  return !loaded || (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) ? error : undefined;
};
