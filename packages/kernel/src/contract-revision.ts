import { addDecimal, compareDecimal, subtractDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * The revisions of a contract and the decision of a change order (ST-CTR-007, CTR 3.3 steps 4 and 5, BR-CTR-03, BR-CTR-06): a revision is the terms a contract is performed under from a
 * day on; exactly one is in force at a time, a revision that is not yet in force changes no price and no value, and a change order cannot take the value of the contract below what has
 * been accepted or paid.
 */

/** The decisions on a change order: approve it (a revision follows), give it back to be assessed again, or turn it down. */
export const CHANGE_DECISIONS = ['approve', 'return', 'reject'] as const;
export type ChangeDecision = (typeof CHANGE_DECISIONS)[number];

export const changeDecisionOf = (value: unknown): ChangeDecision | undefined => CHANGE_DECISIONS.find((decision) => decision === value);

/** The document type of the delegation limit of a change order (ADM): the size of the change is judged against the bands the tenant configured for it. */
export const CHANGE_DOA_DOCUMENT_TYPE = 'CTR_CHANGE';

/** What the contract has taken in so far: the figures its value may not go below. All exact decimal strings in VND. */
export interface ValueLedger {
  acceptedTotalVnd: string;
  advancePaidVnd: string;
  paidTotalVnd: string;
  advanceRecoveredVnd: string;
}

/** The lowest value the contract may have (BR-CTR-06): the greater of what was accepted and what was paid net of the advance recovered. */
export function valueFloorVnd(ledger: ValueLedger): string {
  const outstanding = subtractDecimal(addDecimal(ledger.advancePaidVnd, ledger.paidTotalVnd), ledger.advanceRecoveredVnd);
  return compareDecimal(ledger.acceptedTotalVnd, outstanding) >= 0 ? ledger.acceptedTotalVnd : outstanding;
}

/** 422 `ACCEPTANCE_VALUE_EXCEEDS_CONTRACT` unless the new value of the contract is at least the floor; the extensions say both, so the screen can show them. */
export function assertValueAboveFloor(newValueVnd: string, ledger: ValueLedger): void {
  const floor = valueFloorVnd(ledger);
  if (compareDecimal(newValueVnd, floor) < 0) {
    throw new DomainError('ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', 422, 'approved_delta_vnd', { extensions: { new_value_vnd: newValueVnd, floor_vnd: floor, accepted_total_vnd: ledger.acceptedTotalVnd } });
  }
}

/**
 * 422 `RETROACTIVE_NOT_ALLOWED` for a change that takes effect before the day it is approved: what was accepted and paid under the old terms is not rewritten by an approval, and a
 * change that reaches back goes through the adjustment of its own (a later story). Days as `YYYY-MM-DD`, which compare as text.
 */
export function assertNotRetroactive(effectiveOn: string, today: string): void {
  if (effectiveOn < today) throw new DomainError('RETROACTIVE_NOT_ALLOWED', 422, 'effective_on', { extensions: { effective_on: effectiveOn, approved_on: today } });
}

/**
 * 422 `VALIDATION_FAILED` on `effective_on` unless the change begins after the revision it follows began: a revision is in force from its first day up to, and not including, the first
 * day of the next one (`valid_until` is exclusive), so two revisions cannot begin on the same day. The extensions say the earliest day.
 */
export function assertFollowsRevision(effectiveOn: string, previousValidFrom: string): void {
  if (effectiveOn <= previousValidFrom) throw new DomainError('VALIDATION_FAILED', 422, 'effective_on', { extensions: { reason: 'NOT_AFTER_REVISION', after: previousValidFrom } });
}

/** The value a contract takes from a change order: the value of the revision it stands on and the delta, never below zero (the floor is judged separately). */
export function valueAfterChange(currentValueVnd: string, deltaVnd: string): string {
  return addDecimal(currentValueVnd, deltaVnd);
}
