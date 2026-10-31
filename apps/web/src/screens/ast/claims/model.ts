import { ApiError } from '@machvon/api-client';

/** AST-05: the claims against a warranty and the answer to them (ST-AST-004, AST 3.3, UAT-AC390, UAT-AC391). The server judges every request again. */
export const FILE_PERMISSION = 'warranty.claim';

export const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'REPAIRING', 'FIXED', 'VERIFIED', 'CLOSED', 'DISPUTED'] as const;
export type Status = (typeof STATUSES)[number];
export const BEARERS = ['CONTRACTOR', 'OWNER', 'THIRD_PARTY', 'UNDETERMINED'] as const;
export type Bearer = (typeof BEARERS)[number];
export const OUTCOMES = ['VERIFIED', 'DISPUTED'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The columns of the board: an unanswered claim, one the contractor took on, one it says is put right, one disputed, and one verified. */
export const LANES = ['OPEN', 'IN_PROGRESS', 'FIXED', 'DISPUTED', 'VERIFIED'] as const;
export type Lane = (typeof LANES)[number];

export function laneOf(status: Status): Lane {
  switch (status) {
    case 'OPEN':
      return 'OPEN';
    case 'ACKNOWLEDGED':
    case 'REPAIRING':
      return 'IN_PROGRESS';
    case 'FIXED':
      return 'FIXED';
    case 'DISPUTED':
      return 'DISPUTED';
    case 'VERIFIED':
    case 'CLOSED':
      return 'VERIFIED';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_TEXT = 2000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

export interface ClaimAllowed {
  acknowledge: boolean;
  fix: boolean;
  verify: boolean;
}

export interface ClaimLine {
  id: string;
  claimNo: string;
  obligation: { id: string; endsOn: string };
  contract: { id: string; code: string };
  handoverNo: string | null;
  severity: Severity;
  defect: string;
  location: string | null;
  responder: { id: string; name: string } | null;
  reportedOn: string;
  responseDueOn: string;
  committedFixOn: string | null;
  fixedOn: string | null;
  costBorneBy: Bearer;
  /** What the reporter attached, what the contractor put forward as the repair, and the words of each. */
  evidence: { documentId: string | null; photoId: string | null };
  fixEvidence: { documentId: string | null; photoId: string | null };
  fixNote: string | null;
  verificationNote: string | null;
  status: Status;
  overdue: boolean;
  issue: { id: string; code: string } | null;
  allowed: ClaimAllowed;
  version: number;
}

export function toClaim(raw: unknown): ClaimLine | undefined {
  const row = asRecord(raw);
  const obligation = asRecord(row?.obligation);
  const contract = asRecord(row?.contract);
  const handover = asRecord(row?.handover);
  const responder = asRecord(row?.responder);
  const issue = asRecord(row?.issue);
  const allowed = asRecord(row?.allowed);
  const id = text(row?.id);
  const claimNo = text(row?.claim_no);
  const obligationId = text(obligation?.id);
  const severity = oneOf(SEVERITIES, row?.severity);
  const status = oneOf(STATUSES, row?.status);
  const reportedOn = text(row?.reported_on);
  const dueOn = text(row?.response_due_on);
  if (row === undefined || id === undefined || claimNo === undefined || obligationId === undefined || severity === undefined || status === undefined || reportedOn === undefined || dueOn === undefined) return undefined;
  const responderId = text(responder?.id);
  const issueId = text(issue?.id);
  return {
    id,
    claimNo,
    obligation: { id: obligationId, endsOn: text(obligation?.ends_on) ?? '' },
    contract: { id: text(contract?.id) ?? '', code: text(contract?.code) ?? '' },
    handoverNo: nullableText(handover?.handover_no),
    severity,
    defect: text(row.defect_description) ?? '',
    location: nullableText(row.location_text),
    responder: responderId === undefined ? null : { id: responderId, name: text(responder?.name) ?? '' },
    reportedOn,
    responseDueOn: dueOn,
    committedFixOn: nullableText(row.committed_fix_on),
    fixedOn: nullableText(row.fixed_on),
    costBorneBy: oneOf(BEARERS, row.cost_borne_by) ?? 'UNDETERMINED',
    evidence: { documentId: nullableText(row.evidence_document_version_id), photoId: nullableText(row.evidence_photo_id) },
    fixEvidence: { documentId: nullableText(row.fix_evidence_document_version_id), photoId: nullableText(row.fix_evidence_photo_id) },
    fixNote: nullableText(row.fix_note),
    verificationNote: nullableText(row.verification_note),
    status,
    overdue: row.overdue === true,
    issue: issueId === undefined ? null : { id: issueId, code: text(issue?.code) ?? '' },
    allowed: { acknowledge: allowed?.acknowledge === true, fix: allowed?.fix === true, verify: allowed?.verify === true },
    version: typeof row.version === 'number' ? row.version : 0,
  };
}

/** The obligation a claim can be filed on: one still running, with the contractor the claim is addressed to. */
export interface ObligationOption {
  id: string;
  contractCode: string;
  handoverNo: string | null;
  scope: string;
  startsOn: string;
  endsOn: string;
  contractor: { id: string; name: string } | null;
}

export function toObligationOption(raw: unknown): ObligationOption[] {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const handover = asRecord(row?.handover);
  const contractor = asRecord(row?.contractor);
  const id = text(row?.id);
  const startsOn = text(row?.starts_on);
  const endsOn = text(row?.ends_on);
  if (row === undefined || id === undefined || startsOn === undefined || endsOn === undefined || row.status !== 'ACTIVE') return [];
  const contractorId = text(contractor?.id);
  return [
    {
      id,
      contractCode: text(contract?.code) ?? '',
      handoverNo: nullableText(handover?.handover_no),
      scope: text(row.scope_description) ?? '',
      startsOn,
      endsOn,
      contractor: contractorId === undefined ? null : { id: contractorId, name: text(contractor?.name) ?? '' },
    },
  ];
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const canFile = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(FILE_PERMISSION)) && mode !== 'READ_ONLY';

/** The Vietnam date of `now`. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** A calendar day written YYYY-MM-DD that exists. */
export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// ---- the forms -----------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid' | 'tooLong' | 'evidence' | 'outside';

export interface FileForm {
  obligationId: string;
  claimNo: string;
  reportedOn: string;
  severity: string;
  defect: string;
  location: string;
  evidenceDocumentId: string;
}
export type FileField = keyof FileForm;

export const emptyFile = (obligationId: string, today: string): FileForm => ({ obligationId, claimNo: '', reportedOn: today, severity: '', defect: '', location: '', evidenceDocumentId: '' });

const textProblem = (value: string): FormProblem | undefined => (value.trim() === '' ? 'required' : value.trim().length > MAX_TEXT ? 'tooLong' : undefined);

export function validateFile(form: FileForm, obligations: readonly ObligationOption[]): Partial<Record<FileField, FormProblem>> {
  const found: Partial<Record<FileField, FormProblem>> = {};
  const obligation = obligations.find((candidate) => candidate.id === form.obligationId);
  if (form.obligationId === '') found.obligationId = 'required';
  else if (obligation === undefined) found.obligationId = 'invalid';
  const claimNo = textProblem(form.claimNo);
  if (claimNo !== undefined) found.claimNo = claimNo;
  if (form.reportedOn.trim() === '') found.reportedOn = 'required';
  else if (!isDay(form.reportedOn.trim())) found.reportedOn = 'invalid';
  else if (obligation !== undefined && (form.reportedOn.trim() < obligation.startsOn || form.reportedOn.trim() >= obligation.endsOn)) found.reportedOn = 'outside';
  if (form.severity === '') found.severity = 'required';
  else if (oneOf(SEVERITIES, form.severity) === undefined) found.severity = 'invalid';
  const defect = textProblem(form.defect);
  if (defect !== undefined) found.defect = defect;
  if (form.location.trim().length > MAX_TEXT) found.location = 'tooLong';
  if (form.evidenceDocumentId.trim() !== '' && !UUID.test(form.evidenceDocumentId.trim())) found.evidenceDocumentId = 'invalid';
  return found;
}

/** The body of the command for a form that passed `validateFile`: the claim is addressed to the contractor of the contract. */
export function fileBody(form: FileForm, obligations: readonly ObligationOption[]): Record<string, unknown> {
  const contractor = obligations.find((candidate) => candidate.id === form.obligationId)?.contractor;
  return {
    claim_no: form.claimNo.trim(),
    reported_on: form.reportedOn.trim(),
    defect_description: form.defect.trim(),
    severity: form.severity,
    responder_contractor_id: contractor?.id ?? '',
    ...(form.location.trim() === '' ? {} : { location_text: form.location.trim() }),
    ...(form.evidenceDocumentId.trim() === '' ? {} : { evidence_document_version_id: form.evidenceDocumentId.trim() }),
  };
}

export interface AcknowledgeForm {
  committedOn: string;
  note: string;
}
export const emptyAcknowledge = (): AcknowledgeForm => ({ committedOn: '', note: '' });

export function validateAcknowledge(form: AcknowledgeForm, claim: ClaimLine): Partial<Record<keyof AcknowledgeForm, FormProblem>> {
  const found: Partial<Record<keyof AcknowledgeForm, FormProblem>> = {};
  if (form.committedOn.trim() === '') found.committedOn = 'required';
  else if (!isDay(form.committedOn.trim())) found.committedOn = 'invalid';
  else if (form.committedOn.trim() < claim.reportedOn) found.committedOn = 'outside';
  if (form.note.trim().length > MAX_TEXT) found.note = 'tooLong';
  return found;
}

export const acknowledgeBody = (form: AcknowledgeForm): Record<string, unknown> => ({ committed_fix_on: form.committedOn.trim(), ...(form.note.trim() === '' ? {} : { note: form.note.trim() }) });

export interface FixForm {
  fixedOn: string;
  note: string;
  documentId: string;
  photoId: string;
}
export const emptyFix = (today: string): FixForm => ({ fixedOn: today, note: '', documentId: '', photoId: '' });

export function validateFix(form: FixForm, claim: ClaimLine): Partial<Record<keyof FixForm, FormProblem>> {
  const found: Partial<Record<keyof FixForm, FormProblem>> = {};
  if (form.fixedOn.trim() === '') found.fixedOn = 'required';
  else if (!isDay(form.fixedOn.trim())) found.fixedOn = 'invalid';
  else if (form.fixedOn.trim() < claim.reportedOn) found.fixedOn = 'outside';
  const note = textProblem(form.note);
  if (note !== undefined) found.note = note;
  if (form.documentId.trim() === '' && form.photoId.trim() === '') found.documentId = 'evidence';
  if (form.documentId.trim() !== '' && !UUID.test(form.documentId.trim())) found.documentId = 'invalid';
  if (form.photoId.trim() !== '' && !UUID.test(form.photoId.trim())) found.photoId = 'invalid';
  return found;
}

export const fixBody = (form: FixForm): Record<string, unknown> => ({
  fixed_on: form.fixedOn.trim(),
  note: form.note.trim(),
  ...(form.documentId.trim() === '' ? {} : { evidence_document_version_id: form.documentId.trim() }),
  ...(form.photoId.trim() === '' ? {} : { evidence_photo_id: form.photoId.trim() }),
});

export interface VerifyForm {
  outcome: string;
  bearer: string;
  note: string;
}
export const emptyVerify = (): VerifyForm => ({ outcome: '', bearer: '', note: '' });

export function validateVerify(form: VerifyForm): Partial<Record<keyof VerifyForm, FormProblem>> {
  const found: Partial<Record<keyof VerifyForm, FormProblem>> = {};
  if (form.outcome === '') found.outcome = 'required';
  else if (oneOf(OUTCOMES, form.outcome) === undefined) found.outcome = 'invalid';
  if (form.bearer === '') found.bearer = 'required';
  else if (oneOf(BEARERS, form.bearer) === undefined) found.bearer = 'invalid';
  const note = textProblem(form.note);
  if (note !== undefined) found.note = note;
  return found;
}

export const verifyBody = (form: VerifyForm): Record<string, unknown> => ({ outcome: form.outcome, cost_borne_by: form.bearer, note: form.note.trim() });

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type Problem =
  | 'expired'
  | 'duplicate'
  | 'closed'
  | 'beforeStart'
  | 'notParty'
  | 'beforeReport'
  | 'evidenceInvalid'
  | 'evidenceRequired'
  | 'notClean'
  | 'state'
  | 'conflict'
  | 'self'
  | 'denied'
  | 'notFound'
  | 'validation'
  | 'general';

const BY_CODE: Readonly<Record<string, Problem>> = {
  WARRANTY_EXPIRED: 'expired',
  CLAIM_NO_DUPLICATE: 'duplicate',
  WARRANTY_STATE_INVALID: 'closed',
  EVIDENCE_REQUIRED: 'evidenceRequired',
  DOCUMENT_NOT_CLEAN: 'notClean',
  FILE_NOT_CLEAN: 'notClean',
  CLAIM_STATE_INVALID: 'state',
  VERSION_CONFLICT: 'conflict',
  SELF_APPROVAL_DENIED: 'self',
  SCOPE_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

const BY_REASON: Readonly<Record<string, Problem>> = {
  BEFORE_START: 'beforeStart',
  NOT_A_PARTY: 'notParty',
  BEFORE_REPORT: 'beforeReport',
  NOT_IN_CONTRACT: 'evidenceInvalid',
  NOT_FOUND: 'evidenceInvalid',
};

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  const reason = text(error.extensions.reason);
  return (error.code === 'VALIDATION_FAILED' && reason !== undefined ? BY_REASON[reason] : undefined) ?? BY_CODE[error.code] ?? 'general';
}
