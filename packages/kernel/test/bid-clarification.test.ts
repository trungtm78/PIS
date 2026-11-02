import type { DomainError } from '../src/errors';
import {
  CLARIFICATION_STATUSES,
  MAX_CLARIFICATION_QUESTION,
  MIN_CLARIFICATION_QUESTION,
  assertAnswerDocumentIsNotTheQuestion,
  assertAnswerable,
  clarificationDueOf,
  clarificationQuestionOf,
  clarificationStatusAt,
  clarificationVisibleTo,
  isClarificationLate,
} from '../src/bid-clarification';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const DUE = '2026-11-20T10:00:00.000Z';
const at = (iso: string): Date => new Date(iso);

describe('clarification requests to contractors (ST-BID-011)', () => {
  it('names the statuses and the length of a question', () => {
    expect(CLARIFICATION_STATUSES).toEqual(['DRAFT', 'SENT', 'ANSWERED', 'EXPIRED', 'WITHDRAWN']);
    expect(MIN_CLARIFICATION_QUESTION).toBe(10);
    expect(MAX_CLARIFICATION_QUESTION).toBe(4000);
  });

  describe('the question', () => {
    it('keeps a question trimmed and refuses one that is not text, too short once trimmed or too long with 422 VALIDATION_FAILED on question', () => {
      expect(clarificationQuestionOf('  Explain the unit price of item 7.  ')).toBe('Explain the unit price of item 7.');
      expect(clarificationQuestionOf('x'.repeat(10))).toHaveLength(10);
      expect(clarificationQuestionOf('x'.repeat(4000))).toHaveLength(4000);
      for (const value of [undefined, null, 7, '', '         ', ' short    ', 'x'.repeat(4001)]) {
        expect(refusal(() => clarificationQuestionOf(value))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'question' });
      }
      expect(refusal(() => clarificationQuestionOf('short'))).toMatchObject({ extensions: { min_length: 10, max_length: 4000 } });
    });
  });

  describe('the deadline', () => {
    it('takes a date-time with its zone that lies after now and returns it as an instant', () => {
      expect(clarificationDueOf('2026-11-20T17:00:00+07:00', at('2026-11-19T00:00:00Z'))).toBe(DUE);
      expect(clarificationDueOf(DUE, at('2026-11-20T09:59:59.999Z'))).toBe(DUE);
    });

    it('refuses a deadline that is now or past with 422 DUE_IN_PAST, and one that is not a date-time with 422 VALIDATION_FAILED', () => {
      expect(refusal(() => clarificationDueOf(DUE, at(DUE)))).toMatchObject({ code: 'DUE_IN_PAST', status: 422, detail: 'due_at' });
      expect(refusal(() => clarificationDueOf(DUE, at('2026-11-21T00:00:00Z')))).toMatchObject({ code: 'DUE_IN_PAST', status: 422 });
      for (const value of [undefined, null, 5, '', 'tomorrow', '2026-13-40T10:00:00Z']) {
        expect(refusal(() => clarificationDueOf(value, at('2026-11-19T00:00:00Z')))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'due_at' });
      }
    });
  });

  describe('lateness and the status a reader sees', () => {
    it('is late only after the deadline: the very moment is in time', () => {
      expect(isClarificationLate(DUE, at('2026-11-20T10:00:00.000Z'))).toBe(false);
      expect(isClarificationLate(DUE, at('2026-11-20T10:00:00.001Z'))).toBe(true);
      expect(isClarificationLate(DUE, at('2026-11-20T09:00:00.000Z'))).toBe(false);
    });

    it('shows a request nobody answered by its deadline as EXPIRED and every other status as it is stored', () => {
      expect(clarificationStatusAt('SENT', DUE, at('2026-11-20T09:00:00Z'))).toBe('SENT');
      expect(clarificationStatusAt('SENT', DUE, at('2026-11-21T09:00:00Z'))).toBe('EXPIRED');
      expect(clarificationStatusAt('ANSWERED', DUE, at('2026-11-21T09:00:00Z'))).toBe('ANSWERED');
      expect(clarificationStatusAt('WITHDRAWN', DUE, at('2026-11-21T09:00:00Z'))).toBe('WITHDRAWN');
      expect(clarificationStatusAt('DRAFT', DUE, at('2026-11-21T09:00:00Z'))).toBe('DRAFT');
    });
  });

  describe('whether a request takes an answer (UAT-AC452)', () => {
    const waiting = { status: 'SENT', dueAt: DUE, version: 1 } as const;

    it('takes the answer of a request that waits, in time, on the version the caller saw', () => {
      expect(() => assertAnswerable(waiting, 1, at('2026-11-20T09:00:00Z'))).not.toThrow();
      expect(() => assertAnswerable(waiting, 1, at(DUE))).not.toThrow();
    });

    it('refuses an answer after the deadline with 409 CLARIFICATION_EXPIRED, also for a request that was answered already and whatever version is named', () => {
      const late = at('2026-11-21T09:00:00Z');
      expect(refusal(() => assertAnswerable(waiting, 1, late))).toMatchObject({ code: 'CLARIFICATION_EXPIRED', status: 409, extensions: { due_at: DUE } });
      expect(refusal(() => assertAnswerable({ status: 'ANSWERED', dueAt: DUE, version: 2 }, 2, late))).toMatchObject({ code: 'CLARIFICATION_EXPIRED', status: 409 });
      expect(refusal(() => assertAnswerable({ status: 'ANSWERED', dueAt: DUE, version: 2 }, 1, late))).toMatchObject({ code: 'CLARIFICATION_EXPIRED' });
      expect(refusal(() => assertAnswerable(waiting, 9, late))).toMatchObject({ code: 'CLARIFICATION_EXPIRED' });
    });

    it('refuses a request that does not wait with 409 CLARIFICATION_STATE_INVALID, before it looks at the version', () => {
      for (const status of ['ANSWERED', 'WITHDRAWN', 'DRAFT', 'EXPIRED'] as const) {
        expect(refusal(() => assertAnswerable({ status, dueAt: DUE, version: 3 }, 1, at('2026-11-20T09:00:00Z')))).toMatchObject({ code: 'CLARIFICATION_STATE_INVALID', status: 409, extensions: { status } });
      }
    });

    it('refuses a version that is not the current one with 409 VERSION_CONFLICT and says the current one', () => {
      expect(refusal(() => assertAnswerable({ status: 'SENT', dueAt: DUE, version: 4 }, 3, at('2026-11-20T09:00:00Z')))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 4 } });
    });
  });

  describe('who sees a request', () => {
    it('shows a guest only the requests of their own contractor, in any case of the id, and leaves the staff to the store', () => {
      const guest = { guestContractorId: 'AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
      expect(clarificationVisibleTo(guest, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true);
      expect(clarificationVisibleTo(guest, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(false);
      expect(clarificationVisibleTo({ guestContractorId: null }, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(true);
    });
  });

  describe('the document of the answer', () => {
    it('is not the letter that asked, in any case of the id, and any document is fine when no letter is kept', () => {
      const letter = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      expect(refusal(() => assertAnswerDocumentIsNotTheQuestion(letter.toUpperCase(), letter))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'answer_document_id' });
      expect(() => assertAnswerDocumentIsNotTheQuestion('dddddddd-dddd-4ddd-8ddd-dddddddddddd', letter)).not.toThrow();
      expect(() => assertAnswerDocumentIsNotTheQuestion(letter, null)).not.toThrow();
    });
  });
});
