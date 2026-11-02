import type { DomainError } from '../src/errors';
import {
  MAX_OCR_NOTE,
  MAX_OCR_TABLES,
  MAX_OCR_TABLE_ROWS,
  MAX_OCR_TEXT_BYTES,
  OCR_CONFIDENCE_THRESHOLD,
  OCR_CONFIDENCE_THRESHOLD_TEXT,
  OCR_DECISIONS,
  OCR_STATUSES,
  belowThreshold,
  checkReview,
  classifyPage,
  financialGate,
  isConfidence,
  pageTablesMismatch,
  parseTables,
  tableMismatch,
} from '../src/bid-ocr';
import type { GatePage, OcrStatus } from '../src/bid-ocr';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const table = (amounts: string[], total: string) => ({ rows: amounts.map((amount, n) => ({ label: `Item ${n + 1}`, amount })), total });
const page = (n: number, status: OcrStatus): GatePage => ({ id: `page-${n}`, pageIndex: n, status });

describe('the OCR of the pages of a proposal (ST-BID-008)', () => {
  it('keeps the threshold as an integer count of thousandths and lists the statuses and decisions of the column', () => {
    expect(OCR_CONFIDENCE_THRESHOLD).toBe(850);
    expect(Number.isInteger(OCR_CONFIDENCE_THRESHOLD)).toBe(true);
    expect(OCR_CONFIDENCE_THRESHOLD_TEXT).toBe('0.850');
    expect(MAX_OCR_TEXT_BYTES).toBe(1_048_576);
    expect(OCR_STATUSES).toEqual(['AUTO_ACCEPTED', 'NEEDS_REVIEW', 'CONFIRMED', 'CORRECTED']);
    expect(OCR_DECISIONS).toEqual(['CONFIRMED', 'CORRECTED']);
  });

  it('accepts exactly the threshold and refuses the value just under it, comparing the digits and not a float', () => {
    expect(belowThreshold('0.85')).toBe(false);
    expect(belowThreshold('0.8500')).toBe(false);
    expect(belowThreshold('0.8499')).toBe(true);
    expect(belowThreshold('0.849')).toBe(true);
    expect(belowThreshold('0.71')).toBe(true);
    expect(belowThreshold('1')).toBe(false);
    expect(belowThreshold('1.0000')).toBe(false);
    expect(belowThreshold('0')).toBe(true);
  });

  it('knows a confidence by its form: 0 to 1, up to four digits, as a string', () => {
    for (const good of ['0', '1', '0.5', '0.8500', '1.0', '1.0000', '0.0001']) expect(isConfidence(good)).toBe(true);
    for (const bad of ['1.0001', '1.5', '-0.1', '0.85001', '.5', '', 'x', '0,85']) expect(isConfidence(bad)).toBe(false);
    for (const bad of [0.9, null, undefined, {}]) expect(isConfidence(bad)).toBe(false);
    expect(refusal(() => belowThreshold('1.5')).code).toBe('VALIDATION_FAILED');
    expect(refusal(() => belowThreshold('1.5')).detail).toBe('ocr_confidence');
  });

  it('adds the lines of a table exactly and compares the sum with the total the table states', () => {
    expect(tableMismatch(table(['0.1', '0.2'], '0.3'))).toBe(false);
    expect(tableMismatch(table(['1000000', '2500000.50', '-500000.5'], '3000000'))).toBe(false);
    expect(tableMismatch(table(['0.00000001', '0.00000002'], '0.00000003'))).toBe(false);
    expect(tableMismatch(table(['0.00000001', '0.00000002'], '0.00000004'))).toBe(true);
    expect(tableMismatch(table(['1000', '2000'], '3001'))).toBe(true);
    expect(tableMismatch(table([], '0'))).toBe(false);
    expect(tableMismatch(table([], '5'))).toBe(true);
  });

  it('reads the tables of a page and refuses a shape nobody can check', () => {
    expect(parseTables([])).toEqual([]);
    expect(parseTables([table(['1', '2'], '3')])).toEqual([table(['1', '2'], '3')]);
    expect(parseTables([{ rows: [{ label: 'x', amount: '1', extra: 1 }], total: '1', title: 'Totals' }])).toEqual([{ rows: [{ label: 'x', amount: '1' }], total: '1' }]);
    const bad: unknown[] = [
      {},
      null,
      'text',
      [null],
      [[]],
      [{ rows: 'x', total: '1' }],
      [{ rows: [], total: 1 }],
      [{ rows: [], total: '1e3' }],
      [{ rows: [], total: '1.123456789' }],
      [{ rows: [null], total: '1' }],
      [{ rows: [{ label: 1, amount: '1' }], total: '1' }],
      [{ rows: [{ label: 'x', amount: 1 }], total: '1' }],
      [{ rows: [{ label: 'x', amount: '01' }], total: '1' }],
      Array.from({ length: MAX_OCR_TABLES + 1 }, () => table([], '0')),
      [{ rows: Array.from({ length: MAX_OCR_TABLE_ROWS + 1 }, () => ({ label: 'x', amount: '0' })), total: '0' }],
    ];
    for (const value of bad) expect(parseTables(value)).toBeUndefined();
  });

  it('counts a page with a table that does not add up, or cannot be read, as one that does not add up', () => {
    expect(pageTablesMismatch([])).toBe(false);
    expect(pageTablesMismatch([table(['1', '2'], '3'), table(['5'], '5')])).toBe(false);
    expect(pageTablesMismatch([table(['1', '2'], '3'), table(['5'], '6')])).toBe(true);
    expect(pageTablesMismatch('not tables')).toBe(true);
  });

  it('sends a page under the threshold, or with a table whose total is wrong, to review, and accepts the others (AC-ST-BID-008-1, UAT-AC449)', () => {
    expect(classifyPage({ confidence: '0.71', tables: [] })).toBe('NEEDS_REVIEW');
    expect(classifyPage({ confidence: '0.849', tables: [] })).toBe('NEEDS_REVIEW');
    expect(classifyPage({ confidence: '0.85', tables: [] })).toBe('AUTO_ACCEPTED');
    expect(classifyPage({ confidence: '0.99', tables: [table(['1', '2'], '3')] })).toBe('AUTO_ACCEPTED');
    expect(classifyPage({ confidence: '0.99', tables: [table(['1', '2'], '4')] })).toBe('NEEDS_REVIEW');
    expect(classifyPage({ confidence: '0.99', tables: 'garbled' })).toBe('NEEDS_REVIEW');
    expect(refusal(() => classifyPage({ confidence: '2', tables: [] })).status).toBe(422);
  });

  it('holds the financial analysis back while any page waits, and names the pages in the order given (AC-ST-BID-008-1, UAT-AC449)', () => {
    expect(financialGate([])).toEqual({ ready: true, blocked: [] });
    expect(financialGate([page(0, 'AUTO_ACCEPTED'), page(1, 'CONFIRMED'), page(2, 'CORRECTED')])).toEqual({ ready: true, blocked: [] });
    expect(financialGate([page(7, 'NEEDS_REVIEW'), page(4, 'AUTO_ACCEPTED'), page(23, 'NEEDS_REVIEW')])).toEqual({
      ready: false,
      blocked: [
        { id: 'page-7', pageIndex: 7 },
        { id: 'page-23', pageIndex: 23 },
      ],
    });
    expect(financialGate([page(23, 'CORRECTED')]).ready).toBe(true);
  });

  it('reviews only a page that waits (409 OCR_STATE_INVALID), and tells what the review makes of it', () => {
    expect(checkReview('NEEDS_REVIEW', { decision: 'CONFIRMED' })).toBe('CONFIRMED');
    expect(checkReview('NEEDS_REVIEW', { decision: 'CONFIRMED', note: null, correctedTextObjectKey: null })).toBe('CONFIRMED');
    expect(checkReview('NEEDS_REVIEW', { decision: 'CORRECTED', correctedTextObjectKey: 'tenants/x/document/y', note: 'x'.repeat(MAX_OCR_NOTE) })).toBe('CORRECTED');
    for (const status of ['AUTO_ACCEPTED', 'CONFIRMED', 'CORRECTED'] as const) {
      const denied = refusal(() => checkReview(status, { decision: 'CONFIRMED' }));
      expect(denied).toMatchObject({ code: 'OCR_STATE_INVALID', status: 409, extensions: { review_status: status } });
    }
    // The state is judged before the body.
    expect(refusal(() => checkReview('CONFIRMED', { decision: 'nope' })).code).toBe('OCR_STATE_INVALID');
  });

  it('refuses a decision that is none, a correction without its text, a confirmation with one and a note that is too long (422)', () => {
    expect(refusal(() => checkReview('NEEDS_REVIEW', { decision: 'REJECTED' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision' });
    expect(refusal(() => checkReview('NEEDS_REVIEW', { decision: undefined }))).toMatchObject({ detail: 'decision' });
    expect(refusal(() => checkReview('NEEDS_REVIEW', { decision: 'CORRECTED' }))).toMatchObject({ detail: 'corrected_text_object_key' });
    expect(refusal(() => checkReview('NEEDS_REVIEW', { decision: 'CORRECTED', correctedTextObjectKey: '' }))).toMatchObject({ detail: 'corrected_text_object_key' });
    expect(refusal(() => checkReview('NEEDS_REVIEW', { decision: 'CORRECTED', correctedTextObjectKey: 7 }))).toMatchObject({ detail: 'corrected_text_object_key' });
    expect(refusal(() => checkReview('NEEDS_REVIEW', { decision: 'CONFIRMED', correctedTextObjectKey: 'tenants/x/document/y' }))).toMatchObject({ detail: 'corrected_text_object_key' });
    expect(refusal(() => checkReview('NEEDS_REVIEW', { decision: 'CONFIRMED', note: 'x'.repeat(MAX_OCR_NOTE + 1) }))).toMatchObject({ detail: 'note' });
    expect(refusal(() => checkReview('NEEDS_REVIEW', { decision: 'CONFIRMED', note: 5 }))).toMatchObject({ detail: 'note' });
  });
});
