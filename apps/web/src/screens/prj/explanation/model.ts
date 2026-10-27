import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'explanation.read';
export const REQUEST_PERMISSION = 'explanation.request';
export const RESPOND_PERMISSION = 'explanation.respond';
export const REVIEW_PERMISSION = 'explanation.review';
/** What the list of the staff of the tenant needs: without it the person asked is named by the identifier. */
export const MEMBER_LIST_PERMISSION = 'membership.read';

export const STATUSES = ['REQUESTED', 'RESPONDED', 'ACCEPTED', 'RETURNED', 'OVERDUE', 'CANCELLED'] as const;
export type Status = (typeof STATUSES)[number];
export const SUBJECTS = ['PROJECT', 'UNIT'] as const;
export type Subject = (typeof SUBJECTS)[number];
export const MANUAL_TRIGGER = 'MANUAL';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface ExplanationView {
  id: string;
  subject: Subject;
  projectId: string | null;
  subjectCode: string | null;
  subjectName: string;
  periodId: string | null;
  warningId: string | null;
  triggerCode: string;
  question: string;
  requestedFrom: string;
  dueAt: string;
  originalDueAt: string;
  responseText: string | null;
  responseDocumentId: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  isLate: boolean;
  reviewedBy: string | null;
  reviewNote: string | null;
  status: Status;
  version: number;
}

export interface ExplanationPage {
  items: ExplanationView[];
  nextCursor: string | undefined;
}

function toExplanation(raw: unknown): ExplanationView | undefined {
  const row = asRecord(raw);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const subject = SUBJECTS.find((candidate) => candidate === row?.subject_kind);
  const id = text(row?.id);
  const question = text(row?.question);
  const requestedFrom = text(row?.requested_from_membership_id);
  const dueAt = text(row?.due_at);
  if (row === undefined || status === undefined || subject === undefined || id === undefined || question === undefined || requestedFrom === undefined || dueAt === undefined || typeof row.version !== 'number') return undefined;
  const project = asRecord(row.project);
  const unit = asRecord(row.unit);
  return {
    id,
    subject,
    projectId: text(project?.id) ?? null,
    subjectCode: nullableText(project?.code),
    subjectName: text(subject === 'PROJECT' ? project?.name : unit?.name) ?? '',
    periodId: nullableText(row.period_id),
    warningId: nullableText(row.warning_id),
    triggerCode: text(row.trigger_code) ?? MANUAL_TRIGGER,
    question,
    requestedFrom,
    dueAt,
    originalDueAt: text(row.original_due_at) ?? dueAt,
    responseText: nullableText(row.response_text),
    responseDocumentId: nullableText(row.response_document_id),
    respondedBy: nullableText(row.responded_by),
    respondedAt: nullableText(row.responded_at),
    isLate: row.is_late === true,
    reviewedBy: nullableText(row.reviewed_by),
    reviewNote: nullableText(row.review_note),
    status,
    version: row.version,
  };
}

export function toExplanationPage(raw: unknown): ExplanationPage {
  const page = asRecord(raw);
  const items = (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toExplanation(item) ?? []);
  return { items, nextCursor: text(page?.next_cursor) };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** Whether a request still waits for the person asked and its moment has passed, whatever the job has marked yet. */
export const isPastDue = (view: Pick<ExplanationView, 'status' | 'dueAt'>, now: Date): boolean => (view.status === 'REQUESTED' || view.status === 'RETURNED' || view.status === 'OVERDUE') && now.getTime() > new Date(view.dueAt).getTime();

/** The person asked may answer a request that waits for them, late as well as in time. */
export const canAnswer = (view: Pick<ExplanationView, 'status' | 'requestedFrom'>, membershipId: string | undefined): boolean =>
  (view.status === 'REQUESTED' || view.status === 'OVERDUE' || view.status === 'RETURNED') && membershipId !== undefined && view.requestedFrom === membershipId;

/** An answer waits for a conclusion, and its author cannot conclude it. */
export const canConclude = (view: Pick<ExplanationView, 'status' | 'respondedBy'>, membershipId: string | undefined): boolean => view.status === 'RESPONDED' && (membershipId === undefined || view.respondedBy !== membershipId);

// ---- the forms ---------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid' | 'past';

export interface RequestForm {
  subject: Subject;
  projectId: string;
  unitId: string;
  triggerCode: string;
  question: string;
  requestedFrom: string;
  dueDate: string;
}

export const EMPTY_REQUEST: RequestForm = { subject: 'PROJECT', projectId: '', unitId: '', triggerCode: MANUAL_TRIGGER, question: '', requestedFrom: '', dueDate: '' };
export type RequestField = 'projectId' | 'unitId' | 'triggerCode' | 'question' | 'requestedFrom' | 'dueDate';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A day that exists in the calendar (2026-02-30 does not). */
const isDay = (date: string): boolean => DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

/** The day the form is filled, in Vietnam (UTC+7), as `YYYY-MM-DD`. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** The last moment of a day in Vietnam, as the instant the server stores. */
export const endOfDay = (date: string): string => new Date(`${date}T23:59:59.999+07:00`).toISOString();

export function validateRequest(form: RequestForm, today: string): Partial<Record<RequestField, FormProblem>> {
  const found: Partial<Record<RequestField, FormProblem>> = {};
  if (form.subject === 'PROJECT' && form.projectId === '') found.projectId = 'required';
  if (form.subject === 'UNIT' && form.unitId === '') found.unitId = 'required';
  const trigger = form.triggerCode.trim();
  if (trigger === '') found.triggerCode = 'required';
  else if (trigger.length > 50) found.triggerCode = 'invalid';
  const question = form.question.trim();
  if (question === '') found.question = 'required';
  else if (question.length < 10 || question.length > 2000) found.question = 'invalid';
  if (form.requestedFrom === '') found.requestedFrom = 'required';
  else if (!UUID.test(form.requestedFrom)) found.requestedFrom = 'invalid';
  if (form.dueDate === '') found.dueDate = 'required';
  else if (!isDay(form.dueDate)) found.dueDate = 'invalid';
  else if (form.dueDate <= today) found.dueDate = 'past';
  return found;
}

export function requestBody(form: RequestForm): Record<string, unknown> {
  return {
    subject_kind: form.subject,
    ...(form.subject === 'PROJECT' ? { project_id: form.projectId } : { unit_id: form.unitId }),
    trigger_code: form.triggerCode.trim(),
    question: form.question.trim(),
    requested_from_membership_id: form.requestedFrom,
    due_at: endOfDay(form.dueDate),
  };
}

export function validateAnswer(answer: string): FormProblem | undefined {
  const trimmed = answer.trim();
  if (trimmed === '') return 'required';
  return trimmed.length < 20 || trimmed.length > 2000 ? 'invalid' : undefined;
}

export type Decision = 'ACCEPTED' | 'RETURNED';
export interface ReviewForm {
  decision: Decision;
  note: string;
  newDueDate: string;
}
export const EMPTY_REVIEW: ReviewForm = { decision: 'ACCEPTED', note: '', newDueDate: '' };
export type ReviewField = 'note' | 'newDueDate';

export function validateReview(form: ReviewForm, today: string): Partial<Record<ReviewField, FormProblem>> {
  const found: Partial<Record<ReviewField, FormProblem>> = {};
  const note = form.note.trim();
  if (note === '') found.note = 'required';
  else if (note.length < 5 || note.length > 2000) found.note = 'invalid';
  if (form.decision === 'RETURNED' && form.newDueDate !== '') {
    if (!isDay(form.newDueDate)) found.newDueDate = 'invalid';
    else if (form.newDueDate <= today) found.newDueDate = 'past';
  }
  return found;
}

export function reviewBody(form: ReviewForm): Record<string, unknown> {
  return { decision: form.decision, review_note: form.note.trim(), ...(form.decision === 'RETURNED' && form.newDueDate !== '' ? { new_due_at: endOfDay(form.newDueDate) } : {}) };
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type ExplanationProblem = 'alreadyOpen' | 'alreadySubmitted' | 'selfApproval' | 'versionConflict' | 'stageDenied' | 'scopeDenied' | 'warningState' | 'validation' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ExplanationProblem>> = {
  EXPLANATION_ALREADY_OPEN: 'alreadyOpen',
  EXPLANATION_ALREADY_SUBMITTED: 'alreadySubmitted',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  SCOPE_DENIED: 'scopeDenied',
  WARNING_STATE_INVALID: 'warningState',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeExplanation = (error: unknown): ExplanationProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
