import { DomainError } from './errors.ts';
import { versionConflict } from './if-match.ts';
import { momentOf } from './procurement-file.ts';

/**
 * Clarification requests to a contractor during the evaluation of bids (ST-BID-011, BID 3 F6, BR-BID-03): a member of the evaluation team asks the contractor of a proposal to explain something in it, the
 * contractor (or the clerk who took their letter) answers with a document before the deadline, and the question and the answer stay on record. Everything that judges a request or an answer lives here as pure
 * functions: the words of the question, the deadline, whether a request still takes an answer, and whose request a caller may see.
 */

export const CLARIFICATION_STATUSES = ['DRAFT', 'SENT', 'ANSWERED', 'EXPIRED', 'WITHDRAWN'] as const;
export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];

/** A question says what is unclear in at least ten characters once trimmed, and fits a letter. */
export const MIN_CLARIFICATION_QUESTION = 10;
export const MAX_CLARIFICATION_QUESTION = 4000;

/** The question to the contractor in the words of the evaluator: 422 `VALIDATION_FAILED` (`question`) when it is not text, too short once trimmed or too long. */
export function clarificationQuestionOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < MIN_CLARIFICATION_QUESTION || text.length > MAX_CLARIFICATION_QUESTION) {
    throw new DomainError('VALIDATION_FAILED', 422, 'question', { extensions: { min_length: MIN_CLARIFICATION_QUESTION, max_length: MAX_CLARIFICATION_QUESTION } });
  }
  return text;
}

/**
 * The moment by which the contractor answers: a date-time with its zone (422 `VALIDATION_FAILED` otherwise) that lies after the moment the request is sent (422 `DUE_IN_PAST`); a deadline that
 * has passed or is this very instant leaves the contractor no time to answer.
 */
export function clarificationDueOf(value: unknown, now: Date): string {
  const due = typeof value === 'string' ? momentOf(value) : undefined;
  if (due === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'due_at');
  if (Date.parse(due) <= now.getTime()) throw new DomainError('DUE_IN_PAST', 422, 'due_at', { extensions: { now: now.toISOString() } });
  return due;
}

/** The deadline has passed once the moment of the answer is after it: an answer at the very moment is in time. */
export const isClarificationLate = (dueAt: string, at: Date): boolean => at.getTime() > Date.parse(dueAt);

/**
 * The status a reader is shown: a request nobody answered by its deadline is EXPIRED, though nothing is written when the deadline passes (the stored status stays SENT until a person acts on it, and
 * an answer that comes late is refused without changing it).
 */
export function clarificationStatusAt(status: ClarificationStatus, dueAt: string, at: Date): ClarificationStatus {
  return status === 'SENT' && isClarificationLate(dueAt, at) ? 'EXPIRED' : status;
}

export interface AnswerFacts {
  status: ClarificationStatus;
  dueAt: string;
  version: number;
}

/**
 * Whether the request takes an answer now. Refusals in order: the deadline has passed, whatever the status (409 `CLARIFICATION_EXPIRED`, so that a second answer the day after is told the
 * time is up and not that it was answered); the request is not one that waits for its answer (409 `CLARIFICATION_STATE_INVALID`: answered already, withdrawn); the version the caller saw is not the
 * current one (409 `VERSION_CONFLICT`).
 */
export function assertAnswerable(facts: AnswerFacts, expectedVersion: number, at: Date): void {
  if (isClarificationLate(facts.dueAt, at)) throw new DomainError('CLARIFICATION_EXPIRED', 409, 'due_at', { extensions: { due_at: facts.dueAt } });
  if (facts.status !== 'SENT') throw new DomainError('CLARIFICATION_STATE_INVALID', 409, 'status', { extensions: { status: facts.status } });
  if (facts.version !== expectedVersion) throw versionConflict(facts.version);
}

export interface ClarificationReader {
  /** The contractor the caller is a guest of; null for the staff of the owner. */
  guestContractorId: string | null;
}

/**
 * Whether a caller may read or answer the request of a contractor: a guest only their own contractor's (a request of another contractor is, for them, one that does not exist), the staff of the
 * owner by the project they hold the permission over, which the store judges.
 */
export function clarificationVisibleTo(reader: ClarificationReader, contractorId: string): boolean {
  return reader.guestContractorId === null || reader.guestContractorId.toLowerCase() === contractorId.toLowerCase();
}

/** The document that answers is not the letter that asked: the same paper would make every question look answered. */
export function assertAnswerDocumentIsNotTheQuestion(answerDocumentId: string, sentDocumentId: string | null): void {
  if (sentDocumentId !== null && answerDocumentId.toLowerCase() === sentDocumentId.toLowerCase()) throw new DomainError('VALIDATION_FAILED', 422, 'answer_document_id');
}
