import { addMonthsClamped } from './billing-period.ts';
import { DomainError } from './errors.ts';

/**
 * The warranty a work carries after its handover and the guard that closes it (ST-AST-003, AST 3.3, BR-AST-03, BR-AST-05, UAT-AC390, UAT-AC392): the grades of a work, the statuses of an obligation
 * and of a claim, the minimum term the rule data states for a grade, the day the warranty ends, when an obligation counts as expired and when it may be closed. Pure functions of their input, kept
 * apart from the database.
 */

/** The grade of a construction work (in Vietnamese, "cap cong trinh"); the minimum term of the warranty depends on it. */
export const CONSTRUCTION_GRADES = ['SPECIAL', 'I', 'II', 'III', 'IV'] as const;
export type ConstructionGrade = (typeof CONSTRUCTION_GRADES)[number];

export const WARRANTY_STATUSES = ['ACTIVE', 'EXPIRED', 'CLOSED'] as const;
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];

export const CLAIM_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'REPAIRING', 'FIXED', 'VERIFIED', 'CLOSED', 'DISPUTED'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** A claim stops blocking the closure once the repair was verified by somebody other than the person who reported it; a disputed or an unanswered claim does not. */
export const isOpenClaim = (status: ClaimStatus): boolean => status !== 'VERIFIED' && status !== 'CLOSED';

/** The minimum terms in months the rule data in force states, by grade of work. */
export type WarrantyMinimums = Partial<Record<ConstructionGrade, number>>;

/**
 * The minimum term for a work of the grade. A work whose grade is not stated is held to the longest minimum there is, so that an unknown grade never lets a term through that the real grade would
 * have refused; undefined when the rule data states no minimum for the grade (or for any grade).
 */
export function minimumMonths(minimums: WarrantyMinimums, grade: ConstructionGrade | null): number | undefined {
  if (grade !== null) return minimums[grade];
  const stated = CONSTRUCTION_GRADES.flatMap((candidate) => minimums[candidate] ?? []);
  return stated.length === 0 ? undefined : Math.max(...stated);
}

/** The term is at least the minimum (BR-AST-03): 422 `WARRANTY_PERIOD_BELOW_MINIMUM` with both numbers; a term equal to the minimum is created. */
export function assertWarrantyPeriod(periodMonths: number, minimum: number): void {
  if (periodMonths < minimum) throw new DomainError('WARRANTY_PERIOD_BELOW_MINIMUM', 422, 'period_months', { extensions: { minimum_months: minimum, period_months: periodMonths } });
}

/** The day the warranty ends: the start plus the term, the last day of the month when that month is shorter (1 September 2026 plus 12 months is 1 September 2027). */
export const warrantyEndsOn = (startsOn: string, periodMonths: number): string => addMonthsClamped(startsOn, periodMonths);

/** A warranty has run out from its last day on: a claim is valid only when it was reported before that day (BR-AST-03). */
export const hasRunOut = (endsOn: string, today: string): boolean => today >= endsOn;

/**
 * What an obligation is today. The job that marks obligations expired runs once a day, so an ACTIVE obligation whose last day has come is already expired for every rule; the stored status catches
 * up with it.
 */
export function effectiveWarrantyStatus(status: WarrantyStatus, endsOn: string, today: string): WarrantyStatus {
  return status === 'ACTIVE' && hasRunOut(endsOn, today) ? 'EXPIRED' : status;
}

export interface WarrantyClosure {
  status: WarrantyStatus;
  endsOn: string;
  today: string;
  /** The numbers of the claims that are still open, in order. */
  openClaims: readonly string[];
}

/**
 * An obligation is closed once, after it has run out and when no claim is open (BR-AST-05): 409 `WARRANTY_STATE_INVALID` for one that is closed already, 422 `WARRANTY_NOT_EXPIRED` before its last
 * day, 422 `OPEN_WARRANTY_CLAIMS` with the numbers of the claims. Closing is what lets the retention and the warranty guarantee be released.
 */
export function assertWarrantyClosure(closure: WarrantyClosure): void {
  if (closure.status === 'CLOSED') throw new DomainError('WARRANTY_STATE_INVALID', 409, 'id', { extensions: { status: closure.status } });
  if (!hasRunOut(closure.endsOn, closure.today)) throw new DomainError('WARRANTY_NOT_EXPIRED', 422, 'id', { extensions: { ends_on: closure.endsOn } });
  if (closure.openClaims.length > 0) throw new DomainError('OPEN_WARRANTY_CLAIMS', 422, 'id', { extensions: { open_claims: closure.openClaims.length, claim_nos: [...closure.openClaims] } });
}
