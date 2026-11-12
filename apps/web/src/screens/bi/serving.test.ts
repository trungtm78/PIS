import { datasetAdapters } from '@machvon/kernel/src/bi-query.ts';
import { describe, expect, it } from 'vitest';
import { toMetric } from './bi-model';
import { toDataset } from './dataset-model';
import { DATASET_FIELDS, fieldsOfNode, servingDataset, tileDimensionOf } from './serving';
import { rawMetric, sum } from './test-support';

const dataset = (id: string, code: string) => toDataset({ id, dataset_code: code, title: code, source_kind: 'X', grain: 'g', join_paths: {}, refresh_policy: 'P', status: 'ACTIVE', latest_version: null }) as NonNullable<ReturnType<typeof toDataset>>;
const DISB = dataset('d1', 'DS-DISB');
const CTR = dataset('d2', 'DS-CTR');
const metric = (overrides: Record<string, unknown>) => toMetric(rawMetric({ numerator_ast: null, denominator_ast: null, ...overrides })) as NonNullable<ReturnType<typeof toMetric>>;

describe('which dataset serves a metric (BI-02)', () => {
  it('keeps the field names of the browser in step with the adapters of the query engine', () => {
    for (const adapter of datasetAdapters()) expect([...(DATASET_FIELDS[adapter.code] ?? [])].sort()).toEqual(Object.keys(adapter.fields).sort());
    expect(Object.keys(DATASET_FIELDS).sort()).toEqual(datasetAdapters().map((adapter) => adapter.code).sort());
  });

  it('reads the fields of an expression tree', () => {
    expect(fieldsOfNode({ op: 'div', args: [sum('A'), { op: 'sum', args: [{ op: 'field', name: 'B' }] }] })).toEqual(['A', 'B']);
    expect(fieldsOfNode(null)).toEqual([]);
  });

  it('picks the dataset that has every field the metric reads, and none when no dataset does', () => {
    expect(servingDataset(metric({ expression_ast: sum('GIAI_NGAN') }), [CTR, DISB])?.code).toBe('DS-DISB');
    expect(servingDataset(metric({ expression_ast: sum('CONTRACT_VALUE') }), [DISB, CTR])?.code).toBe('DS-CTR');
    expect(servingDataset(metric({ expression_ast: { op: 'div', args: [sum('PAID'), sum('ACCEPTED')] } }), [DISB, CTR])?.code).toBe('DS-CTR');
    expect(servingDataset(metric({ expression_ast: sum('EARNED_VALUE') }), [DISB, CTR])).toBeUndefined();
    expect(servingDataset(metric({ expression_ast: { op: 'const', value: 1 } }), [DISB, CTR])).toBeUndefined();
  });

  it('names a dimension for the metrics of two stages only', () => {
    expect(tileDimensionOf(metric({ expression_ast: { op: 'div', args: [{ op: 'top_n_sum', args: [sum('ACTIVE_VALUE')] }, sum('ACTIVE_VALUE')] } }))).toBe('contractor');
    expect(tileDimensionOf(metric({ expression_ast: sum('ACTIVE_VALUE') }))).toBeUndefined();
  });

  it('prefers the dataset the metric names', () => {
    expect(servingDataset(metric({ expression_ast: sum('GIAI_NGAN'), dataset_id: 'd2' }), [DISB, CTR])?.code).toBe('DS-CTR');
  });
});
