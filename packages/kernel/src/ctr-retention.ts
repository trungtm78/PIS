import { compareDecimal, subtractDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * The retention held back from a payment and the rules that release it (ST-CTR-010, CTR 3.5, BR-CTR-09, UAT-AC309, UAT-AC397): the statuses, the conditions a release waits for, when a condition is met,
 * how much is still held and who may not release. Pure functions of their input, kept apart from the database.
 */

export const RETENTION_STATUSES = ['HELD', 'PARTIALLY_RELEASED', 'RELEASED', 'FORFEITED'] as const;
export type RetentionStatus = (typeof RETENTION_STATUSES)[number];

export const RELEASE_CONDITIONS = ['WARRANTY_END', 'COMPLETION', 'MANUAL_DECISION'] as const;
export type ReleaseCondition = (typeof RELEASE_CONDITIONS)[number];

/** Why a release is not allowed yet. */
export const RELEASE_BLOCKERS = ['NOT_BEFORE', 'NO_WARRANTY', 'WARRANTY_OPEN', 'CONTRACT_NOT_COMPLETED', 'DECISION_REQUIRED'] as const;
export type ReleaseBlocker = (typeof RELEASE_BLOCKERS)[number];

/** What a release is judged on, read from the database inside the transaction of the command. */
export interface ReleaseFacts {
  condition: ReleaseCondition;
  /** The earliest day the money may leave, if one was set (a Vietnam calendar day). */
  notBefore: string | null;
  today: string;
  /** The status of the contract. */
  contractStatus: string;
  /** The warranty obligations of the contract and how many of them are not closed. */
  warranty: { obligations: number; notClosed: number };
  /** Whether the decision of the authority is attached (a clean document version). */
  hasDecision: boolean;
}

/**
 * Why the money may not be released yet, or undefined when it may (BR-CTR-09). The earliest day always counts. `WARRANTY_END` waits until every warranty obligation of the contract is closed, and a
 * contract with no warranty obligation at all has not ended its warranty, it has not started one; `COMPLETION` waits for the contract to be completed (or closed); `MANUAL_DECISION` waits for the
 * decision of the authority, attached as a document.
 */
export function releaseBlocker(facts: ReleaseFacts): ReleaseBlocker | undefined {
  if (facts.notBefore !== null && facts.today < facts.notBefore) return 'NOT_BEFORE';
  switch (facts.condition) {
    case 'WARRANTY_END':
      if (facts.warranty.obligations === 0) return 'NO_WARRANTY';
      return facts.warranty.notClosed > 0 ? 'WARRANTY_OPEN' : undefined;
    case 'COMPLETION':
      return facts.contractStatus === 'COMPLETED' || facts.contractStatus === 'CLOSED' ? undefined : 'CONTRACT_NOT_COMPLETED';
    case 'MANUAL_DECISION':
      return facts.hasDecision ? undefined : 'DECISION_REQUIRED';
  }
}

/** 422 `RELEASE_CONDITION_NOT_MET` with the condition, the reason and what the reason is about, unless the money may be released. */
export function assertReleasable(facts: ReleaseFacts): void {
  const reason = releaseBlocker(facts);
  if (reason === undefined) return;
  throw new DomainError('RELEASE_CONDITION_NOT_MET', 422, 'id', {
    extensions: {
      condition: facts.condition,
      reason,
      ...(reason === 'NOT_BEFORE' ? { release_not_before: facts.notBefore } : {}),
      ...(reason === 'WARRANTY_OPEN' ? { open_obligations: facts.warranty.notClosed } : {}),
    },
  });
}

/** What is still held: the amount held less what was released, whole VND as text. */
export const retentionLeft = (heldVnd: string, releasedVnd: string): string => subtractDecimal(heldVnd, releasedVnd);

/** Nothing is left to release when everything held was released: a hold that is over takes no release, whatever the amount (422 `RELEASE_EXCEEDS_HELD`). */
export function assertSomethingHeld(heldVnd: string, releasedVnd: string): void {
  if (compareDecimal(retentionLeft(heldVnd, releasedVnd), '0') <= 0) {
    throw new DomainError('RELEASE_EXCEEDS_HELD', 422, 'amount_vnd', { extensions: { held_vnd: heldVnd, released_vnd: releasedVnd, left_vnd: '0' } });
  }
}

/** The amount is above nothing and at most what is left (BR-CTR-09): 422 `RELEASE_EXCEEDS_HELD` with the three figures, 422 `VALIDATION_FAILED` for an amount of nothing. */
export function assertReleaseAmount(heldVnd: string, releasedVnd: string, amountVnd: string): void {
  if (compareDecimal(amountVnd, '0') <= 0) throw new DomainError('VALIDATION_FAILED', 422, 'amount_vnd');
  const left = retentionLeft(heldVnd, releasedVnd);
  if (compareDecimal(amountVnd, left) === 1) {
    throw new DomainError('RELEASE_EXCEEDS_HELD', 422, 'amount_vnd', { extensions: { held_vnd: heldVnd, released_vnd: releasedVnd, left_vnd: left, amount_vnd: amountVnd } });
  }
}

/** The status after a release: released when everything held has been, partially released otherwise. */
export const statusAfterRelease = (heldVnd: string, releasedAfterVnd: string): RetentionStatus => (compareDecimal(releasedAfterVnd, heldVnd) === 0 ? 'RELEASED' : 'PARTIALLY_RELEASED');

/** Whoever put the money on hold does not release it (403 `SELF_APPROVAL_DENIED`): the person who sent the payment request it was held from. */
export function assertNotTheMaker(actor: string, maker: string): void {
  if (actor === maker) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'id');
}
