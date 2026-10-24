import { DomainError } from '@machvon/kernel';

/** What the thresholds of a tenant are when no policy has been published: 90 to warn and 100 to block (CAP.md BR-CAP-06, a working assumption). */
export const DEFAULT_WARN_PCT = '90.00';
export const DEFAULT_BLOCK_PCT = '100.00';

export const AVC_STATES = ['OK', 'WARN', 'BLOCK'] as const;
export type AvcState = (typeof AVC_STATES)[number];
export type AvcBlockReason = 'ZERO_ALLOCATION' | 'ABOVE_BLOCK';

/** What a line or an appropriation holds, in whole VND as decimal strings. */
export interface AvcFigures {
  allocatedVnd: string;
  reservedVnd: string;
  committedVnd: string;
  disbursedVnd: string;
}

/** The thresholds a check runs against, and the policy they came from (null when the tenant default applies). */
export interface AvcThresholds {
  policyId: string | null;
  warnPct: string;
  blockPct: string;
  includeReservations: boolean;
}

export interface AvcVerdict {
  state: AvcState;
  /** Why a check is BLOCK. */
  reason: AvcBlockReason | null;
  /** The share of the allocation used after the amount asked for, to two decimals, rounded down: for the screen, never for the decision. */
  consumptionPct: string;
  /** What is used (reserved when the policy counts reservations, committed, disbursed) after the amount asked for. */
  usedVnd: string;
  /** What is left of the allocation before the amount asked for. */
  availableVnd: string;
}

const PCT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;
const WHOLE = /^(0|[1-9]\d*)$/;
const HUNDREDTHS = 100n;

/** A percentage as hundredths of a percent (90.5 is 9050); a text that is not a percentage of at most two decimals is not one. */
export function hundredthsOf(pct: string): bigint {
  const match = PCT.exec(pct);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, 'pct');
  return BigInt(match[1] ?? '0') * HUNDREDTHS + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
}

const asUnits = (value: string): bigint => {
  const whole = value.replace(/\.0+$/, '');
  if (!WHOLE.test(whole)) throw new DomainError('VALIDATION_FAILED', 422, 'amount');
  return BigInt(whole);
};

function formatHundredths(value: bigint): string {
  const whole = value / HUNDREDTHS;
  const fraction = (value % HUNDREDTHS).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

/**
 * The thresholds as they must be (BR-CAP-06): both at most 100 and the warning not above the block. Anything else is 422 AVC_THRESHOLD_INVALID, named by the
 * field that is wrong, so a policy that would let spending through a line twice over, or warn after it blocks, is never drafted.
 */
export function assertThresholds(warnPct: string, blockPct: string): { warn: bigint; block: bigint } {
  const warn = thresholdOf(warnPct, 'warn_pct');
  const block = thresholdOf(blockPct, 'block_pct');
  if (warn > block) throw new DomainError('AVC_THRESHOLD_INVALID', 422, 'warn_pct', { extensions: { threshold_problem: 'WARN_ABOVE_BLOCK' } });
  return { warn, block };
}

function thresholdOf(text: string, field: string): bigint {
  if (!PCT.test(text)) throw new DomainError('AVC_THRESHOLD_INVALID', 422, field, { extensions: { threshold_problem: 'NOT_A_PERCENTAGE' } });
  const value = hundredthsOf(text);
  if (value > 100n * HUNDREDTHS) throw new DomainError('AVC_THRESHOLD_INVALID', 422, field, { extensions: { threshold_problem: 'ABOVE_100' } });
  return value;
}

/**
 * The availability control of one line or one appropriation (BR-CAP-06). The use after the amount asked for is reserved (when the policy counts it) plus committed plus
 * disbursed plus the amount; the verdict is OK below the warning threshold, WARN from it up to and including the block threshold, and BLOCK above the block threshold. An
 * allocation of nothing blocks every use (ZERO_ALLOCATION). The comparison is made by cross-multiplying whole numbers, so a threshold of 100 lets exactly the allocation
 * through and never one VND more, whatever the rounding of the percentage shown.
 */
export function evaluateAvc(figures: AvcFigures, thresholds: AvcThresholds, amountVnd = '0'): AvcVerdict {
  const allocated = asUnits(figures.allocatedVnd);
  const reserved = thresholds.includeReservations ? asUnits(figures.reservedVnd) : 0n;
  const settled = asUnits(figures.committedVnd) + asUnits(figures.disbursedVnd);
  const asked = asUnits(amountVnd);
  const used = reserved + settled + asked;
  const available = allocated - reserved - settled;
  const base = { usedVnd: used.toString(), availableVnd: (available < 0n ? 0n : available).toString() };
  if (allocated === 0n) return { ...base, state: 'BLOCK', reason: 'ZERO_ALLOCATION', consumptionPct: '0.00' };
  const warn = hundredthsOf(thresholds.warnPct);
  const block = hundredthsOf(thresholds.blockPct);
  const consumption = formatHundredths((used * 100n * HUNDREDTHS) / allocated);
  // used / allocated >= warn / 10000  <=>  used * 10000 >= warn * allocated, all whole numbers.
  const scaled = used * 100n * HUNDREDTHS;
  if (scaled > block * allocated) return { ...base, state: 'BLOCK', reason: 'ABOVE_BLOCK', consumptionPct: consumption };
  if (scaled >= warn * allocated) return { ...base, state: 'WARN', reason: null, consumptionPct: consumption };
  return { ...base, state: 'OK', reason: null, consumptionPct: consumption };
}
