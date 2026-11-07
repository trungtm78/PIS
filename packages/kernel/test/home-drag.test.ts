import { dragPoints, orderByDrag } from '../src/home-drag';

// The whole: 50 of 100 (50 %).
const whole = { numerator: '50', denominator: '100' };

describe('the pull of a part on the ratio of the whole (G3-3)', () => {
  it('is the points of percent a part adds to or takes from the whole: below the whole drags it down, above lifts it', () => {
    // 10 / 40 = 25 %, 25 points under the whole, a share of 40 % of the denominator: -10 points
    expect(dragPoints({ id: 'a', numerator: '10', denominator: '40' }, whole)).toBe('-10.0000');
    // 40 / 60 = 66.7 %: +10 points
    expect(dragPoints({ id: 'b', numerator: '40', denominator: '60' }, whole)).toBe('10.0000');
  });

  it('adds up to zero over parts that add up to the whole, which is what makes the order checkable', () => {
    const parts = [
      { id: 'a', numerator: '10', denominator: '25' },
      { id: 'b', numerator: '15', denominator: '25' },
      { id: 'c', numerator: '25', denominator: '50' },
    ];
    const total = parts.reduce((sum, part) => sum + BigInt((dragPoints(part, whole) as string).replace('.', '')), 0n);
    expect(total).toBe(0n);
  });

  it('is zero for a part exactly at the ratio of the whole, and for a part with nothing in it', () => {
    expect(dragPoints({ id: 'a', numerator: '5', denominator: '10' }, whole)).toBe('0.0000');
    expect(dragPoints({ id: 'a', numerator: '0', denominator: '0' }, whole)).toBe('0.0000');
  });

  it('keeps four decimals and cuts toward zero, with the sign only when something is left', () => {
    expect(dragPoints({ id: 'a', numerator: '1', denominator: '7' }, { numerator: '0', denominator: '3' })).toBe('33.3333');
    expect(dragPoints({ id: 'a', numerator: '0', denominator: '7' }, { numerator: '3', denominator: '3' })).toBe('-233.3333');
    expect(dragPoints({ id: 'a', numerator: '1', denominator: '1000' }, { numerator: '1', denominator: '1000' })).toBe('0.0000');
    // a pull smaller than a ten-thousandth of a point is zero, not "-0.0000"
    expect(dragPoints({ id: 'a', numerator: '0', denominator: '1' }, { numerator: '1', denominator: '1000000000' })).toBe('0.0000');
    expect(dragPoints({ id: 'a', numerator: '1', denominator: '1000' }, { numerator: '3', denominator: '1000' })).toBe('-0.2000');
  });

  it('writes a pull below one point with the leading zero', () => {
    // (1 x 1000 - 3 x 1) / 1000^2 x 100 = 0.0997
    expect(dragPoints({ id: 'a', numerator: '1', denominator: '3' }, { numerator: '1', denominator: '1000' })).toBe('0.0997');
  });

  it('is exact on whole dong beyond what a double holds', () => {
    const big = { numerator: '9007199254740993', denominator: '18014398509481986' };
    expect(dragPoints({ id: 'a', numerator: '9007199254740993', denominator: '18014398509481986' }, big)).toBe('0.0000');
    expect(dragPoints({ id: 'a', numerator: '0', denominator: '9007199254740993' }, { numerator: '9007199254740993', denominator: '9007199254740993' })).toBe('-100.0000');
  });

  it('cannot be told, and is null, for a missing figure or a whole of nothing or less', () => {
    expect(dragPoints({ id: 'a', numerator: null, denominator: '10' }, whole)).toBeNull();
    expect(dragPoints({ id: 'a', numerator: '5', denominator: null }, whole)).toBeNull();
    expect(dragPoints({ id: 'a', numerator: '5', denominator: '10' }, { numerator: null, denominator: '100' })).toBeNull();
    expect(dragPoints({ id: 'a', numerator: '5', denominator: '10' }, { numerator: '5', denominator: null })).toBeNull();
    expect(dragPoints({ id: 'a', numerator: '5', denominator: '10' }, { numerator: '0', denominator: '0' })).toBeNull();
    expect(dragPoints({ id: 'a', numerator: '5', denominator: '10' }, { numerator: '5', denominator: '-4' })).toBeNull();
  });
});

describe('the order of who drags most', () => {
  const part = (id: string, numerator: string | null, denominator: string | null) => ({ id, numerator, denominator });

  it('puts the part that drags the ratio down most first and the one that lifts it most last', () => {
    const ordered = orderByDrag([part('lift', '40', '60'), part('flat', '5', '10'), part('drag', '10', '40')], whole);
    expect(ordered.map((entry) => [entry.id, entry.dragPoints])).toEqual([
      ['drag', '-10.0000'],
      ['flat', '0.0000'],
      ['lift', '10.0000'],
    ]);
  });

  it('puts the parts whose pull cannot be told last, in the order they came, never first and never as zero', () => {
    const ordered = orderByDrag([part('n1', null, null), part('lift', '40', '60'), part('n2', '1', null), part('drag', '10', '40')], whole);
    expect(ordered.map((entry) => entry.id)).toEqual(['drag', 'lift', 'n1', 'n2']);
    expect(ordered.slice(2).map((entry) => entry.dragPoints)).toEqual([null, null]);
  });

  it('keeps the order they came in for parts that pull the same, and compares by value, not as text', () => {
    const ordered = orderByDrag([part('x', '5', '10'), part('y', '10', '20'), part('big', '0', '1000'), part('small', '1', '25')], whole);
    // -500 comes before -11.5 although "-11.5" sorts before "-500" as text; x and y pull the same (nothing) and stay as they came
    expect(ordered.map((entry) => [entry.id, entry.dragPoints])).toEqual([
      ['big', '-500.0000'],
      ['small', '-11.5000'],
      ['x', '0.0000'],
      ['y', '0.0000'],
    ]);
  });

  it('carries the other members of a part along and leaves its input alone', () => {
    const input = [{ id: 'a', numerator: '10', denominator: '40', name: 'Sở A' }, { id: 'b', numerator: '40', denominator: '60', name: 'Sở B' }];
    const ordered = orderByDrag(input, whole);
    expect(ordered[0]).toEqual({ id: 'a', numerator: '10', denominator: '40', name: 'Sở A', dragPoints: '-10.0000' });
    expect(input.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(input[0]).not.toHaveProperty('dragPoints');
  });

  it('is empty for no parts', () => {
    expect(orderByDrag([], whole)).toEqual([]);
  });
});
