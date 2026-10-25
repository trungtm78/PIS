import { ApiError } from '@machvon/api-client';

/** The permissions of BID-20 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the project and the people. */
export const READ_PERMISSION = 'bid.read';
export const MANAGE_PERMISSION = 'bid.petition.manage';

export const PETITION_KINDS = ['PROCESS', 'RESULT'] as const;
export type PetitionKind = (typeof PETITION_KINDS)[number];
export const PETITION_STATUSES = ['RECEIVED', 'PROCESSING', 'RESOLVED', 'ESCALATED', 'WITHDRAWN'] as const;
export type PetitionStatus = (typeof PETITION_STATUSES)[number];
export const OUTCOMES = ['RESOLVED', 'ESCALATED'] as const;
export type Outcome = (typeof OUTCOMES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

export interface Person {
  membershipId: string;
  displayName: string;
}

/** One petition of a contractor as BID-20 shows it. */
export interface PetitionLine {
  id: string;
  package: { id: string; code: string };
  contractor: { id: string; legalName: string };
  petitionKind: PetitionKind;
  receivedOn: string;
  /** The last day to answer. */
  dueOn: string;
  daysApplied: number;
  status: PetitionStatus;
  overdue: boolean;
  daysOverdue: number;
  petitionDocumentId: string;
  resolutionDocumentId: string | null;
  viewerInConflict: boolean;
  handledBy: Person | null;
  resolvedAt: string | null;
  canResolve: boolean;
  version: number;
}

function toPerson(raw: unknown): Person | null {
  const row = asRecord(raw);
  const membershipId = text(row?.membership_id);
  return row === undefined || membershipId === undefined ? null : { membershipId, displayName: text(row.display_name) ?? '' };
}

export function toPetitionLine(raw: unknown): PetitionLine | undefined {
  const row = asRecord(raw);
  const pack = asRecord(row?.package);
  const contractor = asRecord(row?.contractor);
  const id = text(row?.id);
  const packageId = text(pack?.id);
  const contractorId = text(contractor?.id);
  const kind = PETITION_KINDS.find((candidate) => candidate === row?.petition_kind);
  const status = PETITION_STATUSES.find((candidate) => candidate === row?.status);
  const receivedOn = text(row?.received_on);
  const dueOn = text(row?.due_on);
  const documentId = text(row?.petition_document_id);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || packageId === undefined || contractorId === undefined || kind === undefined || status === undefined || receivedOn === undefined || dueOn === undefined || documentId === undefined || version === undefined) {
    return undefined;
  }
  const actions = asRecord(row.actions);
  return {
    id,
    package: { id: packageId, code: text(pack?.code) ?? '' },
    contractor: { id: contractorId, legalName: text(contractor?.legal_name) ?? '' },
    petitionKind: kind,
    receivedOn,
    dueOn,
    daysApplied: whole(row.days_applied) ?? 0,
    status,
    overdue: row.overdue === true,
    daysOverdue: whole(row.days_overdue) ?? 0,
    petitionDocumentId: documentId,
    resolutionDocumentId: nullableText(row.resolution_document_id),
    viewerInConflict: row.viewer_in_conflict === true,
    handledBy: toPerson(row.handled_by),
    resolvedAt: nullableText(row.resolved_at),
    canResolve: actions?.resolve === true,
    version,
  };
}

export function toPetitionList(raw: unknown): PetitionLine[] {
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toPetitionLine(item) ?? []) : [];
}

// ---- who may do what ----------------------------------------------------------------------------------------------------------

/** Whether the caller may log a petition: the permission is held (or not yet known) and the session is not read-only. The server judges the scope again. */
export const canReceive = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(MANAGE_PERMISSION));

// ---- logging a petition ---------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'date' | 'future' | 'uuid';

export interface ReceiveForm {
  petitionKind: PetitionKind | '';
  contractorId: string;
  receivedOn: string;
  documentId: string;
}

export const emptyReceive = (today: string): ReceiveForm => ({ petitionKind: '', contractorId: '', receivedOn: today, documentId: '' });

const isDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** What is wrong with the petition before it is sent: the kind, the contractor, a day that is a day and not after today, and the paper that lodges it. */
export function validateReceive(form: ReceiveForm, today: string): Partial<Record<keyof ReceiveForm, FormProblem>> {
  const problems: Partial<Record<keyof ReceiveForm, FormProblem>> = {};
  if (form.petitionKind === '') problems.petitionKind = 'required';
  if (form.contractorId === '') problems.contractorId = 'required';
  const day = form.receivedOn.trim();
  if (day === '') problems.receivedOn = 'required';
  else if (!isDate(day)) problems.receivedOn = 'date';
  else if (day > today) problems.receivedOn = 'future';
  const document = form.documentId.trim();
  if (document === '') problems.documentId = 'required';
  else if (!UUID.test(document)) problems.documentId = 'uuid';
  return problems;
}

export interface ReceiveBody {
  package_id: string;
  contractor_id: string;
  petition_kind: PetitionKind;
  received_on: string;
  petition_document_id: string;
}

export function receiveBody(packageId: string, form: ReceiveForm): ReceiveBody {
  return {
    package_id: packageId,
    contractor_id: form.contractorId,
    petition_kind: form.petitionKind === '' ? 'PROCESS' : form.petitionKind,
    received_on: form.receivedOn.trim(),
    petition_document_id: form.documentId.trim().toLowerCase(),
  };
}

// ---- answering a petition -------------------------------------------------------------------------------------------------------------

export interface ResolveForm {
  outcome: Outcome | '';
  documentId: string;
}

export const EMPTY_RESOLVE: ResolveForm = { outcome: '', documentId: '' };

/** An answer, or passing the petition on to the level above, rests on a document. */
export function validateResolve(form: ResolveForm): Partial<Record<keyof ResolveForm, FormProblem>> {
  const problems: Partial<Record<keyof ResolveForm, FormProblem>> = {};
  if (form.outcome === '') problems.outcome = 'required';
  const document = form.documentId.trim();
  if (document === '') problems.documentId = 'required';
  else if (!UUID.test(document)) problems.documentId = 'uuid';
  return problems;
}

export interface ResolveBody {
  outcome: Outcome;
  resolution_document_id: string;
}

export const resolveBody = (form: ResolveForm): ResolveBody => ({ outcome: form.outcome === '' ? 'RESOLVED' : form.outcome, resolution_document_id: form.documentId.trim().toLowerCase() });

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'outOfTimeFuture'
  | 'outOfTimeNoResult'
  | 'outOfTimeBeforeResult'
  | 'outOfTimeFiling'
  | 'documentLodged'
  | 'petitionState'
  | 'conflict'
  | 'ruleUnconfirmed'
  | 'calendar'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ProblemView {
  problem: Problem;
  /** The last day on which a petition about the result could still be lodged, when the server said it. */
  lastDayToFile: string | undefined;
}

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): ProblemView {
  const view = (problem: Problem): ProblemView => ({ problem, lastDayToFile: undefined });
  if (!(error instanceof ApiError)) return view('general');
  const extensions = error.extensions;
  switch (error.code) {
    case 'PETITION_OUT_OF_TIME':
      switch (extensions.reason) {
        case 'FUTURE':
          return view('outOfTimeFuture');
        case 'NO_RESULT':
          return view('outOfTimeNoResult');
        case 'BEFORE_RESULT':
          return view('outOfTimeBeforeResult');
        default:
          return { problem: 'outOfTimeFiling', lastDayToFile: typeof extensions.last_day_to_file === 'string' ? extensions.last_day_to_file : undefined };
      }
    case 'PETITION_STATE_INVALID':
      return view(extensions.reason === 'DOCUMENT_ALREADY_LODGED' ? 'documentLodged' : 'petitionState');
    case 'CONFLICT_OF_INTEREST_BLOCKED':
      return view('conflict');
    case 'TIMER_RULE_UNCONFIRMED':
      return view('ruleUnconfirmed');
    case 'CALENDAR_NOT_EFFECTIVE':
      return view('calendar');
    case 'VERSION_CONFLICT':
      return view('versionConflict');
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return view('validation');
    case 'RESOURCE_NOT_FOUND':
      return view('notFound');
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return view('denied');
    case 'SESSION_EXPIRED':
      return view('session');
    default:
      return view('general');
  }
}

/** The Vietnam date of `now`: a petition cannot be received on a day that has not come there. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
