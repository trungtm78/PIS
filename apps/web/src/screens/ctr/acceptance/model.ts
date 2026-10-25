import { ApiError } from '@machvon/api-client';
import { MAX_TEXT, isUuid, signedAmountText } from '../change/model';
import type { Measurement } from '../measurement/model';

export { signedAmountText };

/** The permissions of the commands (x-permission in openapi.json); the server judges them again, with the scope and the people. */
export const CREATE_PERMISSION = 'acceptance.create';

export const ACCEPTANCE_PATH = '/ctr/ctr-12';

/** The acceptances of a contract (CTR-12). */
export const acceptanceLink = (contractId: string): string => `${ACCEPTANCE_PATH}?${new URLSearchParams({ contract: contractId }).toString()}`;

export const STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
export type AcceptanceStatus = (typeof STATUSES)[number];

export const DECISIONS = ['approve', 'return', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];

const MAX_SIGNERS = 20;
const MAX_SIGNER_NAME = 200;
const MAX_EVIDENCE = 50;

// ---- what the server answers ---------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

export interface AcceptedLine {
  id: string;
  measurementId: string;
  businessKey: string;
  description: string;
  unitCode: string;
  /** Exact decimal texts: the quantity, the price of the day the acceptance was drawn up, and the amount in whole dong. */
  quantity: string;
  unitPrice: string;
  amountVnd: string;
  active: boolean;
  referenceNo: string | null;
}

export interface Acceptance {
  id: string;
  acceptanceNo: string;
  contract: { id: string; code: string; status: string; requiresQualityAcceptance: boolean; contractValueVnd: string; acceptedTotalVnd: string };
  period: { id: string; code: string };
  acceptedOn: string;
  status: AcceptanceStatus;
  amountVnd: string;
  lines: AcceptedLine[];
  quality: { id: string; recordNo: string; status: string } | null;
  /** Serious non-conformances in the way of the approval that are still open. */
  openCriticalNcr: number;
  signerCount: number;
  decisionReason: string | null;
  revokeReason: string | null;
  createdAt: string;
  canSubmit: boolean;
  canDecide: boolean;
  canRevoke: boolean;
  version: number;
}

function toLineItem(raw: unknown): AcceptedLine | undefined {
  const row = asRecord(raw);
  const item = asRecord(row?.boq_item);
  const id = text(row?.id);
  const measurementId = text(row?.measurement_id);
  if (row === undefined || id === undefined || measurementId === undefined) return undefined;
  return {
    id,
    measurementId,
    businessKey: text(item?.business_key) ?? '',
    description: text(item?.description) ?? '',
    unitCode: text(item?.unit_code) ?? '',
    quantity: text(row.quantity) ?? '0',
    unitPrice: text(row.unit_price_snapshot) ?? '0',
    amountVnd: text(row.amount_vnd) ?? '0',
    active: row.active === true,
    referenceNo: nullableText(row.reference_no),
  };
}

export function toAcceptance(raw: unknown): Acceptance | undefined {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const period = asRecord(row?.period);
  const id = text(row?.id);
  const contractId = text(contract?.id);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || contractId === undefined || status === undefined || version === undefined) return undefined;
  const actions = asRecord(row.actions);
  const quality = asRecord(row.quality_acceptance);
  const qualityId = text(quality?.id);
  return {
    id,
    acceptanceNo: text(row.acceptance_no) ?? '',
    contract: {
      id: contractId,
      code: text(contract?.code) ?? '',
      status: text(contract?.status) ?? '',
      requiresQualityAcceptance: contract?.requires_quality_acceptance === true,
      contractValueVnd: text(contract?.contract_value_vnd) ?? '0',
      acceptedTotalVnd: text(contract?.accepted_total_vnd) ?? '0',
    },
    period: { id: text(period?.id) ?? '', code: text(period?.code) ?? '' },
    acceptedOn: text(row.accepted_on) ?? '',
    status,
    amountVnd: text(row.accepted_amount_vnd) ?? '0',
    lines: Array.isArray(row.lines) ? row.lines.flatMap((line) => toLineItem(line) ?? []) : [],
    quality: qualityId === undefined ? null : { id: qualityId, recordNo: text(quality?.record_no) ?? '', status: text(quality?.status) ?? '' },
    openCriticalNcr: whole(row.open_critical_ncr) ?? 0,
    signerCount: Array.isArray(row.signer_refs) ? row.signer_refs.length : 0,
    decisionReason: nullableText(row.decision_reason),
    revokeReason: nullableText(row.revoke_reason),
    createdAt: text(row.created_at) ?? '',
    canSubmit: actions?.submit === true,
    canDecide: actions?.decide === true,
    canRevoke: actions?.revoke === true,
    version,
  };
}

// ---- who may do what -----------------------------------------------------------------------------------------------------

/** Whether the caller may draft an acceptance: the permission is held (or not yet known) and the session is not read-only. The server judges the scope again. */
export const canCreate = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(CREATE_PERMISSION));

// ---- the contract in figures ---------------------------------------------------------------------------------------------

/** What the contract can still accept, in whole dong; never below zero. */
export function remainingVnd(contract: Pick<Acceptance['contract'], 'contractValueVnd' | 'acceptedTotalVnd'>): string {
  const left = BigInt(contract.contractValueVnd) - BigInt(contract.acceptedTotalVnd);
  return (left < 0n ? 0n : left).toString();
}

// ---- drafting -------------------------------------------------------------------------------------------------------------

/** The measurements an acceptance can take: approved, and not held by an approved acceptance. */
export function acceptable(measurements: readonly Measurement[], acceptances: readonly Acceptance[]): Measurement[] {
  const held = new Set(acceptances.filter((acceptance) => acceptance.status === 'APPROVED').flatMap((acceptance) => acceptance.lines.map((line) => line.measurementId)));
  return measurements.filter((measurement) => measurement.status === 'APPROVED' && !held.has(measurement.id));
}

export type FormProblem = 'required' | 'tooLong' | 'uuid' | 'tooMany';

export interface DraftForm {
  periodId: string;
  measurementIds: string[];
  documentId: string;
  qualityId: string;
}

export const EMPTY_DRAFT: DraftForm = { periodId: '', measurementIds: [], documentId: '', qualityId: '' };

export function validateDraft(form: DraftForm): Partial<Record<keyof DraftForm, FormProblem>> {
  const problems: Partial<Record<keyof DraftForm, FormProblem>> = {};
  if (form.periodId === '') problems.periodId = 'required';
  if (form.measurementIds.length === 0) problems.measurementIds = 'required';
  const document = form.documentId.trim();
  if (document === '') problems.documentId = 'required';
  else if (!isUuid(document)) problems.documentId = 'uuid';
  const quality = form.qualityId.trim();
  if (quality !== '' && !isUuid(quality)) problems.qualityId = 'uuid';
  return problems;
}

export interface DraftBody {
  measurement_ids: string[];
  period_id: string;
  document_version_id: string;
  quality_acceptance_id?: string;
}

export function draftBody(form: DraftForm): DraftBody {
  const quality = form.qualityId.trim();
  return {
    measurement_ids: form.measurementIds,
    period_id: form.periodId,
    document_version_id: form.documentId.trim().toLowerCase(),
    ...(quality === '' ? {} : { quality_acceptance_id: quality.toLowerCase() }),
  };
}

// ---- sending ---------------------------------------------------------------------------------------------------------------

export interface SubmitForm {
  /** The people who sign the paper, one name for each line. */
  signers: string;
}

export const EMPTY_SUBMIT: SubmitForm = { signers: '' };

export const signerNames = (value: string): string[] =>
  value
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '');

export function validateSubmit(form: SubmitForm): Partial<Record<keyof SubmitForm, FormProblem>> {
  const names = signerNames(form.signers);
  if (names.length === 0) return { signers: 'required' };
  if (names.length > MAX_SIGNERS) return { signers: 'tooMany' };
  return names.some((name) => name.length > MAX_SIGNER_NAME) ? { signers: 'tooLong' } : {};
}

export const submitBody = (form: SubmitForm): { signer_refs: Array<{ name: string }> } => ({ signer_refs: signerNames(form.signers).map((name) => ({ name })) });

// ---- deciding and revoking -------------------------------------------------------------------------------------------------

export interface DecideForm {
  decision: Decision | '';
  reason: string;
  /** One identifier of a document per line, or separated by commas; optional. */
  evidence: string;
}

export const EMPTY_DECIDE: DecideForm = { decision: '', reason: '', evidence: '' };

export const evidenceIds = (value: string): string[] =>
  value
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');

const reasonProblem = (value: string): FormProblem | undefined => (value.trim() === '' ? 'required' : value.trim().length > MAX_TEXT ? 'tooLong' : undefined);

export function validateDecide(form: DecideForm): Partial<Record<keyof DecideForm, FormProblem>> {
  const problems: Partial<Record<keyof DecideForm, FormProblem>> = {};
  if (form.decision === '') problems.decision = 'required';
  const reason = reasonProblem(form.reason);
  if (reason !== undefined) problems.reason = reason;
  const ids = evidenceIds(form.evidence);
  if (ids.length > MAX_EVIDENCE) problems.evidence = 'tooMany';
  else if (!ids.every(isUuid)) problems.evidence = 'uuid';
  return problems;
}

export const decideBody = (form: DecideForm): { decision: Decision; reason: string; evidence_ids: string[] } => ({
  decision: form.decision === '' ? 'return' : form.decision,
  reason: form.reason.trim(),
  evidence_ids: evidenceIds(form.evidence),
});

export interface RevokeForm {
  reason: string;
  documentId: string;
}

export const EMPTY_REVOKE: RevokeForm = { reason: '', documentId: '' };

export function validateRevoke(form: RevokeForm): Partial<Record<keyof RevokeForm, FormProblem>> {
  const problems: Partial<Record<keyof RevokeForm, FormProblem>> = {};
  const reason = reasonProblem(form.reason);
  if (reason !== undefined) problems.reason = reason;
  const document = form.documentId.trim();
  if (document === '') problems.documentId = 'required';
  else if (!isUuid(document)) problems.documentId = 'uuid';
  return problems;
}

export const revokeBody = (form: RevokeForm): { reason: string; approval_document_version_id: string } => ({ reason: form.reason.trim(), approval_document_version_id: form.documentId.trim().toLowerCase() });

// ---- refusals ----------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'measurementNotApproved'
  | 'measurementAccepted'
  | 'qualityRequired'
  | 'openNcr'
  | 'exceedsContract'
  | 'revisionNotEffective'
  | 'claimed'
  | 'selfApproval'
  | 'contractState'
  | 'acceptanceState'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export interface ProblemView {
  problem: Problem;
  /** What the contract can still accept, when the server said it. */
  remainingVnd: string | undefined;
}

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): ProblemView {
  const view = (problem: Problem, remaining?: string): ProblemView => ({ problem, remainingVnd: remaining });
  if (!(error instanceof ApiError)) return view('general');
  switch (error.code) {
    case 'MEASUREMENT_NOT_APPROVED':
      return view('measurementNotApproved');
    case 'MEASUREMENT_ALREADY_ACCEPTED':
      return view('measurementAccepted');
    case 'QUALITY_ACCEPTANCE_REQUIRED':
      return view('qualityRequired');
    case 'OPEN_CRITICAL_NCR':
      return view('openNcr');
    case 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT':
      return view('exceedsContract', typeof error.extensions.remaining_vnd === 'string' ? error.extensions.remaining_vnd : undefined);
    case 'REVISION_NOT_EFFECTIVE':
      return view('revisionNotEffective');
    case 'ACCEPTANCE_ALREADY_CLAIMED':
      return view('claimed');
    case 'SELF_APPROVAL_DENIED':
      return view('selfApproval');
    case 'CONTRACT_STATE_INVALID':
      return view('contractState');
    case 'ACCEPTANCE_STATE_INVALID':
      return view('acceptanceState');
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
