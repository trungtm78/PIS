import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  MAX_NOTE,
  MAX_TEXT_BYTES,
  NO_FILTER,
  canRead,
  canReview,
  describeProblem,
  draftOf,
  filterQuery,
  hasFilter,
  isEdited,
  isReviewable,
  percentOf,
  reviewBody,
  statusFromParam,
  thresholdText,
  toOcrListing,
  toOcrPage,
  toUploadedCorrection,
  validateDraft,
  withDraft,
  withoutDraft,
} from './model';
import type { OcrPage } from './model';
import { page, waiting } from './test-support';

const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const read = (raw: unknown): OcrPage => toOcrPage(raw) as OcrPage;

describe('the OCR review model (ST-BID-008, BID-06)', () => {
  it('reads a page of the list and refuses a row that is not one', () => {
    expect(read(waiting(23))).toMatchObject({ pageIndex: 22, confidence: '0.7100', status: 'NEEDS_REVIEW', tableMismatch: false, reviewedBy: null, textState: 'READABLE', correctedText: null });
    expect(read(page(2, { table_mismatch: true, reviewed_by: 'm', reviewed_at: 't', note: 'n', corrected_text: 'c', text: null, text_state: 'MISSING', engine_version: undefined }))).toMatchObject({
      tableMismatch: true,
      reviewedBy: 'm',
      note: 'n',
      correctedText: 'c',
      text: null,
      textState: 'MISSING',
      engineVersion: '',
    });
    for (const bad of [
      null,
      'x',
      [],
      {},
      page(1, { id: 1 }),
      page(1, { document_version_id: undefined }),
      page(1, { page_index: 1.5 }),
      page(1, { ocr_confidence: 0.9 }),
      page(1, { review_status: 'NOPE' }),
      page(1, { text_state: 'NOPE' }),
    ]) {
      expect(toOcrPage(bad)).toBeUndefined();
    }
  });

  it('reads the list with its gate, and keeps the gate shut when the server did not say it is open', () => {
    const listing = toOcrListing({
      items: [page(1), { broken: true }, waiting(2)],
      next_cursor: 'abc',
      financial_ready: false,
      blocked_pages: 1,
      threshold: '0.850',
      documents: [{ document_version_id: 'v1', title: 'Tài chính', page_count: 30 }, { document_version_id: 'v2' }, { title: 'no id' }, null],
    });
    expect(listing.pages.map((item) => item.id)).toHaveLength(2);
    expect(listing).toMatchObject({ nextCursor: 'abc', financialReady: false, blockedPages: 1, threshold: '0.850' });
    expect(listing.documents).toEqual([
      { documentVersionId: 'v1', title: 'Tài chính', pageCount: 30 },
      { documentVersionId: 'v2', title: '', pageCount: 0 },
    ]);
    expect(toOcrListing({ items: [], financial_ready: true })).toMatchObject({ financialReady: true, nextCursor: undefined, blockedPages: 0, threshold: '', documents: [] });
    expect(toOcrListing(undefined)).toEqual({ pages: [], nextCursor: undefined, financialReady: false, blockedPages: 0, threshold: '', documents: [] });
    expect(toOcrListing({ items: 'x', documents: 'x' })).toMatchObject({ pages: [], documents: [] });
  });

  it('reads the key of the stored corrected text', () => {
    expect(toUploadedCorrection({ file_object_key: 'tenants/x/document/y', file_sha256: 'a', size_bytes: 1 })).toEqual({ key: 'tenants/x/document/y' });
    expect(toUploadedCorrection({})).toBeUndefined();
    expect(toUploadedCorrection(null)).toBeUndefined();
  });

  it('shows a confidence as a percentage by its digits, never through a float', () => {
    expect(percentOf('0.7100')).toBe('71%');
    expect(percentOf('0.71')).toBe('71%');
    expect(percentOf('0.8525')).toBe('85.25%');
    expect(percentOf('0.850')).toBe('85%');
    expect(percentOf('0.0500')).toBe('5%');
    expect(percentOf('0.8499')).toBe('84.99%');
    expect(percentOf('0.845')).toBe('84.5%');
    expect(percentOf('1')).toBe('100%');
    expect(percentOf('1.0000')).toBe('100%');
    expect(percentOf('0')).toBe('0%');
    expect(percentOf('')).toBe('0%');
    expect(thresholdText('0.850')).toBe('85%');
    expect(thresholdText('')).toBe('');
  });

  it('offers the pages to whoever holds the read right or whose rights are not known yet, and the review to a session that is not read-only', () => {
    expect(canRead(undefined)).toBe(true);
    expect(canRead(['bid.ocr.read'])).toBe(true);
    expect(canRead(['bid.read'])).toBe(false);
    expect(canReview(['bid.ocr.review'], 'FULL')).toBe(true);
    expect(canReview(['bid.ocr.review'], undefined)).toBe(true);
    expect(canReview(['bid.ocr.review'], 'READ_ONLY')).toBe(false);
    expect(canReview(['bid.ocr.read'], 'FULL')).toBe(false);
    expect(canReview(undefined, 'FULL')).toBe(false);
  });

  it('builds the query of a filter from what is chosen, and reads the status of the address', () => {
    expect(hasFilter(NO_FILTER)).toBe(false);
    expect(hasFilter({ status: 'NEEDS_REVIEW', documentVersionId: '' })).toBe(true);
    expect(hasFilter({ status: '', documentVersionId: 'v1' })).toBe(true);
    expect(filterQuery(NO_FILTER)).toEqual({});
    expect(filterQuery({ status: 'CORRECTED', documentVersionId: 'v1' })).toEqual({ review_status: 'CORRECTED', document_version_id: 'v1' });
    expect(statusFromParam('NEEDS_REVIEW')).toBe('NEEDS_REVIEW');
    expect(statusFromParam('nope')).toBe('');
    expect(statusFromParam(null)).toBe('');
  });

  it('keeps the draft of a page until the review is done, starting from the reading of the engine', () => {
    const waitingPage = read(waiting(23));
    const unreadable = read(waiting(24, { text: null, text_state: 'MISSING' }));
    expect(draftOf(waitingPage, {})).toEqual({ text: waitingPage.text, note: '' });
    expect(draftOf(unreadable, {})).toEqual({ text: '', note: '' });
    const typed = withDraft({}, waitingPage, { text: 'Tổng cộng: 3.000.000' });
    expect(draftOf(waitingPage, typed)).toEqual({ text: 'Tổng cộng: 3.000.000', note: '' });
    const noted = withDraft(typed, waitingPage, { note: 'Đã đối chiếu bản gốc.' });
    expect(draftOf(waitingPage, noted)).toEqual({ text: 'Tổng cộng: 3.000.000', note: 'Đã đối chiếu bản gốc.' });
    expect(withoutDraft(noted, waitingPage.id)).toEqual({});
    expect(withoutDraft(noted, 'other')).toEqual(noted);
    expect(isEdited(waitingPage, draftOf(waitingPage, {}))).toBe(false);
    expect(isEdited(waitingPage, draftOf(waitingPage, typed))).toBe(true);
    expect(isEdited(unreadable, { text: '', note: '' })).toBe(false);
    expect(isEdited(unreadable, { text: 'x', note: '' })).toBe(true);
  });

  it('offers the review only for a page that waits, to a caller who may review', () => {
    expect(isReviewable(read(waiting(1)), true)).toBe(true);
    expect(isReviewable(read(waiting(1)), false)).toBe(false);
    for (const status of ['AUTO_ACCEPTED', 'CONFIRMED', 'CORRECTED']) expect(isReviewable(read(page(1, { review_status: status })), true)).toBe(false);
  });

  it('checks a draft before it is sent: a confirmation has only a note, a correction a text that is new and fits', () => {
    const waitingPage = read(waiting(23));
    const unchanged = draftOf(waitingPage, {});
    expect(validateDraft(waitingPage, unchanged, 'CONFIRMED')).toBeUndefined();
    expect(validateDraft(waitingPage, { ...unchanged, note: 'x'.repeat(MAX_NOTE + 1) }, 'CONFIRMED')).toBe('noteTooLong');
    expect(validateDraft(waitingPage, { ...unchanged, note: 'x'.repeat(MAX_NOTE) }, 'CONFIRMED')).toBeUndefined();
    expect(validateDraft(waitingPage, { text: '   ', note: '' }, 'CORRECTED')).toBe('required');
    expect(validateDraft(waitingPage, unchanged, 'CORRECTED')).toBe('unchanged');
    expect(validateDraft(waitingPage, { text: 'x'.repeat(MAX_TEXT_BYTES + 1), note: '' }, 'CORRECTED')).toBe('tooLong');
    expect(validateDraft(waitingPage, { text: 'ế'.repeat(MAX_TEXT_BYTES / 2 + 1), note: '' }, 'CORRECTED')).toBe('tooLong');
    expect(validateDraft(waitingPage, { text: 'x'.repeat(MAX_TEXT_BYTES), note: '' }, 'CORRECTED')).toBeUndefined();
    expect(validateDraft(waitingPage, { text: 'Tổng cộng: 3.000.000', note: 'x'.repeat(MAX_NOTE + 1) }, 'CORRECTED')).toBe('noteTooLong');
  });

  it('builds the body of the review with the note only when there is one', () => {
    expect(reviewBody('CONFIRMED', { text: 'a', note: '  ' }, undefined)).toEqual({ decision: 'CONFIRMED' });
    expect(reviewBody('CONFIRMED', { text: 'a', note: ' Đã đối chiếu. ' }, undefined)).toEqual({ decision: 'CONFIRMED', note: 'Đã đối chiếu.' });
    expect(reviewBody('CORRECTED', { text: 'a', note: '' }, 'tenants/x/document/y')).toEqual({ decision: 'CORRECTED', corrected_text_object_key: 'tenants/x/document/y' });
  });

  it('words the refusals of the server', () => {
    expect(describeProblem(new Error('x'))).toBe('general');
    expect(describeProblem(problem('OCR_STATE_INVALID', 409))).toBe('state');
    expect(describeProblem(problem('CONFLICT_UNDECLARED', 403))).toBe('undeclared');
    for (const reason of ['FILE_KEY_INVALID', 'FILE_ALREADY_ATTACHED', 'FILE_TYPE_INVALID']) expect(describeProblem(problem('VALIDATION_FAILED', 422, { reason }))).toBe('file');
    expect(describeProblem(problem('VALIDATION_FAILED'))).toBe('validation');
    expect(describeProblem(problem('INVALID_REQUEST', 400))).toBe('validation');
    expect(describeProblem(problem('FIELD_NOT_ALLOWED', 400))).toBe('validation');
    expect(describeProblem(problem('FILE_TYPE_NOT_ALLOWED'))).toBe('fileType');
    expect(describeProblem(problem('PAYLOAD_TOO_LARGE', 413))).toBe('tooLarge');
    expect(describeProblem(problem('FILE_NOT_CLEAN'))).toBe('notClean');
    expect(describeProblem(problem('SCAN_PENDING', 409))).toBe('scan');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', 404))).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED', 403))).toBe('denied');
    expect(describeProblem(problem('ENTITLEMENT_DENIED', 403))).toBe('denied');
    expect(describeProblem(problem('SESSION_EXPIRED', 401))).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE', 500))).toBe('general');
  });
});
