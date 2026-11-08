import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import type { Tone } from '../../../ui';

/** DOC-24 to DOC-27: the project document repository (DOC-2). The shapes are the ones of the contract; a wrong shape is an error of the read, never an empty screen. */
type Schemas = components['schemas'];
export type DocumentSummary = Schemas['ProjectDocumentSummary'];
export type DocumentPage = Schemas['ProjectDocumentPage'];
export type DocumentDetail = Schemas['ProjectDocumentDetail'];
export type VersionView = Schemas['ProjectDocumentVersionView'];
export type VersionDetail = Schemas['ProjectDocumentVersionDetail'];
export type TextUnit = Schemas['DocumentTextUnit'];
export type UnitPage = Schemas['DocumentTextUnitPage'];
export type CommentView = Schemas['DocumentCommentView'];
export type CommentList = Schemas['DocumentCommentList'];
export type Comparison = Schemas['DocumentComparison'];
export type CompareEntry = Schemas['CompareEntry'];
export type ReviewDetail = Schemas['DocumentReviewDetail'];
export type ReviewStage = Schemas['DocumentReviewStage'];
export type Reviewer = Schemas['DocumentReviewer'];
export type ReviewPage = Schemas['DocumentReviewPage'];
export type ReviewItem = Schemas['DocumentReviewListItem'];
export type DownloadLink = Schemas['DocumentFileDownload'];
export type UploadedFile = Schemas['ProjectDocumentFileUpload'];
export type ReviewRound = Schemas['DocumentReviewRound'];

export const READ_PERMISSION = 'doc.repo.read';
export const UPLOAD_PERMISSION = 'doc.repo.upload';
export const COMMENT_PERMISSION = 'doc.repo.comment';
export const SUBMIT_PERMISSION = 'doc.repo.review.submit';
/** A reason (archive, withdraw, return, reject) is at least this long: the contract says so, and the screen refuses a shorter one before it sends. */
export const MIN_REASON = 10;
export const PAGE_SIZE = 50;
export const UNIT_PAGE_SIZE = 100;

export const repositoryLink = (projectId?: string): string => (projectId === undefined ? '/doc/doc-24' : `/doc/doc-24?project=${projectId}`);
export const documentLink = (id: string, version?: string): string => `/doc/doc-25?id=${id}${version === undefined ? '' : `&version=${version}`}`;
export const boardLink = (review?: string): string => (review === undefined ? '/doc/doc-26' : `/doc/doc-26?review=${review}`);
export const compareLink = (documentId: string, from?: string, to?: string): string => `/doc/doc-27?id=${documentId}${from === undefined ? '' : `&from=${from}`}${to === undefined ? '' : `&to=${to}`}`;

// ---- reading the answers ----------------------------------------------------------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function shaped<T>(raw: unknown, arrays: readonly string[], objects: readonly string[], what: string): T {
  const body = asRecord(raw);
  if (body === undefined || arrays.some((key) => !Array.isArray(body[key])) || objects.some((key) => asRecord(body[key]) === undefined)) throw new Error(`unexpected ${what}`);
  return body as unknown as T;
}

export const toDocumentPage = (raw: unknown): DocumentPage => shaped(raw, ['items', 'classes'], [], 'document page');
export const toDocumentDetail = (raw: unknown): DocumentDetail => shaped(raw, ['versions', 'rounds'], ['document', 'actions'], 'document');
export const toVersionDetail = (raw: unknown): VersionDetail => shaped(raw, [], ['version', 'document', 'outline', 'actions'], 'version');
export const toUnitPage = (raw: unknown): UnitPage => shaped(raw, ['items'], [], 'unit page');
export const toCommentList = (raw: unknown): CommentList => shaped(raw, ['items'], [], 'comment list');
export const toComparison = (raw: unknown): Comparison => shaped(raw, ['entries'], ['from', 'to', 'summary'], 'comparison');
export const toReviewDetail = (raw: unknown): ReviewDetail => shaped(raw, ['stages', 'events'], ['review', 'document', 'actions'], 'review');
export const toReviewPage = (raw: unknown): ReviewPage => shaped(raw, ['items'], [], 'review page');
export const toDownload = (raw: unknown): DownloadLink => shaped(raw, [], [], 'download');
export const toUploaded = (raw: unknown): UploadedFile => shaped(raw, [], [], 'upload');

// ---- time and size ----------------------------------------------------------------------------------------------------------------------------------

const VIETNAM_OFFSET_MS = 7 * 3_600_000;

/** An instant as the people of the screen read it: the Vietnam day and minute ("08/11/2026 14:05"). An unreadable value is shown as it came. */
export function stamp(instant: string | null | undefined): string {
  if (instant === null || instant === undefined) return '';
  const moment = Date.parse(instant);
  if (Number.isNaN(moment)) return instant;
  const text = new Date(moment + VIETNAM_OFFSET_MS).toISOString();
  return `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)} ${text.slice(11, 16)}`;
}

/** A day (`YYYY-MM-DD`) as the people of the screen read it. */
export function dayText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : value;
}

/** The size of a file with the unit that keeps it short: bytes, KiB or MiB. */
export function sizeText(bytes: number): { value: string; unit: 'B' | 'KiB' | 'MiB' } {
  if (bytes < 1024) return { value: String(bytes), unit: 'B' };
  if (bytes < 1024 * 1024) return { value: (bytes / 1024).toFixed(1), unit: 'KiB' };
  return { value: (bytes / (1024 * 1024)).toFixed(1), unit: 'MiB' };
}

/** `LEGAL_BASIS` as a key segment: `legalBasis`. */
export const camel = (value: string): string => value.toLowerCase().replace(/_([a-z])/g, (_whole, letter: string) => letter.toUpperCase());

export const reasonOk = (text: string): boolean => text.trim().length >= MIN_REASON;

// ---- tones ------------------------------------------------------------------------------------------------------------------------------------------

export function versionTone(status: VersionView['status']): Tone {
  if (status === 'APPROVED') return 'success';
  if (status === 'IN_REVIEW') return 'info';
  if (status === 'SUPPLEMENT_REQUESTED') return 'warning';
  if (status === 'REJECTED') return 'danger';
  return 'neutral';
}

export function reviewTone(status: ReviewRound['status']): Tone {
  if (status === 'APPROVED') return 'success';
  if (status === 'IN_REVIEW') return 'info';
  if (status === 'SUPPLEMENT_REQUESTED') return 'warning';
  if (status === 'REJECTED') return 'danger';
  return 'neutral';
}

export function effectiveTone(state: DocumentSummary['effective_state']): Tone {
  if (state === 'IN_FORCE') return 'success';
  if (state === 'EXPIRED') return 'danger';
  if (state === 'NOT_YET') return 'info';
  return 'neutral';
}

export function stageTone(state: ReviewStage['state']): Tone {
  if (state === 'DONE') return 'success';
  if (state === 'CURRENT') return 'info';
  if (state === 'SUPPLEMENT_REQUESTED') return 'warning';
  if (state === 'REJECTED') return 'danger';
  return 'neutral';
}

export function reviewerTone(state: Reviewer['state']): Tone {
  if (state === 'APPROVED') return 'success';
  if (state === 'PENDING') return 'info';
  if (state === 'SUPPLEMENT_REQUESTED' || state === 'EXPIRED') return 'warning';
  if (state === 'REJECTED') return 'danger';
  return 'neutral';
}

export function extractionTone(status: VersionView['extraction_status']): Tone {
  if (status === 'EXTRACTED') return 'success';
  if (status === 'FAILED') return 'danger';
  if (status === 'NO_TEXT') return 'warning';
  return 'neutral';
}

// ---- problems ---------------------------------------------------------------------------------------------------------------------------------------

export type Problem =
  | 'versionConflict'
  | 'locked'
  | 'stateInvalid'
  | 'duplicateReference'
  | 'duplicateVersion'
  | 'linkMismatch'
  | 'archived'
  | 'reviewOpen'
  | 'versionNotNewer'
  | 'extractionPending'
  | 'workflowMissing'
  | 'notClean'
  | 'scanPending'
  | 'formatMismatch'
  | 'fileType'
  | 'tooLarge'
  | 'hashMismatch'
  | 'anchorUnknown'
  | 'denied'
  | 'notFound'
  | 'validation'
  | 'stepUp'
  | 'compareTooLarge'
  | 'selfApproval'
  | 'general';

const BY_CODE: Readonly<Record<string, Problem>> = {
  VERSION_CONFLICT: 'versionConflict',
  DOC_VERSION_LOCKED: 'locked',
  DOC_VERSION_STATE_INVALID: 'stateInvalid',
  DOC_REVIEW_NOT_OPEN: 'stateInvalid',
  DOC_COMMENT_STATE_INVALID: 'stateInvalid',
  DOC_NOT_ARCHIVED: 'stateInvalid',
  DOC_DUPLICATE_REFERENCE: 'duplicateReference',
  DOC_VERSION_DUPLICATE: 'duplicateVersion',
  DOC_LINK_MISMATCH: 'linkMismatch',
  DOC_ARCHIVED: 'archived',
  DOC_REVIEW_ALREADY_OPEN: 'reviewOpen',
  DOC_REVIEW_IN_PROGRESS: 'reviewOpen',
  DOC_REVIEW_VERSION_NOT_NEWER: 'versionNotNewer',
  DOC_EXTRACTION_PENDING: 'extractionPending',
  WORKFLOW_NOT_CONFIGURED: 'workflowMissing',
  FILE_NOT_CLEAN: 'notClean',
  SCAN_PENDING: 'scanPending',
  DOC_FILE_FORMAT_MISMATCH: 'formatMismatch',
  FILE_TYPE_NOT_ALLOWED: 'fileType',
  PAYLOAD_TOO_LARGE: 'tooLarge',
  HASH_MISMATCH: 'hashMismatch',
  DOC_COMMENT_ANCHOR_UNKNOWN: 'anchorUnknown',
  DOC_COMMENT_PARENT_INVALID: 'anchorUnknown',
  VALIDATION_FAILED: 'validation',
  MFA_REQUIRED: 'stepUp',
  DOC_COMPARE_TOO_LARGE: 'compareTooLarge',
  DOC_EXTRACTION_DONE: 'stateInvalid',
  SELF_APPROVAL_DENIED: 'selfApproval',
  TASK_ALREADY_DECIDED: 'stateInvalid',
  APPROVER_NOT_AUTHORIZED: 'denied',
};

/** What a refused command means for the person: one word the screen has a sentence for. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  const known = BY_CODE[error.code];
  if (known !== undefined) return known;
  if (error.status === 403) return 'denied';
  if (error.status === 404) return 'notFound';
  return 'general';
}

// ---- the comparison: equal runs are folded ------------------------------------------------------------------------------------------------------------

export type FoldedEntry = { kind: 'entry'; entry: CompareEntry; index: number } | { kind: 'equal'; entries: CompareEntry[]; from: number };

/** The entries in reading order with every run of equal units folded into one row that says how many it hides; a changed, added or removed unit is never folded. */
export function foldEntries(entries: readonly CompareEntry[], expanded: boolean): FoldedEntry[] {
  const out: FoldedEntry[] = [];
  entries.forEach((entry, index) => {
    const last = out[out.length - 1];
    if (!expanded && entry.op === 'EQUAL') {
      if (last?.kind === 'equal') last.entries.push(entry);
      else out.push({ kind: 'equal', entries: [entry], from: index });
    } else out.push({ kind: 'entry', entry, index });
  });
  return out;
}

/** The text a changed unit shows on one side: the words that stayed and the ones that left (before) or came in (after). */
export function sideWords(entry: CompareEntry, side: 'before' | 'after'): Array<{ text: string; mark: boolean }> {
  const unit = side === 'before' ? entry.before : entry.after;
  if (entry.words === null || entry.words === undefined) return unit === null ? [] : [{ text: unit.text, mark: false }];
  const hidden = side === 'before' ? 'ADDED' : 'REMOVED';
  return entry.words.filter((segment) => segment.op !== hidden).map((segment) => ({ text: segment.text, mark: segment.op !== 'EQUAL' }));
}

/** The id a command answers with (`resource_id` of the CommandResult), or undefined when the answer has none. */
export function resourceIdOf(raw: unknown): string | undefined {
  const body = asRecord(raw);
  return typeof body?.resource_id === 'string' ? body.resource_id : undefined;
}

/** A reference as another feature stores it: `docver:<version>#<citation>`. */
export const referenceOf = (unit: TextUnit): string => unit.citation_ref;

/** The options of a link list: `{ id, label }` from a row of the project, contract or package register (code and name or title). */
export interface LinkOption {
  id: string;
  label: string;
  projectId: string | null;
}

export function toLinkOption(raw: unknown, nameKey: 'name' | 'title'): LinkOption | undefined {
  const row = asRecord(raw);
  if (row === undefined || typeof row.id !== 'string') return undefined;
  const code = typeof row.code === 'string' ? row.code : row.id.slice(0, 8);
  const name = typeof row[nameKey] === 'string' ? (row[nameKey] as string) : '';
  return { id: row.id, label: name === '' ? code : `${code} - ${name}`, projectId: typeof row.project_id === 'string' ? row.project_id : null };
}
