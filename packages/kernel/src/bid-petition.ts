import { DomainError } from './errors.ts';
import { LAND_DAY_COUNTS } from './land-timers.ts';
import type { LandDayCount } from './land-timers.ts';

/**
 * The petitions of contractors about the selection of a contractor (ST-BID-007, BID 3 F7, BR-BID-14). A petition is about the process (before the result) or about the result; the
 * procuring entity answers it with a document before a deadline that the rule data states (with its legal basis), or passes it on to the level above with a document. Until it is
 * answered the petition is open, and once the deadline has passed it is overdue.
 */
export const PETITION_KINDS = ['PROCESS', 'RESULT'] as const;
export type PetitionKind = (typeof PETITION_KINDS)[number];

export const PETITION_STATUSES = ['RECEIVED', 'PROCESSING', 'RESOLVED', 'ESCALATED', 'WITHDRAWN'] as const;
export type PetitionStatus = (typeof PETITION_STATUSES)[number];

/** How a petition is answered: with the reply of the procuring entity, or by passing it on to the level above. */
export const PETITION_OUTCOMES = ['RESOLVED', 'ESCALATED'] as const;
export type PetitionOutcome = (typeof PETITION_OUTCOMES)[number];

/** The statuses in which a petition still waits for an answer, and so can be overdue. */
export const OPEN_PETITION_STATUSES: readonly PetitionStatus[] = ['RECEIVED', 'PROCESSING'];

/** The longest period a rule may state, in days: a year, like the timers of land clearance. */
export const MAX_PETITION_DAYS = 366;

export { LAND_DAY_COUNTS as PETITION_DAY_COUNTS };
export type PetitionDayCount = LandDayCount;

/**
 * The rule of a kind of petition as the rule data in force states it: how many days the answer may take and how they are counted (calendar days, or working days of a named calendar),
 * and, when the law limits it, the days within which the petition may be lodged at all.
 */
export interface PetitionRule {
  kind: PetitionKind;
  days: number;
  dayCount: PetitionDayCount;
  calendarCode: string | null;
  /** The days after the result is approved within which a petition about it may be lodged; null when the rule sets no limit. */
  filingDays: number | null;
}

/** The status a petition moves to when it is answered with `outcome`: an open one takes the outcome, a petition passed on to the level above is then answered by that level. */
export function petitionTarget(outcome: PetitionOutcome, status: PetitionStatus): PetitionStatus | undefined {
  if (OPEN_PETITION_STATUSES.includes(status)) return outcome;
  if (status === 'ESCALATED' && outcome === 'RESOLVED') return 'RESOLVED';
  return undefined;
}

/** 409 `PETITION_STATE_INVALID` (with the status) unless the petition can be answered with `outcome` from `status`. */
export function assertPetitionTransition(outcome: PetitionOutcome, status: PetitionStatus): PetitionStatus {
  const target = petitionTarget(outcome, status);
  if (target === undefined) throw new DomainError('PETITION_STATE_INVALID', 409, 'status', { extensions: { petition_status: status } });
  return target;
}

/** A petition is overdue while it waits for an answer and the last day of its deadline has passed (`dueOn` is the last day to answer; `today` is the Vietnam date). */
export const isPetitionOverdue = (status: PetitionStatus, dueOn: string, today: string): boolean => OPEN_PETITION_STATUSES.includes(status) && today > dueOn;
