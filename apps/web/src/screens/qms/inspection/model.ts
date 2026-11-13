import { ApiError } from '@machvon/api-client';

/** The permissions of QMS-04 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract. */
export const READ_PERMISSION = 'inspection.read';
export const REQUEST_PERMISSION = 'inspection.request';

export const INSPECTION_TYPES = ['MATERIAL_ENTRY', 'CONCEALED_WORK', 'CONSTRUCTION_STAGE', 'PART_ACCEPTANCE', 'COMPLETION', 'SAFETY', 'OTHER'] as const;
export type InspectionType = (typeof INSPECTION_TYPES)[number];
export const INSPECTION_STATUSES = ['REQUESTED', 'SCHEDULED', 'RESULT_RECORDED', 'CANCELLED'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];
export const RESULTS = ['PASS', 'FAIL', 'CONDITIONAL'] as const;
export type InspectionResult = (typeof RESULTS)[number];
export const OUTCOMES = ['PASS', 'FAIL', 'NA'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const SIGNER_ROLES = ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 2000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

export interface Person {
  membershipId: string;
  displayName: string;
}

/** An item of the checklist an inspection was given; once the result is recorded it carries the answer. */
export interface ChecklistRow {
  code: string;
  label: string;
  outcome: Outcome | null;
  note: string | null;
}

/** The regime in force on the day of the request, as the inspection keeps it. */
export interface Regime {
  label: string | null;
  legalBasis: string | null;
  /** The rule data of the regime waits for a confirmation; the screen warns, with the number of the confirmation. */
  awaitingConfirmation: boolean;
  cxn: string | null;
}

/** One inspection as QMS-04 shows it. */
export interface InspectionLine {
  id: string;
  inspectionNo: string;
  contract: { id: string; code: string; status: string };
  boqItem: { id: string; businessKey: string; description: string } | null;
  inspectionType: InspectionType;
  title: string;
  locationText: string | null;
  /** The site diary the request names (QMS-03), if any. */
  siteDiaryId: string | null;
  requestedBy: Person | null;
  requestedFor: string;
  scheduledAt: string | null;
  participants: Person[];
  status: InspectionStatus;
  result: InspectionResult | null;
  resultNote: string | null;
  resultRecordedAt: string | null;
  checklist: ChecklistRow[];
  regime: Regime;
  requiredRoles: SignerRole[];
  cancelReason: string | null;
  canSchedule: boolean;
  canRecord: boolean;
  canCancel: boolean;
  version: number;
}

function toPerson(raw: unknown): Person | null {
  const row = asRecord(raw);
  const membershipId = text(row?.membership_id);
  return row === undefined || membershipId === undefined ? null : { membershipId, displayName: text(row.display_name) ?? '' };
}

function toChecklistRow(raw: unknown): ChecklistRow | undefined {
  const row = asRecord(raw);
  const code = text(row?.code);
  if (row === undefined || code === undefined) return undefined;
  return { code, label: text(row.label) ?? code, outcome: oneOf(OUTCOMES, row.outcome) ?? null, note: nullableText(row.note) };
}

export function toInspectionLine(raw: unknown): InspectionLine | undefined {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const boq = asRecord(row?.boq_item);
  const id = text(row?.id);
  const contractId = text(contract?.id);
  const type = oneOf(INSPECTION_TYPES, row?.inspection_type);
  const status = oneOf(INSPECTION_STATUSES, row?.status);
  const requestedFor = text(row?.requested_for);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || contractId === undefined || type === undefined || status === undefined || requestedFor === undefined || version === undefined) return undefined;
  const regime = asRecord(row.regime);
  const actions = asRecord(row.actions);
  const boqId = text(boq?.id);
  return {
    id,
    inspectionNo: text(row.inspection_no) ?? '',
    contract: { id: contractId, code: text(contract?.code) ?? '', status: text(contract?.status) ?? '' },
    boqItem: boqId === undefined ? null : { id: boqId, businessKey: text(boq?.business_key) ?? '', description: text(boq?.description) ?? '' },
    inspectionType: type,
    title: text(row.title) ?? '',
    locationText: nullableText(row.location_text),
    siteDiaryId: nullableText(row.site_diary_id),
    requestedBy: toPerson(row.requested_by),
    requestedFor,
    scheduledAt: nullableText(row.scheduled_at),
    participants: Array.isArray(row.participants) ? row.participants.flatMap((person) => toPerson(person) ?? []) : [],
    status,
    result: oneOf(RESULTS, row.result) ?? null,
    resultNote: nullableText(row.result_note),
    resultRecordedAt: nullableText(row.result_recorded_at),
    checklist: Array.isArray(row.checklist) ? row.checklist.flatMap((item) => toChecklistRow(item) ?? []) : [],
    regime: { label: nullableText(regime?.label), legalBasis: nullableText(regime?.legal_basis), awaitingConfirmation: regime?.awaiting_confirmation === true, cxn: nullableText(regime?.cxn) },
    requiredRoles: Array.isArray(row.required_roles) ? row.required_roles.flatMap((role) => oneOf(SIGNER_ROLES, role) ?? []) : [],
    cancelReason: nullableText(row.cancel_reason),
    canSchedule: actions?.schedule === true,
    canRecord: actions?.record === true,
    canCancel: actions?.cancel === true,
    version,
  };
}

export function toInspectionList(raw: unknown): InspectionLine[] {
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toInspectionLine(item) ?? []) : [];
}

// ---- who may do what ----------------------------------------------------------------------------------------------------------

/** Whether the caller may ask for an inspection: the permission is held (or not yet known) and the session is not read-only. The server judges the scope again. */
export const canRequest = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(REQUEST_PERMISSION));

// ---- asking for an inspection ---------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'date' | 'uuid' | 'tooLong' | 'past' | 'noParticipant' | 'unanswered' | 'passWithFailed' | 'noFailed' | 'conditionUnstated';

export interface RequestForm {
  contractId: string;
  boqItemId: string;
  inspectionType: InspectionType | '';
  title: string;
  locationText: string;
  requestedFor: string;
  siteDiaryId: string;
}

export const emptyRequest = (today: string, contractId = ''): RequestForm => ({ contractId, boqItemId: '', inspectionType: '', title: '', locationText: '', requestedFor: today, siteDiaryId: '' });

const isDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const wordsProblem = (value: string, required: boolean): FormProblem | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return required ? 'required' : undefined;
  return trimmed.length > MAX_TEXT ? 'tooLong' : undefined;
};

/** What is wrong with the request before it is sent: the contract, the kind, the title and a day that is a day; the regime is the one in force on that day. */
export function validateRequest(form: RequestForm): Partial<Record<keyof RequestForm, FormProblem>> {
  const problems: Partial<Record<keyof RequestForm, FormProblem>> = {};
  if (form.contractId === '') problems.contractId = 'required';
  if (form.inspectionType === '') problems.inspectionType = 'required';
  const title = wordsProblem(form.title, true);
  if (title !== undefined) problems.title = title;
  const place = wordsProblem(form.locationText, false);
  if (place !== undefined) problems.locationText = place;
  const day = form.requestedFor.trim();
  if (day === '') problems.requestedFor = 'required';
  else if (!isDate(day)) problems.requestedFor = 'date';
  const diary = form.siteDiaryId.trim();
  if (diary !== '' && !UUID.test(diary)) problems.siteDiaryId = 'uuid';
  return problems;
}

export interface RequestBody {
  contract_id: string;
  inspection_type: InspectionType;
  title: string;
  requested_for: string;
  boq_item_id?: string;
  location_text?: string;
  site_diary_id?: string;
}

export function requestBody(form: RequestForm): RequestBody {
  const place = form.locationText.trim();
  const diary = form.siteDiaryId.trim();
  return {
    contract_id: form.contractId,
    inspection_type: form.inspectionType === '' ? 'OTHER' : form.inspectionType,
    title: form.title.trim(),
    requested_for: form.requestedFor.trim(),
    ...(form.boqItemId === '' ? {} : { boq_item_id: form.boqItemId }),
    ...(place === '' ? {} : { location_text: place }),
    ...(diary === '' ? {} : { site_diary_id: diary.toLowerCase() }),
  };
}

// ---- scheduling -----------------------------------------------------------------------------------------------------------------------

export interface ScheduleForm {
  /** The value of a `datetime-local` control: a date and a time of the Vietnam day, with no zone. */
  scheduledAt: string;
  participantIds: string[];
}

export const EMPTY_SCHEDULE: ScheduleForm = { scheduledAt: '', participantIds: [] };

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** The instant a `datetime-local` value of the Vietnam day stands for (UTC+7, no daylight saving); undefined when it is not one. */
export function instantOf(local: string): string | undefined {
  if (!LOCAL_TIME.test(local) || !isDate(local.slice(0, 10))) return undefined;
  const at = Date.parse(`${local}:00+07:00`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

export function validateSchedule(form: ScheduleForm, now: Date): Partial<Record<keyof ScheduleForm, FormProblem>> {
  const problems: Partial<Record<keyof ScheduleForm, FormProblem>> = {};
  const instant = instantOf(form.scheduledAt);
  if (form.scheduledAt === '') problems.scheduledAt = 'required';
  else if (instant === undefined) problems.scheduledAt = 'date';
  else if (Date.parse(instant) < now.getTime()) problems.scheduledAt = 'past';
  if (form.participantIds.length === 0) problems.participantIds = 'noParticipant';
  return problems;
}

export interface ScheduleBody {
  scheduled_at: string;
  participant_membership_ids: string[];
}

export const scheduleBody = (form: ScheduleForm): ScheduleBody => ({ scheduled_at: instantOf(form.scheduledAt) ?? form.scheduledAt, participant_membership_ids: form.participantIds });

// ---- recording the result -------------------------------------------------------------------------------------------------------------

export interface AnswerForm {
  outcome: Outcome | '';
  note: string;
}

export interface ResultForm {
  result: InspectionResult | '';
  resultNote: string;
  /** The answers by code of the item of the checklist. */
  answers: Record<string, AnswerForm>;
}

export const emptyResult = (items: readonly ChecklistRow[]): ResultForm => ({ result: '', resultNote: '', answers: Object.fromEntries(items.map((item) => [item.code, { outcome: '', note: '' } satisfies AnswerForm])) });

export interface ResultProblems {
  result?: FormProblem;
  resultNote?: FormProblem;
  /** The problem with the answer of an item, by code. */
  answers: Record<string, FormProblem>;
  /** The problem of the whole: a result the answers contradict. */
  whole?: FormProblem;
}

/**
 * What is wrong with the result before it is sent, by the rules the server holds: every item answered; a PASS has no failed item; a FAIL or a CONDITIONAL has at least one; a
 * CONDITIONAL says its condition in the note of each failed item.
 */
export function validateResult(form: ResultForm, items: readonly ChecklistRow[]): ResultProblems {
  const problems: ResultProblems = { answers: {} };
  if (form.result === '') problems.result = 'required';
  const note = wordsProblem(form.resultNote, true);
  if (note !== undefined) problems.resultNote = note;
  for (const item of items) {
    const answer = form.answers[item.code];
    if (answer === undefined || answer.outcome === '') problems.answers[item.code] = 'unanswered';
    else if (answer.note.trim().length > MAX_TEXT) problems.answers[item.code] = 'tooLong';
  }
  if (form.result === '' || Object.keys(problems.answers).length > 0) return problems;
  const failed = items.filter((item) => form.answers[item.code]?.outcome === 'FAIL');
  if (form.result === 'PASS' && failed.length > 0) problems.whole = 'passWithFailed';
  else if (form.result !== 'PASS' && failed.length === 0) problems.whole = 'noFailed';
  else if (form.result === 'CONDITIONAL') {
    for (const item of failed) if ((form.answers[item.code]?.note.trim() ?? '') === '') problems.answers[item.code] = 'conditionUnstated';
  }
  return problems;
}

export const hasProblems = (problems: ResultProblems): boolean => problems.result !== undefined || problems.resultNote !== undefined || problems.whole !== undefined || Object.keys(problems.answers).length > 0;

export interface ResultBody {
  result: InspectionResult;
  result_note: string;
  checklist: Array<{ code: string; outcome: Outcome; note?: string }>;
}

export function resultBody(form: ResultForm, items: readonly ChecklistRow[]): ResultBody {
  return {
    result: form.result === '' ? 'PASS' : form.result,
    result_note: form.resultNote.trim(),
    checklist: items.map((item) => {
      const answer = form.answers[item.code];
      const note = answer?.note.trim() ?? '';
      return { code: item.code, outcome: answer?.outcome === '' || answer === undefined ? 'NA' : answer.outcome, ...(note === '' ? {} : { note }) };
    }),
  };
}

// ---- cancelling -----------------------------------------------------------------------------------------------------------------------------

export function validateReason(reason: string): FormProblem | undefined {
  return wordsProblem(reason, true);
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'permitGate'
  | 'contractState'
  | 'duplicate'
  | 'regime'
  | 'inspectionState'
  | 'checklistInvalid'
  | 'checklistMissing'
  | 'checklistContradicts'
  | 'checklistCondition'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'PERMIT_GATE_BLOCKED':
      return 'permitGate';
    case 'CONTRACT_STATE_INVALID':
      return 'contractState';
    case 'INSPECTION_DUPLICATE':
      return 'duplicate';
    case 'REGIME_NOT_EFFECTIVE':
      return 'regime';
    case 'INSPECTION_STATE_INVALID':
      return 'inspectionState';
    case 'CHECKLIST_INCOMPLETE':
      switch (error.extensions.reason) {
        case 'ITEMS_MISSING':
          return 'checklistMissing';
        case 'RESULT_CONTRADICTS':
          return 'checklistContradicts';
        case 'CONDITION_UNSTATED':
          return 'checklistCondition';
        default:
          return 'checklistInvalid';
      }
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}

/** The Vietnam date of `now`: the day an inspection is asked for starts from there. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
