import { ApiError } from '@machvon/api-client';
import { MAX_TEXT, isUuid, signedAmountText } from '../../ctr/change/model';

export { signedAmountText };

/** The permissions of the commands and of the reads (x-permission in openapi.json); the server judges them again, with the scope and the people. */
export const CREATE_PERMISSION = 'payment.create';
export const ATTACH_PERMISSION = 'payment.document.attach';
export const CANCEL_PERMISSION = 'payment.cancel';
export const READ_PERMISSION = 'payment_request.read';

export const LIST_PATH = '/pay/pay-01';
export const CREATE_PATH = '/pay/pay-02';
export const DETAIL_PATH = '/pay/pay-03';
export const VALUATION_PATH = '/ctr/ctr-13';

/** The payment requests of a contract (PAY-01), or all of them. */
export const listLink = (contractId?: string): string => (contractId === undefined ? LIST_PATH : `${LIST_PATH}?${new URLSearchParams({ contract: contractId }).toString()}`);
/** A request, its figures and documents (PAY-03). */
export const paymentLink = (id: string): string => `${DETAIL_PATH}?${new URLSearchParams({ request: id }).toString()}`;
/** The table that shows how the amount of a request is made up, line by line (CTR-13). */
export const valuationLink = (id: string): string => `${VALUATION_PATH}?${new URLSearchParams({ request: id }).toString()}`;
/** Drawing up a request, for one contract when it is known (PAY-02). */
export const createLink = (contractId?: string): string => (contractId === undefined ? CREATE_PATH : `${CREATE_PATH}?${new URLSearchParams({ contract: contractId }).toString()}`);

export const STATUSES = ['DRAFT', 'SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED', 'RETURNED', 'CANCELLED', 'REVERSED'] as const;
export type PaymentStatus = (typeof STATUSES)[number];

export const KINDS = ['ADVANCE', 'INTERIM', 'FINAL'] as const;
export type PaymentKind = (typeof KINDS)[number];

export const DOC_KINDS = ['INVOICE', 'ACCEPTANCE_MINUTES', 'GUARANTEE', 'CONTRACT_COPY', 'TREASURY_FORM', 'OTHER'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

const MAX_REFERENCE = 100;
const SIGNED = /^-?(0|[1-9][0-9]{0,23})$/;
const WHOLE = /^(0|[1-9][0-9]{0,23})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- what the server answers ---------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const amount = (value: unknown): string | undefined => (typeof value === 'string' && SIGNED.test(value) ? value : undefined);

export interface PaymentLine {
  id: string;
  acceptanceLineId: string;
  boqItemId: string;
  businessKey: string;
  description: string;
  unitCode: string;
  partyId: string | null;
  /** Exact decimal texts: the quantity accepted, the price of the day the acceptance was drawn up, and the retention percentage. */
  quantity: string;
  unitPrice: string;
  retentionPct: string;
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
  netVnd: string;
}

export interface PaymentDocument {
  id: string;
  documentVersionId: string;
  docKind: DocKind;
  checksum: string;
  invoiceNo: string | null;
  invoiceDate: string | null;
  signed: boolean;
  duplicateOverrideReason: string | null;
  createdAt: string;
}

export interface PaymentActions {
  revise: boolean;
  attachDocument: boolean;
  cancel: boolean;
  overrideDuplicate: boolean;
  submit: boolean;
  verify: boolean;
  return: boolean;
  generateForms: boolean;
  sendTreasury: boolean;
}

export interface PaymentRequest {
  id: string;
  requestNo: string | null;
  requestKind: PaymentKind;
  status: PaymentStatus;
  contract: { id: string; code: string; status: string };
  projectId: string;
  acceptance: { id: string; acceptanceNo: string; acceptedOn: string } | null;
  allocationLineId: string | null;
  planYear: number | null;
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
  taxAdjustmentVnd: string;
  taxAdjustmentBasis: string | null;
  advanceRecoveryExtraVnd: string;
  netVnd: string;
  claimsAcceptance: boolean;
  /** Other drafts of the same acceptance; null where the reader may not be told. */
  otherDrafts: number | null;
  returnReason: string | null;
  verificationNote: string | null;
  /** The day the file went to the Treasury and the number the Treasury gave it, as they were entered. */
  treasurySubmittedOn: string | null;
  treasuryRef: string | null;
  /** The day the Treasury confirmed the payment (Vietnam time), once the request is settled. */
  treasuryPaidOn: string | null;
  /** The Treasury transaction that settled the request, and, once it is reversed, when and against which refund. */
  settledTransactionId: string | null;
  reversedAt: string | null;
  refundTransactionId: string | null;
  /** The codes of the Treasury forms that stand for the request. */
  formsStanding: string[];
  cancelReason: string | null;
  createdAt: string;
  lines: PaymentLine[];
  documents: PaymentDocument[];
  actions: PaymentActions;
  version: number;
}

function toLine(raw: unknown): PaymentLine | undefined {
  const row = asRecord(raw);
  const item = asRecord(row?.boq_item);
  const id = text(row?.id);
  const acceptanceLineId = text(row?.acceptance_line_id);
  const boqItemId = text(item?.id);
  const grossVnd = amount(row?.gross_vnd);
  const advanceRecoveryVnd = amount(row?.advance_recovery_vnd);
  const retentionVnd = amount(row?.retention_vnd);
  const netVnd = amount(row?.net_vnd);
  if (row === undefined || id === undefined || acceptanceLineId === undefined || boqItemId === undefined || grossVnd === undefined || advanceRecoveryVnd === undefined || retentionVnd === undefined || netVnd === undefined) return undefined;
  return {
    id,
    acceptanceLineId,
    boqItemId,
    businessKey: text(item?.business_key) ?? '',
    description: text(item?.description) ?? '',
    unitCode: text(item?.unit_code) ?? '',
    partyId: nullableText(row.party_id),
    quantity: text(row.quantity) ?? '0',
    unitPrice: text(row.unit_price_snapshot) ?? '0',
    retentionPct: text(row.retention_pct_snapshot) ?? '0',
    grossVnd,
    advanceRecoveryVnd,
    retentionVnd,
    netVnd,
  };
}

function toDocument(raw: unknown): PaymentDocument | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const documentVersionId = text(row?.document_version_id);
  const docKind = DOC_KINDS.find((candidate) => candidate === row?.doc_kind);
  if (row === undefined || id === undefined || documentVersionId === undefined || docKind === undefined) return undefined;
  return {
    id,
    documentVersionId,
    docKind,
    checksum: text(row.checksum) ?? '',
    invoiceNo: nullableText(row.invoice_no),
    invoiceDate: nullableText(row.invoice_date),
    signed: row.signed === true,
    duplicateOverrideReason: nullableText(row.duplicate_override_reason),
    createdAt: text(row.created_at) ?? '',
  };
}

/** A payment request from the read; undefined for anything that is not one (a record that cannot be read is not shown half). */
export function toPaymentRequest(value: unknown): PaymentRequest | undefined {
  const row = asRecord(value);
  const contract = asRecord(row?.contract);
  const acceptance = asRecord(row?.acceptance);
  const actions = asRecord(row?.actions);
  const id = text(row?.id);
  const requestKind = KINDS.find((candidate) => candidate === row?.request_kind);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const contractId = text(contract?.id);
  const grossVnd = amount(row?.gross_vnd);
  const advanceRecoveryVnd = amount(row?.advance_recovery_vnd);
  const retentionVnd = amount(row?.retention_vnd);
  const taxAdjustmentVnd = amount(row?.tax_adjustment_vnd);
  const netVnd = amount(row?.net_vnd);
  const version = whole(row?.version);
  if (
    row === undefined ||
    id === undefined ||
    requestKind === undefined ||
    status === undefined ||
    contractId === undefined ||
    grossVnd === undefined ||
    advanceRecoveryVnd === undefined ||
    retentionVnd === undefined ||
    taxAdjustmentVnd === undefined ||
    netVnd === undefined ||
    version === undefined
  ) {
    return undefined;
  }
  const acceptanceId = text(acceptance?.id);
  return {
    id,
    requestNo: nullableText(row.request_no),
    requestKind,
    status,
    contract: { id: contractId, code: text(contract?.code) ?? '', status: text(contract?.status) ?? '' },
    projectId: text(row.project_id) ?? '',
    acceptance: acceptanceId === undefined ? null : { id: acceptanceId, acceptanceNo: text(acceptance?.acceptance_no) ?? '', acceptedOn: text(acceptance?.accepted_on) ?? '' },
    allocationLineId: nullableText(row.allocation_line_id),
    planYear: whole(row.plan_year) ?? null,
    grossVnd,
    advanceRecoveryVnd,
    retentionVnd,
    taxAdjustmentVnd,
    taxAdjustmentBasis: nullableText(row.tax_adjustment_basis),
    advanceRecoveryExtraVnd: amount(row.advance_recovery_extra_vnd) ?? '0',
    netVnd,
    claimsAcceptance: row.claims_acceptance === true,
    otherDrafts: whole(row.other_drafts) ?? null,
    returnReason: nullableText(row.return_reason),
    cancelReason: nullableText(row.cancel_reason),
    verificationNote: nullableText(row.verification_note),
    treasurySubmittedOn: nullableText(row.treasury_submitted_on),
    treasuryPaidOn: nullableText(row.treasury_paid_on),
    settledTransactionId: nullableText(row.settled_transaction_id),
    reversedAt: nullableText(row.reversed_at),
    refundTransactionId: nullableText(row.refund_transaction_id),
    treasuryRef: nullableText(row.treasury_ref),
    formsStanding: (Array.isArray(row.forms_standing) ? row.forms_standing : []).flatMap((code) => text(code) ?? []),
    createdAt: text(row.created_at) ?? '',
    lines: (Array.isArray(row.lines) ? row.lines : []).flatMap((line) => toLine(line) ?? []),
    documents: (Array.isArray(row.documents) ? row.documents : []).flatMap((document) => toDocument(document) ?? []),
    actions: { revise: actions?.revise === true, attachDocument: actions?.attach_document === true, cancel: actions?.cancel === true, overrideDuplicate: actions?.override_duplicate === true, submit: actions?.submit === true, verify: actions?.verify === true, return: actions?.return === true, generateForms: actions?.generate_forms === true, sendTreasury: actions?.send_treasury === true },
    version,
  };
}

export type WarningCode = 'OTHER_DRAFTS_FOR_ACCEPTANCE' | 'NATIONAL_CODE_MISSING' | 'DUPLICATE_INVOICE_OTHER_CONTRACT';
const WARNING_CODES: readonly WarningCode[] = ['OTHER_DRAFTS_FOR_ACCEPTANCE', 'NATIONAL_CODE_MISSING', 'DUPLICATE_INVOICE_OTHER_CONTRACT'];

/** What a command answered: the request after it and what the caller should know. */
export interface PaymentAnswer {
  id: string;
  status: string;
  version: number;
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
  taxAdjustmentVnd: string;
  netVnd: string;
  warnings: WarningCode[];
}

export function toAnswer(value: unknown): PaymentAnswer | undefined {
  const row = asRecord(value);
  const id = text(row?.resource_id);
  const version = whole(row?.resource_version);
  const grossVnd = amount(row?.gross_vnd);
  const advanceRecoveryVnd = amount(row?.advance_recovery_vnd);
  const retentionVnd = amount(row?.retention_vnd);
  const taxAdjustmentVnd = amount(row?.tax_adjustment_vnd);
  const netVnd = amount(row?.net_vnd);
  if (row === undefined || id === undefined || version === undefined || grossVnd === undefined || advanceRecoveryVnd === undefined || retentionVnd === undefined || taxAdjustmentVnd === undefined || netVnd === undefined) return undefined;
  const warnings = (Array.isArray(row.warnings) ? row.warnings : []).flatMap((warning) => WARNING_CODES.find((code) => code === asRecord(warning)?.code) ?? []);
  return { id, status: text(row.status) ?? '', version, grossVnd, advanceRecoveryVnd, retentionVnd, taxAdjustmentVnd, netVnd, warnings };
}

// ---- what the screens decide -----------------------------------------------------------------------------------------------

export const canCreate = (permissions: readonly string[] | undefined, mode: string | undefined): boolean => mode !== 'READ_ONLY' && permissions?.includes(CREATE_PERMISSION) === true;

/** A request that is still a draft, or has been returned, can be revised, given documents and cancelled. */
export const isEditable = (status: PaymentStatus): boolean => status === 'DRAFT' || status === 'RETURNED';

/** The retention percentage as the person reads it, without the zeros the server keeps. */
export function percentText(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? whole : `${whole}.${trimmed}`;
}

// ---- the forms ---------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooLong' | 'amount' | 'uuid' | 'date';

const requiredText = (value: string, max: number): FormProblem | undefined => (value.trim() === '' ? 'required' : value.trim().length > max ? 'tooLong' : undefined);

/** The tax adjustment is a whole amount of dong, signed, or empty (nothing); its basis is needed when it is not nothing. */
function taxProblems(adjustment: string, basis: string): Partial<Record<'taxAdjustment' | 'taxBasis', FormProblem>> {
  const problems: Partial<Record<'taxAdjustment' | 'taxBasis', FormProblem>> = {};
  const value = adjustment.trim();
  if (value !== '' && !SIGNED.test(value)) problems.taxAdjustment = 'amount';
  const filled = value !== '' && SIGNED.test(value) && BigInt(value) !== 0n;
  if (filled && basis.trim() === '') problems.taxBasis = 'required';
  else if (basis.trim().length > MAX_TEXT) problems.taxBasis = 'tooLong';
  return problems;
}

const extraProblem = (extra: string): FormProblem | undefined => (extra.trim() !== '' && !WHOLE.test(extra.trim()) ? 'amount' : undefined);

export interface CreateForm {
  contractId: string;
  acceptanceId: string;
  allocationLineId: string;
  requestNo: string;
  taxAdjustment: string;
  taxBasis: string;
  extraRecovery: string;
}

export const EMPTY_CREATE: CreateForm = { contractId: '', acceptanceId: '', allocationLineId: '', requestNo: '', taxAdjustment: '', taxBasis: '', extraRecovery: '' };

export function validateCreate(form: CreateForm): Partial<Record<keyof CreateForm, FormProblem>> {
  const problems: Partial<Record<keyof CreateForm, FormProblem>> = {};
  if (form.contractId === '') problems.contractId = 'required';
  if (form.acceptanceId === '') problems.acceptanceId = 'required';
  if (form.allocationLineId === '') problems.allocationLineId = 'required';
  const number = requiredText(form.requestNo, MAX_REFERENCE);
  if (number !== undefined) problems.requestNo = number;
  Object.assign(problems, taxProblems(form.taxAdjustment, form.taxBasis));
  const extra = extraProblem(form.extraRecovery);
  if (extra !== undefined) problems.extraRecovery = extra;
  return problems;
}

export interface CreateBody {
  contract_id: string;
  request_kind: 'INTERIM';
  acceptance_id: string;
  allocation_line_id: string;
  request_no: string;
  tax_adjustment_vnd?: string;
  tax_adjustment_basis?: string;
  advance_recovery_extra_vnd?: string;
}

/** What the client decides, and only that: gross, recovery, retention and net are the server's. */
export function createBody(form: CreateForm): CreateBody {
  const adjustment = form.taxAdjustment.trim();
  const adjusted = adjustment !== '' && BigInt(adjustment) !== 0n;
  const extra = form.extraRecovery.trim();
  return {
    contract_id: form.contractId,
    request_kind: 'INTERIM',
    acceptance_id: form.acceptanceId,
    allocation_line_id: form.allocationLineId,
    request_no: form.requestNo.trim(),
    ...(adjusted ? { tax_adjustment_vnd: adjustment, tax_adjustment_basis: form.taxBasis.trim() } : {}),
    ...(extra === '' ? {} : { advance_recovery_extra_vnd: extra }),
  };
}

export interface ReviseForm {
  requestNo: string;
  allocationLineId: string;
  taxAdjustment: string;
  taxBasis: string;
  extraRecovery: string;
}

export const reviseFormOf = (request: PaymentRequest): ReviseForm => ({
  requestNo: request.requestNo ?? '',
  allocationLineId: request.allocationLineId ?? '',
  taxAdjustment: request.taxAdjustmentVnd === '0' ? '' : request.taxAdjustmentVnd,
  taxBasis: request.taxAdjustmentBasis ?? '',
  extraRecovery: request.advanceRecoveryExtraVnd === '0' ? '' : request.advanceRecoveryExtraVnd,
});

export function validateRevise(form: ReviseForm): Partial<Record<keyof ReviseForm, FormProblem>> {
  const problems: Partial<Record<keyof ReviseForm, FormProblem>> = {};
  const number = requiredText(form.requestNo, MAX_REFERENCE);
  if (number !== undefined) problems.requestNo = number;
  if (form.allocationLineId === '') problems.allocationLineId = 'required';
  Object.assign(problems, taxProblems(form.taxAdjustment, form.taxBasis));
  const extra = extraProblem(form.extraRecovery);
  if (extra !== undefined) problems.extraRecovery = extra;
  return problems;
}

export interface ReviseBody {
  allocation_line_id: string;
  request_no: string;
  tax_adjustment_vnd: string;
  tax_adjustment_basis?: string;
  advance_recovery_extra_vnd: string;
}

export function reviseBody(form: ReviseForm): ReviseBody {
  const adjustment = form.taxAdjustment.trim() === '' ? '0' : form.taxAdjustment.trim();
  const adjusted = BigInt(adjustment) !== 0n;
  return {
    allocation_line_id: form.allocationLineId,
    request_no: form.requestNo.trim(),
    tax_adjustment_vnd: adjustment,
    ...(adjusted ? { tax_adjustment_basis: form.taxBasis.trim() } : {}),
    advance_recovery_extra_vnd: form.extraRecovery.trim() === '' ? '0' : form.extraRecovery.trim(),
  };
}

export interface AttachForm {
  documentId: string;
  docKind: DocKind | '';
  invoiceNo: string;
  invoiceDate: string;
  signed: boolean;
  /** The reason an approver gives to let an invoice number used before in the contract through. */
  overrideReason: string;
}

export const EMPTY_ATTACH: AttachForm = { documentId: '', docKind: '', invoiceNo: '', invoiceDate: '', signed: false, overrideReason: '' };

export function validateAttach(form: AttachForm): Partial<Record<keyof AttachForm, FormProblem>> {
  const problems: Partial<Record<keyof AttachForm, FormProblem>> = {};
  const document = form.documentId.trim();
  if (document === '') problems.documentId = 'required';
  else if (!isUuid(document)) problems.documentId = 'uuid';
  if (form.docKind === '') problems.docKind = 'required';
  if (form.docKind === 'INVOICE') {
    const number = requiredText(form.invoiceNo, MAX_REFERENCE);
    if (number !== undefined) problems.invoiceNo = number;
    if (form.invoiceDate.trim() === '') problems.invoiceDate = 'required';
    else if (!DATE.test(form.invoiceDate.trim())) problems.invoiceDate = 'date';
    if (form.overrideReason.trim().length > MAX_TEXT) problems.overrideReason = 'tooLong';
  }
  return problems;
}

export interface AttachBody {
  document_version_id: string;
  doc_kind: DocKind;
  invoice_no?: string;
  invoice_date?: string;
  signed?: boolean;
  duplicate_override_reason?: string;
}

export function attachBody(form: AttachForm): AttachBody {
  const invoice = form.docKind === 'INVOICE';
  const reason = form.overrideReason.trim();
  return {
    document_version_id: form.documentId.trim().toLowerCase(),
    doc_kind: form.docKind === '' ? 'OTHER' : form.docKind,
    ...(invoice ? { invoice_no: form.invoiceNo.trim(), invoice_date: form.invoiceDate.trim() } : {}),
    ...(form.signed ? { signed: true } : {}),
    ...(invoice && reason !== '' ? { duplicate_override_reason: reason } : {}),
  };
}

export interface CancelForm {
  reason: string;
}

export const EMPTY_CANCEL: CancelForm = { reason: '' };

export function validateCancel(form: CancelForm): Partial<Record<keyof CancelForm, FormProblem>> {
  const problem = requiredText(form.reason, MAX_TEXT);
  return problem === undefined ? {} : { reason: problem };
}

export const cancelBody = (form: CancelForm): { reason: string } => ({ reason: form.reason.trim() });

/** Sending a request: the figures the person saw are sent with it, so a screen that is out of date is refused rather than sent. */
export const submitBody = (request: PaymentRequest): { expected_gross_vnd: string; expected_net_vnd: string } => ({ expected_gross_vnd: request.grossVnd, expected_net_vnd: request.netVnd });

export interface VerifyForm {
  note: string;
}

export const EMPTY_VERIFY: VerifyForm = { note: '' };

/** The note of the person who checks is optional; when written it is not blank and not too long. */
export function validateVerify(form: VerifyForm): Partial<Record<keyof VerifyForm, FormProblem>> {
  const problem = form.note === '' ? undefined : requiredText(form.note, MAX_TEXT);
  return problem === undefined ? {} : { note: problem };
}

export const verifyBody = (form: VerifyForm): { note?: string } => (form.note.trim() === '' ? {} : { note: form.note.trim() });

export interface ReturnForm {
  reason: string;
}

export const EMPTY_RETURN: ReturnForm = { reason: '' };

export function validateReturn(form: ReturnForm): Partial<Record<keyof ReturnForm, FormProblem>> {
  const problem = requiredText(form.reason, MAX_TEXT);
  return problem === undefined ? {} : { reason: problem };
}

export const returnBody = (form: ReturnForm): { reason: string } => ({ reason: form.reason.trim() });

// ---- refusals ----------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'acceptanceNotApproved'
  | 'claimed'
  | 'contractState'
  | 'referenceDuplicate'
  | 'paymentState'
  | 'netMismatch'
  | 'invoiceRequired'
  | 'valueExceeded'
  | 'advanceExceeded'
  | 'allocationUnavailable'
  | 'planYear'
  | 'nationalCode'
  | 'invoiceDuplicate'
  | 'documentNotClean'
  | 'selfApproval'
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
    case 'ACCEPTANCE_NOT_APPROVED':
      return 'acceptanceNotApproved';
    case 'ACCEPTANCE_ALREADY_CLAIMED':
      return 'claimed';
    case 'CONTRACT_STATE_INVALID':
      return 'contractState';
    case 'PAYMENT_REFERENCE_DUPLICATE':
      return 'referenceDuplicate';
    case 'PAYMENT_STATE_INVALID':
      return 'paymentState';
    case 'PAYMENT_NET_MISMATCH':
      return 'netMismatch';
    case 'INVOICE_REQUIRED':
      return 'invoiceRequired';
    case 'VALUE_EXCEEDED':
      return 'valueExceeded';
    case 'ADVANCE_RECOVERY_EXCEEDED':
      return 'advanceExceeded';
    case 'ALLOCATION_UNAVAILABLE':
      return 'allocationUnavailable';
    case 'PLAN_YEAR_MISMATCH':
      return 'planYear';
    case 'NATIONAL_CODE_REQUIRED':
    case 'NATIONAL_CODE_FORMAT_INVALID':
      return 'nationalCode';
    case 'INVOICE_DUPLICATE':
      return 'invoiceDuplicate';
    case 'DOCUMENT_NOT_CLEAN':
      return 'documentNotClean';
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

/** Whether the server refused a document because the invoice number was used before in the contract: the screen then offers the exception to whoever may give it. */
export const isInvoiceDuplicate = (error: unknown): boolean => error instanceof ApiError && error.code === 'INVOICE_DUPLICATE';
