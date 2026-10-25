import { DomainError } from './errors.ts';
import { addCalendarDays } from './land-timers.ts';
import { percentScaled, targetRecovered, wholeVnd } from './pay-money.ts';

/**
 * The advance of a contract (ST-PAY-004, PAY 3.2, BR-PAY-04, BR-PAY-10, BR-PAY-11): how much may be asked for, when the rest of it must be given back, and how the recovery runs against the work of
 * one member. Every figure is whole dong over BigInt and a pure function of its input, so the cases of the chief accountant run without a database.
 */

/** The categories a contract is advanced by (the table of caps has a row for each one). */
export const ADVANCE_CATEGORIES = ['CONSTRUCTION', 'EQUIPMENT', 'CONSULTING', 'EPC', 'LAND_CLEARANCE', 'OTHER'] as const;
export type AdvanceCategory = (typeof ADVANCE_CATEGORIES)[number];

export const ADVANCE_KINDS = ['CONTRACT', 'GPMB'] as const;
export type AdvanceKind = (typeof ADVANCE_KINDS)[number];

export const ADVANCE_STATUSES = ['PLANNED', 'REQUESTED', 'PAID', 'RECOVERING', 'FULLY_RECOVERED', 'CANCELLED'] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

/** What a recovery outside the payments is made of: a compensation paid to the person who owes the advance, a refund of money, anything else with its evidence. */
export const RECOVERY_BASES = ['COMPENSATION_PAYMENT', 'REFUND', 'OTHER'] as const;
export type RecoveryBasis = (typeof RECOVERY_BASES)[number];

/** The statuses that still hold a place under the cap: an advance that is planned, asked for, paid or being recovered (a cancelled one gives its place back). */
export const COUNTED_STATUSES: readonly AdvanceStatus[] = ['PLANNED', 'REQUESTED', 'PAID', 'RECOVERING', 'FULLY_RECOVERED'];

const PCT_SCALE = 10_000n;
const MAX_DEADLINE_DAYS = 366;

const invalid = (field: string, reason: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, { extensions: { reason } });

/** One step of the table of caps: from this value of the contract the contract may be advanced this share of the work of a member. */
export interface CapTier {
  minValueVnd: string;
  capPct: string;
}

/** The share the table gives a contract worth `contractValueVnd`: the tier with the highest minimum the value reaches; undefined when it reaches none. */
export function capPercentFor(tiers: readonly CapTier[], contractValueVnd: string): string | undefined {
  const value = wholeVnd(contractValueVnd, 'contract_value_vnd');
  let best: { min: bigint; pct: string } | undefined;
  for (const tier of tiers) {
    const min = wholeVnd(tier.minValueVnd, 'min_value_vnd');
    if (percentScaled(tier.capPct, 'cap_pct') > 100n * PCT_SCALE) throw invalid('cap_pct', 'ABOVE_ONE_HUNDRED_PERCENT');
    if (min <= value && (best === undefined || min > best.min)) best = { min, pct: tier.capPct };
  }
  return best?.pct;
}

/** The room left under the cap: `floor(cap_pct x work value of the member / 100)` less what is already advanced to the member, never below zero (BR-PAY-10). */
export function advanceCap(capPct: string, workValueVnd: string, advancedVnd: string): string {
  const work = wholeVnd(workValueVnd, 'work_value_vnd');
  const advanced = wholeVnd(advancedVnd, 'advanced_vnd');
  const whole = (work * percentScaled(capPct, 'cap_pct')) / (100n * PCT_SCALE);
  return (whole > advanced ? whole - advanced : 0n).toString();
}

/** The last day an advance of the GPMB kind may be left unrecovered: the day it was paid and the number of days the rule gives (BR-PAY-11). */
export function gpmbDeadline(paidOn: string, days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DEADLINE_DAYS) throw invalid('days', 'NOT_A_NUMBER_OF_DAYS');
  return addCalendarDays(paidOn, days);
}

/** A recovery may not take more than is still owed (`recovered <= paid`, UAT-AC61): 422 `ADVANCE_RECOVERY_EXCEEDED` with the figures. */
export function assertRecoverable(paidVnd: string, recoveredVnd: string, amountVnd: string): string {
  const paid = wholeVnd(paidVnd, 'paid_vnd');
  const recovered = wholeVnd(recoveredVnd, 'recovered_vnd');
  const amount = wholeVnd(amountVnd, 'amount_vnd');
  if (amount === 0n) throw invalid('amount_vnd', 'MUST_BE_POSITIVE');
  const outstanding = paid - recovered;
  if (amount > outstanding) {
    throw new DomainError('ADVANCE_RECOVERY_EXCEEDED', 422, 'amount_vnd', {
      extensions: { paid_vnd: paid.toString(), recovered_vnd: recovered.toString(), outstanding_vnd: outstanding.toString(), exceeds_by_vnd: (amount - outstanding).toString() },
    });
  }
  return (recovered + amount).toString();
}

/** Where the recovery of one advance stands and where it goes (CTR-06, PAY-07): everything is for the one member the advance was paid to, whatever the other members have done. */
export interface RecoveryPlanInput {
  paidVnd: string;
  recoveredVnd: string;
  workValueVnd: string;
  thresholdPct: string;
  /** What was asked for in the payments of the member before (the `G` of BR-PAY-04, this request not included). */
  grossToDateVnd: string;
}

export interface RecoveryMilestone {
  /** The share of the threshold reached, in percent. */
  atPct: number;
  /** The gross of the member at which that share is reached. */
  atGrossVnd: string;
  /** What should have been recovered by then. */
  recoveredVnd: string;
}

export interface RecoveryPlan {
  thresholdValueVnd: string;
  grossToDateVnd: string;
  remainingToThresholdVnd: string;
  /** What the formula says should be recovered at the gross reached; the advance is recovered in full once the threshold is reached. */
  targetRecoveredVnd: string;
  recoveredVnd: string;
  outstandingVnd: string;
  /** What still has to come back for the recovery to be where the formula says it should be (never below zero). */
  behindVnd: string;
  milestones: RecoveryMilestone[];
}

const MILESTONES = [25, 50, 75, 100] as const;

export function recoveryPlan(input: RecoveryPlanInput): RecoveryPlan {
  const paid = wholeVnd(input.paidVnd, 'paid_vnd');
  const recovered = wholeVnd(input.recoveredVnd, 'recovered_vnd');
  const work = wholeVnd(input.workValueVnd, 'work_value_vnd');
  const gross = wholeVnd(input.grossToDateVnd, 'gross_to_date_vnd');
  const thresholdValue = (work * percentScaled(input.thresholdPct, 'recovery_threshold_pct')) / (100n * PCT_SCALE);
  const target = BigInt(targetRecovered(input.paidVnd, input.workValueVnd, input.thresholdPct, input.grossToDateVnd));
  const outstanding = paid > recovered ? paid - recovered : 0n;
  return {
    thresholdValueVnd: thresholdValue.toString(),
    grossToDateVnd: gross.toString(),
    remainingToThresholdVnd: (thresholdValue > gross ? thresholdValue - gross : 0n).toString(),
    targetRecoveredVnd: target.toString(),
    recoveredVnd: recovered.toString(),
    outstandingVnd: outstanding.toString(),
    behindVnd: (target > recovered ? target - recovered : 0n).toString(),
    milestones: MILESTONES.map((atPct) => {
      const atGross = (thresholdValue * BigInt(atPct)) / 100n;
      return { atPct, atGrossVnd: atGross.toString(), recoveredVnd: targetRecovered(input.paidVnd, input.workValueVnd, input.thresholdPct, atGross.toString()) };
    }),
  };
}
