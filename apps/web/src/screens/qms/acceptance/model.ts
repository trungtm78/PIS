import { ApiError } from '@machvon/api-client';
import { SIGNER_ROLES } from '../inspection/model';
import type { InspectionLine, InspectionType, SignerRole } from '../inspection/model';

export { SIGNER_ROLES };
export type { SignerRole };

/** The permissions of QMS-05 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract. */
export const READ_PERMISSION = 'qacceptance.read';
export const DRAFT_PERMISSION = 'qacceptance.manage';

export const ACCEPTANCE_SCOPES = ['WORK_ITEM', 'STAGE', 'PART', 'COMPLETION'] as const;
export type AcceptanceScope = (typeof ACCEPTANCE_SCOPES)[number];
export const ACCEPTANCE_STATUSES = ['DRAFT', 'SIGNING', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];
export const SIGNATURE_METHODS = ['IN_APP_OTP', 'IN_APP_WEBAUTHN', 'DIGITAL_CERT'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];
export const LEGAL_EFFECTS = ['INTERNAL_RECORD', 'LEGAL_E_SIGNATURE'] as const;
export type LegalEffect = (typeof LEGAL_EFFECTS)[number];
export const DECISIONS = ['approve', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);
const rolesOf = (value: unknown): SignerRole[] => (Array.isArray(value) ? value.flatMap((role) => oneOf(SIGNER_ROLES, role) ?? []) : []);

export interface Signature {
  role: SignerRole;
  signerName: string;
  method: SignatureMethod;
  legalEffect: LegalEffect;
  certSerial: string | null;
  signedAt: string;
  /** Whether it is over the hash the minutes carry; one that is not is void. */
  valid: boolean;
}

/** One set of minutes as QMS-05 shows it. */
export interface AcceptanceLine {
  id: string;
  recordNo: string;
  contract: { id: string; code: string; status: string };
  inspection: { id: string; inspectionNo: string; inspectionType: InspectionType; title: string };
  boqItemKey: string | null;
  acceptanceScope: AcceptanceScope;
  status: AcceptanceStatus;
  requiredRoles: SignerRole[];
  signatures: Signature[];
  missingRoles: SignerRole[];
  openCriticalNcr: number;
  regime: { label: string | null; legalBasis: string | null; awaitingConfirmation: boolean; cxn: string | null };
  decisionNote: string | null;
  approvedBy: string | null;
  revokeReason: string | null;
  createdBy: string;
  signableRoles: SignerRole[];
  canSign: boolean;
  canApprove: boolean;
  canReject: boolean;
  canRevoke: boolean;
  version: number;
}

function toSignature(raw: unknown): Signature | undefined {
  const row = asRecord(raw);
  const role = oneOf(SIGNER_ROLES, row?.role);
  const method = oneOf(SIGNATURE_METHODS, row?.method);
  const effect = oneOf(LEGAL_EFFECTS, row?.legal_effect);
  const at = text(row?.signed_at);
  if (row === undefined || role === undefined || method === undefined || effect === undefined || at === undefined) return undefined;
  return { role, signerName: text(row.signer_name) ?? '', method, legalEffect: effect, certSerial: nullableText(row.cert_serial), signedAt: at, valid: row.valid === true };
}

export function toAcceptanceLine(raw: unknown): AcceptanceLine | undefined {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const inspection = asRecord(row?.inspection);
  const id = text(row?.id);
  const contractId = text(contract?.id);
  const inspectionId = text(inspection?.id);
  const type = text(inspection?.inspection_type);
  const scope = oneOf(ACCEPTANCE_SCOPES, row?.acceptance_scope);
  const status = oneOf(ACCEPTANCE_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || contractId === undefined || inspectionId === undefined || type === undefined || scope === undefined || status === undefined || version === undefined) return undefined;
  const regime = asRecord(row.regime);
  const actions = asRecord(row.actions);
  const boq = asRecord(row.boq_item);
  const approver = asRecord(row.approved_by);
  const creator = asRecord(row.created_by);
  return {
    id,
    recordNo: text(row.record_no) ?? '',
    contract: { id: contractId, code: text(contract?.code) ?? '', status: text(contract?.status) ?? '' },
    inspection: { id: inspectionId, inspectionNo: text(inspection?.inspection_no) ?? '', inspectionType: type as InspectionType, title: text(inspection?.title) ?? '' },
    boqItemKey: text(boq?.business_key) ?? null,
    acceptanceScope: scope,
    status,
    requiredRoles: rolesOf(row.required_roles),
    signatures: Array.isArray(row.signatures) ? row.signatures.flatMap((signature) => toSignature(signature) ?? []) : [],
    missingRoles: rolesOf(row.missing_roles),
    openCriticalNcr: whole(row.open_critical_ncr) ?? 0,
    regime: { label: nullableText(regime?.label), legalBasis: nullableText(regime?.legal_basis), awaitingConfirmation: regime?.awaiting_confirmation === true, cxn: nullableText(regime?.cxn) },
    decisionNote: nullableText(row.decision_note),
    approvedBy: text(approver?.display_name) ?? null,
    revokeReason: nullableText(row.revoke_reason),
    createdBy: text(creator?.display_name) ?? '',
    signableRoles: rolesOf(row.signable_roles),
    canSign: actions?.sign === true,
    canApprove: actions?.approve === true,
    canReject: actions?.reject === true,
    canRevoke: actions?.revoke === true,
    version,
  };
}

export function toAcceptanceList(raw: unknown): AcceptanceLine[] {
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toAcceptanceLine(item) ?? []) : [];
}

/** Minutes that are not over: an inspection with such minutes is not drafted again. */
export const isLive = (status: AcceptanceStatus): boolean => status === 'DRAFT' || status === 'SIGNING' || status === 'APPROVED';

// ---- who may do what ----------------------------------------------------------------------------------------------------------

/** Whether the caller may draft minutes: the permission is held (or not yet known) and the session is not read-only. The server judges the scope again. */
export const canDraft = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(DRAFT_PERMISSION));

// ---- drafting -----------------------------------------------------------------------------------------------------------------------

/** The scope of the minutes an inspection leads to: the kind of inspection says how much of the work was inspected, and so how much the minutes accept. */
export function scopeOf(type: InspectionType): AcceptanceScope {
  switch (type) {
    case 'CONSTRUCTION_STAGE':
      return 'STAGE';
    case 'PART_ACCEPTANCE':
      return 'PART';
    case 'COMPLETION':
      return 'COMPLETION';
    case 'MATERIAL_ENTRY':
    case 'CONCEALED_WORK':
    case 'SAFETY':
    case 'OTHER':
      return 'WORK_ITEM';
  }
}

/** The inspections minutes can be drafted from: a result of PASS or CONDITIONAL, and no live minutes yet. */
export function draftable(inspections: readonly InspectionLine[], minutes: readonly AcceptanceLine[]): InspectionLine[] {
  const taken = new Set(minutes.filter((line) => isLive(line.status)).map((line) => line.inspection.id));
  return inspections.filter((inspection) => inspection.status === 'RESULT_RECORDED' && (inspection.result === 'PASS' || inspection.result === 'CONDITIONAL') && !taken.has(inspection.id));
}

export type FormProblem = 'required' | 'uuid' | 'tooLong' | 'certSerial';

export interface DraftForm {
  inspectionId: string;
  recordNo: string;
  documentId: string;
}

export const EMPTY_DRAFT: DraftForm = { inspectionId: '', recordNo: '', documentId: '' };

const wordsProblem = (value: string): FormProblem | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  return trimmed.length > MAX_TEXT ? 'tooLong' : undefined;
};

export function validateDraft(form: DraftForm): Partial<Record<keyof DraftForm, FormProblem>> {
  const problems: Partial<Record<keyof DraftForm, FormProblem>> = {};
  if (form.inspectionId === '') problems.inspectionId = 'required';
  const number = wordsProblem(form.recordNo);
  if (number !== undefined) problems.recordNo = number;
  const document = form.documentId.trim();
  if (document === '') problems.documentId = 'required';
  else if (!UUID.test(document)) problems.documentId = 'uuid';
  return problems;
}

export interface DraftBody {
  acceptance_scope: AcceptanceScope;
  record_no: string;
  document_version_id: string;
}

export const draftBody = (form: DraftForm, type: InspectionType): DraftBody => ({ acceptance_scope: scopeOf(type), record_no: form.recordNo.trim(), document_version_id: form.documentId.trim().toLowerCase() });

/** What a signature is worth (BR-QMS-03): an in-app confirmation is an internal record; only a certificate is a legal electronic signature. */
export const legalEffectOf = (method: SignatureMethod): LegalEffect => (method === 'DIGITAL_CERT' ? 'LEGAL_E_SIGNATURE' : 'INTERNAL_RECORD');

// ---- signing --------------------------------------------------------------------------------------------------------------------------

export interface SignForm {
  role: SignerRole | '';
  method: SignatureMethod;
  certSerial: string;
  /** One for each intention to sign, kept while the dialog is open: a retry of the same signature is the same signature. */
  clientOperationId: string;
}

export const emptySign = (roles: readonly SignerRole[], clientOperationId: string): SignForm => ({ role: roles.length === 1 ? (roles[0] ?? '') : '', method: 'IN_APP_OTP', certSerial: '', clientOperationId });

/** The role to sign as, and the serial of the certificate for, and only for, a digital certificate. */
export function validateSign(form: SignForm): Partial<Record<keyof SignForm, FormProblem>> {
  const problems: Partial<Record<keyof SignForm, FormProblem>> = {};
  if (form.role === '') problems.role = 'required';
  const serial = form.certSerial.trim();
  if (form.method === 'DIGITAL_CERT' && serial === '') problems.certSerial = 'certSerial';
  else if (serial.length > MAX_TEXT) problems.certSerial = 'tooLong';
  return problems;
}

export interface SignBody {
  signer_role: SignerRole;
  signature_method: SignatureMethod;
  client_operation_id: string;
  cert_serial?: string;
}

export function signBody(form: SignForm): SignBody {
  const serial = form.certSerial.trim();
  return { signer_role: form.role === '' ? 'OWNER' : form.role, signature_method: form.method, client_operation_id: form.clientOperationId, ...(form.method === 'DIGITAL_CERT' && serial !== '' ? { cert_serial: serial } : {}) };
}

// ---- deciding and revoking ------------------------------------------------------------------------------------------------------------

export interface DecideForm {
  decision: Decision | '';
  reason: string;
}

export const EMPTY_DECIDE: DecideForm = { decision: '', reason: '' };

export function validateDecide(form: DecideForm): Partial<Record<keyof DecideForm, FormProblem>> {
  const problems: Partial<Record<keyof DecideForm, FormProblem>> = {};
  if (form.decision === '') problems.decision = 'required';
  const reason = wordsProblem(form.reason);
  if (reason !== undefined) problems.reason = reason;
  return problems;
}

export const decideBody = (form: DecideForm): { decision: Decision; reason: string } => ({ decision: form.decision === '' ? 'reject' : form.decision, reason: form.reason.trim() });

export const validateReason = (reason: string): FormProblem | undefined => wordsProblem(reason);

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'inspectionNotPassed'
  | 'openCriticalNcr'
  | 'contractState'
  | 'alreadyDrafted'
  | 'recordNoUsed'
  | 'contentChanged'
  | 'acceptanceState'
  | 'roleNotRequired'
  | 'alreadySigned'
  | 'methodNotAccepted'
  | 'notYourRole'
  | 'signaturesIncomplete'
  | 'selfApproval'
  | 'alreadyUsed'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ProblemView {
  problem: Problem;
  /** The roles that have not signed, when the server said which. */
  missingRoles: SignerRole[];
}

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): ProblemView {
  const view = (problem: Problem, missingRoles: SignerRole[] = []): ProblemView => ({ problem, missingRoles });
  if (!(error instanceof ApiError)) return view('general');
  const extensions = error.extensions;
  switch (error.code) {
    case 'INSPECTION_NOT_PASSED':
      return view('inspectionNotPassed');
    case 'OPEN_CRITICAL_NCR':
      return view('openCriticalNcr');
    case 'CONTRACT_STATE_INVALID':
      return view('contractState');
    case 'QUALITY_ACCEPTANCE_STATE_INVALID':
      switch (extensions.reason) {
        case 'ALREADY_DRAFTED':
          return view('alreadyDrafted');
        case 'RECORD_NO_USED':
          return view('recordNoUsed');
        case 'CONTENT_CHANGED':
          return view('contentChanged');
        default:
          return view('acceptanceState');
      }
    case 'ROLE_NOT_REQUIRED':
      return view('roleNotRequired');
    case 'ALREADY_SIGNED':
      return view('alreadySigned');
    case 'SIGNATURE_METHOD_NOT_ACCEPTED':
      return view('methodNotAccepted');
    case 'SIGNATURES_INCOMPLETE':
      return view('signaturesIncomplete', rolesOf(extensions.missing_roles));
    case 'SELF_APPROVAL_DENIED':
      return view('selfApproval');
    case 'ACCEPTANCE_ALREADY_USED':
      return view('alreadyUsed');
    case 'VERSION_CONFLICT':
      return view('versionConflict');
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return view('validation');
    case 'RESOURCE_NOT_FOUND':
      return view('notFound');
    case 'SCOPE_DENIED':
      // Signing as a role that is not the signer's to sign is refused as outside the scope; the other commands are refused for lack of the right.
      return view(error.detail === 'signer_role' ? 'notYourRole' : 'denied');
    case 'ENTITLEMENT_DENIED':
      return view('denied');
    case 'SESSION_EXPIRED':
      return view('session');
    default:
      return view('general');
  }
}
