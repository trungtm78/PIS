import type { StepDeadline } from './reporting-schedule.ts';

/**
 * When the job that locks periods may lock a period of the enterprise calendar (INT-2, QT.02). The public rule, three working days after the entry deadline (D03), knows nothing of the review of the planning board and of
 * the close of the period, which the schedule of the enterprise edition puts later (by default the review on day 10 and the close on day 12 of the month, while the entry deadline is day 5, so the three working days end
 * on day 8 to 10). A period that is locked takes no figure any more except under an approved reopening, and a review that has to send a record back to its unit needs the unit to be able to hand it in again: locking
 * before the review and the close have finished would turn every correction into a reopening with a reason and a second approver, and would let the lock decide what the people who review had not decided yet.
 *
 * So the lock of an enterprise period waits for the two steps. A step with a fact (staged approval: the platform knows which records passed it) lets the period go when every record passed it, and holds it for as long as
 * one has not; a step with no fact (the tenant runs the single decision, so the platform cannot see the step) lets the period go once its deadline in the schedule has passed, which is the only evidence of "finished"
 * that exists. A hold is never a lock: the people are reminded by the calendar, and a person with the right can still lock by hand.
 */

export const LOCK_HOLDS = ['PLANNING_REVIEW_PENDING', 'PLANNING_REVIEW_NOT_DUE', 'PERIOD_CLOSE_PENDING', 'PERIOD_CLOSE_NOT_DUE'] as const;
export type LockHold = (typeof LOCK_HOLDS)[number];

/**
 * How far the records of a period went through the two steps: the instant the last record passed, `null` when some record has not passed, `undefined` when the platform has no fact (no record runs the staged approval).
 */
export interface LockProgress {
  planningReviewAt?: string | null | undefined;
  periodCloseAt?: string | null | undefined;
}

export type LockVerdict = { open: true } | { open: false; hold: LockHold };

/** Whether the lock of a period may go ahead at `now`, given the deadlines of its schedule and the progress of its records; the first step that holds it is named. */
export function periodLockVerdict(deadlines: readonly StepDeadline[], progress: LockProgress, now: Date): LockVerdict {
  const steps: ReadonlyArray<{ kind: 'PLANNING_REVIEW' | 'PERIOD_CLOSE'; done: string | null | undefined; pending: LockHold; notDue: LockHold }> = [
    { kind: 'PLANNING_REVIEW', done: progress.planningReviewAt, pending: 'PLANNING_REVIEW_PENDING', notDue: 'PLANNING_REVIEW_NOT_DUE' },
    { kind: 'PERIOD_CLOSE', done: progress.periodCloseAt, pending: 'PERIOD_CLOSE_PENDING', notDue: 'PERIOD_CLOSE_NOT_DUE' },
  ];
  for (const step of steps) {
    if (step.done === null) return { open: false, hold: step.pending };
    if (step.done !== undefined) continue;
    const deadline = deadlines.find((one) => one.kind === step.kind);
    if (deadline !== undefined && now.getTime() < Date.parse(deadline.dueAt)) return { open: false, hold: step.notDue };
  }
  return { open: true };
}
