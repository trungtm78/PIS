import { DomainError } from './errors.ts';
import { addDays, daysBetween } from './monitoring-file.ts';

/**
 * The transmittal of documents (G4-11, the practice of ISO 19650 and of the document control of a project): a document of the project is kept in a container whose state says how far it is trusted (WIP, Shared,
 * Published, Archive), and a document that leaves its author goes in a TRANSMITTAL, a sheet that names what is sent (the document, its version and its hash at that moment), to whom, for what (review, approval or
 * information) and by which day an answer is due. A sent transmittal never changes; an answer is a row that is added; a correction is a new transmittal that supersedes the old one. The days of review are read from
 * the governance rule `DOC_TRANSMITTAL_RULE` (UNVERIFIED), the documents are linked by their id in DOC.
 */

export const TRANSMITTAL_RULE_TYPE = 'DOC_TRANSMITTAL_RULE';

export interface TransmittalPolicy {
  /** Days from the day of sending to the day a review is due, for each purpose that asks for an answer. */
  review_days: number;
  approval_days: number;
  /** A review is "due soon" from this many days before its day. */
  reminder_days: number;
  /** The most days that a due day may be moved by the sender once, with a reason. */
  max_extension_days: number;
}

export const transmittalDefaults = (): TransmittalPolicy => ({ review_days: 5, approval_days: 10, reminder_days: 1, max_extension_days: 10 });

function intIn(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new DomainError('VALIDATION_FAILED', 422, path);
  return value;
}

export function transmittalPolicyOf(params: Readonly<Record<string, unknown>>): TransmittalPolicy {
  return {
    review_days: intIn(params.review_days, 1, 90, 'review_days'),
    approval_days: intIn(params.approval_days, 1, 180, 'approval_days'),
    reminder_days: intIn(params.reminder_days, 0, 30, 'reminder_days'),
    max_extension_days: intIn(params.max_extension_days, 0, 90, 'max_extension_days'),
  };
}

export const CONTAINER_STATES = ['WIP', 'SHARED', 'PUBLISHED', 'ARCHIVE'] as const;
export type ContainerState = (typeof CONTAINER_STATES)[number];

export const TRANSMITTAL_PURPOSES = ['FOR_INFORMATION', 'FOR_REVIEW', 'FOR_APPROVAL'] as const;
export type TransmittalPurpose = (typeof TRANSMITTAL_PURPOSES)[number];

export const RECIPIENT_ANSWERS = ['APPROVED', 'APPROVED_WITH_COMMENTS', 'REJECTED', 'NO_COMMENT'] as const;
export type RecipientAnswer = (typeof RECIPIENT_ANSWERS)[number];

/** A purpose that asks for an answer from a recipient who is required to give one. */
export const purposeAsksAnswer = (purpose: TransmittalPurpose): boolean => purpose !== 'FOR_INFORMATION';

/** The day an answer is due: the day of sending plus the days of the purpose; a purpose that asks for nothing has no due day. */
export function dueOnOf(purpose: TransmittalPurpose, sentOn: string, policy: TransmittalPolicy): string | null {
  if (purpose === 'FOR_INFORMATION') return null;
  return addDays(sentOn, purpose === 'FOR_REVIEW' ? policy.review_days : policy.approval_days);
}

/** The edges of the container: forward along WIP, Shared, Published, Archive; Shared goes back to WIP when the review rejects it; Published and Archive never go back (a new revision is a new container in WIP). */
const EDGES: Readonly<Record<ContainerState, readonly ContainerState[]>> = { WIP: ['SHARED', 'ARCHIVE'], SHARED: ['PUBLISHED', 'WIP', 'ARCHIVE'], PUBLISHED: ['ARCHIVE'], ARCHIVE: [] };

export interface MoveFacts {
  from: ContainerState;
  to: ContainerState;
  /** The person who moves it and the person who made the container's content (the author). */
  actorId: string;
  authorId: string;
  reason: string | null;
  /** The state of the answers of the latest transmittal for review or approval of this very version; null when there is none. */
  latest: TransmittalProgress | null;
}

export function assertContainerMove(facts: MoveFacts): void {
  if (!EDGES[facts.from].includes(facts.to)) throw new DomainError('TRANSMITTAL_STATE_INVALID', 409, 'state');
  if (facts.to === 'SHARED') {
    // A document is shared only because somebody was asked to look at it.
    if (facts.latest === null) throw new DomainError('TRANSMITTAL_REQUIRED', 422, 'transmittal');
  }
  if (facts.to === 'PUBLISHED') {
    // Published means that every person who had to answer approved it, and the author does not publish their own work.
    if (facts.latest === null || !facts.latest.allRequiredAnswered || facts.latest.rejected > 0) throw new DomainError('TRANSMITTAL_NOT_APPROVED', 422, 'transmittal');
    if (facts.actorId === facts.authorId) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
  }
  if ((facts.to === 'ARCHIVE' || (facts.from === 'SHARED' && facts.to === 'WIP')) && (facts.reason === null || facts.reason.trim().length < 5)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
}

export const REVIEW_STATES = ['NOT_ASKED', 'WAITING', 'DUE_SOON', 'OVERDUE', 'ANSWERED_ON_TIME', 'ANSWERED_LATE'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export interface ReviewReading {
  state: ReviewState;
  dueOn: string | null;
  daysLeft: number | null;
  daysLate: number | null;
}

/** The state of one recipient's answer on a day. */
export function reviewReading(facts: { dueOn: string | null; required: boolean; answeredOn: string | null }, today: string, policy: TransmittalPolicy): ReviewReading {
  if (facts.dueOn === null || !facts.required) {
    return facts.answeredOn === null ? { state: 'NOT_ASKED', dueOn: facts.dueOn, daysLeft: null, daysLate: null } : { state: 'ANSWERED_ON_TIME', dueOn: facts.dueOn, daysLeft: null, daysLate: facts.dueOn === null ? null : daysBetween(facts.dueOn, facts.answeredOn) };
  }
  if (facts.answeredOn !== null) {
    const late = daysBetween(facts.dueOn, facts.answeredOn);
    return { state: late > 0 ? 'ANSWERED_LATE' : 'ANSWERED_ON_TIME', dueOn: facts.dueOn, daysLeft: null, daysLate: late };
  }
  const left = daysBetween(today, facts.dueOn);
  if (left < 0) return { state: 'OVERDUE', dueOn: facts.dueOn, daysLeft: left, daysLate: null };
  return { state: left <= policy.reminder_days ? 'DUE_SOON' : 'WAITING', dueOn: facts.dueOn, daysLeft: left, daysLate: null };
}

export interface TransmittalProgress {
  recipients: number;
  required: number;
  answered: number;
  approved: number;
  rejected: number;
  overdue: number;
  allRequiredAnswered: boolean;
}

/** The progress of a transmittal from its recipients: how many must answer, how many did, how they answered, and how many are late. */
export function transmittalProgress(recipients: ReadonlyArray<{ required: boolean; answer: RecipientAnswer | null; review: ReviewReading }>): TransmittalProgress {
  let required = 0;
  let answered = 0;
  let approved = 0;
  let rejected = 0;
  let overdue = 0;
  let requiredAnswered = 0;
  for (const recipient of recipients) {
    if (recipient.required) required += 1;
    if (recipient.answer !== null) {
      answered += 1;
      if (recipient.required) requiredAnswered += 1;
      if (recipient.answer === 'APPROVED' || recipient.answer === 'APPROVED_WITH_COMMENTS' || recipient.answer === 'NO_COMMENT') approved += 1;
      if (recipient.answer === 'REJECTED') rejected += 1;
    }
    if (recipient.review.state === 'OVERDUE') overdue += 1;
  }
  return { recipients: recipients.length, required, answered, approved, rejected, overdue, allRequiredAnswered: required > 0 && requiredAnswered === required };
}

/** A transmittal needs a document, a recipient, and for a purpose that asks for an answer at least one recipient who must give it; a document appears once. */
export function assertTransmittalShape(input: { purpose: TransmittalPurpose; documentIds: readonly string[]; recipients: ReadonlyArray<{ required: boolean }> }): void {
  if (input.documentIds.length < 1 || input.documentIds.length > 100 || new Set(input.documentIds).size !== input.documentIds.length) throw new DomainError('VALIDATION_FAILED', 422, 'documents');
  if (input.recipients.length < 1 || input.recipients.length > 100) throw new DomainError('VALIDATION_FAILED', 422, 'recipients');
  if (purposeAsksAnswer(input.purpose) && !input.recipients.some((recipient) => recipient.required)) throw new DomainError('VALIDATION_FAILED', 422, 'recipients');
}

/** A due day moves once, forward, by at most the days the policy allows, with a reason; the answer of a recipient is accepted once. */
export function assertTransmittalExtension(input: { dueOn: string; newDueOn: string; alreadyExtended: boolean; reason: string | null }, policy: TransmittalPolicy): void {
  if (input.alreadyExtended) throw new DomainError('TRANSMITTAL_STATE_INVALID', 409, 'extension');
  const moved = daysBetween(input.dueOn, input.newDueOn);
  if (moved < 1 || moved > policy.max_extension_days) throw new DomainError('VALIDATION_FAILED', 422, 'due_on');
  if (input.reason === null || input.reason.trim().length < 5) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
}

export function assertAnswerAllowed(input: { answer: RecipientAnswer; comment: string | null; alreadyAnswered: boolean }): void {
  if (input.alreadyAnswered) throw new DomainError('TRANSMITTAL_STATE_INVALID', 409, 'answer');
  if ((input.answer === 'REJECTED' || input.answer === 'APPROVED_WITH_COMMENTS') && (input.comment === null || input.comment.trim().length < 5)) throw new DomainError('VALIDATION_FAILED', 422, 'comment');
}
