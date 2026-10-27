import { drillChildTile, drillDimensions, drillLevelOf, reconcileChildren } from '../src/home-drill.ts';
import type { RateSums } from '../src/dis-rates.ts';

const sums = (overrides: Partial<RateSums> = {}): RateSums => ({ projects: 1, planPmVnd: '1000', planLocalVnd: '250', treasuryVnd: '600', reportedVnd: '610', ctmtqgVnd: null, allNone: false, allComplete: true, ...overrides });
const base = { unitId: null, projectId: null, lineId: null };

describe('the levels of the drill (ST-HOME-002, HOME 3 F2)', () => {
  it('goes from the scope to a unit, a project and a cell of the snapshot, and says what each level can be broken into', () => {
    expect(drillLevelOf(base)).toBe('SCOPE');
    expect(drillLevelOf({ ...base, unitId: 'u' })).toBe('UNIT');
    expect(drillLevelOf({ ...base, unitId: 'u', projectId: 'p' })).toBe('PROJECT');
    expect(drillLevelOf({ unitId: 'u', projectId: 'p', lineId: 'l' })).toBe('CELL');
    expect(drillDimensions('SCOPE')).toEqual(['unit', 'project']);
    expect(drillDimensions('UNIT')).toEqual(['unit', 'project']);
    // The unit alone has no units under it to break into: the way down from it is its projects.
    expect(drillDimensions('UNIT', true)).toEqual(['project']);
    expect(drillDimensions('SCOPE', true)).toEqual(['unit', 'project']);
    expect(drillDimensions('PROJECT')).toEqual(['cell']);
    // A cell is the last step of the snapshot: from there the way goes to the sources (report, Treasury).
    expect(drillDimensions('CELL')).toEqual([]);
  });
});

describe('what a child of the drill gives (BR-HOME-02, BR-HOME-03, BR-HOME-04)', () => {
  it('gives for each metric the figure the tile gives, over the sums of the child, with the numerator and the denominator of a rate', () => {
    expect(drillChildTile('DISBURSEMENT_RATE_PM', sums(), 'SIGNED')).toMatchObject({ value: '60.0000', numerator: '600', denominator: '1000', unit: 'PERCENT', nullReason: null });
    expect(drillChildTile('DISBURSEMENT_RATE_TOTAL', sums(), 'SIGNED')).toMatchObject({ value: '48.0000', numerator: '600', denominator: '1250' });
    expect(drillChildTile('DISBURSED_TREASURY', sums(), 'SIGNED')).toMatchObject({ value: '600', unit: 'VND' });
    expect(drillChildTile('PLAN_PM_ASSIGNED', sums(), 'SIGNED')).toMatchObject({ value: '1000' });
    expect(drillChildTile('PLAN_TOTAL', sums(), 'SIGNED')).toMatchObject({ value: '1250' });
  });

  it('says no data, never 0, for a child the Treasury booked nothing for', () => {
    const none = sums({ treasuryVnd: null, allNone: true, allComplete: false });
    expect(drillChildTile('DISBURSED_TREASURY', none, 'SIGNED')).toMatchObject({ value: null, nullReason: 'NO_DATA' });
    expect(drillChildTile('DISBURSEMENT_RATE_PM', none, 'SIGNED')).toMatchObject({ value: null });
    expect(drillChildTile('PLAN_TOTAL', none, 'SIGNED')).toMatchObject({ value: '1250', nullReason: null });
  });

  it('refuses a metric the center does not give', () => {
    expect(() => drillChildTile('GUESS', sums(), 'SIGNED')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', status: 400 }));
  });
});

describe('the children add up to the parent to the dong, or say why they do not (AC-ST-HOME-002-1)', () => {
  it('reconciles money: the children that have a figure add up to the parent, and a child with none adds nothing', () => {
    expect(reconcileChildren('VND', '1250', ['1000', '250'])).toEqual({ reconcilesToParent: true, nonAdditiveReason: null });
    expect(reconcileChildren('VND', '1250', ['1000', null, '250'])).toEqual({ reconcilesToParent: true, nonAdditiveReason: null });
    expect(reconcileChildren('VND', null, [null, null])).toEqual({ reconcilesToParent: true, nonAdditiveReason: null });
    expect(reconcileChildren('VND', '0', [])).toEqual({ reconcilesToParent: true, nonAdditiveReason: null });
  });

  it('does not say they reconcile when they do not, by a dong', () => {
    expect(reconcileChildren('VND', '1250', ['1000', '249'])).toEqual({ reconcilesToParent: false, nonAdditiveReason: null });
    expect(reconcileChildren('VND', null, ['1'])).toEqual({ reconcilesToParent: false, nonAdditiveReason: null });
    expect(reconcileChildren('VND', '12345678901234567890', ['12345678901234567889', '1'])).toEqual({ reconcilesToParent: true, nonAdditiveReason: null });
  });

  it('never adds a ratio: the parent is made from the sums of its children, the numerator and the denominator say how', () => {
    expect(reconcileChildren('PERCENT', '60.0000', ['50.0000', '70.0000'])).toEqual({ reconcilesToParent: false, nonAdditiveReason: 'RATIO' });
  });
});
