import { ApiError } from '@machvon/api-client';

/** MNE-08: the investment evaluation of a project (ST-MNE-009, MNE F9, BR-MNE-08, UAT-AC292, UAT-PLAN-74). */
export const MANAGE_PERMISSION = 'mne.evaluation.manage';
export const APPROVE_PERMISSION = 'mne.evaluation.approve';
export const READ_PERMISSION = 'mne.read';

export const KINDS = ['INITIAL', 'MIDTERM', 'FINAL', 'IMPACT', 'AD_HOC'] as const;
export type Kind = (typeof KINDS)[number];
export const EVALUATOR_KINDS = ['INTERNAL', 'INDEPENDENT_CONSULTANT'] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];
export const STATUSES = ['PLANNED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'RETURNED'] as const;
export type Status = (typeof STATUSES)[number];
export const CONCLUSIONS = ['SATISFACTORY', 'PARTIALLY_SATISFACTORY', 'UNSATISFACTORY'] as const;
export type Conclusion = (typeof CONCLUSIONS)[number];

export const NAME_MAX = 300;
export const SCOPE_MIN = 10;
export const TEXT_MAX = 2000;
export const REASON_MIN = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);
const isDay = (value: string): boolean => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** The day in Vietnam (UTC+7), the day an evaluation is judged by. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export interface Evaluation {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  kind: Kind;
  evaluatorKind: EvaluatorKind;
  evaluatorName: string;
  scopeText: string;
  plannedDate: string;
  status: Status;
  findings: unknown[];
  conclusion: Conclusion | null;
  recommendations: string | null;
  completedDate: string | null;
  reportDocumentId: string | null;
  linkedReport: boolean;
  decisionReason: string | null;
  mayChange: boolean;
  mayDecide: boolean;
  version: number;
}

/** An evaluation the screen cannot read is dropped rather than shown half. */
export function toEvaluation(raw: unknown): Evaluation | undefined {
  const row = asRecord(raw);
  const project = asRecord(row?.project);
  const actions = asRecord(row?.actions);
  const id = text(row?.id);
  const projectId = text(project?.id);
  const kind = oneOf(KINDS, row?.evaluation_kind);
  const evaluatorKind = oneOf(EVALUATOR_KINDS, row?.evaluator_kind);
  const status = oneOf(STATUSES, row?.status);
  const plannedDate = text(row?.planned_date);
  if (row === undefined || id === undefined || projectId === undefined || kind === undefined || evaluatorKind === undefined || status === undefined || plannedDate === undefined || typeof row.version !== 'number') return undefined;
  return {
    id,
    projectId,
    projectCode: text(project?.code) ?? '',
    projectName: text(project?.name) ?? '',
    kind,
    evaluatorKind,
    evaluatorName: text(row.evaluator_name) ?? '',
    scopeText: text(row.scope_text) ?? '',
    plannedDate,
    status,
    findings: Array.isArray(row.findings) ? row.findings : [],
    conclusion: oneOf(CONCLUSIONS, row.conclusion) ?? null,
    recommendations: nullableText(row.recommendations_text),
    completedDate: nullableText(row.completed_date),
    reportDocumentId: nullableText(row.report_document_id),
    linkedReport: typeof row.mne_report_id === 'string',
    decisionReason: nullableText(row.decision_reason),
    mayChange: actions?.submit === true,
    mayDecide: actions?.decide === true,
    version: row.version,
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);
export const canPlan = (permissions: readonly string[] | undefined, mode: Mode): boolean => holds(permissions, MANAGE_PERMISSION) && mode !== 'READ_ONLY';

export type FormProblem = 'required' | 'invalid' | 'future' | 'short';

// ---- planning --------------------------------------------------------------------------------------------------------------

export interface PlanForm {
  projectId: string;
  kind: string;
  evaluatorKind: string;
  evaluatorName: string;
  scopeText: string;
  plannedDate: string;
}

export const EMPTY_PLAN: PlanForm = { projectId: '', kind: '', evaluatorKind: 'INTERNAL', evaluatorName: '', scopeText: '', plannedDate: '' };
export type PlanField = keyof PlanForm;

export function validatePlan(form: PlanForm): Partial<Record<PlanField, FormProblem>> {
  const found: Partial<Record<PlanField, FormProblem>> = {};
  if (form.projectId === '') found.projectId = 'required';
  if (form.kind === '') found.kind = 'required';
  else if (oneOf(KINDS, form.kind) === undefined) found.kind = 'invalid';
  if (oneOf(EVALUATOR_KINDS, form.evaluatorKind) === undefined) found.evaluatorKind = 'invalid';
  const name = form.evaluatorName.trim();
  if (name === '') found.evaluatorName = 'required';
  else if (name.length < 2 || name.length > NAME_MAX) found.evaluatorName = 'invalid';
  const scope = form.scopeText.trim();
  if (scope === '') found.scopeText = 'required';
  else if (scope.length < SCOPE_MIN) found.scopeText = 'short';
  else if (scope.length > TEXT_MAX) found.scopeText = 'invalid';
  if (form.plannedDate === '') found.plannedDate = 'required';
  else if (!isDay(form.plannedDate)) found.plannedDate = 'invalid';
  return found;
}

export const planBody = (form: PlanForm): Record<string, unknown> => ({
  project_id: form.projectId,
  evaluation_kind: form.kind,
  evaluator_kind: form.evaluatorKind,
  evaluator_name: form.evaluatorName.trim(),
  scope_text: form.scopeText.trim(),
  planned_date: form.plannedDate,
});

// ---- submitting ------------------------------------------------------------------------------------------------------------

export interface SubmitForm {
  /** One finding for each line. */
  findings: string;
  conclusion: string;
  recommendations: string;
  completedDate: string;
  reportDocument: string;
}

export const EMPTY_SUBMIT: SubmitForm = { findings: '', conclusion: '', recommendations: '', completedDate: '', reportDocument: '' };

/** A finding as a line of the form: its text when it is only a text that comes back unchanged, else the object itself in one line (it comes back as the object). */
export function findingLine(finding: unknown): string {
  const row = asRecord(finding);
  // A text goes back as it is only when the line survives the reading of the lines: one line, trimmed, not empty and not beginning with a brace.
  const survives = row !== undefined && Object.keys(row).length === 1 && typeof row.text === 'string' && row.text !== '' && row.text === row.text.trim() && !row.text.includes(String.fromCharCode(10)) && !row.text.startsWith('{');
  return survives ? (row.text as string) : JSON.stringify(finding);
}

/** The form of a submission that is made again: what was submitted before, so that a correction changes what it means to change and loses nothing else. */
export function submitFormOf(evaluation: Evaluation): SubmitForm {
  return {
    findings: evaluation.findings.map(findingLine).join('\n'),
    conclusion: evaluation.conclusion ?? '',
    recommendations: evaluation.recommendations ?? '',
    completedDate: evaluation.completedDate ?? '',
    reportDocument: evaluation.reportDocumentId ?? '',
  };
}

/** One line of the findings: an object written in one line is that object, anything else a text. */
function findingOf(line: string): unknown {
  if (line.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (asRecord(parsed) !== undefined) return parsed;
    } catch {
      // A line that only begins with a brace is a text.
    }
  }
  return { text: line };
}
export type SubmitField = keyof SubmitForm;

export function validateSubmit(form: SubmitForm, today: string): Partial<Record<SubmitField, FormProblem>> {
  const found: Partial<Record<SubmitField, FormProblem>> = {};
  if (form.conclusion === '') found.conclusion = 'required';
  else if (oneOf(CONCLUSIONS, form.conclusion) === undefined) found.conclusion = 'invalid';
  if (form.completedDate === '') found.completedDate = 'required';
  else if (!isDay(form.completedDate)) found.completedDate = 'invalid';
  else if (form.completedDate > today) found.completedDate = 'future';
  if (form.recommendations.trim().length > TEXT_MAX) found.recommendations = 'invalid';
  const document = form.reportDocument.trim();
  if (document !== '' && !UUID.test(document)) found.reportDocument = 'invalid';
  return found;
}

/** The body of the command for a form that passed `validateSubmit`: each line of the findings is one finding. */
export function submitBody(form: SubmitForm): Record<string, unknown> {
  const recommendations = form.recommendations.trim();
  const document = form.reportDocument.trim();
  return {
    findings: form.findings
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map(findingOf),
    conclusion: form.conclusion,
    completed_date: form.completedDate,
    ...(recommendations === '' ? {} : { recommendations_text: recommendations }),
    ...(document === '' ? {} : { report_document_id: document.toLowerCase() }),
  };
}

// ---- deciding --------------------------------------------------------------------------------------------------------------

export interface DecideForm {
  decision: string;
  reason: string;
}

export const EMPTY_DECIDE: DecideForm = { decision: '', reason: '' };
export type DecideField = keyof DecideForm;

export function validateDecide(form: DecideForm): Partial<Record<DecideField, FormProblem>> {
  const found: Partial<Record<DecideField, FormProblem>> = {};
  if (form.decision !== 'approve' && form.decision !== 'return') found.decision = 'required';
  const reason = form.reason.trim();
  if (reason === '') found.reason = 'required';
  else if (reason.length < REASON_MIN) found.reason = 'short';
  else if (reason.length > TEXT_MAX) found.reason = 'invalid';
  return found;
}

export const decideBody = (form: DecideForm): { decision: 'approve' | 'return'; reason: string } => ({ decision: form.decision === 'approve' ? 'approve' : 'return', reason: form.reason.trim() });

// ---- what the server refuses -------------------------------------------------------------------------------------------------

export type Problem = 'stage' | 'selfApproval' | 'versionConflict' | 'validation' | 'scopeDenied' | 'notFound' | 'general';

export interface Refusal {
  problem: Problem;
  kind: Kind | null;
  projectStatus: string | null;
  /** The initial evaluation is refused for the stage and also for the months that have gone by. */
  windowPassed: boolean;
}

const BY_CODE: Readonly<Record<string, Problem>> = {
  STAGE_TRANSITION_DENIED: 'stage',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'scopeDenied',
  RESOURCE_NOT_FOUND: 'notFound',
};

export function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return { problem: 'general', kind: null, projectStatus: null, windowPassed: false };
  const ext = error.extensions;
  return {
    problem: BY_CODE[error.code] ?? 'general',
    kind: oneOf(KINDS, ext.evaluation_kind) ?? null,
    projectStatus: typeof ext.project_status === 'string' ? ext.project_status : null,
    windowPassed: ext.reason === 'INITIAL_WINDOW_PASSED',
  };
}
