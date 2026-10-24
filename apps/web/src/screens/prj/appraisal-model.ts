import { ApiError } from '@machvon/api-client';
import { PROJECT_STATUSES } from './model';
import type { ProjectStatus } from './model';

/** The appraisal of a project (ST-PRJ-003): PRJ-09 sends the proposal, PRJ-15 scores it, PRJ-10 decides on it. */
export const PROPOSAL_PATH = '/prj/prj-09';
export const DECISION_PATH = '/prj/prj-10';
export const SCORE_PATH = '/prj/prj-15';

export const SUBMIT_PERMISSION = 'project.stage.submit';
export const APPRAISE_PERMISSION = 'project.appraise';
export const DECIDE_PERMISSION = 'project.appraisal.decide';

export const RECOMMENDATIONS = ['ADMIT', 'REJECT', 'RETURN'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];
export const SCORE_VALUES = [0, 1, 2, 3, 4, 5] as const;
export const PROJECT_GROUPS = ['QTQG', 'A', 'B', 'C'] as const;
export type ProjectGroup = (typeof PROJECT_GROUPS)[number];

export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 2000;
export const NOTE_MAX_LENGTH = 2000;
export const OVERRIDE_MIN_LENGTH = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEIGHT = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const isRecommendation = (value: string): value is Recommendation => (RECOMMENDATIONS as readonly string[]).includes(value);
const isStage = (value: string): value is ProjectStatus => (PROJECT_STATUSES as readonly string[]).includes(value);

function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// ---- what the lifecycle read tells of the appraisal ---------------------------------------------------------------------

export interface Criterion {
  code: string;
  name: string;
  /** An exact decimal string; the weights of a set add up to 100. */
  weight: string;
}

export interface CriteriaSet {
  versionId: string;
  key: string;
  revision: number;
  legalBasis: string;
  awaitingConfirmation: boolean;
  cxn: string | null;
  passThreshold: string;
  criteria: Criterion[];
}

export interface SheetScore {
  criterionCode: string;
  score: number;
  evidenceIds: string[];
}

export type SheetStatus = 'DRAFT' | 'SUBMITTED' | 'DECIDED' | 'VOID';
const SHEET_STATUSES: readonly string[] = ['DRAFT', 'SUBMITTED', 'DECIDED', 'VOID'];

export interface Sheet {
  id: string;
  version: number;
  status: SheetStatus;
  mine: boolean;
  appraiserName: string | null;
  scores: SheetScore[];
  totalScore: string;
  recommendation: Recommendation;
  note: string | null;
  decision: Recommendation | null;
}

export interface Summary {
  sheetCount: number;
  meanScore: string | null;
  thresholdRecommendation: 'ADMIT' | 'REJECT' | null;
  overrideRequired: Record<Recommendation, boolean> | null;
}

/** The project as the lifecycle read gives it, with the appraisal block the caller may see (none for a reader). */
export interface AppraisalView {
  projectId: string;
  code: string;
  status: ProjectStatus;
  version: number;
  /** Whether the server returned an appraisal block at all: the caller neither scores nor decides when it did not. */
  hasAppraisal: boolean;
  round: number | null;
  viewerIsProposer: boolean;
  canRecord: boolean;
  canDecide: boolean;
  criteriaSet: CriteriaSet | null;
  sheets: Sheet[];
  summary: Summary | null;
  decisionTarget: { id: string; version: number } | null;
}

function toCriterion(raw: unknown): Criterion[] {
  const row = asRecord(raw);
  const code = text(row?.code);
  const weight = text(row?.weight);
  return code !== undefined && weight !== undefined && WEIGHT.test(weight) ? [{ code, name: text(row?.name) ?? code, weight }] : [];
}

function toCriteriaSet(raw: unknown): CriteriaSet | null {
  const row = asRecord(raw);
  const versionId = text(row?.version_id);
  const threshold = text(row?.pass_threshold);
  if (row === undefined || versionId === undefined || threshold === undefined) return null;
  return {
    versionId,
    key: text(row.key) ?? '',
    revision: whole(row.revision) ?? 0,
    legalBasis: text(row.legal_basis) ?? '',
    awaitingConfirmation: row.awaiting_confirmation === true,
    cxn: nullableText(row.cxn),
    passThreshold: threshold,
    criteria: (Array.isArray(row.criteria) ? row.criteria : []).flatMap(toCriterion),
  };
}

function toScore(raw: unknown): SheetScore[] {
  const row = asRecord(raw);
  const code = text(row?.criterion_code);
  const score = whole(row?.score);
  return code !== undefined && score !== undefined ? [{ criterionCode: code, score, evidenceIds: (Array.isArray(row?.evidence_ids) ? row.evidence_ids : []).filter((id): id is string => typeof id === 'string') }] : [];
}

function toSheet(raw: unknown): Sheet[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const version = whole(row?.version);
  const status = text(row?.status);
  const total = text(row?.total_score);
  const recommendation = text(row?.recommendation);
  if (row === undefined || id === undefined || version === undefined || status === undefined || !SHEET_STATUSES.includes(status) || total === undefined || recommendation === undefined || !isRecommendation(recommendation)) return [];
  const decision = text(row.decision);
  return [
    {
      id,
      version,
      status: status as SheetStatus,
      mine: row.mine === true,
      appraiserName: nullableText(asRecord(row.appraiser)?.display_name),
      scores: (Array.isArray(row.scores) ? row.scores : []).flatMap(toScore),
      totalScore: total,
      recommendation,
      note: nullableText(row.note),
      decision: decision !== undefined && isRecommendation(decision) ? decision : null,
    },
  ];
}

function toSummary(raw: unknown): Summary | null {
  const row = asRecord(raw);
  const count = whole(row?.sheet_count);
  if (row === undefined || count === undefined) return null;
  const override = asRecord(row.override_required);
  const threshold = text(row.threshold_recommendation);
  return {
    sheetCount: count,
    meanScore: nullableText(row.mean_score),
    thresholdRecommendation: threshold === 'ADMIT' || threshold === 'REJECT' ? threshold : null,
    overrideRequired: override === undefined ? null : { ADMIT: override.ADMIT === true, REJECT: override.REJECT === true, RETURN: override.RETURN === true },
  };
}

export function toAppraisalView(raw: unknown): AppraisalView | undefined {
  const body = asRecord(raw);
  const projectId = text(body?.project_id);
  const code = text(body?.code);
  const status = text(body?.status);
  const version = whole(body?.version);
  if (body === undefined || projectId === undefined || code === undefined || status === undefined || !isStage(status) || version === undefined) return undefined;
  const appraisal = asRecord(body.appraisal);
  const target = asRecord(appraisal?.decision_target);
  const targetId = text(target?.id);
  const targetVersion = whole(target?.version);
  return {
    projectId,
    code,
    status,
    version,
    hasAppraisal: appraisal !== undefined,
    round: whole(appraisal?.round) ?? null,
    viewerIsProposer: appraisal?.viewer_is_proposer === true,
    canRecord: appraisal?.can_record === true,
    canDecide: appraisal?.can_decide === true,
    criteriaSet: toCriteriaSet(appraisal?.criteria_set),
    sheets: (Array.isArray(appraisal?.sheets) ? appraisal.sheets : []).flatMap(toSheet),
    summary: toSummary(appraisal?.summary),
    decisionTarget: targetId !== undefined && targetVersion !== undefined ? { id: targetId, version: targetVersion } : null,
  };
}

// ---- the arithmetic of the sheet ----------------------------------------------------------------------------------------

const hundredths = (weight: string): bigint => {
  const [integer = '0', fraction = ''] = weight.split('.');
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
};

/**
 * The total of a sheet as the server computes it (`sum(score x weight) / 5`, half-up to two digits), on whole hundredths. It is only a
 * preview while the form is filled: the figure that counts is the one the server answers. Null while a criterion has no score.
 */
export function previewTotal(criteria: readonly Criterion[], scores: Readonly<Record<string, string>>): string | null {
  let sum = 0n;
  for (const criterion of criteria) {
    const given = scores[criterion.code];
    if (given === undefined || given === '') return null;
    sum += BigInt(given) * hundredths(criterion.weight);
  }
  // sum is in hundredths of (score x weight); a fifth of it, rounded half up, is the total in hundredths.
  const total = (2n * sum + 5n) / 10n;
  const digits = total.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

// ---- PRJ-09: the proposal ----------------------------------------------------------------------------------------------

export interface ProposalForm {
  reason: string;
  documentId: string;
  effectiveDate: string;
}

export const EMPTY_PROPOSAL: ProposalForm = { reason: '', documentId: '', effectiveDate: '' };

export type FieldProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidId' | 'invalidDate' | 'scoresIncomplete' | 'evidenceInvalid' | 'overrideShort';

export function validateProposal(form: ProposalForm): Partial<Record<keyof ProposalForm, FieldProblem>> {
  const problems: Partial<Record<keyof ProposalForm, FieldProblem>> = {};
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length < REASON_MIN_LENGTH) problems.reason = 'tooShort';
  else if (reason.length > REASON_MAX_LENGTH) problems.reason = 'tooLong';
  const document = form.documentId.trim();
  if (document === '') problems.documentId = 'required';
  else if (!UUID.test(document)) problems.documentId = 'invalidId';
  if (form.effectiveDate !== '' && !isCalendarDate(form.effectiveDate)) problems.effectiveDate = 'invalidDate';
  return problems;
}

export interface ProposalBody {
  reason: string;
  policy_proposal_document_id: string;
  effective_date?: string;
}

export function proposalBody(form: ProposalForm): ProposalBody {
  const body: ProposalBody = { reason: form.reason.trim(), policy_proposal_document_id: form.documentId.trim().toLowerCase() };
  if (form.effectiveDate !== '') body.effective_date = form.effectiveDate;
  return body;
}

// ---- PRJ-15: the sheet --------------------------------------------------------------------------------------------------

export interface ScoreForm {
  /** The score of each criterion by its code, '0' to '5', or '' while it has none. */
  scores: Record<string, string>;
  /** The documents that evidence each score, written as ids separated by commas or spaces. */
  evidence: Record<string, string>;
  recommendation: Recommendation | '';
  note: string;
}

export const EMPTY_SCORE_FORM: ScoreForm = { scores: {}, evidence: {}, recommendation: '', note: '' };

/** The form of the sheet the caller recorded already, so that scoring again starts from what they said. */
export function formOfSheet(sheet: Sheet): ScoreForm {
  return {
    scores: Object.fromEntries(sheet.scores.map((entry) => [entry.criterionCode, String(entry.score)])),
    evidence: Object.fromEntries(sheet.scores.map((entry) => [entry.criterionCode, entry.evidenceIds.join(', ')])),
    recommendation: sheet.recommendation,
    note: sheet.note ?? '',
  };
}

export const evidenceIdsOf = (value: string): string[] => value.split(/[\s,;]+/).filter((id) => id !== '');

export type ScoreField = 'scores' | 'evidence' | 'recommendation' | 'note';

export function validateScoreForm(criteria: readonly Criterion[], form: ScoreForm): Partial<Record<ScoreField, FieldProblem>> {
  const problems: Partial<Record<ScoreField, FieldProblem>> = {};
  if (criteria.some((criterion) => (form.scores[criterion.code] ?? '') === '')) problems.scores = 'scoresIncomplete';
  if (criteria.some((criterion) => evidenceIdsOf(form.evidence[criterion.code] ?? '').some((id) => !UUID.test(id)))) problems.evidence = 'evidenceInvalid';
  if (form.recommendation === '') problems.recommendation = 'required';
  if (form.note.trim().length > NOTE_MAX_LENGTH) problems.note = 'tooLong';
  return problems;
}

export interface ScoreBody {
  criteria_set_version_id: string;
  recommendation: Recommendation;
  note?: string;
  scores: Array<{ criterion_code: string; score: number; evidence_ids?: string[] }>;
}

/** The body of a sheet for a form that passed `validateScoreForm`. */
export function scoreBody(set: CriteriaSet, form: ScoreForm): ScoreBody {
  const body: ScoreBody = {
    criteria_set_version_id: set.versionId,
    recommendation: form.recommendation as Recommendation,
    scores: set.criteria.map((criterion) => {
      const evidence = evidenceIdsOf(form.evidence[criterion.code] ?? '').map((id) => id.toLowerCase());
      return { criterion_code: criterion.code, score: Number(form.scores[criterion.code]), ...(evidence.length === 0 ? {} : { evidence_ids: [...new Set(evidence)] }) };
    }),
  };
  const note = form.note.trim();
  if (note !== '') body.note = note;
  return body;
}

/** The sheet of the caller, if they recorded one for the round. */
export const ownSheet = (view: AppraisalView): Sheet | undefined => view.sheets.find((sheet) => sheet.mine && sheet.status !== 'VOID');

// ---- PRJ-10: the decision -----------------------------------------------------------------------------------------------

export interface DecisionForm {
  decision: Recommendation | '';
  reason: string;
  documentId: string;
  projectGroup: ProjectGroup | '';
  overrideReason: string;
}

export const EMPTY_DECISION: DecisionForm = { decision: '', reason: '', documentId: '', projectGroup: '', overrideReason: '' };

export type DecisionField = keyof DecisionForm;

/** Whether the decision chosen goes against what the sheets say, so that it needs a reason of its own. */
export const needsOverride = (view: AppraisalView, decision: Recommendation | ''): boolean => decision !== '' && view.summary?.overrideRequired?.[decision] === true;

export function validateDecisionForm(view: AppraisalView, form: DecisionForm): Partial<Record<DecisionField, FieldProblem>> {
  const problems: Partial<Record<DecisionField, FieldProblem>> = {};
  if (form.decision === '') problems.decision = 'required';
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length < REASON_MIN_LENGTH) problems.reason = 'tooShort';
  else if (reason.length > REASON_MAX_LENGTH) problems.reason = 'tooLong';
  const document = form.documentId.trim();
  if (form.decision === 'ADMIT' && document === '') problems.documentId = 'required';
  else if (document !== '' && !UUID.test(document)) problems.documentId = 'invalidId';
  if (form.decision === 'ADMIT' && form.projectGroup === '') problems.projectGroup = 'required';
  if (needsOverride(view, form.decision)) {
    const override = form.overrideReason.trim();
    if (override === '') problems.overrideReason = 'required';
    else if (override.length < OVERRIDE_MIN_LENGTH) problems.overrideReason = 'overrideShort';
    else if (override.length > REASON_MAX_LENGTH) problems.overrideReason = 'tooLong';
  }
  return problems;
}

export interface DecisionBody {
  decision: Recommendation;
  reason: string;
  decision_document_id?: string;
  project_group?: ProjectGroup;
  override_reason?: string;
}

/** The body of a decision for a form that passed `validateDecisionForm`: what the decision does not take is not sent. */
export function decisionBody(view: AppraisalView, form: DecisionForm): DecisionBody {
  const body: DecisionBody = { decision: form.decision as Recommendation, reason: form.reason.trim() };
  const document = form.documentId.trim();
  if (document !== '') body.decision_document_id = document.toLowerCase();
  if (form.decision === 'ADMIT' && form.projectGroup !== '') body.project_group = form.projectGroup;
  if (needsOverride(view, form.decision)) body.override_reason = form.overrideReason.trim();
  return body;
}

// ---- refusals -----------------------------------------------------------------------------------------------------------

export type AppraisalProblem =
  | 'selfApproval'
  | 'criteriaWeight'
  | 'scoreRange'
  | 'overrideRequired'
  | 'groupRequired'
  | 'decisionRequired'
  | 'incomplete'
  | 'transitionDenied'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, AppraisalProblem>> = {
  SELF_APPROVAL_DENIED: 'selfApproval',
  CRITERIA_WEIGHT_INVALID: 'criteriaWeight',
  SCORE_OUT_OF_RANGE: 'scoreRange',
  OVERRIDE_REASON_REQUIRED: 'overrideRequired',
  PROJECT_GROUP_REQUIRED: 'groupRequired',
  DECISION_REQUIRED: 'decisionRequired',
  APPRAISAL_INCOMPLETE: 'incomplete',
  STAGE_TRANSITION_DENIED: 'transitionDenied',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of a command of the appraisal to what the screen shows; an unknown failure is the general message. */
export function describeAppraisalProblem(error: unknown): AppraisalProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}

/** The address of one of the screens of the appraisal for a project. */
export function appraisalLink(path: string, projectId: string): string {
  return `${path}?${new URLSearchParams({ id: projectId }).toString()}`;
}
