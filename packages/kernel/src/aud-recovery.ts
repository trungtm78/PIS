import { DomainError } from './errors.ts';

export const RECOVERY_SOURCE_KINDS = ['PAY_RECOVERY', 'PAY_DEDUCTION', 'TREASURY_REMITTANCE', 'MANUAL_EVIDENCE'] as const;
export type RecoverySourceKind = (typeof RECOVERY_SOURCE_KINDS)[number];

/** The kinds of recovery PAY reports, in the words of its event (`kind`), and the kind of source each is on the ledger of AUD. */
export const PAY_RECOVERY_KINDS = { RECOVERY: 'PAY_RECOVERY', DEDUCTION: 'PAY_DEDUCTION' } as const satisfies Record<string, RecoverySourceKind>;

/** The sources a person may enter by hand: what PAY does not report (a direct payment to the Treasury, a document) and nothing PAY owns. */
export const MANUAL_SOURCE_KINDS: readonly RecoverySourceKind[] = ['TREASURY_REMITTANCE', 'MANUAL_EVIDENCE'];

/** What a line of the ledger does to a recommendation, as the ledger sees it: the sum of its signed lines. */
export interface Position {
  /** What was recommended, in whole dong. */
  amountVnd: string;
  /** What the ledger says was recovered, in whole dong. */
  recoveredVnd: string;
}

/**
 * BR-AUD-02: a line may not take what was recovered above what was recommended (409 `RECOVERY_EXCEEDS_RECOMMENDATION`, with the figures so that the screen can show how much is left). The table
 * says the same (`recovery_chk`); the check here is the answer the caller gets.
 */
export function assertWithinRecommendation(position: Position, lineVnd: string): void {
  const after = BigInt(position.recoveredVnd) + BigInt(lineVnd);
  if (after > BigInt(position.amountVnd)) {
    throw new DomainError('RECOVERY_EXCEEDS_RECOMMENDATION', 409, 'amount_vnd', {
      extensions: {
        amount_vnd: position.amountVnd,
        recovered_vnd: position.recoveredVnd,
        line_vnd: lineVnd,
        remaining_vnd: remaining(position),
        excess_vnd: (after - BigInt(position.amountVnd)).toString(),
      },
    });
  }
}

/** What is left to recover: the amount less what was recovered, never below zero. */
export function remaining(position: Position): string {
  const difference = BigInt(position.amountVnd) - BigInt(position.recoveredVnd);
  return (difference > 0n ? difference : 0n).toString();
}

/** A ratio with its numerator and its denominator, always: a rate shown without them cannot be checked (BR-AUD-04). */
export interface Rate {
  numerator: string;
  denominator: string;
  /** The percentage with two decimals, or null when the denominator is zero ("not applicable", never 0%). */
  percent: string | null;
}

/** BR-AUD-04: the rate of completion of the money, `recovered / recommended`, rounded half up to two decimals of a percent; an empty denominator is not applicable. */
export function rateOf(numerator: string, denominator: string): Rate {
  const top = BigInt(numerator);
  const bottom = BigInt(denominator);
  if (bottom === 0n) return { numerator, denominator, percent: null };
  // percent = top / bottom * 100 with two decimals: (top * 10000 + bottom / 2) / bottom, written as hundredths of a percent.
  const hundredths = (top * 10_000n * 2n + bottom) / (bottom * 2n);
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return { numerator, denominator, percent: `${whole.toString()}.${fraction}` };
}

/** What the payload of a PAY event says of a recovery, once it is read; anything that does not read is 422 `VALIDATION_FAILED` naming the field. */
export interface PayRecoveryFacts {
  recoveryId: string;
  recommendationId: string;
  amountVnd: string;
  sourceKind: RecoverySourceKind;
  day: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const malformed = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function uuidField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || !UUID.test(value)) throw malformed(field);
  return value.toLowerCase();
}

function amountField(payload: Record<string, unknown>): string {
  const value = payload.amount_vnd;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,23}$/.test(value)) throw malformed('amount_vnd');
  return value;
}

function dayField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw malformed(field);
  return value;
}

/** `pay.recovery.recorded.v1 {recovery_id, audit_recommendation_id, amount_vnd, kind, recorded_on}` (AUD 3.4). */
export function readRecordedRecovery(payload: Record<string, unknown>): PayRecoveryFacts {
  const kind = Object.entries(PAY_RECOVERY_KINDS).find(([name]) => name === payload.kind)?.[1];
  if (kind === undefined) throw malformed('kind');
  return { recoveryId: uuidField(payload, 'recovery_id'), recommendationId: uuidField(payload, 'audit_recommendation_id'), amountVnd: amountField(payload), sourceKind: kind, day: dayField(payload, 'recorded_on') };
}

/** `pay.recovery.reversed.v1 {recovery_id, audit_recommendation_id, amount_vnd, kind, reversed_on}`: the same recovery, taken back. */
export function readReversedRecovery(payload: Record<string, unknown>): PayRecoveryFacts {
  const kind = Object.entries(PAY_RECOVERY_KINDS).find(([name]) => name === payload.kind)?.[1];
  if (kind === undefined) throw malformed('kind');
  return { recoveryId: uuidField(payload, 'recovery_id'), recommendationId: uuidField(payload, 'audit_recommendation_id'), amountVnd: amountField(payload), sourceKind: kind, day: dayField(payload, 'reversed_on') };
}

/**
 * BR-AUD-01 and AUD 3.4: a closed recommendation that no longer has everything recovered goes back to work. A recommendation whose dispute the authority accepted was closed on what was
 * recovered and owes no more, so a reversal does not reopen it.
 */
export function reopensOnReversal(input: { status: string; amountVnd: string; recoveredVnd: string; disputeAccepted: boolean }): boolean {
  return input.status === 'CLOSED' && !input.disputeAccepted && BigInt(input.recoveredVnd) < BigInt(input.amountVnd);
}
