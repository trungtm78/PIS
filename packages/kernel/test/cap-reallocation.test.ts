import { belowFloor, decidedReallocation, netReductions, positiveVnd, reductionsOf } from '../src/cap-reallocation.ts';

const hold = (allocated: string, extra: Partial<Record<'reservedVnd' | 'committedVnd' | 'disbursedVnd', string>> = {}) => ({ allocatedVnd: allocated, reservedVnd: '0', committedVnd: '0', disbursedVnd: '0', ...extra });

describe('the reallocation of capital (ST-CAP-010, BR-CAP-07)', () => {
  it('takes only a whole positive number of dong', () => {
    expect(positiveVnd('2000000000', 'amount_vnd')).toBe('2000000000');
    for (const bad of ['0', '-5', '1.5', '01', '', 'x', 12, null, '1'.repeat(26)]) expect(() => positiveVnd(bad, 'amount_vnd')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
  });

  it('decides a proposal that waits: approve, reject, or return it to its author; nothing else can be decided', () => {
    expect(['approve', 'reject', 'return'].map((decision) => decidedReallocation('SUBMITTED', decision as 'approve'))).toEqual(['APPROVED', 'REJECTED', 'DRAFT']);
    for (const status of ['DRAFT', 'APPROVED', 'APPLIED', 'REJECTED', 'WITHDRAWN'] as const) {
      expect(() => decidedReallocation(status, 'approve')).toThrow(expect.objectContaining({ code: 'STAGE_TRANSITION_DENIED', status: 409 }));
    }
  });

  it('adds up the reductions of a line named more than once', () => {
    expect([...reductionsOf([{ fromLineId: 'a', amountVnd: '5' }, { fromLineId: 'b', amountVnd: '7' }, { fromLineId: 'a', amountVnd: '6' }])]).toEqual([['a', '11'], ['b', '7']]);
  });

  it('judges a line that gives and receives in one proposal by the difference, and leaves a line that only receives out', () => {
    const lines = [
      { fromLineId: 'a', toLineId: 'b', amountVnd: '20' },
      { fromLineId: 'b', toLineId: 'a', amountVnd: '20' },
      { fromLineId: 'c', toLineId: 'b', amountVnd: '7' },
      { fromLineId: 'b', toLineId: 'd', amountVnd: '4' },
    ];
    expect([...netReductions(lines)]).toEqual([['c', '7']]);
    expect([...netReductions([{ fromLineId: 'a', toLineId: 'b', amountVnd: '5' }, { fromLineId: 'a', toLineId: 'c', amountVnd: '6' }])]).toEqual([['a', '11']]);
  });

  it('keeps on a donor line at least what is reserved, committed and disbursed, and never more than it holds', () => {
    const holds = new Map([
      ['a', hold('100', { reservedVnd: '10', committedVnd: '20', disbursedVnd: '30' })],
      ['b', hold('100')],
      ['c', hold('50')],
    ]);
    expect(belowFloor(new Map([['a', '40'], ['b', '100']]), holds)).toEqual([]);
    expect(belowFloor(new Map([['a', '41'], ['c', '51']]), holds)).toEqual([
      { lineId: 'a', allocatedVnd: '100', reducedVnd: '41', floorVnd: '60' },
      { lineId: 'c', allocatedVnd: '50', reducedVnd: '51', floorVnd: '0' },
    ]);
  });
});
