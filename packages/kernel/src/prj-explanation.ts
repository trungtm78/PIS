import { DomainError } from './errors.ts';

/**
 * The explanation request (ST-PRJ-006, PRJ 3.1 F10): a leader asks the person who answers for a project (or a unit) to explain, the person answers, and someone
 * else accepts the answer or returns it. The statuses and what each may do are here, with no store or clock of their own.
 */
export const EXPLANATION_STATUSES = ['REQUESTED', 'RESPONDED', 'ACCEPTED', 'RETURNED', 'OVERDUE', 'CANCELLED'] as const;
export type ExplanationStatus = (typeof EXPLANATION_STATUSES)[number];
export const EXPLANATION_SUBJECTS = ['PROJECT', 'UNIT'] as const;
export type ExplanationSubject = (typeof EXPLANATION_SUBJECTS)[number];
export const EXPLANATION_DECISIONS = ['ACCEPTED', 'RETURNED'] as const;
export type ExplanationDecision = (typeof EXPLANATION_DECISIONS)[number];

/** The statuses of a request that is still to be settled: the ones of which one is allowed at a time for a subject, a trigger and a period. */
export const OPEN_EXPLANATION_STATUSES: readonly ExplanationStatus[] = ['REQUESTED', 'OVERDUE', 'RESPONDED', 'RETURNED'];

/** The working days given to answer when the request comes from a warning (MDM-18, an assumption until CXN-33 is confirmed). */
export const EXPLANATION_DUE_WORKING_DAYS = 3;

/** The trigger code a request has when it was asked for by a person rather than by a rule. */
export const MANUAL_EXPLANATION_TRIGGER = 'MANUAL';

const RESPONDABLE: readonly ExplanationStatus[] = ['REQUESTED', 'OVERDUE', 'RETURNED'];
const OVERDUE_BEFORE: readonly ExplanationStatus[] = ['REQUESTED', 'RETURNED'];

/** Whether the person asked may still answer: a late answer is taken (it is told late), a request that was answered, accepted or withdrawn is not. */
export const canRespond = (status: ExplanationStatus): boolean => RESPONDABLE.includes(status);

/** Whether an answer waits for a conclusion. */
export const canReview = (status: ExplanationStatus): boolean => status === 'RESPONDED';

/** Whether the job marks the request overdue now: asked or returned, and past its due moment. */
export const becomesOverdue = (status: ExplanationStatus, dueAt: Date, now: Date): boolean => OVERDUE_BEFORE.includes(status) && now.getTime() > dueAt.getTime();

/** Whether an answer given at `respondedAt` is late for a request due at `dueAt`. */
export const isAnswerLate = (respondedAt: Date, dueAt: Date): boolean => respondedAt.getTime() > dueAt.getTime();

/** The moment a due date ends, in Vietnam: the last second of the day (UTC+7 has no summer time). */
export function dueMomentOf(date: string): Date {
  const moment = new Date(`${date}T23:59:59.999+07:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(moment.getTime())) throw new DomainError('VALIDATION_FAILED', 422, 'due_at');
  return moment;
}

/** The status a conclusion gives the request: ACCEPTED or RETURNED; a request that is not waiting for one is 409 STAGE_TRANSITION_DENIED. */
export function concludedStatus(status: ExplanationStatus, decision: ExplanationDecision): ExplanationStatus {
  if (!canReview(status)) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { explanation_status: status } });
  return decision;
}

/** The status after an answer: a request that was answered or concluded is 422 EXPLANATION_ALREADY_SUBMITTED; one withdrawn is 409 STAGE_TRANSITION_DENIED. */
export function answeredStatus(status: ExplanationStatus): ExplanationStatus {
  if (status === 'RESPONDED' || status === 'ACCEPTED') throw new DomainError('EXPLANATION_ALREADY_SUBMITTED', 422, 'status', { extensions: { explanation_status: status } });
  if (!canRespond(status)) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { explanation_status: status } });
  return 'RESPONDED';
}
