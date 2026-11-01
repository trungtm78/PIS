import { BI_DIMENSION_WEIGHTS, BI_SYNC_COST_LIMIT, BI_TOTAL_WEIGHT, estimateQueryCost, isHeavyQuery } from '../src/bi-query-cost.ts';

describe('what a query of BI costs before it is run (ST-BI-009)', () => {
  it('is the lines of the snapshot times the weight of the dimension, and the total alone is read once', () => {
    expect(estimateQueryCost({ snapshotRows: 5000, dimension: 'project' })).toBe(5000 * (BI_DIMENSION_WEIGHTS.project as number));
    expect(estimateQueryCost({ snapshotRows: 5000, dimension: 'unit' })).toBe(5000 * (BI_DIMENSION_WEIGHTS.unit as number));
    expect(estimateQueryCost({ snapshotRows: 5000, dimension: undefined })).toBe(5000 * BI_TOTAL_WEIGHT);
  });

  it('weighs a dimension that makes many groups more than one that makes few', () => {
    expect(BI_DIMENSION_WEIGHTS.project as number).toBeGreaterThan(BI_DIMENSION_WEIGHTS.unit as number);
    expect(BI_DIMENSION_WEIGHTS.unit as number).toBeGreaterThan(BI_DIMENSION_WEIGHTS.bucket as number);
  });

  it('takes a dimension the table does not know for the heaviest one, never for the lightest', () => {
    expect(estimateQueryCost({ snapshotRows: 10, dimension: 'something_new' })).toBe(10 * Math.max(...Object.values(BI_DIMENSION_WEIGHTS)));
  });

  it('is nothing for a snapshot with no lines, and for a count that is not a count', () => {
    expect(estimateQueryCost({ snapshotRows: 0, dimension: 'project' })).toBe(0);
    expect(estimateQueryCost({ snapshotRows: -5, dimension: 'project' })).toBe(0);
    expect(estimateQueryCost({ snapshotRows: Number.NaN, dimension: 'project' })).toBe(0);
    expect(estimateQueryCost({ snapshotRows: Number.POSITIVE_INFINITY, dimension: 'project' })).toBe(0);
    expect(estimateQueryCost({ snapshotRows: 7.9, dimension: undefined })).toBe(7);
  });

  it('is heavy only when it is over the limit, and the limit is the one given or the one of the kernel', () => {
    expect(isHeavyQuery(BI_SYNC_COST_LIMIT)).toBe(false);
    expect(isHeavyQuery(BI_SYNC_COST_LIMIT + 1)).toBe(true);
    expect(isHeavyQuery(50, 50)).toBe(false);
    expect(isHeavyQuery(51, 50)).toBe(true);
  });
});
