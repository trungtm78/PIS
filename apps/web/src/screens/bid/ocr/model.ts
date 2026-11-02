import { ApiError } from '@machvon/api-client';
import type { TrackedPackage } from '../procurement/model';

/** The permissions of BID-06 (x-permission of the operations in openapi.json); the server judges each call again, with the scope of the project and the full view of the proposal. */
export const READ_PERMISSION = 'bid.ocr.read';
export const REVIEW_PERMISSION = 'bid.ocr.review';

export const OCR_STATUSES = ['AUTO_ACCEPTED', 'NEEDS_REVIEW', 'CONFIRMED', 'CORRECTED'] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];
export const TEXT_STATES = ['READABLE', 'DIGEST_MISMATCH', 'MISSING'] as const;
export type TextState = (typeof TEXT_STATES)[number];
export type Decision = 'CONFIRMED' | 'CORRECTED';

/** A note is short, and the text of a page is the text of a page: the server holds the same limits. */
export const MAX_NOTE = 1000;
export const MAX_TEXT_BYTES = 1024 * 1024;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

/** Whether the caller is offered the pages: the right is held, or the permissions are not known yet. Reading is allowed in a read-only session; the server judges the proposal and the project again. */
export const canRead = (permissions: readonly string[] | undefined): boolean => permissions === undefined || permissions.includes(READ_PERMISSION);
/** Whether the caller is offered the review: the right is held and the session is not read-only. The server judges the proposal and the project again. */
export const canReview = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && (permissions ?? []).includes(REVIEW_PERMISSION);

/** The statuses of a package that was never open for bids: it has no proposal, so it has no page. */
const NEVER_OPENED: readonly string[] = ['DRAFT', 'IN_REVIEW', 'SUPERSEDED'];

/** The packages that are, or were, open for bids, by code: the pages read of their proposals stay readable once the package is awarded, has no acceptable bid, or is cancelled. */
export const biddingPackages = (packages: readonly TrackedPackage[]): TrackedPackage[] =>
  packages.filter((pack) => !NEVER_OPENED.includes(pack.status)).sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));

// ---- the pages -------------------------------------------------------------------------------------------------------------------------

export interface OcrPage {
  id: string;
  documentVersionId: string;
  /** From 0; the screen shows the page as `pageIndex + 1`. */
  pageIndex: number;
  /** A decimal string from 0 to 1. */
  confidence: string;
  status: OcrStatus;
  tableMismatch: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
  note: string | null;
  engineVersion: string;
  /** What the engine recognised; null when it cannot be read. */
  text: string | null;
  textState: TextState;
  correctedText: string | null;
}

export function toOcrPage(raw: unknown): OcrPage | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const documentVersionId = text(row?.document_version_id);
  const pageIndex = whole(row?.page_index);
  const confidence = text(row?.ocr_confidence);
  const status = oneOf(OCR_STATUSES, row?.review_status);
  const textState = oneOf(TEXT_STATES, row?.text_state);
  if (row === undefined || id === undefined || documentVersionId === undefined || pageIndex === undefined || confidence === undefined || status === undefined || textState === undefined)
    return undefined;
  return {
    id,
    documentVersionId,
    pageIndex,
    confidence,
    status,
    tableMismatch: row.table_mismatch === true,
    reviewedBy: nullableText(row.reviewed_by),
    reviewedAt: nullableText(row.reviewed_at),
    note: nullableText(row.note),
    engineVersion: text(row.engine_version) ?? '',
    text: nullableText(row.text),
    textState,
    correctedText: nullableText(row.corrected_text),
  };
}

export interface OcrDocument {
  documentVersionId: string;
  title: string;
  pageCount: number;
}

export interface OcrListing {
  pages: OcrPage[];
  nextCursor: string | undefined;
  /** No page of the proposal waits for a person: the financial analysis may run. */
  financialReady: boolean;
  blockedPages: number;
  /** The confidence under which a page waits, as a decimal string. */
  threshold: string;
  documents: OcrDocument[];
}

function toDocument(raw: unknown): OcrDocument | undefined {
  const row = asRecord(raw);
  const documentVersionId = text(row?.document_version_id);
  return row === undefined || documentVersionId === undefined ? undefined : { documentVersionId, title: text(row.title) ?? '', pageCount: whole(row.page_count) ?? 0 };
}

export function toOcrListing(raw: unknown): OcrListing {
  const body = asRecord(raw);
  const items = body?.items;
  const documents = body?.documents;
  return {
    pages: Array.isArray(items) ? items.flatMap((item) => toOcrPage(item) ?? []) : [],
    nextCursor: text(body?.next_cursor),
    // Without the word of the server the gate is shut: a screen that cannot tell must not tell the expert the analysis may run.
    financialReady: body?.financial_ready === true,
    blockedPages: whole(body?.blocked_pages) ?? 0,
    threshold: text(body?.threshold) ?? '',
    documents: Array.isArray(documents) ? documents.flatMap((item) => toDocument(item) ?? []) : [],
  };
}

export interface UploadedCorrection {
  key: string;
}

export function toUploadedCorrection(raw: unknown): UploadedCorrection | undefined {
  const key = text(asRecord(raw)?.file_object_key);
  return key === undefined ? undefined : { key };
}

/** A confidence such as `0.8525` as the percentage a person reads (`85.25%`), by the digits of the text: no float is made of it. */
export function percentOf(confidence: string): string {
  const [integer = '0', fraction = ''] = confidence.split('.');
  if (integer === '1') return '100%';
  const digits = fraction.padEnd(4, '0');
  const rest = digits.slice(2).replace(/0+$/, '');
  return `${Number(digits.slice(0, 2))}${rest === '' ? '' : `.${rest}`}%`;
}

/** The threshold the server named as the percentage the screen shows; empty when the server named none. */
export const thresholdText = (threshold: string): string => (threshold === '' ? '' : percentOf(threshold));

// ---- the filters -------------------------------------------------------------------------------------------------------------------------

export interface PageFilter {
  status: OcrStatus | '';
  documentVersionId: string;
}

export const NO_FILTER: PageFilter = { status: '', documentVersionId: '' };

export const hasFilter = (filter: PageFilter): boolean => filter.status !== '' || filter.documentVersionId !== '';

/** The query of the read for a filter: only what is chosen. */
export function filterQuery(filter: PageFilter): Record<string, string> {
  return { ...(filter.status === '' ? {} : { review_status: filter.status }), ...(filter.documentVersionId === '' ? {} : { document_version_id: filter.documentVersionId }) };
}

export const statusFromParam = (value: string | null): OcrStatus | '' => oneOf(OCR_STATUSES, value) ?? '';

// ---- the review ---------------------------------------------------------------------------------------------------------------------------

/** What the reviewer has typed for one page and not yet sent. It is kept until the review is done. */
export interface Draft {
  text: string;
  note: string;
}

export type Drafts = Readonly<Record<string, Draft>>;

/** The draft of a page: what was typed, else the reading of the engine to start from. */
export const draftOf = (page: OcrPage, drafts: Drafts): Draft => drafts[page.id] ?? { text: page.text ?? '', note: '' };

export const withDraft = (drafts: Drafts, page: OcrPage, change: Partial<Draft>): Drafts => ({ ...drafts, [page.id]: { ...draftOf(page, drafts), ...change } });

export const withoutDraft = (drafts: Drafts, pageId: string): Drafts => Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== pageId));

/** Whether the reviewer changed the text the engine recognised: a changed text is a correction, an unchanged one can only be confirmed. */
export const isEdited = (page: OcrPage, draft: Draft): boolean => draft.text !== (page.text ?? '');

/** Whether a page is offered to the reviewer: it waits for a person and the caller may review. */
export const isReviewable = (page: OcrPage, allowed: boolean): boolean => allowed && page.status === 'NEEDS_REVIEW';

export type DraftProblem = 'required' | 'unchanged' | 'tooLong' | 'noteTooLong';

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** What is wrong with the draft before it is sent: a confirmation has only a note; a correction names a text that is not empty, is not the reading as it was, and fits. */
export function validateDraft(page: OcrPage, draft: Draft, decision: Decision): DraftProblem | undefined {
  if (draft.note.length > MAX_NOTE) return 'noteTooLong';
  if (decision === 'CONFIRMED') return undefined;
  if (draft.text.trim() === '') return 'required';
  if (!isEdited(page, draft)) return 'unchanged';
  if (byteLength(draft.text) > MAX_TEXT_BYTES) return 'tooLong';
  return undefined;
}

export interface ReviewBody {
  decision: Decision;
  corrected_text_object_key?: string;
  note?: string;
}

/** The body of the review: the note only when there is one. */
export function reviewBody(decision: Decision, draft: Draft, correctedKey: string | undefined): ReviewBody {
  const note = draft.note.trim();
  return {
    decision,
    ...(correctedKey === undefined ? {} : { corrected_text_object_key: correctedKey }),
    ...(note === '' ? {} : { note }),
  };
}

// ---- refusals -------------------------------------------------------------------------------------------------------------------------------

export type Problem = 'state' | 'undeclared' | 'file' | 'fileType' | 'tooLarge' | 'notClean' | 'scan' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'OCR_STATE_INVALID':
      return 'state';
    case 'CONFLICT_UNDECLARED':
      return 'undeclared';
    case 'VALIDATION_FAILED':
      return error.extensions.reason === 'FILE_KEY_INVALID' || error.extensions.reason === 'FILE_ALREADY_ATTACHED' || error.extensions.reason === 'FILE_TYPE_INVALID' ? 'file' : 'validation';
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'FILE_TYPE_NOT_ALLOWED':
      return 'fileType';
    case 'PAYLOAD_TOO_LARGE':
      return 'tooLarge';
    case 'FILE_NOT_CLEAN':
      return 'notClean';
    case 'SCAN_PENDING':
      return 'scan';
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
