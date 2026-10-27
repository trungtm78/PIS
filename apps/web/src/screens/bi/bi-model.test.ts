import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { DATASET, ID, field, rawMetric, sum } from './test-support';
import { EMPTY_VALUES, describeProblem, formulaText, metricBody, metricFormula, registrationsOf, toMetric, validateMetric } from './bi-model';
import type { Metric, MetricValues } from './bi-model';

const metric = (overrides: Record<string, unknown> = {}): Metric => toMetric(rawMetric(overrides)) as Metric;
const values = (overrides: Partial<MetricValues> = {}): MetricValues => ({
  ...EMPTY_VALUES,
  code: 't_rate',
  grain: 'project',
  unit: 'percent',
  expression: { aggregate: 'sum', field: 'A' },
  numerator: { aggregate: 'sum', field: 'A' },
  denominator: { aggregate: 'sum', field: 'B' },
  dimensions: 'unit, fund',
  datasetId: DATASET,
  effectiveFrom: '2026-01-01',
  ...overrides,
});

describe('a revision as the screens read it', () => {
  it('reads a revision of the registry, and leaves out an entry that lacks what the screens need', () => {
    expect(metric()).toMatchObject({ id: ID, code: 'disbursement_rate', aggregationType: 'ratio', origin: 'PLATFORM_CODE', sourceCommit: 'c1a2b3c', dimensionCodes: ['unit'], datasetId: null });
    for (const broken of [{ id: 5 }, { revision: 1.5 }, { aggregation_type: 'median' }, { status: 'GONE' }, { origin: 'ELSEWHERE' }, { null_policy: 'ZERO' }, { expression_ast: 'x' }]) {
      expect(toMetric(rawMetric(broken))).toBeUndefined();
    }
    expect(toMetric('x')).toBeUndefined();
    expect(toMetric(rawMetric({ dimension_codes: 'x', created_at: undefined, owner_id: undefined }))).toMatchObject({ dimensionCodes: [], createdAt: '', ownerId: '' });
  });

  it('writes a tree as a formula, a ratio as its numerator over its denominator, and what the grammar does not have as a question mark', () => {
    expect(metricFormula(metric())).toBe('SUM(GIAI_NGAN) / SUM(KE_HOACH_TTG)');
    expect(metricFormula(metric({ aggregation_type: 'additive', numerator_ast: null, denominator_ast: null, expression_ast: { op: 'sub', args: [sum('A'), { op: 'const', value: 2 }] } }))).toBe('(SUM(A) - 2)');
    expect(formulaText({ op: 'raw_sql' })).toBe('?');
    expect(formulaText({ op: 'field' })).toBe('?');
    expect(formulaText({ op: 'const', value: 'x' })).toBe('?');
    expect(formulaText({ op: 'sum', args: [] })).toBe('?');
    expect(formulaText(null)).toBe('');
  });
});

describe('what the files of the repository brought (BI-15)', () => {
  it('counts, for each commit, the metrics it added and revised, and what of it is retired or in force, the newest commit first, and leaves out the tenant', () => {
    const rows = registrationsOf([
      metric({ id: '1', code: 'a', revision: 1, status: 'SUPERSEDED', source_commit: 'c1', created_at: '2026-10-01T00:00:00.000Z' }),
      metric({ id: '2', code: 'a', revision: 2, status: 'CERTIFIED', source_commit: 'c2', created_at: '2026-10-02T00:00:00.000Z' }),
      metric({ id: '3', code: 'b', revision: 1, status: 'RETIRED', source_commit: 'c1', created_at: '2026-10-01T00:00:00.000Z' }),
      metric({ id: '4', code: 'c', revision: 1, status: 'CERTIFIED', source_commit: 'c2', created_at: '2026-10-02T00:00:00.000Z' }),
      metric({ id: '5', code: 't_x', revision: 1, status: 'DRAFT', origin: 'TENANT_UI', source_commit: null }),
    ]);
    expect(rows).toEqual([
      { sourceCommit: 'c2', added: 1, revised: 1, retired: 0, inForce: 2, lastAt: '2026-10-02T00:00:00.000Z' },
      { sourceCommit: 'c1', added: 2, revised: 0, retired: 1, inForce: 0, lastAt: '2026-10-01T00:00:00.000Z' },
    ]);
  });
});

describe('the form of a tenant metric', () => {
  it('accepts a valid metric and writes a ratio from a numerator and a denominator, the tree built from an aggregate and a field', () => {
    expect(validateMetric(values({ aggregationType: 'ratio' }))).toEqual({});
    expect(metricBody(values({ aggregationType: 'ratio', dimensions: ' unit , fund ,' }))).toEqual({
      code: 't_rate',
      grain: 'project',
      aggregation_type: 'ratio',
      expression_ast: { op: 'div', args: [sum('A'), sum('B')] },
      numerator_ast: sum('A'),
      denominator_ast: sum('B'),
      unit: 'percent',
      null_policy: 'NULL_NOT_ZERO',
      dimension_codes: ['unit', 'fund'],
      dataset_id: DATASET,
      effective_from: '2026-01-01',
    });
    const additive = metricBody(values({ aggregationType: 'additive', expression: { aggregate: 'count_distinct', field: ' PROJECT ' } }));
    expect(additive.expression_ast).toEqual({ op: 'count_distinct', args: [field('PROJECT')] });
    expect(additive).not.toHaveProperty('numerator_ast');
  });

  it.each([
    ['code', { code: 'free_rate' }, 'invalidCode'],
    ['code', { code: 't_Bad' }, 'invalidCode'],
    ['grain', { grain: ' ' }, 'required'],
    ['unit', { unit: '' }, 'required'],
    ['expression', { expression: { aggregate: 'sum' as const, field: '' } }, 'required'],
    ['expression', { expression: { aggregate: 'sum' as const, field: 'a b; drop' } }, 'invalidField'],
    ['dimensions', { dimensions: 'ok, bad dimension' }, 'invalidDimension'],
    ['datasetId', { datasetId: '' }, 'required'],
    ['datasetId', { datasetId: 'not-a-uuid' }, 'invalidId'],
    ['effectiveFrom', { effectiveFrom: '' }, 'required'],
    ['effectiveFrom', { effectiveFrom: '01/01/2026' }, 'invalidDate'],
  ])('names the problem of %s', (name, overrides, problem) => {
    expect(validateMetric(values(overrides as Partial<MetricValues>))).toEqual({ [name]: problem });
  });

  it('judges the numerator and the denominator of a ratio, and not the expression of one', () => {
    const empty = { aggregate: 'sum' as const, field: '' };
    expect(validateMetric(values({ aggregationType: 'ratio', numerator: empty, denominator: empty, expression: empty }))).toEqual({ numerator: 'required', denominator: 'required' });
  });

  it('maps a refusal of the server to what the screen says, naming the field when it names one', () => {
    const refused = (code: string, detail?: string) => describeProblem(new ApiError({ status: 422, code, correlationId: 'c', detail, extensions: {} }));
    expect(refused('RATIO_REQUIRES_NUMERATOR_DENOMINATOR')).toEqual({ reason: 'ratio', field: undefined });
    expect(refused('EXPRESSION_NOT_ALLOWED', 'expression')).toEqual({ reason: 'expression', field: 'expression' });
    expect(refused('PLATFORM_METRIC_READ_ONLY').reason).toBe('platformReadOnly');
    expect(refused('DIMENSION_NOT_IN_DATASET', 'fund')).toEqual({ reason: 'dimension', field: 'fund' });
    expect(refused('VALIDATION_FAILED', 'code').reason).toBe('invalid');
    expect(refused('SCOPE_DENIED').reason).toBe('denied');
    expect(refused('SESSION_EXPIRED').reason).toBe('session');
    expect(refused('SOMETHING_ELSE').reason).toBe('general');
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });
});
