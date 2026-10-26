import { ApiError } from '@machvon/api-client';
import { isDay, isUuid } from '../model';

/** LND-08: the complaints of the households about the clearance of their land (ST-LND-008, LND 3.3). */
export const COMPLAINTS_PATH = '/lnd/lnd-08';

/** The permissions that gate the buttons of this screen; the server decides again on every request (the project and the units of the households included). */
export const FILE_PERMISSION = 'land.complaint.write';
export const RESOLVE_PERMISSION = 'land.complaint.resolve';

export const COMPLAINT_CHANNELS = ['IN_PERSON', 'LETTER', 'PORTAL', 'MEETING'] as const;
export type ComplaintChannel = (typeof COMPLAINT_CHANNELS)[number];

export const COMPLAINT_SUBJECTS = ['PRICE', 'AREA', 'ELIGIBILITY', 'RESETTLEMENT', 'PROCEDURE', 'OTHER'] as const;
export type ComplaintSubject = (typeof COMPLAINT_SUBJECTS)[number];

export const COMPLAINT_STATUSES = ['RECEIVED', 'UNDER_REVIEW', 'RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'ESCALATED', 'CLOSED'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_OUTCOMES = ['RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'ESCALATED'] as const;
export type ComplaintOutcome = (typeof COMPLAINT_OUTCOMES)[number];

/** A complaint is answered while it waits, is under review, or was escalated and the answer of the higher level is recorded. */
export const ANSWERABLE: readonly ComplaintStatus[] = ['RECEIVED', 'UNDER_REVIEW', 'ESCALATED'];
export const TEXT_MAX_LENGTH = 2000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** A complaint as the list answers it; the words of the complainant are read only inside the unit of the household. */
export interface ComplaintLine {
  id: string;
  householdId: string;
  householdCode: string;
  planId: string | null;
  complaintNo: string;
  filedOn: string;
  channel: ComplaintChannel;
  subject: ComplaintSubject;
  description: string;
  status: ComplaintStatus;
  dueOn: string;
  remainingDays: number | null;
  resolvedOn: string | null;
  resolutionNote: string | null;
  resolutionDocumentVersionId: string | null;
  issueId: string | null;
  version: number;
}

/** A complaint the screen cannot read is dropped rather than shown half. */
export function toComplaintLine(raw: unknown): ComplaintLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const householdId = text(row?.household_id);
  const householdCode = text(row?.household_code);
  const complaintNo = text(row?.complaint_no);
  const filedOn = text(row?.filed_on);
  const channel = oneOf(COMPLAINT_CHANNELS, row?.channel);
  const subject = oneOf(COMPLAINT_SUBJECTS, row?.subject);
  const description = text(row?.description);
  const status = oneOf(COMPLAINT_STATUSES, row?.status);
  const dueOn = text(row?.due_on);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || householdId === undefined || householdCode === undefined || complaintNo === undefined || filedOn === undefined) return undefined;
  if (channel === undefined || subject === undefined || description === undefined || status === undefined || dueOn === undefined || version === undefined) return undefined;
  return {
    id,
    householdId,
    householdCode,
    planId: nullableText(row.plan_id),
    complaintNo,
    filedOn,
    channel,
    subject,
    description,
    status,
    dueOn,
    remainingDays: whole(row.remaining_days) ?? null,
    resolvedOn: nullableText(row.resolved_on),
    resolutionNote: nullableText(row.resolution_note),
    resolutionDocumentVersionId: nullableText(row.resolution_document_version_id),
    issueId: nullableText(row.issue_id),
    version,
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';
export const canFile = (permissions: readonly string[] | undefined, mode: Mode): boolean => holds(permissions, FILE_PERMISSION, mode);
export const canResolve = (permissions: readonly string[] | undefined, mode: Mode): boolean => holds(permissions, RESOLVE_PERMISSION, mode);
export const isAnswerable = (complaint: ComplaintLine): boolean => ANSWERABLE.includes(complaint.status);

/** A complaint that waits for an answer past its day. */
export const isOverdue = (complaint: ComplaintLine): boolean => complaint.remainingDays !== null && complaint.remainingDays < 0;

/** The complaints of a status in the order of the read, or all of them. */
export const complaintsOf = (complaints: readonly ComplaintLine[], status: '' | ComplaintStatus): ComplaintLine[] => (status === '' ? [...complaints] : complaints.filter((complaint) => complaint.status === status));

export type FormProblem = 'required' | 'tooLong' | 'invalid' | 'future' | 'early';

const wordsProblem = (value: string): FormProblem | undefined => {
  const words = value.trim();
  if (words === '') return 'required';
  if (words.length > TEXT_MAX_LENGTH) return 'tooLong';
  return CONTROL.test(words) ? 'invalid' : undefined;
};

export interface FileForm {
  householdId: string;
  planId: string;
  channel: '' | ComplaintChannel;
  subject: '' | ComplaintSubject;
  description: string;
  filedOn: string;
}

export const EMPTY_FILE_FORM: FileForm = { householdId: '', planId: '', channel: '', subject: '', description: '', filedOn: '' };

/** What is wrong with a complaint before it is sent: a household, a channel, a subject, words, and a day that has come. */
export function validateFile(form: FileForm, today: string): Partial<Record<keyof FileForm, FormProblem>> {
  const problems: Partial<Record<keyof FileForm, FormProblem>> = {};
  if (form.householdId === '') problems.householdId = 'required';
  if (form.channel === '') problems.channel = 'required';
  if (form.subject === '') problems.subject = 'required';
  const description = wordsProblem(form.description);
  if (description !== undefined) problems.description = description;
  const day = form.filedOn.trim();
  if (day === '') problems.filedOn = 'required';
  else if (!isDay(day)) problems.filedOn = 'invalid';
  else if (day > today) problems.filedOn = 'future';
  return problems;
}

export interface FileBody {
  project_id: string;
  household_id: string;
  owner_unit_id: string;
  channel: ComplaintChannel;
  subject: ComplaintSubject;
  description: string;
  filed_on: string;
  plan_id?: string;
}

/** The unit that answers a complaint is the unit of the household, which the screen takes from the household it chose. */
export function fileBody(projectId: string, ownerUnitId: string, form: FileForm): FileBody {
  const body: FileBody = {
    project_id: projectId,
    household_id: form.householdId,
    owner_unit_id: ownerUnitId,
    channel: form.channel as ComplaintChannel,
    subject: form.subject as ComplaintSubject,
    description: form.description.trim(),
    filed_on: form.filedOn.trim(),
  };
  if (form.planId !== '') body.plan_id = form.planId;
  return body;
}

export interface ResolveForm {
  outcome: '' | ComplaintOutcome;
  resolvedOn: string;
  resolutionDocumentVersionId: string;
  note: string;
}

export const EMPTY_RESOLVE_FORM: ResolveForm = { outcome: '', resolvedOn: '', resolutionDocumentVersionId: '', note: '' };

/** An answer is dated a day that has come and is not before the complaint, has words, and an acceptance or a rejection has its reply document. */
export function validateResolve(form: ResolveForm, complaint: ComplaintLine, today: string): Partial<Record<keyof ResolveForm, FormProblem>> {
  const problems: Partial<Record<keyof ResolveForm, FormProblem>> = {};
  if (form.outcome === '') problems.outcome = 'required';
  const day = form.resolvedOn.trim();
  if (day === '') problems.resolvedOn = 'required';
  else if (!isDay(day)) problems.resolvedOn = 'invalid';
  else if (day > today) problems.resolvedOn = 'future';
  else if (day < complaint.filedOn) problems.resolvedOn = 'early';
  const note = wordsProblem(form.note);
  if (note !== undefined) problems.note = note;
  const document = form.resolutionDocumentVersionId.trim();
  if (document === '') {
    if (form.outcome === 'RESOLVED_ACCEPTED' || form.outcome === 'RESOLVED_REJECTED') problems.resolutionDocumentVersionId = 'required';
  } else if (!isUuid(document)) problems.resolutionDocumentVersionId = 'invalid';
  return problems;
}

export interface ResolveBody {
  outcome: ComplaintOutcome;
  resolved_on: string;
  note: string;
  resolution_document_version_id?: string;
}

export function resolveBody(form: ResolveForm): ResolveBody {
  const body: ResolveBody = { outcome: form.outcome as ComplaintOutcome, resolved_on: form.resolvedOn.trim(), note: form.note.trim() };
  if (form.resolutionDocumentVersionId.trim() !== '') body.resolution_document_version_id = form.resolutionDocumentVersionId.trim().toLowerCase();
  return body;
}

export type CommandProblem = 'householdNotFound' | 'stateInvalid' | 'documentRequired' | 'documentNotClean' | 'ruleUnconfirmed' | 'versionConflict' | 'scopeDenied' | 'validation' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, CommandProblem>> = {
  HOUSEHOLD_NOT_FOUND: 'householdNotFound',
  COMPLAINT_STATE_INVALID: 'stateInvalid',
  DECISION_DOCUMENT_REQUIRED: 'documentRequired',
  DOCUMENT_NOT_CLEAN: 'documentNotClean',
  TIMER_RULE_UNCONFIRMED: 'ruleUnconfirmed',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

/** Maps the error of a command to what a dialog shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): CommandProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}
