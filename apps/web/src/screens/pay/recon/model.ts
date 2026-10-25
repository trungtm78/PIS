import { ApiError } from '@machvon/api-client';
import { isUuid } from '../../ctr/change/model';
import { signedAmountText } from '../model';

export const MATCH_PERMISSION = 'treasury.match';
export const ASSIGN_PERMISSION = 'reconciliation.assign';
export const RESOLVE_PERMISSION = 'reconciliation.resolve';
export const READ_PERMISSION = 'reconciliation.read';
export const TRANSACTION_READ_PERMISSION = 'treasury_transaction.read';
export const REQUEST_READ_PERMISSION = 'payment_request.read';
export const MEMBER_READ_PERMISSION = 'membership.read';

export const BOARD_PATH = '/pay/pay-05';
export const ITEM_PATH = '/pay/pay-06';
export const TRACKING_PATH = '/pay/pay-09';

/** The board of matching and of differences (PAY-05). */
export const boardLink = (): string => BOARD_PATH;
/** One difference and the work on it (PAY-06). */
export const itemLink = (id: string): string => `${ITEM_PATH}?${new URLSearchParams({ item: id }).toString()}`;
/** Where the projects stand with the Treasury (PAY-09). */
export const trackingLink = (): string => TRACKING_PATH;

export const ITEM_STATUSES = ['OPEN', 'EXPLAINED', 'RESOLVED', 'WRITTEN_OFF_APPROVED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const ITEM_KINDS = ['AMOUNT_MISMATCH', 'UNMATCHED_TRANSACTION', 'MISSING_CONFIRMATION', 'DUPLICATE_CONFLICT', 'ADVANCE_OVERDUE'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const RESOLUTIONS = ['EXPLAINED', 'RESOLVED', 'WRITTEN_OFF'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

const MAX_TEXT = 2000;
const SIGNED = /^-?(0|[1-9][0-9]{0,23})$/;
const SHA = /^[0-9a-f]{64}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const signed = (value: unknown): string | undefined => (typeof value === 'string' && SIGNED.test(value) ? value : undefined);
const nullableSigned = (value: unknown): string | null => signed(value) ?? null;

// ---- what the server answers --------------------------------------------------------------------------------------------------

export interface ItemActions {
  assign: boolean;
  explain: boolean;
  resolve: boolean;
  writeOff: boolean;
}

export interface ReconItem {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  projectId: string;
  projectCode: string;
  contractCode: string | null;
  paymentRequestId: string | null;
  requestNo: string | null;
  transactionId: string | null;
  documentNo: string | null;
  sourceFileName: string | null;
  sourceFileSha256: string | null;
  internalVnd: string | null;
  confirmedVnd: string | null;
  differenceVnd: string | null;
  ownerMembershipId: string;
  ownerName: string | null;
  dueAt: string;
  overdue: boolean;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  approvalDocumentVersionId: string | null;
  issueId: string | null;
  version: number;
  actions: ItemActions;
}

export function toItem(raw: unknown): ReconItem | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const kind = ITEM_KINDS.find((candidate) => candidate === row?.kind);
  const status = ITEM_STATUSES.find((candidate) => candidate === row?.status);
  const projectId = text(row?.project_id);
  const owner = text(row?.owner_membership_id);
  const dueAt = text(row?.due_at);
  const version = whole(row?.version);
  const actions = asRecord(row?.actions);
  if (row === undefined || id === undefined || kind === undefined || status === undefined || projectId === undefined || owner === undefined || dueAt === undefined || version === undefined || actions === undefined) return undefined;
  const sha = text(row.source_file_sha256);
  return {
    id,
    kind,
    status,
    projectId,
    projectCode: text(row.project_code) ?? '',
    contractCode: nullableText(row.contract_code),
    paymentRequestId: nullableText(row.payment_request_id),
    requestNo: nullableText(row.request_no),
    transactionId: nullableText(row.treasury_transaction_id),
    documentNo: nullableText(row.document_no),
    sourceFileName: nullableText(row.source_file_name),
    sourceFileSha256: sha !== undefined && SHA.test(sha) ? sha : null,
    internalVnd: nullableSigned(row.internal_amount_vnd),
    confirmedVnd: nullableSigned(row.confirmed_amount_vnd),
    differenceVnd: nullableSigned(row.difference_vnd),
    ownerMembershipId: owner,
    ownerName: nullableText(row.owner_name),
    dueAt,
    overdue: row.overdue === true,
    resolutionNote: nullableText(row.resolution_note),
    resolvedBy: nullableText(row.resolved_by),
    resolvedAt: nullableText(row.resolved_at),
    approvalDocumentVersionId: nullableText(row.approval_document_version_id),
    issueId: nullableText(row.issue_id),
    version,
    actions: { assign: actions.assign === true, explain: actions.explain === true, resolve: actions.resolve === true, writeOff: actions.write_off === true },
  };
}

export interface ItemSummary {
  waiting: number;
  overdue: number;
  waitingDifferenceVnd: string;
}

export interface ItemPage {
  items: ReconItem[];
  summary: ItemSummary;
}

const NO_SUMMARY: ItemSummary = { waiting: 0, overdue: 0, waitingDifferenceVnd: '0' };

export function toItemPage(value: unknown): ItemPage {
  const row = asRecord(value);
  const summary = asRecord(row?.summary);
  const items = row?.items;
  return {
    items: (Array.isArray(items) ? items : []).flatMap((item) => toItem(item) ?? []),
    summary:
      summary === undefined
        ? NO_SUMMARY
        : { waiting: whole(summary.waiting) ?? 0, overdue: whole(summary.overdue) ?? 0, waitingDifferenceVnd: signed(summary.waiting_difference_vnd) ?? '0' },
  };
}

export type TransactionMatch = 'UNMATCHED' | 'MATCHED' | 'EXCEPTION';
const MATCH_STATUSES: readonly TransactionMatch[] = ['UNMATCHED', 'MATCHED', 'EXCEPTION'];

/** A Treasury transaction as the read model shows it: the voucher, the amount and whether it has been matched. */
export interface Transaction {
  id: string;
  projectId: string;
  projectCode: string;
  provider: string;
  direction: string;
  documentNo: string | null;
  documentDate: string | null;
  amountVnd: string;
  confirmedAt: string;
  matchStatus: TransactionMatch;
  paymentRequestId: string | null;
  /** For a refund, the payment it undoes. */
  reversalOfId: string | null;
}

export function toTransaction(raw: unknown): Transaction | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const projectId = text(row?.project_id);
  const amount = signed(row?.amount_vnd);
  const confirmedAt = text(row?.confirmed_at);
  const matchStatus = MATCH_STATUSES.find((candidate) => candidate === row?.match_status);
  if (row === undefined || id === undefined || projectId === undefined || amount === undefined || confirmedAt === undefined || matchStatus === undefined) return undefined;
  return {
    id,
    projectId,
    projectCode: text(row.project_code) ?? '',
    provider: text(row.provider) ?? '',
    direction: text(row.direction) ?? 'PAYMENT',
    documentNo: nullableText(row.document_no),
    documentDate: nullableText(row.document_date),
    amountVnd: amount,
    confirmedAt,
    matchStatus,
    paymentRequestId: nullableText(row.payment_request_id),
    reversalOfId: nullableText(row.reversal_of_id),
  };
}

export interface TrackingCount {
  count: number;
  amountVnd: string;
}

export interface TrackingRow {
  projectId: string;
  projectCode: string;
  projectName: string;
  sent: TrackingCount;
  settled: TrackingCount;
  confirmed: TrackingCount;
  unmatched: number;
  differences: TrackingCount;
  lastConfirmedAt: string | null;
  lastImportAt: string | null;
}

const toCount = (value: unknown): TrackingCount | undefined => {
  const row = asRecord(value);
  const count = whole(row?.count);
  const amount = signed(row?.amount_vnd);
  return count === undefined || amount === undefined ? undefined : { count, amountVnd: amount };
};

export function toTracking(raw: unknown): TrackingRow | undefined {
  const row = asRecord(raw);
  const projectId = text(row?.project_id);
  const sent = toCount(row?.sent);
  const settled = toCount(row?.settled);
  const confirmed = toCount(row?.confirmed);
  const differences = toCount(row?.differences);
  const unmatched = whole(row?.unmatched);
  if (row === undefined || projectId === undefined || sent === undefined || settled === undefined || confirmed === undefined || differences === undefined || unmatched === undefined) return undefined;
  return {
    projectId,
    projectCode: text(row.project_code) ?? '',
    projectName: text(row.project_name) ?? '',
    sent,
    settled,
    confirmed,
    unmatched,
    differences,
    lastConfirmedAt: nullableText(row.last_confirmed_at),
    lastImportAt: nullableText(row.last_import_at),
  };
}

/** The answer of a match that settled the request. */
export interface Settlement {
  paymentRequestId: string;
  transactionId: string;
  amountVnd: string;
  treasuryPaidOn: string;
}

export function toSettlement(value: unknown): Settlement | undefined {
  const row = asRecord(value);
  const paymentRequestId = text(row?.payment_request_id);
  const transactionId = text(row?.transaction_id);
  const amount = signed(row?.amount_vnd);
  const paidOn = text(row?.treasury_paid_on);
  if (row === undefined || paymentRequestId === undefined || transactionId === undefined || amount === undefined || paidOn === undefined) return undefined;
  return { paymentRequestId, transactionId, amountVnd: amount, treasuryPaidOn: paidOn };
}

/** The answer of a command on an item. */
export interface ItemAnswer {
  id: string;
  status: string;
  version: number;
}

export function toItemAnswer(value: unknown): ItemAnswer | undefined {
  const row = asRecord(value);
  const id = text(row?.resource_id);
  const version = whole(row?.resource_version);
  if (row === undefined || id === undefined || version === undefined) return undefined;
  return { id, status: text(row.status) ?? '', version };
}

/** A member that can own a difference: an active member with a name to show. */
export interface MemberOption {
  id: string;
  name: string;
}

export function toMember(raw: unknown): MemberOption | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const name = text(row?.display_name);
  if (id === undefined || name === undefined || row?.status !== 'Active') return undefined;
  if (row.membership_type !== undefined && row.membership_type !== 'STAFF') return undefined;
  return { id, name };
}

/** An amount of dong in groups of three digits, as the locale writes them. */
export const vndText = (value: string, locale: string): string => (SIGNED.test(value) ? new Intl.NumberFormat(locale).format(BigInt(value)) : value);

/** A difference with its sign shown: a shortfall is negative. */
export const differenceText = (value: string, locale: string): string => (SIGNED.test(value) ? signedAmountText(value, locale) : value);

// ---- reading the board ---------------------------------------------------------------------------------------------------------

/** The transactions that wait to be matched: confirmed payments (not refunds) that no request has taken. */
export const unmatchedTransactions = (rows: readonly Transaction[]): Transaction[] => rows.filter((row) => row.matchStatus === 'UNMATCHED' && row.direction === 'PAYMENT');

/** The requests a transaction can be matched to: with the Treasury and of the project of the transaction. */
export function candidatesFor<T extends { status: string; projectId: string }>(requests: readonly T[], transaction: Pick<Transaction, 'projectId'>): T[] {
  return requests.filter((request) => request.status === 'SENT_TREASURY' && request.projectId === transaction.projectId);
}

/** Whether the net of a request is the amount of the transaction: the match settles only then. */
export const sameAmount = (netVnd: string, amountVnd: string): boolean => netVnd === amountVnd;

/** The difference as the screen words it: the confirmed figure less the internal one, signed (a shortfall is negative). */
export function differenceOf(internal: string, confirmed: string): string {
  return (BigInt(confirmed) - BigInt(internal)).toString();
}

// ---- the commands ---------------------------------------------------------------------------------------------------------------

export type ReconProblem = 'required' | 'tooLong' | 'uuid' | 'invalid' | 'past';

export interface MatchForm {
  requestId: string;
  note: string;
}

export const EMPTY_MATCH: MatchForm = { requestId: '', note: '' };

export function validateMatch(form: MatchForm): Partial<Record<keyof MatchForm, ReconProblem>> {
  const problems: Partial<Record<keyof MatchForm, ReconProblem>> = {};
  if (form.requestId.trim() === '') problems.requestId = 'required';
  else if (!isUuid(form.requestId.trim())) problems.requestId = 'uuid';
  if (form.note.trim().length > MAX_TEXT) problems.note = 'tooLong';
  return problems;
}

export const matchBody = (form: MatchForm): { payment_request_id: string; note?: string } => {
  const note = form.note.trim();
  return { payment_request_id: form.requestId.trim(), ...(note === '' ? {} : { note }) };
};

export interface AssignForm {
  ownerId: string;
  /** A day and time as the browser's `datetime-local` gives them, in Vietnam time. */
  dueAt: string;
}

export const EMPTY_ASSIGN: AssignForm = { ownerId: '', dueAt: '' };

const LOCAL_DUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** The instant a day and time in Vietnam stand for (UTC+7, no daylight saving); undefined when they are not a real moment. */
export function dueInstant(value: string): Date | undefined {
  if (!LOCAL_DUE.test(value)) return undefined;
  const instant = new Date(`${value}:00+07:00`);
  return Number.isNaN(instant.getTime()) || new Date(instant.getTime() + 7 * 3_600_000).toISOString().slice(0, 16) !== value ? undefined : instant;
}

export function validateAssign(form: AssignForm, now: Date): Partial<Record<keyof AssignForm, ReconProblem>> {
  const problems: Partial<Record<keyof AssignForm, ReconProblem>> = {};
  if (form.ownerId.trim() === '') problems.ownerId = 'required';
  else if (!isUuid(form.ownerId.trim())) problems.ownerId = 'uuid';
  const due = dueInstant(form.dueAt.trim());
  if (form.dueAt.trim() === '') problems.dueAt = 'required';
  else if (due === undefined) problems.dueAt = 'invalid';
  else if (due.getTime() <= now.getTime()) problems.dueAt = 'past';
  return problems;
}

export const assignBody = (form: AssignForm): { owner_membership_id: string; due_at: string } => ({
  owner_membership_id: form.ownerId.trim(),
  due_at: (dueInstant(form.dueAt.trim()) ?? new Date(0)).toISOString(),
});

export interface ResolveForm {
  note: string;
  approvalDocumentVersionId: string;
}

export const EMPTY_RESOLVE: ResolveForm = { note: '', approvalDocumentVersionId: '' };

export function validateResolve(form: ResolveForm, resolution: Resolution): Partial<Record<keyof ResolveForm, ReconProblem>> {
  const problems: Partial<Record<keyof ResolveForm, ReconProblem>> = {};
  const note = form.note.trim();
  if (note === '') problems.note = 'required';
  else if (note.length > MAX_TEXT) problems.note = 'tooLong';
  if (resolution === 'WRITTEN_OFF') {
    const document = form.approvalDocumentVersionId.trim();
    if (document === '') problems.approvalDocumentVersionId = 'required';
    else if (!isUuid(document)) problems.approvalDocumentVersionId = 'uuid';
  }
  return problems;
}

export const resolveBody = (form: ResolveForm, resolution: Resolution): { resolution: Resolution; note: string; approval_document_version_id?: string } => ({
  resolution,
  note: form.note.trim(),
  ...(resolution === 'WRITTEN_OFF' ? { approval_document_version_id: form.approvalDocumentVersionId.trim() } : {}),
});

// ---- refusals ----------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'mismatch'
  | 'alreadyMatched'
  | 'paymentState'
  | 'itemState'
  | 'approvalRequired'
  | 'selfApproval'
  | 'planYear'
  | 'notClean'
  | 'versionConflict'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

/** The two figures a difference was opened with, which the refusal of a match tells at once. */
export interface Mismatch {
  itemId: string;
  internalVnd: string;
  confirmedVnd: string;
  differenceVnd: string;
}

export interface Refusal {
  problem: Problem;
  mismatch: Mismatch | null;
}

/** The refusal of the server as the screen words it; a match that did not agree carries the difference that was opened. */
export function describeProblem(error: unknown): Refusal {
  const refusal = (problem: Problem, mismatch: Mismatch | null = null): Refusal => ({ problem, mismatch });
  if (!(error instanceof ApiError)) return refusal('general');
  const extensions = error.extensions;
  switch (error.code) {
    case 'AMOUNT_MISMATCH_OPENED': {
      const itemId = extensions.reconciliation_item_id;
      const internal = signed(extensions.internal_amount_vnd);
      const confirmed = signed(extensions.confirmed_amount_vnd);
      const difference = signed(extensions.difference_vnd);
      return refusal('mismatch', typeof itemId === 'string' && internal !== undefined && confirmed !== undefined && difference !== undefined ? { itemId, internalVnd: internal, confirmedVnd: confirmed, differenceVnd: difference } : null);
    }
    case 'TRANSACTION_ALREADY_MATCHED':
      return refusal('alreadyMatched');
    case 'PAYMENT_STATE_INVALID':
      return refusal('paymentState');
    case 'RECONCILIATION_STATE_INVALID':
      return refusal('itemState');
    case 'APPROVAL_REQUIRED':
      return refusal('approvalRequired');
    case 'SELF_APPROVAL_DENIED':
      return refusal('selfApproval');
    case 'PLAN_YEAR_MISMATCH':
      return refusal('planYear');
    case 'DOCUMENT_NOT_CLEAN':
      return refusal('notClean');
    case 'VERSION_CONFLICT':
      return refusal('versionConflict');
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return refusal('validation');
    case 'RESOURCE_NOT_FOUND':
      return refusal('notFound');
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return refusal('denied');
    case 'SESSION_EXPIRED':
      return refusal('session');
    default:
      return refusal('general');
  }
}
