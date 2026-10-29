import { DomainError } from './errors.ts';

/**
 * Source mappings and the reconciliation of two sources (ST-DGV-004, DGV.md F7, BR-DGV-09). A field of a source reaches a dataset only through a mapping that its owner confirmed, with the unit the source writes it in; and
 * two sources are compared on the same period and basis, difference by difference, without ever choosing one as right or adding them into one number.
 */

// ---- units of money ------------------------------------------------------------------------------------------------------------------

const FOLD = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** How many dong one unit of the source is, by the name of the unit (a code, or the words as the source writes them). */
const UNIT_FACTORS: ReadonlyArray<readonly [string, bigint]> = [
  ['vnd', 1n],
  ['dong', 1n],
  ['thousand_vnd', 1_000n],
  ['nghin dong', 1_000n],
  ['ngan dong', 1_000n],
  ['million_vnd', 1_000_000n],
  ['trieu dong', 1_000_000n],
  ['billion_vnd', 1_000_000_000n],
  ['ty dong', 1_000_000_000n],
];

/** The factor to dong of a unit; no unit means dong. Undefined for a unit that is not known (the proposal is refused rather than guessed). */
export function unitFactor(unit: string | null | undefined): bigint | undefined {
  if (unit === null || unit === undefined || unit.trim() === '') return 1n;
  const name = FOLD(unit);
  return UNIT_FACTORS.find(([candidate]) => candidate === name)?.[1];
}

/**
 * A decimal string multiplied by the factor, exactly: 12.5 million is 12500000. A result that is not a whole number of dong is refused (422 `VALIDATION_FAILED` on `field`), never rounded.
 */
export function convertAmount(value: string, factor: bigint, field = 'amount'): string {
  const match = /^(-?)(\d{1,24})(?:\.(\d{1,12}))?$/.exec(value.trim());
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, field);
  const [, sign, whole, fraction = ''] = match as unknown as [string, string, string, string | undefined];
  const scale = 10n ** BigInt(fraction.length);
  const scaled = (BigInt(whole) * scale + BigInt(fraction === '' ? '0' : fraction)) * factor;
  if (scaled % scale !== 0n) throw new DomainError('VALIDATION_FAILED', 422, field);
  const result = scaled / scale;
  return `${sign === '-' && result !== 0n ? '-' : ''}${result.toString()}`;
}

// ---- the gate of a batch ---------------------------------------------------------------------------------------------------------------

export interface ConfirmedMapping {
  id: string;
  sourceField: string;
  targetField: string;
  unit: string | null;
}

export type GateOutcome =
  | { outcome: 'APPLIED'; fields: Array<{ sourceField: string; targetField: string; mappingId: string; factor: bigint }> }
  | { outcome: 'QUARANTINED'; reason: 'MAPPING_NOT_CONFIRMED'; missing: string[] };

/**
 * What the pipeline does with a batch that carries these fields of a source: every field must have a mapping that was confirmed, otherwise the whole batch is kept out in quarantine with the reason
 * `MAPPING_NOT_CONFIRMED` (it is not read with a guessed mapping). The factor of each field is the one of the unit of its mapping.
 */
export function gateBatch(sourceFields: readonly string[], confirmed: readonly ConfirmedMapping[]): GateOutcome {
  const fields: Array<{ sourceField: string; targetField: string; mappingId: string; factor: bigint }> = [];
  const missing: string[] = [];
  for (const sourceField of new Set(sourceFields)) {
    // A source field may go into several fields of the dataset: each confirmed mapping is an instruction of its own.
    const usable = confirmed.flatMap((candidate) => {
      const factor = candidate.sourceField === sourceField ? unitFactor(candidate.unit) : undefined;
      return factor === undefined ? [] : [{ sourceField, targetField: candidate.targetField, mappingId: candidate.id, factor }];
    });
    if (usable.length === 0) missing.push(sourceField);
    else fields.push(...usable);
  }
  return missing.length > 0 ? { outcome: 'QUARANTINED', reason: 'MAPPING_NOT_CONFIRMED', missing } : { outcome: 'APPLIED', fields };
}

// ---- reconciliation ------------------------------------------------------------------------------------------------------------------------

/** The basis both sources are read on: dong, by the day the Treasury paid. */
export const RECON_BASIS = 'VND, ngày Kho bạc thanh toán';
const SUPPORTED_BASES = [FOLD(RECON_BASIS), FOLD('VND, treasury payment date')];
export const RECON_SOURCE_A = 'PAY.treasury_transaction';
export const RECON_SOURCE_B = 'DIS.report_accepted';

/** 422 `BASIS_MISMATCH` unless the sources are the two this reconciliation knows (PAY treasury as A, DIS reported as B) and the basis is the one both are read on. */
export function assertComparable(input: { sourceA: string; sourceB: string; basis: string }): void {
  const name = (source: string): string => FOLD(source);
  if (![FOLD(RECON_SOURCE_A), 'pay'].includes(name(input.sourceA))) throw new DomainError('BASIS_MISMATCH', 422, 'source_a');
  if (![FOLD(RECON_SOURCE_B), 'dis'].includes(name(input.sourceB))) throw new DomainError('BASIS_MISMATCH', 422, 'source_b');
  if (!SUPPORTED_BASES.includes(FOLD(input.basis))) throw new DomainError('BASIS_MISMATCH', 422, 'basis');
}

/** `2026-10`: the period code; anything else is 422 on `as_of_period`. */
export function assertPeriod(period: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period.trim());
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, 'as_of_period');
  return period.trim();
}

export const DIFFERENCE_KINDS = ['MISSING', 'TIMING', 'REVERSAL', 'MAPPING', 'AMOUNT'] as const;
export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number];
export type ReconResult = 'MATCHED' | 'WITHIN_TOLERANCE' | 'DIFFERENT';

/** What the Treasury has for one key (a project) up to the end of the period. */
export interface TreasuryLine {
  key: string;
  /** Net amount in dong, reversals included. */
  amountVnd: bigint;
  /** The part of it that is reversals. */
  reversalVnd: bigint;
  /** The part of it confirmed after the cut-off the report was made on. */
  afterCutoffVnd: bigint;
}

/** What the accepted report says for one key. */
export interface ReportedLine {
  key: string;
  amountVnd: bigint;
}

export interface ReconDifference {
  key: string;
  kind: DifferenceKind;
  side: 'A_ONLY' | 'B_ONLY' | 'BOTH';
  amountAVnd: bigint;
  amountBVnd: bigint;
  differenceVnd: bigint;
}

export interface ReconOutcome {
  countA: number;
  countB: number;
  totalAVnd: bigint;
  totalBVnd: bigint;
  differences: ReconDifference[];
  result: ReconResult;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const POWERS = [1_000n, 1_000_000n, 1_000_000_000n];

/**
 * Compares the Treasury with the report key by key and says what each difference is: a key that only one side has is MISSING (or TIMING when all of it was confirmed after the cut-off of the report, REVERSAL when it is a reversal);
 * on both, TIMING when what was confirmed after the cut-off is the whole difference, REVERSAL when the reversals are, MAPPING when one amount is the other times a thousand, a million or a billion (a unit that was not
 * converted), otherwise AMOUNT. Neither side is chosen and the two totals stay apart. MATCHED when nothing differs; WITHIN_TOLERANCE when every key is on both sides and every difference, and the one of the totals, is
 * within the tolerance; otherwise DIFFERENT (a difference that offsets another is still a difference).
 */
export function reconcileSources(input: { a: readonly TreasuryLine[]; b: readonly ReportedLine[]; toleranceVnd: bigint }): ReconOutcome {
  const byKeyB = new Map(input.b.map((line) => [line.key, line]));
  const byKeyA = new Map(input.a.map((line) => [line.key, line]));
  const differences: ReconDifference[] = [];
  for (const line of input.a) {
    const other = byKeyB.get(line.key);
    if (other === undefined) {
      if (line.amountVnd === 0n) continue;
      const kind: DifferenceKind = line.afterCutoffVnd === line.amountVnd ? 'TIMING' : line.reversalVnd !== 0n && line.reversalVnd === line.amountVnd ? 'REVERSAL' : 'MISSING';
      differences.push({ key: line.key, kind, side: 'A_ONLY', amountAVnd: line.amountVnd, amountBVnd: 0n, differenceVnd: line.amountVnd });
      continue;
    }
    const delta = line.amountVnd - other.amountVnd;
    if (delta === 0n) continue;
    let kind: DifferenceKind = 'AMOUNT';
    if (line.afterCutoffVnd === delta) kind = 'TIMING';
    else if (line.reversalVnd !== 0n && line.reversalVnd === delta) kind = 'REVERSAL';
    else if (line.amountVnd !== 0n && other.amountVnd !== 0n && POWERS.some((power) => line.amountVnd === other.amountVnd * power || other.amountVnd === line.amountVnd * power)) kind = 'MAPPING';
    differences.push({ key: line.key, kind, side: 'BOTH', amountAVnd: line.amountVnd, amountBVnd: other.amountVnd, differenceVnd: delta });
  }
  for (const line of input.b) {
    if (byKeyA.has(line.key) || line.amountVnd === 0n) continue;
    differences.push({ key: line.key, kind: 'MISSING', side: 'B_ONLY', amountAVnd: 0n, amountBVnd: line.amountVnd, differenceVnd: -line.amountVnd });
  }
  differences.sort((x, y) => x.key.localeCompare(y.key));
  const totalAVnd = input.a.reduce((sum, line) => sum + line.amountVnd, 0n);
  const totalBVnd = input.b.reduce((sum, line) => sum + line.amountVnd, 0n);
  const countA = input.a.filter((line) => line.amountVnd !== 0n).length;
  const countB = input.b.filter((line) => line.amountVnd !== 0n).length;
  let result: ReconResult = 'DIFFERENT';
  if (differences.length === 0 && totalAVnd === totalBVnd) result = 'MATCHED';
  else if (differences.every((entry) => entry.side === 'BOTH' && abs(entry.differenceVnd) <= input.toleranceVnd) && abs(totalAVnd - totalBVnd) <= input.toleranceVnd) result = 'WITHIN_TOLERANCE';
  return { countA, countB, totalAVnd, totalBVnd, differences, result };
}

/** How many differences of each kind, for the summary line of the screen. */
export function countByKind(differences: readonly ReconDifference[]): Record<DifferenceKind, number> {
  const counted = { MISSING: 0, TIMING: 0, REVERSAL: 0, MAPPING: 0, AMOUNT: 0 };
  for (const entry of differences) counted[entry.kind] += 1;
  return counted;
}
