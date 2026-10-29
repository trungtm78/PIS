import { DomainError } from '../src/errors';
import { RECON_BASIS, assertComparable, assertPeriod, convertAmount, countByKind, gateBatch, reconcileSources, unitFactor } from '../src/dgv-recon';
import type { ConfirmedMapping, ReportedLine, TreasuryLine } from '../src/dgv-recon';

const refusal = (run: () => unknown): [string, number, string | undefined] | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof DomainError ? [error.code, error.status, error.detail] : undefined;
  }
  return undefined;
};

describe('units of money', () => {
  it('knows the units a source writes, by code or by the words, and refuses one it does not know', () => {
    expect(unitFactor(undefined)).toBe(1n);
    expect(unitFactor('')).toBe(1n);
    expect(unitFactor('VND')).toBe(1n);
    expect(unitFactor('triệu đồng')).toBe(1_000_000n);
    expect(unitFactor('  TRIỆU   ĐỒNG ')).toBe(1_000_000n);
    expect(unitFactor('MILLION_VND')).toBe(1_000_000n);
    expect(unitFactor('nghìn đồng')).toBe(1_000n);
    expect(unitFactor('tỷ đồng')).toBe(1_000_000_000n);
    expect(unitFactor('đô la')).toBeUndefined();
  });

  it('converts exactly and never rounds', () => {
    expect(convertAmount('98450', 1_000_000n)).toBe('98450000000');
    expect(convertAmount('12.5', 1_000_000n)).toBe('12500000');
    expect(convertAmount('-3', 1_000n)).toBe('-3000');
    expect(convertAmount('0', 1_000_000n)).toBe('0');
    expect(convertAmount('-0.0', 1_000n)).toBe('0');
    expect(convertAmount('7', 1n)).toBe('7');
    expect(refusal(() => convertAmount('0.0000001', 1_000_000n, 'so_tien'))).toEqual(['VALIDATION_FAILED', 422, 'so_tien']);
    expect(refusal(() => convertAmount('1.5', 1n))).toEqual(['VALIDATION_FAILED', 422, 'amount']);
    expect(refusal(() => convertAmount('abc', 1n))).toEqual(['VALIDATION_FAILED', 422, 'amount']);
    expect(refusal(() => convertAmount('1,5', 1n))).toEqual(['VALIDATION_FAILED', 422, 'amount']);
  });
});

describe('the gate of a batch (AC-ST-DGV-004-2, UAT-AC491)', () => {
  const confirmed: ConfirmedMapping[] = [{ id: 'm1', sourceField: 'so_tien', targetField: 'amount_vnd', unit: 'triệu đồng' }];

  it('keeps a batch out while a field has no confirmed mapping, naming the field', () => {
    expect(gateBatch(['so_tien'], [])).toEqual({ outcome: 'QUARANTINED', reason: 'MAPPING_NOT_CONFIRMED', missing: ['so_tien'] });
    expect(gateBatch(['so_tien', 'ma_du_an'], confirmed)).toEqual({ outcome: 'QUARANTINED', reason: 'MAPPING_NOT_CONFIRMED', missing: ['ma_du_an'] });
    // A mapping with a unit nobody knows is not a mapping the pipeline can use.
    expect(gateBatch(['so_tien'], [{ ...confirmed[0], unit: 'đô la' } as ConfirmedMapping]).outcome).toBe('QUARANTINED');
  });

  it('applies a source field into every field of the dataset it has a confirmed mapping to, and keeps the batch out if a field has none', () => {
    const two: ConfirmedMapping[] = [...confirmed, { id: 'm2', sourceField: 'so_tien', targetField: 'amount_original', unit: null }];
    expect(gateBatch(['so_tien'], two)).toEqual({ outcome: 'APPLIED', fields: [{ sourceField: 'so_tien', targetField: 'amount_vnd', mappingId: 'm1', factor: 1_000_000n }, { sourceField: 'so_tien', targetField: 'amount_original', mappingId: 'm2', factor: 1n }] });
    expect(gateBatch(['so_tien', 'ma_du_an'], two).outcome).toBe('QUARANTINED');
  });

  it('applies a batch with the factor of the unit of each confirmed mapping', () => {
    expect(gateBatch(['so_tien', 'so_tien'], confirmed)).toEqual({ outcome: 'APPLIED', fields: [{ sourceField: 'so_tien', targetField: 'amount_vnd', mappingId: 'm1', factor: 1_000_000n }] });
    expect(gateBatch([], confirmed)).toEqual({ outcome: 'APPLIED', fields: [] });
  });
});

describe('what the sources must have in common (BR-DGV-09)', () => {
  const ok = { sourceA: 'PAY.treasury_transaction', sourceB: 'DIS.report_accepted', basis: RECON_BASIS };

  it('compares the Treasury of PAY with the accepted report of DIS, on the same basis', () => {
    expect(refusal(() => assertComparable(ok))).toBeUndefined();
    expect(refusal(() => assertComparable({ sourceA: 'pay', sourceB: 'DIS', basis: 'VND, NGÀY KHO BẠC THANH TOÁN' }))).toBeUndefined();
    expect(refusal(() => assertComparable({ ...ok, sourceA: 'DIS.report_accepted' }))).toEqual(['BASIS_MISMATCH', 422, 'source_a']);
    expect(refusal(() => assertComparable({ ...ok, sourceB: 'PAY.treasury_transaction' }))).toEqual(['BASIS_MISMATCH', 422, 'source_b']);
    expect(refusal(() => assertComparable({ ...ok, basis: 'VND, ngày báo cáo' }))).toEqual(['BASIS_MISMATCH', 422, 'basis']);
  });

  it('reads a period as a year and a month', () => {
    expect(assertPeriod('2026-10')).toBe('2026-10');
    for (const bad of ['2026-13', '2026-1', '26-10', '2026/10', '']) expect([bad, refusal(() => assertPeriod(bad))]).toEqual([bad, ['VALIDATION_FAILED', 422, 'as_of_period']]);
  });
});

describe('reconcileSources', () => {
  const line = (key: string, amount: number, extra: { reversalVnd?: number; afterCutoffVnd?: number } = {}): TreasuryLine => ({ key, amountVnd: BigInt(amount), reversalVnd: BigInt(extra.reversalVnd ?? 0), afterCutoffVnd: BigInt(extra.afterCutoffVnd ?? 0) });
  const reported = (key: string, amount: number): ReportedLine => ({ key, amountVnd: BigInt(amount) });

  it('AC-ST-DGV-004-1: UAT-AC488 classifies each difference, chooses neither side and keeps the two totals apart', () => {
    // Three keys only the Treasury has: two the report does not have, one confirmed after its cut-off; the rest agree.
    const a = [line('P1', 100), line('P2', 200), line('P3', 300), line('M1', 150_000_000), line('M2', 60_000_000), line('T1', 40_000_000, { afterCutoffVnd: 40_000_000 })];
    const b = [reported('P1', 100), reported('P2', 200), reported('P3', 300)];
    const outcome = reconcileSources({ a, b, toleranceVnd: 0n });
    expect(outcome).toMatchObject({ result: 'DIFFERENT', countA: 6, countB: 3, totalAVnd: 250_000_600n, totalBVnd: 600n });
    expect(outcome.totalAVnd - outcome.totalBVnd).toBe(250_000_000n);
    expect(outcome.differences.map((entry) => [entry.key, entry.kind, entry.side])).toEqual([
      ['M1', 'MISSING', 'A_ONLY'],
      ['M2', 'MISSING', 'A_ONLY'],
      ['T1', 'TIMING', 'A_ONLY'],
    ]);
    expect(countByKind(outcome.differences)).toEqual({ MISSING: 2, TIMING: 1, REVERSAL: 0, MAPPING: 0, AMOUNT: 0 });
  });

  it('classifies a key on both sides by what explains the difference', () => {
    const a = [line('T', 1_000, { afterCutoffVnd: 300 }), line('R', 900, { reversalVnd: -100 }), line('U', 5_000_000), line('V', 7_000), line('W', 1_234)];
    const b = [reported('T', 700), reported('R', 1_000), reported('U', 5), reported('V', 7_000_000), reported('W', 1_000)];
    const kinds = Object.fromEntries(reconcileSources({ a, b, toleranceVnd: 0n }).differences.map((entry) => [entry.key, entry.kind]));
    expect(kinds).toEqual({ T: 'TIMING', R: 'REVERSAL', U: 'MAPPING', V: 'MAPPING', W: 'AMOUNT' });
  });

  it('classifies a key only the report has as missing from the Treasury, and a reversal that only the Treasury has as a reversal', () => {
    const outcome = reconcileSources({ a: [line('X', -50, { reversalVnd: -50 })], b: [reported('Y', 80)], toleranceVnd: 0n });
    expect(outcome.differences.map((entry) => [entry.key, entry.kind, entry.side, entry.differenceVnd])).toEqual([
      ['X', 'REVERSAL', 'A_ONLY', -50n],
      ['Y', 'MISSING', 'B_ONLY', -80n],
    ]);
  });

  it('is MATCHED when nothing differs and WITHIN_TOLERANCE when every key is on both sides and within the tolerance', () => {
    expect(reconcileSources({ a: [line('P', 10)], b: [reported('P', 10)], toleranceVnd: 0n })).toMatchObject({ result: 'MATCHED', differences: [] });
    expect(reconcileSources({ a: [], b: [], toleranceVnd: 0n }).result).toBe('MATCHED');
    expect(reconcileSources({ a: [line('P', 10), line('Q', 20)], b: [reported('P', 9), reported('Q', 21)], toleranceVnd: 1n }).result).toBe('WITHIN_TOLERANCE');
    // The totals are equal but the keys are not: offsetting differences are still differences.
    expect(reconcileSources({ a: [line('P', 10), line('Q', 20)], b: [reported('P', 9), reported('Q', 21)], toleranceVnd: 0n }).result).toBe('DIFFERENT');
    // Within tolerance for a key, but a key is missing on one side.
    expect(reconcileSources({ a: [line('P', 10), line('Q', 1)], b: [reported('P', 10)], toleranceVnd: 5n }).result).toBe('DIFFERENT');
    // One key beyond the tolerance.
    expect(reconcileSources({ a: [line('P', 10)], b: [reported('P', 7)], toleranceVnd: 2n }).result).toBe('DIFFERENT');
  });

  it('reads a refund as the reason only when it has the sign and the size of the difference', () => {
    // The report ignores a refund of 100: the Treasury is lower by 100. A Treasury that is higher by 100 is not that.
    expect(reconcileSources({ a: [line('R', 900, { reversalVnd: -100 })], b: [reported('R', 1_000)], toleranceVnd: 0n }).differences[0]?.kind).toBe('REVERSAL');
    expect(reconcileSources({ a: [line('R', 900, { reversalVnd: -100 })], b: [reported('R', 800)], toleranceVnd: 0n }).differences[0]?.kind).toBe('AMOUNT');
  });

  it('is within the tolerance when a project is on both sides with nothing on one of them, if the differences are small', () => {
    expect(reconcileSources({ a: [line('P', 0)], b: [reported('P', 1)], toleranceVnd: 1n }).result).toBe('WITHIN_TOLERANCE');
    expect(reconcileSources({ a: [line('P', 0)], b: [reported('P', 2)], toleranceVnd: 1n }).result).toBe('DIFFERENT');
    // A project only one side has at all is still a difference.
    expect(reconcileSources({ a: [], b: [reported('P', 1)], toleranceVnd: 5n }).result).toBe('DIFFERENT');
  });

  it('does not count a key whose amount is nil', () => {
    const outcome = reconcileSources({ a: [line('P', 0), line('Q', 5)], b: [reported('Q', 5), reported('Z', 0)], toleranceVnd: 0n });
    expect(outcome).toMatchObject({ result: 'MATCHED', countA: 1, countB: 1 });
  });
});
