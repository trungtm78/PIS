import { ApiError } from '@machvon/api-client';
import { SIGNER_ROLES } from '../inspection/model';
import type { SignerRole } from '../inspection/model';

export { SIGNER_ROLES };
export type { SignerRole };

/** The permissions of QMS-01..03 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract. */
export const READ_PERMISSION = 'site_diary.read';
export const WRITE_PERMISSION = 'diary.write';

export const DIARY_STATUSES = ['DRAFT', 'CONTRACTOR_SIGNED', 'SUPERVISED', 'OWNER_CONFIRMED', 'LOCKED', 'SUPERSEDED'] as const;
export type DiaryStatus = (typeof DIARY_STATUSES)[number];
export const SIGNATURE_METHODS = ['IN_APP_OTP', 'IN_APP_WEBAUTHN', 'DIGITAL_CERT'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];
export const LEGAL_EFFECTS = ['INTERNAL_RECORD', 'LEGAL_E_SIGNATURE'] as const;
export type LegalEffect = (typeof LEGAL_EFFECTS)[number];
/** The roles that sign a diary, in the order they sign. */
export const DIARY_ROLES = ['CONTRACTOR', 'SUPERVISOR', 'OWNER'] as const;
export type DiaryRole = (typeof DIARY_ROLES)[number];
export const WEATHER_CODES = ['SUNNY', 'CLOUDY', 'RAIN', 'HEAVY_RAIN', 'STORM', 'HOT', 'COLD'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 2000;
/** What the server takes as a weather code (the kernel's shape), not only the ones the form offers. */
const WEATHER_SHAPE = /^[A-Z][A-Z0-9_]{1,19}$/;
const MAX_SUMMARY = 8000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

export interface DiarySignature {
  role: DiaryRole;
  signerName: string;
  method: SignatureMethod;
  legalEffect: LegalEffect;
  certSerial: string | null;
  signedAt: string;
  /** Whether it is over the hash the diary carries; one that is not is void. */
  valid: boolean;
}

/** The ways a person settles the conflict of two devices. */
export const CONFLICT_RESOLUTIONS = ['KEEP_PRIMARY', 'ADOPT_CONFLICT', 'MERGED'] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

/** What a device left when it saved over a draft it had not read at its version, and how a person settled it. */
export interface ConflictCopy {
  id: string;
  diaryNo: string;
  state: 'CONFLICT_PENDING' | 'RESOLVED';
  deviceId: string | null;
  author: string;
  createdAt: string;
  content: Raw;
  resolution: ConflictResolution | null;
  note: string | null;
  discarded: Raw | null;
  resolvedAt: string | null;
}

export interface DiaryActions {
  resolveConflict: boolean;
  revise: boolean;
  contractorSign: boolean;
  supervise: boolean;
  ownerConfirm: boolean;
  lock: boolean;
  correct: boolean;
}

/** One diary as QMS-01..03 show it. */
export interface DiaryLine {
  id: string;
  diaryNo: string;
  contract: { id: string; code: string; status: string };
  recordDate: string;
  status: DiaryStatus;
  content: Raw;
  weatherCode: string | null;
  workforceCount: number | null;
  supervisorRemark: string | null;
  ownerNote: string | null;
  lockReason: string | null;
  correctionOfId: string | null;
  correctionReason: string | null;
  /** The copies that devices left for this diary, oldest first. */
  conflicts: ConflictCopy[];
  author: string;
  signatures: DiarySignature[];
  /** What the regime says about the value of an in-app signature: while the business has not confirmed it (the CXN), the screen says so. */
  signatureValue: { cxn: string; awaitingConfirmation: boolean };
  signableRoles: DiaryRole[];
  actions: DiaryActions;
  version: number;
}

function toSignature(raw: unknown): DiarySignature | undefined {
  const row = asRecord(raw);
  const role = oneOf(DIARY_ROLES, row?.role);
  const method = oneOf(SIGNATURE_METHODS, row?.method);
  const effect = oneOf(LEGAL_EFFECTS, row?.legal_effect);
  const signedAt = text(row?.signed_at);
  if (row === undefined || role === undefined || method === undefined || effect === undefined || signedAt === undefined) return undefined;
  return { role, signerName: text(row.signer_name) ?? '', method, legalEffect: effect, certSerial: nullableText(row.cert_serial), signedAt, valid: row.valid === true };
}

function toConflictCopy(raw: unknown): ConflictCopy | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const state = row?.state === 'CONFLICT_PENDING' || row?.state === 'RESOLVED' ? row.state : undefined;
  const createdAt = text(row?.created_at);
  if (row === undefined || id === undefined || state === undefined || createdAt === undefined) return undefined;
  const author = asRecord(row.author);
  return {
    id,
    diaryNo: text(row.diary_no) ?? '',
    state,
    deviceId: nullableText(row.device_id),
    author: text(author?.display_name) ?? '',
    createdAt,
    content: asRecord(row.content) ?? {},
    resolution: oneOf(CONFLICT_RESOLUTIONS, row.resolution) ?? null,
    note: nullableText(row.note),
    discarded: asRecord(row.discarded) ?? null,
    resolvedAt: nullableText(row.resolved_at),
  };
}

export const pendingConflicts = (line: DiaryLine): ConflictCopy[] => line.conflicts.filter((copy) => copy.state === 'CONFLICT_PENDING');

export function toDiaryLine(raw: unknown): DiaryLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const contract = asRecord(row?.contract);
  const status = oneOf(DIARY_STATUSES, row?.status);
  const version = whole(row?.version);
  const date = text(row?.record_date);
  const actions = asRecord(row?.actions);
  if (row === undefined || id === undefined || contract === undefined || status === undefined || version === undefined || date === undefined || !DATE.test(date) || actions === undefined) return undefined;
  const author = asRecord(row.author);
  const value = asRecord(row.signature_value);
  return {
    id,
    diaryNo: text(row.diary_no) ?? '',
    contract: { id: text(contract.id) ?? '', code: text(contract.code) ?? '', status: text(contract.status) ?? '' },
    recordDate: date,
    status,
    content: asRecord(row.content) ?? {},
    weatherCode: nullableText(row.weather_code),
    workforceCount: whole(row.workforce_count) ?? null,
    supervisorRemark: nullableText(row.supervisor_remark),
    ownerNote: nullableText(row.owner_note),
    lockReason: nullableText(row.lock_reason),
    correctionOfId: nullableText(row.correction_of_id),
    correctionReason: nullableText(row.correction_reason),
    conflicts: Array.isArray(row.conflicts) ? row.conflicts.flatMap((entry) => toConflictCopy(entry) ?? []) : [],
    author: text(author?.display_name) ?? '',
    signatures: Array.isArray(row.signatures) ? row.signatures.flatMap((entry) => toSignature(entry) ?? []) : [],
    // Until the server says otherwise the value of an in-app signature is not settled: the screen never claims more than it was told.
    signatureValue: { cxn: text(value?.cxn) ?? 'CXN-EXE-05', awaitingConfirmation: value?.awaiting_confirmation !== false },
    signableRoles: Array.isArray(row.signable_roles) ? row.signable_roles.flatMap((role) => oneOf(DIARY_ROLES, role) ?? []) : [],
    actions: {
      resolveConflict: actions.resolveConflict === true,
      revise: actions.revise === true,
      contractorSign: actions.contractorSign === true,
      supervise: actions.supervise === true,
      ownerConfirm: actions.ownerConfirm === true,
      lock: actions.lock === true,
      correct: actions.correct === true,
    },
    version,
  };
}

export interface DiaryPage {
  lines: DiaryLine[];
  next: string | undefined;
}

export function toDiaryPage(raw: unknown): DiaryPage {
  const body = asRecord(raw);
  return { lines: Array.isArray(body?.items) ? body.items.flatMap((entry) => toDiaryLine(entry) ?? []) : [], next: text(body?.next_cursor) };
}

/** Whether the session may act on a diary at all: what each command needs is the server's to say (the flags of `actions` are judged for the permission of that command), so only a read-only session is refused here. */
export const canAct = (mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY';

export const canWrite = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(WRITE_PERMISSION));

/** The fields of the content that the form does not edit: whatever else the diary carries (equipment, incidents, what another client wrote) is signed with it, so it is shown as it is. */
export function otherContent(content: Raw): Raw {
  return Object.fromEntries(Object.entries(content).filter(([key, value]) => !representable(key, value)));
}

/** Whether the form can show and write back a field of the content as it is: the fields it edits, holding the kind of value it edits (text, a code, a whole number). Anything else is kept and shown as it is. */
function representable(key: string, value: unknown): boolean {
  switch (key) {
    case 'summary':
    case 'notes':
    case 'weather_code':
      return typeof value === 'string';
    case 'workforce_count':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return false;
  }
}

/** The signatures of the diary in the order the roles sign, with the ones that are missing. */
export const signedRoles = (line: DiaryLine): DiaryRole[] => DIARY_ROLES.filter((role) => line.signatures.some((signature) => signature.role === role && signature.valid));

export const isOpen = (status: DiaryStatus): boolean => status !== 'LOCKED' && status !== 'SUPERSEDED';

// ---- the filter -------------------------------------------------------------------------------------------------------------------

export interface DiaryFilter {
  contractId: string;
  status: string;
  from: string;
  to: string;
  /** Only the diaries that have a copy of a device that nobody has settled. */
  hasConflict: boolean;
}
export const NO_FILTER: DiaryFilter = { contractId: '', status: '', from: '', to: '', hasConflict: false };

/** What the filter asks the server for: only what was chosen and is well formed. */
export function filterQuery(filter: DiaryFilter): Record<string, string> {
  return {
    ...(UUID.test(filter.contractId) ? { contract_id: filter.contractId } : {}),
    ...(oneOf(DIARY_STATUSES, filter.status) === undefined ? {} : { status: filter.status }),
    ...(DATE.test(filter.from) ? { from: filter.from } : {}),
    ...(DATE.test(filter.to) ? { to: filter.to } : {}),
    ...(filter.hasConflict ? { has_conflict: 'true' } : {}),
  };
}

// ---- the form ---------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooLong' | 'invalidDate' | 'futureDate' | 'invalidNumber' | 'invalidWeather' | 'certSerial';

export interface DiaryForm {
  contractId: string;
  recordDate: string;
  summary: string;
  weatherCode: string;
  workforceCount: string;
  notes: string;
}

export const emptyDiary = (today: string): DiaryForm => ({ contractId: '', recordDate: today, summary: '', weatherCode: '', workforceCount: '', notes: '' });

/** What the form shows of a diary that exists: its summary, weather, workforce and notes. */
export function formOf(line: DiaryLine): DiaryForm {
  const summary = line.content.summary;
  const notes = line.content.notes;
  return {
    contractId: line.contract.id,
    recordDate: line.recordDate,
    summary: typeof summary === 'string' ? summary : '',
    weatherCode: line.weatherCode ?? '',
    workforceCount: line.workforceCount === null ? '' : String(line.workforceCount),
    notes: typeof notes === 'string' ? notes : '',
  };
}

export function validateDiary(form: DiaryForm, today: string, withDay: boolean): Partial<Record<keyof DiaryForm, FormProblem>> {
  const problems: Partial<Record<keyof DiaryForm, FormProblem>> = {};
  if (withDay) {
    if (!UUID.test(form.contractId)) problems.contractId = 'required';
    const parsed = Date.parse(`${form.recordDate}T00:00:00Z`);
    if (!DATE.test(form.recordDate) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== form.recordDate) problems.recordDate = 'invalidDate';
    else if (form.recordDate > today) problems.recordDate = 'futureDate';
  }
  const summary = form.summary.trim();
  if (summary === '') problems.summary = 'required';
  else if (summary.length > MAX_SUMMARY) problems.summary = 'tooLong';
  if (form.notes.length > MAX_SUMMARY) problems.notes = 'tooLong';
  if (form.weatherCode !== '' && !WEATHER_SHAPE.test(form.weatherCode)) problems.weatherCode = 'invalidWeather';
  if (form.workforceCount.trim() !== '' && !/^\d{1,7}$/.test(form.workforceCount.trim())) problems.workforceCount = 'invalidNumber';
  return problems;
}

/**
 * The content that goes to the server: what the form says, over what the diary already held (the other fields, written by another client, are kept as they were). An empty field is taken out, not sent as
 * an empty string.
 */
export function contentOf(form: DiaryForm, base: Raw = {}): Raw {
  const content: Raw = { ...base, summary: form.summary.trim() };
  // A field that holds what the form cannot show (notes as a list, say) stays as it is until the form says something in its place; an emptied field that the form could show is taken out.
  const optional = (key: string, value: string | number | undefined): void => {
    if ((value === undefined || value === '') && key in base && !representable(key, base[key])) return;
    if (value === undefined || value === '') delete content[key];
    else content[key] = value;
  };
  optional('weather_code', form.weatherCode === '' ? undefined : form.weatherCode);
  optional('workforce_count', form.workforceCount.trim() === '' ? undefined : Number(form.workforceCount.trim()));
  optional('notes', form.notes.trim() === '' ? undefined : form.notes.trim());
  return content;
}

export interface SaveBody {
  contract_id: string;
  record_date: string;
  client_operation_id: string;
  content: Raw;
  base_server_version?: number;
}

export const saveBody = (form: DiaryForm, clientOperationId: string): SaveBody => ({ contract_id: form.contractId, record_date: form.recordDate, client_operation_id: clientOperationId, content: contentOf(form) });

export interface SignForm {
  method: SignatureMethod | '';
  certSerial: string;
  /** The words of the supervisor (the remark) or of the owner (the note). */
  words: string;
  clientOperationId: string;
}

export const emptySign = (clientOperationId: string): SignForm => ({ method: '', certSerial: '', words: '', clientOperationId });

export function validateSign(form: SignForm, wordsRequired: boolean): Partial<Record<keyof SignForm, FormProblem>> {
  const problems: Partial<Record<keyof SignForm, FormProblem>> = {};
  if (form.method === '') problems.method = 'required';
  // A certificate is a legal electronic signature and carries its serial; an in-app confirmation carries none.
  if ((form.method === 'DIGITAL_CERT') !== (form.certSerial.trim() !== '') && form.method !== '') problems.certSerial = 'certSerial';
  const words = form.words.trim();
  if (wordsRequired && words === '') problems.words = 'required';
  if (words.length > MAX_TEXT) problems.words = 'tooLong';
  return problems;
}

export interface SignBody {
  signature_method: SignatureMethod;
  cert_serial?: string;
  client_operation_id: string;
}

export function signBody(form: SignForm): SignBody {
  return { signature_method: form.method === '' ? 'IN_APP_OTP' : form.method, ...(form.certSerial.trim() === '' ? {} : { cert_serial: form.certSerial.trim() }), client_operation_id: form.clientOperationId };
}

export interface ReasonForm {
  reason: string;
}

export const validateReason = (reason: string, required: boolean): FormProblem | undefined => {
  const trimmed = reason.trim();
  if (required && trimmed === '') return 'required';
  return trimmed.length > MAX_TEXT ? 'tooLong' : undefined;
};

export interface ResolveForm {
  conflictId: string;
  resolution: ConflictResolution | '';
  note: string;
  /** What the person wrote for a merge: the fields of the form over what the diary held. */
  merged: DiaryForm;
}

export const emptyResolve = (line: DiaryLine): ResolveForm => ({ conflictId: pendingConflicts(line)[0]?.id ?? '', resolution: '', note: '', merged: formOf(line) });

export function validateResolve(form: ResolveForm, line: DiaryLine): Partial<Record<'conflictId' | 'resolution' | 'note' | 'merged', FormProblem>> {
  const problems: Partial<Record<'conflictId' | 'resolution' | 'note' | 'merged', FormProblem>> = {};
  if (!pendingConflicts(line).some((copy) => copy.id === form.conflictId)) problems.conflictId = 'required';
  if (form.resolution === '') problems.resolution = 'required';
  const note = form.note.trim();
  if (note === '') problems.note = 'required';
  else if (note.length > MAX_TEXT) problems.note = 'tooLong';
  if (form.resolution === 'MERGED' && Object.keys(validateDiary(form.merged, '9999-12-31', false)).length > 0) problems.merged = 'required';
  return problems;
}

export interface ResolveBody {
  conflict_diary_id: string;
  resolution: ConflictResolution;
  merged_content?: Raw;
  note: string;
}

export function resolveBody(form: ResolveForm, line: DiaryLine): ResolveBody {
  return {
    conflict_diary_id: form.conflictId,
    resolution: form.resolution === '' ? 'KEEP_PRIMARY' : form.resolution,
    ...(form.resolution === 'MERGED' ? { merged_content: contentOf(form.merged, line.content) } : {}),
    note: form.note.trim(),
  };
}

export interface CorrectBody {
  content: Raw;
  correction_reason: string;
  client_operation_id: string;
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export type Problem = 'diaryState' | 'correctionOpen' | 'contentChanged' | 'dayExists' | 'syncConflict' | 'alreadySigned' | 'methodNotAccepted' | 'notYourRole' | 'contractState' | 'permitGate' | 'versionConflict' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'DIARY_STATE_INVALID':
      return error.extensions.reason === 'CORRECTION_OPEN' ? 'correctionOpen' : error.extensions.reason === 'CONTENT_CHANGED' ? 'contentChanged' : 'diaryState';
    case 'DIARY_DAY_EXISTS':
      return 'dayExists';
    case 'DIARY_SYNC_CONFLICT':
      return 'syncConflict';
    case 'ALREADY_SIGNED':
      return 'alreadySigned';
    case 'SIGNATURE_METHOD_NOT_ACCEPTED':
      return 'methodNotAccepted';
    case 'CONTRACT_STATE_INVALID':
      return 'contractState';
    case 'PERMIT_GATE_BLOCKED':
      return 'permitGate';
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
      // Signing as a role that is not the signer's to sign is refused as outside the scope; the other commands are refused for lack of the right.
      return error.detail === 'signer_role' ? 'notYourRole' : 'denied';
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}

// ---- time and links ---------------------------------------------------------------------------------------------------------------

/** `YYYY-MM-DD` of an instant on the calendar of Vietnam, the calendar a diary day is kept in. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export const catalogueLink = (): string => '/qms/qms-01';
export const composeLink = (id: string): string => `/qms/qms-02?diary=${id}`;
export const reviewLink = (id: string): string => `/qms/qms-03?diary=${id}`;
