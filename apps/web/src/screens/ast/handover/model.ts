import { ApiError } from '@machvon/api-client';

/** The permissions of AST-01 and AST-02 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract and of the receiving unit. */
export const READ_PERMISSION = 'handover.read';
export const MANAGE_PERMISSION = 'handover.manage';

export const HANDOVER_KINDS = ['PARTIAL', 'COMPLETION', 'ASSET_TRANSFER'] as const;
export type HandoverKind = (typeof HANDOVER_KINDS)[number];
export const HANDOVER_STATUSES = ['DRAFT', 'INSPECTING', 'PUNCH_PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];
export const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const PUNCH_STATUSES = ['OPEN', 'FIXED', 'VERIFIED', 'WAIVED'] as const;
export type PunchStatus = (typeof PUNCH_STATUSES)[number];
export const VERIFICATIONS = ['VERIFIED', 'REOPEN'] as const;
export type Verification = (typeof VERIFICATIONS)[number];
export const DECISIONS = ['approve', 'return', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 2000;
const MAX_EVIDENCE = 50;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

export interface HandoverAllowed {
  addItem: boolean;
  approve: boolean;
  return: boolean;
  reject: boolean;
}

/** One handover as AST-01 and AST-02 show it. */
export interface HandoverLine {
  id: string;
  handoverNo: string;
  kind: HandoverKind;
  status: HandoverStatus;
  contract: { id: string; code: string; status: string };
  recipientUnit: { id: string; code: string; name: string };
  qualityAcceptanceId: string | null;
  plannedOn: string | null;
  handedOn: string | null;
  acceptedAt: string | null;
  rejectionReason: string | null;
  decisionNote: string | null;
  openCriticalCount: number;
  itemCount: number;
  documentVersionId: string | null;
  asBuiltDocumentVersionId: string | null;
  omManualDocumentVersionId: string | null;
  warrantyCertificateDocumentVersionId: string | null;
  /** Created at, in microseconds: the cursor of the page. */
  createdAt: string;
  allowed: HandoverAllowed;
  version: number;
}

export interface PunchAllowed {
  fix: boolean;
  verify: boolean;
  waive: boolean;
}

export interface PunchItem {
  id: string;
  itemNo: number;
  description: string;
  severity: Severity;
  locationText: string | null;
  contractor: { id: string; name: string } | null;
  dueOn: string;
  overdue: boolean;
  status: PunchStatus;
  fixedNote: string | null;
  verificationNote: string | null;
  waiverReason: string | null;
  reopenCount: number;
  allowed: PunchAllowed;
}

export interface AssetLine {
  id: string;
  assetCode: string;
  name: string | null;
  valueVnd: string;
  status: string;
}

export interface Trace {
  handover: HandoverLine;
  items: PunchItem[];
  assets: AssetLine[];
  documents: Array<{ role: string; documentVersionId: string }>;
  qualityAcceptance: { id: string; recordNo: string; scope: string; status: string } | null;
}

export function toHandover(raw: unknown): HandoverLine | undefined {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const unit = asRecord(row?.recipient_unit);
  const id = text(row?.id);
  const contractId = text(contract?.id);
  const kind = oneOf(HANDOVER_KINDS, row?.handover_kind);
  const status = oneOf(HANDOVER_STATUSES, row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || contractId === undefined || kind === undefined || status === undefined || version === undefined) return undefined;
  const allowed = asRecord(row.allowed);
  return {
    id,
    handoverNo: text(row.handover_no) ?? '',
    kind,
    status,
    contract: { id: contractId, code: text(contract?.code) ?? '', status: text(contract?.status) ?? '' },
    recipientUnit: { id: text(unit?.id) ?? '', code: text(unit?.code) ?? '', name: text(unit?.name) ?? '' },
    qualityAcceptanceId: nullableText(row.quality_acceptance_id),
    plannedOn: nullableText(row.planned_on),
    handedOn: nullableText(row.handed_on),
    acceptedAt: nullableText(row.accepted_at),
    rejectionReason: nullableText(row.rejection_reason),
    decisionNote: nullableText(row.decision_note),
    openCriticalCount: whole(row.open_critical_punch_count) ?? 0,
    itemCount: whole(row.punch_item_count) ?? 0,
    documentVersionId: nullableText(row.document_version_id),
    asBuiltDocumentVersionId: nullableText(row.as_built_document_version_id),
    omManualDocumentVersionId: nullableText(row.om_manual_document_version_id),
    warrantyCertificateDocumentVersionId: nullableText(row.warranty_certificate_document_version_id),
    createdAt: text(row.created_at) ?? '',
    allowed: { addItem: allowed?.add_item === true, approve: allowed?.approve === true, return: allowed?.return === true, reject: allowed?.reject === true },
    version,
  };
}

export function toHandoverList(raw: unknown): HandoverLine[] {
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toHandover(item) ?? []) : [];
}

function toItem(raw: unknown): PunchItem | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const itemNo = whole(row?.item_no);
  const severity = oneOf(SEVERITIES, row?.severity);
  const status = oneOf(PUNCH_STATUSES, row?.status);
  if (row === undefined || id === undefined || itemNo === undefined || severity === undefined || status === undefined) return undefined;
  const contractor = asRecord(row.responsible_contractor);
  const contractorId = text(contractor?.id);
  const allowed = asRecord(row.allowed);
  return {
    id,
    itemNo,
    description: text(row.description) ?? '',
    severity,
    locationText: nullableText(row.location_text),
    contractor: contractorId === undefined ? null : { id: contractorId, name: text(contractor?.name) ?? '' },
    dueOn: text(row.due_on) ?? '',
    overdue: row.overdue === true,
    status,
    fixedNote: nullableText(row.fixed_note),
    verificationNote: nullableText(row.verification_note),
    waiverReason: nullableText(row.waiver_reason),
    reopenCount: whole(row.reopen_count) ?? 0,
    allowed: { fix: allowed?.fix === true, verify: allowed?.verify === true, waive: allowed?.waive === true },
  };
}

export function toTrace(raw: unknown): Trace | undefined {
  const row = asRecord(raw);
  const handover = toHandover(row?.handover);
  if (row === undefined || handover === undefined) return undefined;
  const minutes = asRecord(row.quality_acceptance);
  const minutesId = text(minutes?.id);
  return {
    handover,
    items: Array.isArray(row.items) ? row.items.flatMap((item) => toItem(item) ?? []) : [],
    assets: Array.isArray(row.assets)
      ? row.assets.flatMap((raw) => {
          const asset = asRecord(raw);
          const id = text(asset?.id);
          return id === undefined
            ? []
            : [{ id, assetCode: text(asset?.asset_code) ?? '', name: nullableText(asset?.name), valueVnd: text(asset?.value_vnd) ?? '0', status: text(asset?.status) ?? '' }];
        })
      : [],
    documents: Array.isArray(row.documents)
      ? row.documents.flatMap((raw) => {
          const document = asRecord(raw);
          const role = text(document?.role);
          const id = text(document?.document_version_id);
          return role === undefined || id === undefined ? [] : [{ role, documentVersionId: id }];
        })
      : [],
    qualityAcceptance: minutesId === undefined ? null : { id: minutesId, recordNo: text(minutes?.record_no) ?? minutesId, scope: text(minutes?.scope) ?? '', status: text(minutes?.status) ?? '' },
  };
}

/** The items that still stand between the handover and its acceptance: critical and not verified. */
export const openCritical = (items: readonly PunchItem[]): PunchItem[] => items.filter((item) => item.severity === 'CRITICAL' && item.status !== 'VERIFIED');

// ---- who may do what ------------------------------------------------------------------------------------------------------------

/** Whether the caller may draft a handover: the permission is held (or not yet known) and the session is not read-only. The server judges the scope again. */
export const canDraft = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(MANAGE_PERMISSION));

// ---- forms ----------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'date' | 'uuid' | 'tooLong' | 'past' | 'tooMany';

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

const dayProblem = (value: string, required: boolean, today: string | undefined): FormProblem | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return required ? 'required' : undefined;
  if (!isDate(trimmed)) return 'date';
  return today !== undefined && trimmed < today ? 'past' : undefined;
};

/** The Vietnam date of `now`: a day for the work to be put right starts from there. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export interface CreateForm {
  contractId: string;
  kind: HandoverKind | '';
  handoverNo: string;
  recipientUnitId: string;
  qualityAcceptanceId: string;
  plannedOn: string;
  documentVersionId: string;
}

export const emptyCreate = (contractId = ''): CreateForm => ({ contractId, kind: '', handoverNo: '', recipientUnitId: '', qualityAcceptanceId: '', plannedOn: '', documentVersionId: '' });

/** What is wrong with the handover before it is drafted; the handover of the completion rests on approved completion minutes. */
export function validateCreate(form: CreateForm): Partial<Record<keyof CreateForm, FormProblem>> {
  const problems: Partial<Record<keyof CreateForm, FormProblem>> = {};
  if (form.contractId === '') problems.contractId = 'required';
  if (form.kind === '') problems.kind = 'required';
  const number = wordsProblem(form.handoverNo, true);
  if (number !== undefined) problems.handoverNo = number;
  if (form.recipientUnitId === '') problems.recipientUnitId = 'required';
  const minutes = idProblem(form.qualityAcceptanceId, form.kind === 'COMPLETION');
  if (minutes !== undefined) problems.qualityAcceptanceId = minutes;
  const planned = dayProblem(form.plannedOn, false, undefined);
  if (planned !== undefined) problems.plannedOn = planned;
  const document = idProblem(form.documentVersionId, true);
  if (document !== undefined) problems.documentVersionId = document;
  return problems;
}

export interface CreateBody {
  project_id: string;
  contract_id: string;
  recipient_unit_id: string;
  handover_kind: HandoverKind;
  handover_no: string;
  document_version_id: string;
  quality_acceptance_id?: string;
  planned_on?: string;
}

export function createBody(form: CreateForm, projectId: string): CreateBody {
  const minutes = form.qualityAcceptanceId.trim();
  const planned = form.plannedOn.trim();
  return {
    project_id: projectId,
    contract_id: form.contractId,
    recipient_unit_id: form.recipientUnitId,
    handover_kind: form.kind === '' ? 'COMPLETION' : form.kind,
    handover_no: form.handoverNo.trim(),
    document_version_id: form.documentVersionId.trim().toLowerCase(),
    ...(minutes === '' ? {} : { quality_acceptance_id: minutes.toLowerCase() }),
    ...(planned === '' ? {} : { planned_on: planned }),
  };
}

export interface ItemForm {
  description: string;
  severity: Severity | '';
  locationText: string;
  dueOn: string;
  responsibleContractorId: string;
  defectPhotoId: string;
}

export const emptyItem = (today: string): ItemForm => ({ description: '', severity: '', locationText: '', dueOn: today, responsibleContractorId: '', defectPhotoId: '' });

export function validateItem(form: ItemForm, today: string): Partial<Record<keyof ItemForm, FormProblem>> {
  const problems: Partial<Record<keyof ItemForm, FormProblem>> = {};
  const description = wordsProblem(form.description, true);
  if (description !== undefined) problems.description = description;
  if (form.severity === '') problems.severity = 'required';
  const place = wordsProblem(form.locationText, false);
  if (place !== undefined) problems.locationText = place;
  const due = dayProblem(form.dueOn, true, today);
  if (due !== undefined) problems.dueOn = due;
  const contractor = idProblem(form.responsibleContractorId, false);
  if (contractor !== undefined) problems.responsibleContractorId = contractor;
  const photo = idProblem(form.defectPhotoId, false);
  if (photo !== undefined) problems.defectPhotoId = photo;
  return problems;
}

export interface ItemBody {
  description: string;
  severity: Severity;
  due_on: string;
  location_text?: string;
  responsible_contractor_id?: string;
  evidence_photo_id?: string;
}

export function itemBody(form: ItemForm): ItemBody {
  const place = form.locationText.trim();
  const contractor = form.responsibleContractorId.trim();
  const photo = form.defectPhotoId.trim();
  return {
    description: form.description.trim(),
    severity: form.severity === '' ? 'MINOR' : form.severity,
    due_on: form.dueOn.trim(),
    ...(place === '' ? {} : { location_text: place }),
    ...(contractor === '' ? {} : { responsible_contractor_id: contractor.toLowerCase() }),
    ...(photo === '' ? {} : { evidence_photo_id: photo.toLowerCase() }),
  };
}

export interface FixForm {
  photoId: string;
  documentVersionId: string;
  note: string;
}

export const EMPTY_FIX: FixForm = { photoId: '', documentVersionId: '', note: '' };

/** The answer is a photo or a document, with a note that says what was done. */
export function validateFix(form: FixForm): Partial<Record<keyof FixForm, FormProblem>> {
  const problems: Partial<Record<keyof FixForm, FormProblem>> = {};
  const photo = idProblem(form.photoId, false);
  if (photo !== undefined) problems.photoId = photo;
  const document = idProblem(form.documentVersionId, false);
  if (document !== undefined) problems.documentVersionId = document;
  if (form.photoId.trim() === '' && form.documentVersionId.trim() === '') problems.photoId = 'required';
  const note = wordsProblem(form.note, true);
  if (note !== undefined) problems.note = note;
  return problems;
}

export interface FixBody {
  note: string;
  evidence_photo_id?: string;
  evidence_document_version_id?: string;
}

export function fixBody(form: FixForm): FixBody {
  const photo = form.photoId.trim();
  const document = form.documentVersionId.trim();
  return { note: form.note.trim(), ...(photo === '' ? {} : { evidence_photo_id: photo.toLowerCase() }), ...(document === '' ? {} : { evidence_document_version_id: document.toLowerCase() }) };
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

/** The words of a waiver: one reason, kept with the item. */
export function validateReason(reason: string): FormProblem | undefined {
  return wordsProblem(reason, true);
}

export interface DecisionForm {
  decision: Decision | '';
  reason: string;
  asBuilt: string;
  manual: string;
  certificate: string;
  /** One identifier of a document per line, or separated by commas. */
  evidence: string;
}

export const emptyDecision = (handover: HandoverLine): DecisionForm => ({
  decision: '',
  reason: '',
  asBuilt: handover.asBuiltDocumentVersionId ?? '',
  manual: handover.omManualDocumentVersionId ?? '',
  certificate: handover.warrantyCertificateDocumentVersionId ?? '',
  evidence: '',
});

export const evidenceIds = (form: DecisionForm): string[] =>
  form.evidence
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');

/** What is wrong with the decision before it is sent; the acceptance needs the as-built dossier, which the handover may already hold. */
export function validateDecision(form: DecisionForm): Partial<Record<keyof DecisionForm, FormProblem>> {
  const problems: Partial<Record<keyof DecisionForm, FormProblem>> = {};
  if (form.decision === '') problems.decision = 'required';
  const reason = wordsProblem(form.reason, true);
  if (reason !== undefined) problems.reason = reason;
  const asBuilt = idProblem(form.asBuilt, form.decision === 'approve');
  if (asBuilt !== undefined) problems.asBuilt = asBuilt;
  const manual = idProblem(form.manual, false);
  if (manual !== undefined) problems.manual = manual;
  const certificate = idProblem(form.certificate, false);
  if (certificate !== undefined) problems.certificate = certificate;
  const evidence = evidenceIds(form);
  if (evidence.length > MAX_EVIDENCE) problems.evidence = 'tooMany';
  else if (evidence.some((item) => !UUID.test(item))) problems.evidence = 'uuid';
  return problems;
}

export interface DecisionBody {
  decision: Decision;
  reason: string;
  evidence_ids: string[];
  as_built_document_version_id?: string;
  om_manual_document_version_id?: string;
  warranty_certificate_document_version_id?: string;
}

export function decisionBody(form: DecisionForm): DecisionBody {
  const asBuilt = form.asBuilt.trim();
  const manual = form.manual.trim();
  const certificate = form.certificate.trim();
  const approving = form.decision === 'approve';
  return {
    decision: form.decision === '' ? 'return' : form.decision,
    reason: form.reason.trim(),
    evidence_ids: [...new Set(evidenceIds(form))],
    ...(approving && asBuilt !== '' ? { as_built_document_version_id: asBuilt.toLowerCase() } : {}),
    ...(approving && manual !== '' ? { om_manual_document_version_id: manual.toLowerCase() } : {}),
    ...(approving && certificate !== '' ? { warranty_certificate_document_version_id: certificate.toLowerCase() } : {}),
  };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'contractState'
  | 'minutesRequired'
  | 'permitGate'
  | 'handoverState'
  | 'punchState'
  | 'openCritical'
  | 'asBuiltRequired'
  | 'criticalWaiver'
  | 'evidenceRequired'
  | 'selfApproval'
  | 'notClean'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ProblemView {
  problem: Problem;
  /** What the sentence adds to the code: the numbers of the critical items that are still open. */
  detail: string[];
}

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { problem: 'general', detail: [] };
  switch (error.code) {
    case 'CONTRACT_STATE_INVALID':
      return { problem: 'contractState', detail: [] };
    case 'QUALITY_ACCEPTANCE_REQUIRED':
      return { problem: 'minutesRequired', detail: [] };
    case 'PERMIT_GATE_BLOCKED':
      return { problem: 'permitGate', detail: [] };
    case 'HANDOVER_STATE_INVALID':
      return { problem: 'handoverState', detail: [] };
    case 'PUNCH_STATE_INVALID':
      return { problem: 'punchState', detail: [] };
    case 'OPEN_CRITICAL_PUNCH': {
      const numbers = error.extensions.item_nos;
      return { problem: 'openCritical', detail: Array.isArray(numbers) ? numbers.filter((item): item is number => typeof item === 'number').map(String) : [] };
    }
    case 'AS_BUILT_REQUIRED':
      return { problem: 'asBuiltRequired', detail: [] };
    case 'CRITICAL_CANNOT_BE_WAIVED':
      return { problem: 'criticalWaiver', detail: [] };
    case 'EVIDENCE_REQUIRED':
      return { problem: 'evidenceRequired', detail: [] };
    case 'SELF_APPROVAL_DENIED':
      return { problem: 'selfApproval', detail: [] };
    case 'DOCUMENT_NOT_CLEAN':
    case 'FILE_NOT_CLEAN':
      return { problem: 'notClean', detail: [] };
    case 'VERSION_CONFLICT':
      return { problem: 'versionConflict', detail: [] };
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return { problem: 'validation', detail: [] };
    case 'RESOURCE_NOT_FOUND':
      return { problem: 'notFound', detail: [] };
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return { problem: 'denied', detail: [] };
    case 'SESSION_EXPIRED':
      return { problem: 'session', detail: [] };
    default:
      return { problem: 'general', detail: [] };
  }
}
