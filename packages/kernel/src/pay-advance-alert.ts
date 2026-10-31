import { addDays } from './billing-period.ts';
import { DomainError } from './errors.ts';
import { daysBetween } from './pay-project-settlement.ts';

/**
 * The alerts of an advance that is not recovered in time (ST-PAY-011, PAY 3.2 step 4, BR-PAY-11, UAT-AC328, UAT-AC329). Pure functions of the facts of the advance and of the day, kept apart from the database.
 * The deadline of a land clearance advance is thirty days after it was paid; the days of the warnings are a working assumption until the business owner confirms the rule (CXN-12).
 */

/** The alert levels in the order they are reached: seven days before the deadline, the deadline, the day after it, seven days after it. */
export const ADVANCE_ALERT_LEVELS = [1, 2, 3, 4] as const;
export type AdvanceAlertLevel = (typeof ADVANCE_ALERT_LEVELS)[number];
export type AdvanceAlertState = 0 | AdvanceAlertLevel;

/** The days before the deadline at which the first alert goes, and the days after it at which the alert is raised to the leader. */
export const ADVANCE_WARNING_DAYS = 7;
export const ADVANCE_ESCALATION_DAYS = 7;

export interface AdvanceAlertFacts {
  kind: 'CONTRACT' | 'GPMB';
  outstandingVnd: string;
  /** The day a land clearance advance must be recovered by. */
  recoveryDeadline: string | null;
  /** The day the advance was first found overdue, when it was. */
  overdueSince: string | null;
  /** For an advance of a contract: the member has asked to be paid up to the threshold of recovery and still owes the advance. */
  thresholdReached: boolean;
  /** For an advance of a contract: the contract is completed or terminated. */
  contractEnded: boolean;
}

export interface AdvanceAlert {
  level: AdvanceAlertState;
  /** The day the advance became overdue; null while it is not. */
  overdueSince: string | null;
}

/**
 * The level an advance is at on a day. Nothing owed raises no alert. A land clearance advance goes through the four levels around its deadline (the overdue day is the day after it); an advance of a contract is overdue
 * from the first day it is found past the threshold of recovery, or on a contract that has ended, and is raised to the leader a week later. Nothing here marks an advance as recovered.
 */
export function advanceAlert(facts: AdvanceAlertFacts, today: string): AdvanceAlert {
  if (BigInt(facts.outstandingVnd) <= 0n) return { level: 0, overdueSince: facts.overdueSince };
  if (facts.kind === 'GPMB') {
    if (facts.recoveryDeadline === null) return { level: 0, overdueSince: facts.overdueSince };
    const left = daysBetween(today, facts.recoveryDeadline);
    const overdueSince = left < 0 ? addDays(facts.recoveryDeadline, 1) : facts.overdueSince;
    if (left < -ADVANCE_ESCALATION_DAYS + 1) return { level: 4, overdueSince };
    if (left < 0) return { level: 3, overdueSince };
    if (left === 0) return { level: 2, overdueSince };
    return { level: left <= ADVANCE_WARNING_DAYS ? 1 : 0, overdueSince };
  }
  if (!facts.thresholdReached && !facts.contractEnded) return { level: 0, overdueSince: facts.overdueSince };
  const since = facts.overdueSince ?? today;
  return { level: daysBetween(since, today) >= ADVANCE_ESCALATION_DAYS ? 4 : 3, overdueSince: since };
}

/** The day the plan of recovery is due: not before today (422 `VALIDATION_FAILED` naming the field). */
export function assertPlanDue(planDueOn: string, today: string): void {
  if (planDueOn < today) throw new DomainError('VALIDATION_FAILED', 422, 'action_plan_due_on', { extensions: { reason: 'IN_THE_PAST' } });
}

/** Only an advance that is overdue and still owed is acknowledged (422 `ADVANCE_NOT_OVERDUE`). */
export function assertAcknowledgeable(facts: { outstandingVnd: string; overdueSince: string | null }): void {
  if (facts.overdueSince === null || BigInt(facts.outstandingVnd) <= 0n) throw new DomainError('ADVANCE_NOT_OVERDUE', 422, 'id');
}
