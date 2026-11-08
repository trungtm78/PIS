import { DomainError } from './errors.ts';
import { monthsOfQuarter } from './fnd-period.ts';
import type { EntryMode } from './fnd-taxonomy.ts';

/**
 * The identities checked when a figure is written (docs/fnd-funding-model.md section 8, I4): the cumulative identity, the sum of months and quarters, the phasing against the year plan in force, the estimate that may not
 * follow an actual, the subset that may not pass its parent. The same functions back the `DATA_ENTRY_RULE` codes of IND-1, so that a screen, a command and a rule judge a figure in one way. Pure; whole dong as text.
 */

const wholeVnd = (value: string, field: string): bigint => {
  if (!/^-?(0|[1-9][0-9]{0,22})$/.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return BigInt(value);
};

/** A money amount as the contract writes it: whole dong, no sign, no thousand separators (422 `VALIDATION_FAILED` naming `field`). */
export function nonNegativeVnd(value: string, field: string): string {
  const parsed = wholeVnd(value, field);
  if (parsed < 0n) throw new DomainError('VALIDATION_FAILED', 422, field);
  return parsed.toString();
}

/** A money amount that may be negative (a reversal or a credit of an actual). */
export const signedVnd = (value: string, field: string): string => wholeVnd(value, field).toString();

/**
 * I-CUM: for a month other than the first of the year `CUMULATIVE_YTD(p) = CUMULATIVE_YTD(p-1) + ACTUAL(p)`; for the first month `CUMULATIVE_YTD = ACTUAL`. `previousYtdVnd` is null for the first month of the year (and
 * for a first period with nothing before it). 422 `CUMULATIVE_IDENTITY_BROKEN` naming `cumulative_vnd`.
 */
export function assertCumulativeIdentity(input: { previousYtdVnd: string | null; actualVnd: string; ytdVnd: string }): void {
  const expected = (input.previousYtdVnd === null ? 0n : BigInt(input.previousYtdVnd)) + BigInt(input.actualVnd);
  if (expected !== BigInt(input.ytdVnd)) throw new DomainError('CUMULATIVE_IDENTITY_BROKEN', 422, 'cumulative_vnd', { extensions: { expected_vnd: expected.toString() } });
}

export interface CumulativeEntry {
  ordinal: number;
  cumulativeVnd: string;
}

/**
 * Entry mode `CUMULATIVE_ENTRY` (the public pack): the person types the year-to-date and the actual of a period is derived as `deltaOf` does today (BR-DIS-03): the cumulative less the cumulative of the earlier period of
 * the same year, null when there is none, a fall kept as a fall. Entry mode `PERIOD_ENTRY` (the enterprise pack): the person types the actual of the period and the first month is the cumulative itself (I-CUM), so the
 * first period has an actual. Either way a gap in the months (a month nobody entered) gives null for the month after it in cumulative mode, never a guess.
 */
export function deriveActuals(mode: EntryMode, entries: readonly CumulativeEntry[]): Array<{ ordinal: number; actualVnd: string | null }> {
  const ordered = [...entries].sort((left, right) => left.ordinal - right.ordinal);
  return ordered.map((entry, index) => {
    const before = ordered[index - 1];
    if (before === undefined) return { ordinal: entry.ordinal, actualVnd: mode === 'PERIOD_ENTRY' && entry.ordinal === 1 ? entry.cumulativeVnd : null };
    if (before.ordinal !== entry.ordinal - 1) return { ordinal: entry.ordinal, actualVnd: null };
    return { ordinal: entry.ordinal, actualVnd: (BigInt(entry.cumulativeVnd) - BigInt(before.cumulativeVnd)).toString() };
  });
}

/** The year-to-date of each month from the actuals typed by the person (entry mode `PERIOD_ENTRY`): the running sum within a year; a month nobody entered is a gap and the sum goes on from what is known. */
export function cumulativeOf(actuals: ReadonlyArray<{ ordinal: number; actualVnd: string }>): Array<{ ordinal: number; cumulativeVnd: string }> {
  let running = 0n;
  return [...actuals]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((one) => {
      running += BigInt(one.actualVnd);
      return { ordinal: one.ordinal, cumulativeVnd: running.toString() };
    });
}

const sum = (values: Iterable<string>): bigint => {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return total;
};

/** `sum of the months of a quarter = the quarter` when both exist (422 `GRAIN_SUM_MISMATCH` naming `quarter_vnd`); a quarter with fewer than three months entered is not judged. */
export function assertGrainSum(input: { quarterVnd: string | null; monthVnds: ReadonlyArray<string | null> }): void {
  if (input.quarterVnd === null) return;
  const months = input.monthVnds.filter((one): one is string => one !== null);
  if (months.length !== 3) return;
  const total = sum(months);
  if (total !== BigInt(input.quarterVnd)) throw new DomainError('GRAIN_SUM_MISMATCH', 422, 'quarter_vnd', { extensions: { months_sum_vnd: total.toString() } });
}

/** A phasing of a year plan: the quarters and the months entered, by ordinal. */
export interface Phasing {
  planInForceVnd: string | null;
  quarters: ReadonlyMap<number, string>;
  months: ReadonlyMap<number, string>;
}

/**
 * With `phasing_must_sum`, `the sum over the quarters q of PLAN_QUARTER = PLAN_IN_FORCE` for the same class, tier and measure when the four quarters exist (422 `PHASING_SUM_MISMATCH` naming `quarters`), and the months of a quarter add up to
 * the quarter when both exist (422 `GRAIN_SUM_MISMATCH` naming `months`). A year plan nobody published cannot be phased (422 `PHASING_SUM_MISMATCH`). Without the rule nothing is judged (the public pack: the registration of
 * a month is the project's own).
 */
export function assertPhasing(mustSum: boolean, phasing: Phasing): void {
  if (!mustSum) return;
  if (phasing.quarters.size > 0 && phasing.planInForceVnd === null) throw new DomainError('PHASING_SUM_MISMATCH', 422, 'quarters');
  if (phasing.quarters.size === 4 && phasing.planInForceVnd !== null && sum(phasing.quarters.values()) !== BigInt(phasing.planInForceVnd)) {
    throw new DomainError('PHASING_SUM_MISMATCH', 422, 'quarters', { extensions: { plan_in_force_vnd: phasing.planInForceVnd, quarters_sum_vnd: sum(phasing.quarters.values()).toString() } });
  }
  for (let quarter = 1; quarter <= 4; quarter += 1) {
    const planned = phasing.quarters.get(quarter);
    const months = monthsOfQuarter(quarter).map((month) => phasing.months.get(month) ?? null);
    if (planned !== undefined && months.every((one) => one !== null)) {
      if (sum(months.filter((one): one is string => one !== null)) !== BigInt(planned)) throw new DomainError('GRAIN_SUM_MISMATCH', 422, 'months', { extensions: { quarter: quarter } });
    }
  }
}

/** I3: an estimate cannot be accepted for a key that has an accepted actual (422 `ESTIMATE_AFTER_ACTUAL`). */
export function assertEstimateAllowed(hasActual: boolean): void {
  if (hasActual) throw new DomainError('ESTIMATE_AFTER_ACTUAL', 422, 'figure_kind');
}

/** A subset ("of which") never exceeds the cell it is a part of (422 `SUBSET_EXCEEDS_PARENT` naming `subset_vnd`). */
export function assertSubsetWithinParent(parentVnd: string, subsetVnd: string): void {
  if (BigInt(subsetVnd) > BigInt(parentVnd)) throw new DomainError('SUBSET_EXCEEDS_PARENT', 422, 'subset_vnd', { extensions: { parent_vnd: parentVnd, subset_vnd: subsetVnd } });
}

/** A negative actual (a reversal or a credit) needs its explanation (BR-DIS-03): 20 to 2000 characters. */
export function assertNegativeExplained(amountVnd: string, explanation: string | null): void {
  if (BigInt(amountVnd) < 0n && (explanation === null || explanation.trim().length < 20)) throw new DomainError('NEGATIVE_DELTA_EXPLANATION_REQUIRED', 422, 'explanation');
}
