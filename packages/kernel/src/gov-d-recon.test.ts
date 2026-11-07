import { RECON_LINE_KINDS, TREASURY_RECON_FALLBACK, UNMATCHED_FUND, classifyLine, crossTotal, differenceOf, dueOn, isWeekday, keyGaps, opensItem, parseReconPolicy, runStatusOf, sumKeys } from './gov-d-recon.ts';
import type { DimensionTotal, ReconLine } from './gov-d-recon.ts';
import { builtInDefault } from './governance-rules.ts';

const line = (extra: Partial<ReconLine> = {}): ReconLine => ({ projectId: 'p1', projectCode: 'DA-1', fundKey: 'NSNN', fundLabel: 'NSNN', booksVnd: '10000000', treasuryVnd: '10000000', booksCount: 1, treasuryCount: 1, ...extra });
const dimension = (total: string): DimensionTotal => ({ totalVnd: total, keys: [], source: 'test' });

describe('the policy of the daily reconciliation', () => {
  it('reads the same numbers as the registry default, so the fallback and the registry never drift apart', () => {
    const registry = parseReconPolicy(builtInDefault('RECONCILIATION_POLICY', 'DEFAULT')?.params ?? {});
    expect(registry).toEqual(TREASURY_RECON_FALLBACK);
  });

  it('names the field it refuses', () => {
    expect(() => parseReconPolicy({ threshold_vnd: -1, due_days: 3, partial_after_days: 1 })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'threshold_vnd' }));
    expect(() => parseReconPolicy({ threshold_vnd: 1, due_days: 0, partial_after_days: 1 })).toThrow(expect.objectContaining({ detail: 'due_days' }));
    expect(() => parseReconPolicy({ threshold_vnd: 1, due_days: 1, partial_after_days: 1, threshold_pct: 101 })).toThrow(expect.objectContaining({ detail: 'threshold_pct' }));
    expect(parseReconPolicy({ threshold_vnd: 5, due_days: 2, partial_after_days: 0, threshold_pct: 0.5 })).toEqual({ thresholdVnd: 5, thresholdPct: 0.5, dueDays: 2, partialAfterDays: 0 });
  });
});

describe('classifyLine', () => {
  it('says nothing for lines that agree to the dong', () => {
    expect(classifyLine(line())).toBeNull();
    expect(differenceOf(line({ treasuryVnd: '10000001' }))).toBe(1n);
  });
  it('names the five kinds', () => {
    expect(classifyLine(line({ treasuryVnd: '9000000' }))).toBe('AMOUNT');
    expect(classifyLine(line({ treasuryVnd: '0', treasuryCount: 0 }))).toBe('MISSING_ON_TREASURY');
    expect(classifyLine(line({ booksVnd: '0', booksCount: 0 }))).toBe('MISSING_INTERNAL');
    expect(classifyLine(line({ fundKey: UNMATCHED_FUND, booksVnd: '0', booksCount: 0 }))).toBe('UNMATCHED');
    expect(classifyLine(line({ treasuryVnd: '12000000' }), [{ booksVnd: '2000000', treasuryVnd: '0' }])).toBe('TIMING');
    expect(RECON_LINE_KINDS).toHaveLength(5);
  });
  it('a refund that takes off is a signed figure, not an absolute one', () => {
    expect(classifyLine(line({ booksVnd: '-5000000', treasuryVnd: '-4000000' }))).toBe('AMOUNT');
    expect(differenceOf(line({ booksVnd: '-5000000', treasuryVnd: '-4000000' }))).toBe(1000000n);
  });
});

describe('opensItem: strictly above the threshold', () => {
  const policy = TREASURY_RECON_FALLBACK;
  it('the threshold itself opens nothing, one dong above does', () => {
    const exactly = line({ treasuryVnd: '11000000' });
    expect(opensItem(exactly, classifyLine(exactly), policy)).toBe(false);
    const above = line({ treasuryVnd: '11000001' });
    expect(opensItem(above, classifyLine(above), policy)).toBe(true);
    const below = line({ treasuryVnd: '9000001' });
    expect(opensItem(below, classifyLine(below), policy)).toBe(false);
    const under = line({ treasuryVnd: '8999999' });
    expect(opensItem(under, classifyLine(under), policy)).toBe(true);
  });
  it('a timing pair and an equal line open nothing whatever the amount', () => {
    const big = line({ treasuryVnd: '900000000' });
    expect(opensItem(big, 'TIMING', policy)).toBe(false);
    expect(opensItem(line(), null, policy)).toBe(false);
  });
  it('the percentage is a second way to open, strictly above too', () => {
    const pct = { ...policy, thresholdVnd: 1_000_000_000, thresholdPct: 1 };
    const exactly = line({ booksVnd: '100000000', treasuryVnd: '99000000' });
    expect(opensItem(exactly, classifyLine(exactly), pct)).toBe(false);
    const above = line({ booksVnd: '100000000', treasuryVnd: '98999999' });
    expect(opensItem(above, classifyLine(above), pct)).toBe(true);
  });
});

describe('dueOn counts working days', () => {
  it('skips the weekend and a holiday', () => {
    // 2026-11-06 is a Friday; 3 working days: Mon 9, Tue 10, Wed 11.
    expect(dueOn('2026-11-06', 3, isWeekday)).toBe('2026-11-11');
    const holiday = (day: string): boolean => isWeekday(day) && day !== '2026-11-09';
    expect(dueOn('2026-11-06', 3, holiday)).toBe('2026-11-12');
  });
  it('refuses a calendar with no working day instead of looping', () => {
    expect(() => dueOn('2026-11-06', 1, () => false)).toThrow(expect.objectContaining({ code: 'CALENDAR_NOT_EFFECTIVE' }));
  });
});

describe('runStatusOf: a missing statement is partial, never no difference', () => {
  it('is partial on a working day with no statement and no transaction', () => {
    expect(runStatusOf({ statementPresent: false, workingDay: true, transactions: 0, sourceReadable: true })).toEqual({ status: 'PARTIAL', reason: 'STATEMENT_MISSING' });
  });
  it('is complete with a statement, with transactions, or on a day nobody works', () => {
    expect(runStatusOf({ statementPresent: true, workingDay: true, transactions: 0, sourceReadable: true }).status).toBe('COMPLETE');
    expect(runStatusOf({ statementPresent: false, workingDay: true, transactions: 2, sourceReadable: true }).status).toBe('COMPLETE');
    expect(runStatusOf({ statementPresent: false, workingDay: false, transactions: 0, sourceReadable: true }).status).toBe('COMPLETE');
  });
  it('an unreadable source is partial whatever else is true', () => {
    expect(runStatusOf({ statementPresent: true, workingDay: true, transactions: 5, sourceReadable: false })).toEqual({ status: 'PARTIAL', reason: 'SOURCE_UNREADABLE' });
  });
});

describe('crossTotal names the dimension that disagrees', () => {
  it('publishes when the three totals are equal to the dong', () => {
    const result = crossTotal({ UNIT: dimension('100'), FUND: dimension('100'), PROJECT: dimension('100') });
    expect(result).toMatchObject({ published: true, disagreeing: [] });
  });
  it('names the one that stands alone, with its offset from the two that agree', () => {
    const result = crossTotal({ UNIT: dimension('100'), FUND: dimension('90'), PROJECT: dimension('100') });
    expect(result).toMatchObject({ published: false, disagreeing: ['FUND'], agreeing: ['UNIT', 'PROJECT'], offsetVnd: { FUND: '-10' } });
    expect(crossTotal({ UNIT: dimension('101'), FUND: dimension('100'), PROJECT: dimension('100') }).disagreeing).toEqual(['UNIT']);
    expect(crossTotal({ UNIT: dimension('100'), FUND: dimension('100'), PROJECT: dimension('99') }).disagreeing).toEqual(['PROJECT']);
  });
  it('names all three when no two agree, and one dong is a disagreement', () => {
    const result = crossTotal({ UNIT: dimension('100'), FUND: dimension('101'), PROJECT: dimension('102') });
    expect(result).toMatchObject({ published: false, disagreeing: ['UNIT', 'FUND', 'PROJECT'], agreeing: [] });
  });
  it('lists the keys that differ between two dimensions, largest first and at most the limit', () => {
    const gaps = keyGaps(
      [
        { key: 'a', label: 'A', vnd: '10' },
        { key: 'b', label: 'B', vnd: '5' },
        { key: 'c', label: 'C', vnd: '7' },
      ],
      [
        { key: 'a', label: 'A', vnd: '10' },
        { key: 'b', label: 'B', vnd: '50' },
        { key: 'd', label: 'D', vnd: '1' },
      ],
      2,
    );
    expect(gaps.map((gap) => [gap.key, gap.gapVnd])).toEqual([
      ['b', '-45'],
      ['c', '7'],
    ]);
    expect(
      sumKeys([
        { key: 'a', label: null, vnd: '3' },
        { key: 'b', label: null, vnd: '-1' },
      ]),
    ).toBe('2');
  });
});
