import { describe, expect, it } from 'vitest';
import { toUnitNode, unitChoices } from './unit-tree';

const node = (id: string, code: string, parentId: string | null = null) => ({ id, code, name: `Đơn vị ${code}`, parentId });

describe('unit tree: reading the list of units', () => {
  it('takes the id, code, name and parent of a row and drops what is not a unit', () => {
    expect(toUnitNode({ id: 'u1', code: 'SO', name: 'Sở', parent_id: 'u0' }, '2026-11-16')).toEqual([{ id: 'u1', code: 'SO', name: 'Sở', parentId: 'u0' }]);
    expect(toUnitNode({ code: 'x' }, '2026-11-16')).toEqual([]);
    expect(toUnitNode('x', '2026-11-16')).toEqual([]);
    expect(toUnitNode({ id: 'u2' }, '2026-11-16')).toEqual([{ id: 'u2', code: '', name: '', parentId: null }]);
  });

  it('leaves out a unit whose period of effect has ended, and keeps one that ends today or later or has no end', () => {
    expect(toUnitNode({ id: 'u1', valid_until: '2026-11-15' }, '2026-11-16')).toEqual([]);
    expect(toUnitNode({ id: 'u1', valid_until: '2026-11-16T00:00:00Z' }, '2026-11-16')).toHaveLength(1);
    expect(toUnitNode({ id: 'u1', valid_until: null }, '2026-11-16')).toHaveLength(1);
  });
});

describe('unit tree: the order to choose from', () => {
  it('puts a parent before its children, children by code, with the depth of each', () => {
    const list = unitChoices([node('c2', 'B2', 'p'), node('p', 'A'), node('c1', 'B1', 'p'), node('g', 'C1', 'c1'), node('r2', 'Z')]);
    expect(list.map((one) => [one.code, one.depth])).toEqual([
      ['A', 0],
      ['B1', 1],
      ['C1', 2],
      ['B2', 1],
      ['Z', 0],
    ]);
  });

  it('makes a unit whose parent the caller does not read a root, and survives a loop', () => {
    expect(unitChoices([node('a', 'A', 'hidden')]).map((one) => one.depth)).toEqual([0]);
    expect(unitChoices([node('a', 'A', 'a')]).map((one) => one.depth)).toEqual([0]);
    // Two units that name each other as parent are never reached from a root: they are not offered (and nothing loops).
    expect(unitChoices([node('a', 'A', 'b'), node('b', 'B', 'a')])).toEqual([]);
  });
});
