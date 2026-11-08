/**
 * The budget of a measured read is stated for a reference machine; a slower machine gets a longer budget in proportion to how much slower it is, measured in the same run, and never a shorter one.
 *
 * Why not a bare number: the same code on the same data takes 1.5 to 4 times as long on a development box that is running other suites, the antivirus or a second database as on an idle one (see the numbers in
 * `contract-fact-performance.test.ts`). A fixed 800 ms then fails on the load of the day and says nothing about the code. A budget that is only ever stretched by the measured speed of the machine keeps the claim of
 * the requirement (800 ms at the p95 on a machine of the reference speed) and still fails when the code itself becomes slower: the stretch is measured with a workload that does not touch anything under test, so a
 * slower query is not excused by it.
 */

/** The budget on a machine of the reference speed (NFR-PERFORMANCE: what a screen asks, at the p95). */
export const REFERENCE_BUDGET_MS = 800;

/** A machine slower than this many times the reference is not judged: the result would say more about the machine than about the code, so the run fails and says so. */
export const MAX_SLOWDOWN = 3;

export interface BudgetDecision {
  /** How many times slower than the reference machine this one measured (at least 1: a faster machine keeps the reference budget). */
  factor: number;
  /** The budget to hold the p95 to, in milliseconds. */
  budgetMs: number;
  /** True when the machine is so slow that no verdict can be given. */
  tooSlow: boolean;
}

/** The median of a list of samples (the middle one; the lower middle for an even count). */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new RangeError('median of no samples');
  return [...samples].sort((a, b) => a - b)[Math.floor((samples.length - 1) / 2)] as number;
}

/** The p95 of a list of samples (nearest rank). */
export function p95Of(samples: readonly number[]): number {
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

/**
 * The budget for a machine whose reference workload took `measuredMs` where the reference machine takes `referenceMs`. Never below the reference budget; not stretched past `MAX_SLOWDOWN` (then `tooSlow`).
 * A measurement that is not a positive finite number is refused: a broken calibration must not silently give a long budget.
 */
export function budgetFor(measuredMs: number, referenceMs: number, budgetMs: number = REFERENCE_BUDGET_MS): BudgetDecision {
  if (!Number.isFinite(measuredMs) || measuredMs <= 0 || !Number.isFinite(referenceMs) || referenceMs <= 0) throw new RangeError('the calibration needs positive, finite timings');
  const ratio = measuredMs / referenceMs;
  const factor = Math.min(Math.max(1, ratio), MAX_SLOWDOWN);
  return { factor, budgetMs: budgetMs * factor, tooSlow: ratio > MAX_SLOWDOWN };
}
