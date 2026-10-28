import { ApiError } from '@machvon/api-client';

/** The permissions of DOC-11..13 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the units. */
export const RECEIVE_PERMISSION = 'doc.incoming.receive';
export const REGISTER_PERMISSION = 'doc.incoming.register';
export const READ_PERMISSION = 'doc.incoming.read';
export const UPLOAD_PERMISSION = 'doc.file.upload';

export const INCOMING_STATUSES = ['RECEIVED', 'REGISTERED', 'ASSIGNED', 'PROCESSING', 'RESOLVED', 'FILED', 'REJECTED'] as const;
export type IncomingStatus = (typeof INCOMING_STATUSES)[number];
export const CHANNELS = ['PAPER_SCAN', 'EMAIL', 'LGSP', 'PORTAL', 'UPLOAD'] as const;
export type Channel = (typeof CHANNELS)[number];
export const URGENCIES = ['NORMAL', 'KHAN', 'THUONG_KHAN', 'HOA_TOC'] as const;
export type Urgency = (typeof URGENCIES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

export interface IncomingActions {
  register: boolean;
  reject: boolean;
  assign: boolean;
  startProcessing: boolean;
  resolve: boolean;
}

export interface IncomingAssignmentLine {
  id: string;
  unitName: string;
  assignee: string | null;
  directive: string | null;
  dueOn: string | null;
  assignedAt: string;
}

/** One letter as DOC-11..13 show it. */
export interface IncomingLine {
  id: string;
  status: IncomingStatus;
  channel: Channel;
  title: string;
  docTypeCode: string;
  receivedAt: string;
  register: { id: string; code: string } | null;
  number: number | null;
  symbol: string | null;
  originalSymbol: string | null;
  originalIssuedOn: string | null;
  senderName: string;
  urgency: Urgency;
  dueOn: string | null;
  leaderDirective: string | null;
  assignedUnit: { id: string; name: string } | null;
  assignee: { userId: string; name: string } | null;
  resolutionSummary: string | null;
  resolvedAt: string | null;
  lateDays: number | null;
  duplicateOfId: string | null;
  duplicateOverrideReason: string | null;
  rejectionReason: string | null;
  isOverdue: boolean;
  overdueDays: number | null;
  actions: IncomingActions;
  assignments: IncomingAssignmentLine[];
  version: number;
}

export function toIncomingLine(raw: unknown): IncomingLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const status = oneOf(INCOMING_STATUSES, row?.status);
  const channel = oneOf(CHANNELS, row?.channel);
  const receivedAt = text(row?.received_at);
  const version = typeof row?.version === 'number' && Number.isInteger(row.version) ? row.version : undefined;
  if (row === undefined || id === undefined || status === undefined || channel === undefined || receivedAt === undefined || version === undefined) return undefined;
  const register = asRecord(row.register);
  const unit = asRecord(row.assigned_unit);
  const assignee = asRecord(row.assignee);
  const actions = asRecord(row.actions);
  return {
    id,
    status,
    channel,
    title: text(row.title) ?? '',
    docTypeCode: text(row.doc_type_code) ?? '',
    receivedAt,
    register: register === undefined || text(register.id) === undefined ? null : { id: text(register.id) ?? '', code: text(register.code) ?? '' },
    number: typeof row.number === 'number' ? row.number : null,
    symbol: nullableText(row.symbol),
    originalSymbol: nullableText(row.original_symbol),
    originalIssuedOn: nullableText(row.original_issued_on),
    senderName: text(row.sender_name) ?? '',
    urgency: oneOf(URGENCIES, row.urgency) ?? 'NORMAL',
    dueOn: nullableText(row.due_on),
    leaderDirective: nullableText(row.leader_directive),
    assignedUnit: unit === undefined || text(unit.id) === undefined ? null : { id: text(unit.id) ?? '', name: text(unit.name) ?? '' },
    assignee: assignee === undefined || text(assignee.user_id) === undefined ? null : { userId: text(assignee.user_id) ?? '', name: text(assignee.display_name) ?? '' },
    resolutionSummary: nullableText(row.resolution_summary),
    resolvedAt: nullableText(row.resolved_at),
    lateDays: typeof row.late_days === 'number' ? row.late_days : null,
    duplicateOfId: nullableText(row.duplicate_of_id),
    duplicateOverrideReason: nullableText(row.duplicate_override_reason),
    rejectionReason: nullableText(row.rejection_reason),
    isOverdue: row.is_overdue === true,
    overdueDays: typeof row.overdue_days === 'number' ? row.overdue_days : null,
    actions: {
      register: actions?.register === true,
      reject: actions?.reject === true,
      assign: actions?.assign === true,
      startProcessing: actions?.startProcessing === true,
      resolve: actions?.resolve === true,
    },
    assignments: Array.isArray(row.assignments)
      ? row.assignments.flatMap((entry) => {
          const item = asRecord(entry);
          const unitOf = asRecord(item?.assigned_unit);
          const who = asRecord(item?.assignee);
          const assignedAt = text(item?.assigned_at);
          if (item === undefined || assignedAt === undefined || text(item.id) === undefined) return [];
          return [{ id: text(item.id) ?? '', unitName: text(unitOf?.name) ?? '', assignee: who === undefined ? null : (text(who.display_name) ?? text(who.user_id) ?? null), directive: nullableText(item.leader_directive), dueOn: nullableText(item.due_on), assignedAt }];
        })
      : [],
    version,
  };
}

export interface IncomingPage {
  lines: IncomingLine[];
  next: string | undefined;
}

export function toIncomingPage(raw: unknown): IncomingPage {
  const body = asRecord(raw);
  return { lines: Array.isArray(body?.items) ? body.items.flatMap((entry) => toIncomingLine(entry) ?? []) : [], next: text(body?.next_cursor) };
}

/** Whether the session may act at all: only a read-only session (a suspended tenant) may not; what each command needs is the server's to say (the flags of `actions`). */
export const canAct = (mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY';

export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/** `YYYY-MM-DD` of an instant on the calendar of Vietnam, the calendar a deadline is kept in. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export const ledgerLink = (): string => '/doc/doc-12';
export const intakeLink = (): string => '/doc/doc-11';
export const handlingLink = (id: string): string => `/doc/doc-13?id=${id}`;

// ---- the filter -------------------------------------------------------------------------------------------------------------------

export interface IncomingFilter {
  status: string;
  overdue: boolean;
  year: string;
}
export const NO_FILTER: IncomingFilter = { status: '', overdue: false, year: '' };

/** What the filter asks the server for: only what was chosen and is well formed. */
export function filterQuery(filter: IncomingFilter): Record<string, string> {
  return {
    ...(oneOf(INCOMING_STATUSES, filter.status) === undefined ? {} : { status: filter.status }),
    ...(filter.overdue ? { overdue: 'true' } : {}),
    ...(/^\d{4}$/.test(filter.year) ? { year: filter.year } : {}),
  };
}

// ---- the forms --------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidDate' | 'futureDate' | 'pastDate' | 'invalidId' | 'notPdf';

export interface ReceiveForm {
  title: string;
  docTypeCode: string;
  channel: Channel | '';
  senderName: string;
  originalSymbol: string;
  originalIssuedOn: string;
  urgency: Urgency;
  duplicateReason: string;
}

export const emptyReceive = (): ReceiveForm => ({ title: '', docTypeCode: '', channel: 'UPLOAD', senderName: '', originalSymbol: '', originalIssuedOn: '', urgency: 'NORMAL', duplicateReason: '' });

const realDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

export function validateReceive(form: ReceiveForm, file: { name: string; type: string; size: number } | undefined, today: string): Partial<Record<keyof ReceiveForm | 'file', FormProblem>> {
  const problems: Partial<Record<keyof ReceiveForm | 'file', FormProblem>> = {};
  const title = form.title.trim();
  if (title.length < 3) problems.title = title === '' ? 'required' : 'tooShort';
  else if (title.length > 500) problems.title = 'tooLong';
  if (form.docTypeCode.trim() === '') problems.docTypeCode = 'required';
  if (form.channel === '') problems.channel = 'required';
  const sender = form.senderName.trim();
  if (sender.length < 2) problems.senderName = sender === '' ? 'required' : 'tooShort';
  else if (sender.length > 300) problems.senderName = 'tooLong';
  if (form.originalSymbol.trim().length > 80) problems.originalSymbol = 'tooLong';
  if (form.originalIssuedOn !== '') {
    if (!realDate(form.originalIssuedOn)) problems.originalIssuedOn = 'invalidDate';
    else if (form.originalIssuedOn > today) problems.originalIssuedOn = 'futureDate';
  }
  const reason = form.duplicateReason.trim();
  if (reason !== '' && reason.length < 10) problems.duplicateReason = 'tooShort';
  else if (reason.length > 500) problems.duplicateReason = 'tooLong';
  if (file === undefined) problems.file = 'required';
  else if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) problems.file = 'notPdf';
  return problems;
}

export interface ReceiveBody {
  title: string;
  doc_type_code: string;
  channel: Channel;
  file_object_key: string;
  file_sha256: string;
  sender_name: string;
  urgency: Urgency;
  original_symbol?: string;
  original_issued_on?: string;
  duplicate_override_reason?: string;
}

export function receiveBody(form: ReceiveForm, file: { key: string; sha256: string }): ReceiveBody {
  const symbol = form.originalSymbol.trim();
  const reason = form.duplicateReason.trim();
  return {
    title: form.title.trim(),
    doc_type_code: form.docTypeCode.trim(),
    channel: form.channel === '' ? 'UPLOAD' : form.channel,
    file_object_key: file.key,
    file_sha256: file.sha256,
    sender_name: form.senderName.trim(),
    urgency: form.urgency,
    ...(symbol === '' ? {} : { original_symbol: symbol }),
    ...(form.originalIssuedOn === '' ? {} : { original_issued_on: form.originalIssuedOn }),
    ...(reason === '' ? {} : { duplicate_override_reason: reason }),
  };
}

export interface AssignForm {
  unitId: string;
  assigneeUserId: string;
  directive: string;
  dueOn: string;
}
export const emptyAssign = (): AssignForm => ({ unitId: '', assigneeUserId: '', directive: '', dueOn: '' });

export function validateAssign(form: AssignForm, today: string): Partial<Record<keyof AssignForm, FormProblem>> {
  const problems: Partial<Record<keyof AssignForm, FormProblem>> = {};
  if (form.unitId === '') problems.unitId = 'required';
  else if (!UUID.test(form.unitId)) problems.unitId = 'invalidId';
  if (form.assigneeUserId.trim() !== '' && !UUID.test(form.assigneeUserId.trim())) problems.assigneeUserId = 'invalidId';
  if (form.directive.length > 2000) problems.directive = 'tooLong';
  if (form.dueOn !== '') {
    if (!realDate(form.dueOn)) problems.dueOn = 'invalidDate';
    else if (form.dueOn < today) problems.dueOn = 'pastDate';
  }
  return problems;
}

export interface AssignBody {
  assigned_unit_id: string;
  assignee_user_id?: string;
  leader_directive?: string;
  due_on?: string;
}

export function assignBody(form: AssignForm): AssignBody {
  return {
    assigned_unit_id: form.unitId,
    ...(form.assigneeUserId.trim() === '' ? {} : { assignee_user_id: form.assigneeUserId.trim() }),
    ...(form.directive.trim() === '' ? {} : { leader_directive: form.directive.trim() }),
    ...(form.dueOn === '' ? {} : { due_on: form.dueOn }),
  };
}

export function validateWords(value: string, min: number, max: number): FormProblem | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  if (trimmed.length < min) return 'tooShort';
  return trimmed.length > max ? 'tooLong' : undefined;
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export type Problem =
  'duplicate' | 'notPdf' | 'scanPending' | 'infected' | 'stateSecret' | 'wrongState' | 'registerNotOpen' | 'registerBusy' | 'outOfScope' | 'dueInPast' | 'notAssignee' | 'responseNotIssued' | 'versionConflict' | 'validation' | 'registerChoice' | 'notFound' | 'denied' | 'session' | 'general';

/** The open registers that the server names when it cannot choose one (`register_id` is needed). */
export function openRegistersOf(error: unknown): Array<{ id: string; code: string; name: string }> {
  const named = error instanceof ApiError ? error.extensions.open_registers : undefined;
  if (!Array.isArray(named)) return [];
  const found: Array<{ id: string; code: string; name: string }> = [];
  for (const entry of named) {
    const row = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    if (typeof row.id === 'string' && typeof row.register_code === 'string') found.push({ id: row.id, code: row.register_code, name: typeof row.name === 'string' ? row.name : '' });
  }
  return found;
}

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'INCOMING_DUPLICATE_SUSPECTED':
      return 'duplicate';
    case 'UPLOAD_NOT_PDF':
      return 'notPdf';
    case 'SCAN_PENDING':
      return 'scanPending';
    case 'FILE_NOT_CLEAN':
      return 'infected';
    case 'STATE_SECRET_NOT_SUPPORTED':
      return 'stateSecret';
    case 'DOCUMENT_STATE_INVALID':
      return 'wrongState';
    case 'REGISTER_NOT_OPEN':
      return 'registerNotOpen';
    case 'REGISTER_LOCK_TIMEOUT':
      return 'registerBusy';
    case 'ASSIGNEE_OUT_OF_SCOPE':
      return 'outOfScope';
    case 'DUE_DATE_IN_PAST':
      return 'dueInPast';
    case 'NOT_ASSIGNEE':
      return 'notAssignee';
    case 'RESPONSE_DOCUMENT_NOT_ISSUED':
      return 'responseNotIssued';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
      // Several registers are open for the caller and none was named.
      return error.detail === 'register_id' ? 'registerChoice' : 'validation';
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

/** The letter that a suspected duplicate is a copy of, as the refusal names it. */
export function duplicateOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== 'INCOMING_DUPLICATE_SUSPECTED') return undefined;
  const id = error.extensions.duplicate_of_id;
  return typeof id === 'string' && UUID.test(id) ? id : undefined;
}
