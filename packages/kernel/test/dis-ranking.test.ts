import { DEFAULT_MINIMUM_PLAN_VND, rankUnits } from '../src/dis-ranking.ts';

const unit = (code: string, planVnd: string, disbursedVnd: string | null) => ({ code, planVnd, disbursedVnd });

describe('the ranking of the units (ST-DIS-011 fixture FX-DIS-007, BR-DIS-10, proposals until D03 is signed)', () => {
  it('ranks by rate from the highest, from fractions of whole dong and not from rounded percents', () => {
    // 1/3 of 3 billion and 33.33333% of 3 billion differ by less than the four decimals that are shown.
    const ranking = rankUnits([unit('A', '3000000000', '1000000000'), unit('B', '3000000000', '1000000001'), unit('C', '2000000000', '1500000000')]);
    expect(ranking.ranked.map((item) => item.code)).toEqual(['C', 'B', 'A']);
    expect(ranking.ranked.map((item) => item.rank)).toEqual([1, 2, 3]);
    expect(ranking.ranked[0]?.ratePct).toBe('75.0000');
  });

  it('breaks a tie by the larger disbursement, then by the code of the unit, whatever the order the units are given in', () => {
    const units = [unit('U-Z', '1000000000', '500000000'), unit('U-A', '2000000000', '1000000000'), unit('U-B', '2000000000', '1000000000'), unit('U-C', '3000000000', '1500000000')];
    const forward = rankUnits(units).ranked.map((item) => item.code);
    expect(forward).toEqual(['U-C', 'U-A', 'U-B', 'U-Z']);
    expect(rankUnits([...units].reverse()).ranked.map((item) => item.code)).toEqual(forward);
  });

  it('leaves out a unit with no plan (ZERO_DENOMINATOR) and one below the minimum (PLAN_BELOW_MINIMUM), with the reason, in the order of the code, and ranks the rest without a gap', () => {
    const ranking = rankUnits([unit('U-9', '999999999', '900000000'), unit('U-2', '0', '5'), unit('U-1', '1000000000', '100000000'), unit('U-0', '1000000000', '300000000')]);
    expect(ranking.excluded).toEqual([
      { code: 'U-2', reason: 'ZERO_DENOMINATOR' },
      { code: 'U-9', reason: 'PLAN_BELOW_MINIMUM' },
    ]);
    expect(ranking.ranked.map((item) => [item.rank, item.code])).toEqual([
      [1, 'U-0'],
      [2, 'U-1'],
    ]);
  });

  it('leaves out a unit that has no figure, or a net below zero, as NO_DATA: a rate is not a guess, and it is not negative', () => {
    const ranking = rankUnits([unit('A', '2000000000', null), unit('B', '2000000000', '-5'), unit('C', '2000000000', '0'), unit('D', '2000000000', '10')]);
    expect(ranking.excluded).toEqual([
      { code: 'A', reason: 'NO_DATA' },
      { code: 'B', reason: 'NO_DATA' },
    ]);
    expect(ranking.ranked.map((item) => [item.rank, item.code, item.ratePct])).toEqual([
      [1, 'D', '0.0000'],
      [2, 'C', '0.0000'],
    ]);
  });

  it('takes the minimum of the call, and the default minimum is 1 billion dong; nothing to rank is an empty ranking', () => {
    expect(DEFAULT_MINIMUM_PLAN_VND).toBe('1000000000');
    expect(rankUnits([unit('S', '500', '250')], '500').ranked.map((item) => item.code)).toEqual(['S']);
    expect(rankUnits([unit('S', '499', '250')], '500').excluded).toEqual([{ code: 'S', reason: 'PLAN_BELOW_MINIMUM' }]);
    expect(rankUnits([])).toEqual({ ranked: [], excluded: [] });
  });
});
