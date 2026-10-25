import { ApiError } from '@machvon/api-client';

/** The permissions of QMS-07 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract. */
export const READ_PERMISSION = 'quality_nonconformance.read';
export const RAISE_PERMISSION = 'ncr.raise';

export const SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SOURCE_KINDS = ['INSPECTION', 'MATERIAL_TEST', 'SUPERVISOR_REMARK', 'SELF_REPORT', 'AUDIT'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const NCR_STATUSES = ['OPEN', 'ACTION_ASSIGNED', 'ACTION_SUBMITTED', 'VERIFIED', 'CLOSED', 'REOPENED'] as const;
export type NcrStatus = (typeof NCR_STATUSES)[number];
export const ACTION_STATUSES = ['ASSIGNED', 'SUBMITTED', 'REJECTED', 'VERIFIED'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export const VERIFICATIONS = ['VERIFIED', 'REJECTED'] as const;
export type Verification = (typeof VERIFICATIONS)[number];

/** The lanes of the board, in the order a non-conformance travels through them; a reopened one waits where a new one waits. */
export const LANES = ['OPEN', 'ACTION_ASSIGNED', 'ACTION_SUBMITTED', 'VERIFIED', 'CLOSED'] as const;
export type Lane = (typeof LANES)[number];
export const laneOf = (status: NcrStatus): Lane => (status === 'REOPENED' ? 'OPEN' : status);

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

export interface ActionLine {
  id: string;
  description: string;
  owner: Person;
  dueAt: string;
  overdue: boolean;
  status: ActionStatus;
  evidenceNote: string | null;
  verificationNote: string | null;
  version: number;
}

/** What the caller may do with a non-conformance as it stands (the server says; a button is shown for exactly these). */
export interface Allowed {
  assign: boolean;
  respond: boolean;
  verify: boolean;
  close: boolean;
  reopen: boolean;
}

/** One non-conformance as QMS-07 shows it. */
export interface NcrLine {
  id: string;
  ncrNo: string;
  title: string;
  description: string;
  severity: Severity;
  sourceKind: SourceKind | null;
  status: NcrStatus;
  blocksAcceptance: boolean;
  contract: { id: string; code: string };
  detectedOn: string | null;
  dueAt: string;
  overdue: boolean;
  actionOwner: Person;
  rootCause: string | null;
  closureNote: string | null;
  reopenReason: string | null;
  reopenCount: number;
  actions: ActionLine[];
  allowed: Allowed;
  /** Created at, in microseconds: the cursor of the page. */
  createdAt: string;
  version: number;
}

function toPerson(raw: unknown): Person {
  const row = asRecord(raw);
  return { membershipId: text(row?.membership_id) ?? '', displayName: text(row?.display_name) ?? '' };
}

function toAction(raw: unknown): ActionLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const status = oneOf(ACTION_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    description: text(row.description) ?? '',
    owner: toPerson(row.owner),
    dueAt: text(row.due_at) ?? '',
    overdue: row.overdue === true,
    status,
    evidenceNote: nullableText(row.evidence_note),
    verificationNote: nullableText(row.verification_note),
    version,
  };
}

export function toNcrLine(raw: unknown): NcrLine | undefined {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const id = text(row?.id);
  const contractId = text(contract?.id);
  const severity = oneOf(SEVERITIES, row?.severity);
  const status = oneOf(NCR_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || contractId === undefined || severity === undefined || status === undefined || version === undefined) return undefined;
  const allowed = asRecord(row.allowed);
  return {
    id,
    ncrNo: text(row.ncr_no) ?? '',
    title: text(row.title) ?? '',
    description: text(row.description) ?? '',
    severity,
    sourceKind: oneOf(SOURCE_KINDS, row.source_kind) ?? null,
    status,
    blocksAcceptance: row.blocks_acceptance === true,
    contract: { id: contractId, code: text(contract?.code) ?? '' },
    detectedOn: nullableText(row.detected_on),
    dueAt: text(row.due_at) ?? '',
    overdue: row.overdue === true,
    actionOwner: toPerson(row.action_owner),
    rootCause: nullableText(row.root_cause),
    closureNote: nullableText(row.closure_note),
    reopenReason: nullableText(row.reopen_reason),
    reopenCount: whole(row.reopen_count) ?? 0,
    actions: Array.isArray(row.actions) ? row.actions.flatMap((action) => toAction(action) ?? []) : [],
    allowed: { assign: allowed?.assign === true, respond: allowed?.respond === true, verify: allowed?.verify === true, close: allowed?.close === true, reopen: allowed?.reopen === true },
    createdAt: text(row.created_at) ?? '',
    version,
  };
}

export function toNcrList(raw: unknown): NcrLine[] {
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toNcrLine(item) ?? []) : [];
}

/** The lines of one lane, the one due soonest first. */
export const inLane = (lines: readonly NcrLine[], lane: Lane): NcrLine[] => lines.filter((line) => laneOf(line.status) === lane).sort((left, right) => left.dueAt.localeCompare(right.dueAt));

/** The actions the caller may answer (carried out by the caller, waiting for evidence) and the actions the caller may verify (answered, and not the caller's own). */
export const answerable = (line: NcrLine, me: string | undefined): ActionLine[] =>
  line.allowed.respond ? line.actions.filter((action) => (action.status === 'ASSIGNED' || action.status === 'REJECTED') && action.owner.membershipId === me) : [];
export const verifiable = (line: NcrLine, me: string | undefined): ActionLine[] =>
  line.allowed.verify ? line.actions.filter((action) => action.status === 'SUBMITTED' && action.owner.membershipId !== me) : [];

// ---- who may do what ----------------------------------------------------------------------------------------------------------

/** Whether the caller may raise a non-conformance: the permission is held (or not yet known) and the session is not read-only. The server judges the scope again. */
export const canRaise = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(RAISE_PERMISSION));

// ---- forms ----------------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'date' | 'uuid' | 'tooLong' | 'past' | 'sourceReference' | 'evidenceRequired';

const isDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const wordsProblem = (value: string, required: boolean): FormProblem | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return required ? 'required' : undefined;
  return trimmed.length > MAX_TEXT ? 'tooLong' : undefined;
};

const idProblem = (value: string, required: boolean): FormProblem | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return required ? 'required' : undefined;
  return UUID.test(trimmed) ? undefined : 'uuid';
};

/** The Vietnam date of `now`: a day for the work to be put right starts from there. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** The end of a day of Vietnam (UTC+7, no daylight saving) as an instant; undefined when the day is not one. */
export function endOfDay(day: string): string | undefined {
  if (!isDate(day)) return undefined;
  const at = Date.parse(`${day}T23:59:00+07:00`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

const dayProblem = (day: string, today: string): FormProblem | undefined => {
  const trimmed = day.trim();
  if (trimmed === '') return 'required';
  if (!isDate(trimmed)) return 'date';
  return trimmed < today ? 'past' : undefined;
};

export interface RaiseForm {
  contractId: string;
  severity: Severity | '';
  sourceKind: SourceKind | '';
  title: string;
  description: string;
  inspectionId: string;
  materialTestId: string;
  siteDiaryId: string;
  actionOwnerId: string;
  dueOn: string;
}

export const emptyRaise = (today: string, contractId = ''): RaiseForm => ({
  contractId,
  severity: '',
  sourceKind: '',
  title: '',
  description: '',
  inspectionId: '',
  materialTestId: '',
  siteDiaryId: '',
  actionOwnerId: '',
  dueOn: today,
});

/** What is wrong with the non-conformance before it is raised; a source names what it came from (an inspection for an inspection, a test for a test) and only that. */
export function validateRaise(form: RaiseForm, today: string): Partial<Record<keyof RaiseForm, FormProblem>> {
  const problems: Partial<Record<keyof RaiseForm, FormProblem>> = {};
  if (form.contractId === '') problems.contractId = 'required';
  if (form.severity === '') problems.severity = 'required';
  if (form.sourceKind === '') problems.sourceKind = 'required';
  const title = wordsProblem(form.title, true);
  if (title !== undefined) problems.title = title;
  const description = wordsProblem(form.description, true);
  if (description !== undefined) problems.description = description;
  if (form.actionOwnerId === '') problems.actionOwnerId = 'required';
  const due = dayProblem(form.dueOn, today);
  if (due !== undefined) problems.dueOn = due;
  const inspection = idProblem(form.inspectionId, form.sourceKind === 'INSPECTION');
  if (inspection !== undefined) problems.inspectionId = inspection === 'required' ? 'sourceReference' : inspection;
  const test = idProblem(form.materialTestId, form.sourceKind === 'MATERIAL_TEST');
  if (test !== undefined) problems.materialTestId = test === 'required' ? 'sourceReference' : test;
  const diary = idProblem(form.siteDiaryId, false);
  if (diary !== undefined) problems.siteDiaryId = diary;
  return problems;
}

export interface RaiseBody {
  contract_id: string;
  severity: Severity;
  title: string;
  description: string;
  source_kind: SourceKind;
  action_owner_id: string;
  due_at: string;
  inspection_id?: string;
  material_test_id?: string;
  site_diary_id?: string;
}

export function raiseBody(form: RaiseForm): RaiseBody {
  const source = form.sourceKind === '' ? 'SELF_REPORT' : form.sourceKind;
  const diary = form.siteDiaryId.trim();
  return {
    contract_id: form.contractId,
    severity: form.severity === '' ? 'MINOR' : form.severity,
    title: form.title.trim(),
    description: form.description.trim(),
    source_kind: source,
    action_owner_id: form.actionOwnerId,
    due_at: endOfDay(form.dueOn.trim()) ?? form.dueOn,
    ...(source === 'INSPECTION' ? { inspection_id: form.inspectionId.trim().toLowerCase() } : {}),
    ...(source === 'MATERIAL_TEST' ? { material_test_id: form.materialTestId.trim().toLowerCase() } : {}),
    ...(diary === '' ? {} : { site_diary_id: diary.toLowerCase() }),
  };
}

export interface AssignForm {
  description: string;
  ownerId: string;
  dueOn: string;
}

export const emptyAssign = (today: string): AssignForm => ({ description: '', ownerId: '', dueOn: today });

export function validateAssign(form: AssignForm, today: string): Partial<Record<keyof AssignForm, FormProblem>> {
  const problems: Partial<Record<keyof AssignForm, FormProblem>> = {};
  const description = wordsProblem(form.description, true);
  if (description !== undefined) problems.description = description;
  if (form.ownerId === '') problems.ownerId = 'required';
  const due = dayProblem(form.dueOn, today);
  if (due !== undefined) problems.dueOn = due;
  return problems;
}

export interface AssignBody {
  description: string;
  owner_membership_id: string;
  due_at: string;
}

export const assignBody = (form: AssignForm): AssignBody => ({ description: form.description.trim(), owner_membership_id: form.ownerId, due_at: endOfDay(form.dueOn.trim()) ?? form.dueOn });

export interface EvidenceForm {
  documentVersionId: string;
  photoId: string;
  note: string;
}

export const EMPTY_EVIDENCE: EvidenceForm = { documentVersionId: '', photoId: '', note: '' };

/** The evidence is a document or a photo, with a note that says what was done. */
export function validateEvidence(form: EvidenceForm): Partial<Record<keyof EvidenceForm, FormProblem>> {
  const problems: Partial<Record<keyof EvidenceForm, FormProblem>> = {};
  const document = idProblem(form.documentVersionId, false);
  if (document !== undefined) problems.documentVersionId = document;
  const photo = idProblem(form.photoId, false);
  if (photo !== undefined) problems.photoId = photo;
  if (form.documentVersionId.trim() === '' && form.photoId.trim() === '') problems.documentVersionId = 'evidenceRequired';
  const note = wordsProblem(form.note, true);
  if (note !== undefined) problems.note = note;
  return problems;
}

export interface EvidenceBody {
  note: string;
  evidence_document_version_id?: string;
  evidence_photo_id?: string;
}

export function evidenceBody(form: EvidenceForm): EvidenceBody {
  const document = form.documentVersionId.trim();
  const photo = form.photoId.trim();
  return { note: form.note.trim(), ...(document === '' ? {} : { evidence_document_version_id: document.toLowerCase() }), ...(photo === '' ? {} : { evidence_photo_id: photo.toLowerCase() }) };
}

export interface VerifyForm {
  outcome: Verification | '';
  note: string;
}

export const EMPTY_VERIFY: VerifyForm = { outcome: '', note: '' };

export function validateVerify(form: VerifyForm): Partial<Record<keyof VerifyForm, FormProblem>> {
  const problems: Partial<Record<keyof VerifyForm, FormProblem>> = {};
  if (form.outcome === '') problems.outcome = 'required';
  const note = wordsProblem(form.note, true);
  if (note !== undefined) problems.note = note;
  return problems;
}

/** The words of a closing or of a reopening: one note, kept with the non-conformance. */
export function validateNote(note: string): FormProblem | undefined {
  return wordsProblem(note, true);
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------

export type Problem =
  'contractState' | 'ncrState' | 'actionState' | 'actionsOpen' | 'evidenceRequired' | 'notClean' | 'selfApproval' | 'versionConflict' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'CONTRACT_STATE_INVALID':
      return 'contractState';
    case 'NCR_STATE_INVALID':
      return 'ncrState';
    case 'CORRECTIVE_ACTION_STATE_INVALID':
      return 'actionState';
    case 'CORRECTIVE_ACTION_OPEN':
      return 'actionsOpen';
    case 'EVIDENCE_REQUIRED':
      return 'evidenceRequired';
    case 'DOCUMENT_NOT_CLEAN':
    case 'FILE_NOT_CLEAN':
      return 'notClean';
    case 'SELF_APPROVAL_DENIED':
      return 'selfApproval';
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
