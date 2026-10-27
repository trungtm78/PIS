import { createHash } from 'node:crypto';
import { DomainError } from '../src/errors.ts';
import { expressionProblem, metricOfDocument, metricSha256, parseMetricBundle, periodEndValue, planMetricSync, ratioOfSums, validateMetric } from '../src/bi-metric.ts';
import type { MetricDefinition, MetricFields, RegisteredMetric } from '../src/bi-metric.ts';

const field = (name: string) => ({ op: 'field', name });
const sum = (name: string) => ({ op: 'sum', args: [field(name)] });
const RATIO_DOC = { code: 'disbursement_rate', grain: 'project', aggregation_type: 'ratio', numerator: sum('GIAI_NGAN'), denominator: sum('KE_HOACH_TTG'), unit: 'percent', null_policy: 'NULL_NOT_ZERO', effective_from: '2026-01-01' };
const fields = (overrides: Partial<MetricFields> = {}): MetricFields => ({
  code: 't_rate',
  grain: 'project',
  aggregationType: 'ratio',
  expressionAst: { op: 'div', args: [sum('A'), sum('B')] },
  numeratorAst: sum('A'),
  denominatorAst: sum('B'),
  unit: 'percent',
  nullPolicy: 'NULL_NOT_ZERO',
  dimensionCodes: [],
  glossaryTerm: undefined,
  effectiveFrom: '2026-01-01',
  ...overrides,
});
const definition = (overrides: Record<string, unknown> = {}): MetricDefinition => {
  const result = metricOfDocument({ ...RATIO_DOC, ...overrides });
  if (!result.ok) throw new Error(`fixture: ${result.problem.field}`);
  return result.value;
};
const registered = (value: MetricDefinition, extra: Partial<RegisteredMetric> = {}): RegisteredMetric => ({ id: `id-${value.code}`, code: value.code, revision: 1, status: 'CERTIFIED', definitionSha256: metricSha256(value), definition: value, ...extra });
const thrown = (action: () => unknown): DomainError => {
  try {
    action();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

describe('the expression of a metric is a tree of allowed nodes (BI 3 F1)', () => {
  it('AC-ST-BI-001-2: UAT-AC472 refuses a raw_sql node, a function call and any key outside the grammar', () => {
    expect(expressionProblem({ op: 'raw_sql', args: [] }, 'expression')).toEqual({ code: 'EXPRESSION_NOT_ALLOWED', field: 'expression' });
    expect(expressionProblem({ op: 'sum', args: [{ op: 'raw_sql', sql: 'select 1' }] }, 'expression')).toEqual({ code: 'EXPRESSION_NOT_ALLOWED', field: 'expression.args[0]' });
    expect(expressionProblem({ op: 'field', name: 'a; drop table x' }, 'e')).toBeDefined();
    expect(expressionProblem({ op: 'field', name: 'A', extra: 1 }, 'e')).toBeDefined();
    expect(expressionProblem({ op: 'sum', args: [field('A'), field('B')] }, 'e')).toBeDefined();
    expect(expressionProblem({ op: 'add', args: [field('A')] }, 'e')).toBeDefined();
    expect(expressionProblem({ op: 'const', value: Number.NaN }, 'e')).toBeDefined();
    expect(expressionProblem('select 1', 'e')).toBeDefined();
    expect(expressionProblem(null, 'e')).toBeDefined();
  });

  it('accepts aggregates over a field and arithmetic over two nodes, and bounds the depth and the size', () => {
    expect(expressionProblem({ op: 'div', args: [sum('A'), { op: 'add', args: [sum('B'), { op: 'const', value: 1 }] }] }, 'e')).toBeUndefined();
    let deep: unknown = field('A');
    for (let i = 0; i < 8; i += 1) deep = { op: 'sum', args: [deep] };
    expect(expressionProblem(deep, 'e')).toBeDefined();
    let wide: unknown = field('A');
    for (let i = 0; i < 5; i += 1) wide = { op: 'add', args: [wide, wide] };
    expect(expressionProblem(wide, 'e')).toBeDefined();
  });
});

describe('a metric needs what its kind needs', () => {
  it('AC-ST-BI-001-2: UAT-AC472 refuses a ratio without a denominator or without a numerator, and a metric that is not a ratio with either', () => {
    expect(validateMetric(fields({ denominatorAst: undefined }))).toEqual({ ok: false, problem: { code: 'RATIO_REQUIRES_NUMERATOR_DENOMINATOR', field: 'denominator' } });
    expect(validateMetric(fields({ numeratorAst: undefined }))).toEqual({ ok: false, problem: { code: 'RATIO_REQUIRES_NUMERATOR_DENOMINATOR', field: 'numerator' } });
    expect(validateMetric(fields({ aggregationType: 'additive' }))).toEqual({ ok: false, problem: { code: 'METRIC_DEFINITION_INVALID', field: 'numerator' } });
    expect(validateMetric(fields({ aggregationType: 'additive', numeratorAst: undefined }))).toEqual({ ok: false, problem: { code: 'METRIC_DEFINITION_INVALID', field: 'denominator' } });
  });

  it('AC-ST-BI-001-2: UAT-AC472 refuses a raw_sql node in the expression, the numerator or the denominator, naming which', () => {
    expect(validateMetric(fields({ expressionAst: { op: 'raw_sql' } }))).toEqual({ ok: false, problem: { code: 'EXPRESSION_NOT_ALLOWED', field: 'expression' } });
    expect(validateMetric(fields({ numeratorAst: { op: 'raw_sql' } }))).toEqual({ ok: false, problem: { code: 'EXPRESSION_NOT_ALLOWED', field: 'numerator' } });
    expect(validateMetric(fields({ denominatorAst: { op: 'raw_sql' } }))).toEqual({ ok: false, problem: { code: 'EXPRESSION_NOT_ALLOWED', field: 'denominator' } });
  });

  it.each([
    ['code', { code: 'Bad Code' }],
    ['grain', { grain: ' ' }],
    ['aggregation_type', { aggregationType: 'median' }],
    ['unit', { unit: '' }],
    ['null_policy', { nullPolicy: 'ZERO' }],
    ['effective_from', { effectiveFrom: '2026-13-45' }],
    ['effective_from', { effectiveFrom: '2026-02-30' }],
    ['effective_from', { effectiveFrom: '2027-02-29' }],
    ['dimensions', { dimensionCodes: ['a', 'a'] }],
    ['dimensions', { dimensionCodes: ['bad dimension'] }],
    ['glossary_term', { glossaryTerm: 5 }],
  ])('refuses a bad %s with METRIC_DEFINITION_INVALID naming it', (name, overrides) => {
    expect(validateMetric(fields(overrides as Partial<MetricFields>))).toEqual({ ok: false, problem: { code: 'METRIC_DEFINITION_INVALID', field: name } });
  });

  it('refuses a ratio whose own expression says something other than its numerator over its denominator, and accepts the one that says the same', () => {
    expect(validateMetric(fields({ expressionAst: { op: 'const', value: 1 } }))).toEqual({ ok: false, problem: { code: 'METRIC_DEFINITION_INVALID', field: 'expression' } });
    expect(validateMetric(fields({ expressionAst: { op: 'div', args: [sum('B'), sum('A')] } }))).toEqual({ ok: false, problem: { code: 'METRIC_DEFINITION_INVALID', field: 'expression' } });
    expect(validateMetric(fields({ expressionAst: { op: 'div', args: [sum('A'), sum('B')] } })).ok).toBe(true);
    // The grammar is judged first: a node outside it is not allowed, whatever the operands are.
    expect(validateMetric(fields({ expressionAst: { op: 'raw_sql' } }))).toEqual({ ok: false, problem: { code: 'EXPRESSION_NOT_ALLOWED', field: 'expression' } });
  });

  it('makes the expression of a ratio from its numerator and denominator, sorts the dimensions, and keeps the glossary term', () => {
    const made = metricOfDocument({ ...RATIO_DOC, dimensions: ['unit', 'fund'], glossary_term: 'GIAI_NGAN' });
    expect(made).toMatchObject({ ok: true, value: { expressionAst: { op: 'div', args: [RATIO_DOC.numerator, RATIO_DOC.denominator] }, dimensionCodes: ['fund', 'unit'], glossaryTerm: 'GIAI_NGAN', nullPolicy: 'NULL_NOT_ZERO' } });
    expect(metricOfDocument({ ...RATIO_DOC, surprise: 1 })).toEqual({ ok: false, problem: { code: 'METRIC_DEFINITION_INVALID', field: 'surprise' } });
    // The prefix of the tenant's metrics is the tenant's: a platform code that carried it could meet a draft of a tenant.
    expect(metricOfDocument({ ...RATIO_DOC, code: 't_rate' })).toEqual({ ok: false, problem: { code: 'METRIC_DEFINITION_INVALID', field: 'code' } });
    expect(metricOfDocument('x')).toEqual({ ok: false, problem: { code: 'METRIC_DEFINITION_INVALID', field: 'metric' } });
  });

  it('hashes the definition, not the order of the keys of the file', () => {
    const a = definition();
    const b = metricOfDocument({ effective_from: '2026-01-01', null_policy: 'NULL_NOT_ZERO', unit: 'percent', denominator: RATIO_DOC.denominator, numerator: RATIO_DOC.numerator, aggregation_type: 'ratio', grain: 'project', code: 'disbursement_rate' });
    expect(b.ok && metricSha256(b.value)).toBe(metricSha256(a));
    expect(metricSha256(definition({ unit: 'ratio' }))).not.toBe(metricSha256(a));
  });
});

describe('the bundle the pipeline hands over', () => {
  const bundleBytes = (metrics: unknown[]): Uint8Array => new TextEncoder().encode(JSON.stringify({ version: 1, metrics }));
  const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

  it('AC-ST-BI-001-1: UAT-AC471 reads the metrics of a bundle whose hash is the hash of its bytes, and refuses another with BUNDLE_HASH_MISMATCH', () => {
    const bytes = bundleBytes([RATIO_DOC]);
    expect(parseMetricBundle(bytes, hashOf(bytes)).map((item) => item.code)).toEqual(['disbursement_rate']);
    expect(thrown(() => parseMetricBundle(bytes, '0'.repeat(64))).code).toBe('BUNDLE_HASH_MISMATCH');
  });

  it('refuses a bundle that is not a version 1 document, has a bad metric or the same code twice, naming where', () => {
    const named = (bytes: Uint8Array): string | undefined => thrown(() => parseMetricBundle(bytes, hashOf(bytes))).detail;
    expect(named(new TextEncoder().encode('not json'))).toBe('bundle');
    expect(named(new TextEncoder().encode(JSON.stringify({ version: 2, metrics: [] })))).toBe('bundle');
    expect(named(bundleBytes([RATIO_DOC, { ...RATIO_DOC, unit: '' }]))).toBe('metrics[1].unit');
    expect(named(bundleBytes([RATIO_DOC, RATIO_DOC]))).toBe('metrics[1].code');
    expect(named(bundleBytes([{ ...RATIO_DOC, denominator: undefined }]))).toBe('metrics[0].denominator');
  });
});

describe('what a sync does to the registry', () => {
  it('AC-ST-BI-001-1: UAT-AC471 adds a code that is new, leaves the same definition alone, and retires a code that left the bundle', () => {
    const rate = definition();
    const other = definition({ code: 'other_rate' });
    const plan = planMetricSync([registered(rate), registered(other)], [rate, definition({ code: 'brand_new' })]);
    expect(plan.added.map((item) => item.code)).toEqual(['brand_new']);
    expect(plan.unchanged).toEqual(['disbursement_rate']);
    expect(plan.retired).toEqual(['other_rate']);
    expect(plan.revised).toEqual([]);
  });

  it('AC-ST-BI-001-1: UAT-AC471 refuses a change of the denominator under the same code on the same day, naming the code', () => {
    const rate = definition();
    const changed = definition({ denominator: sum('KE_HOACH_TONG') });
    expect(thrown(() => planMetricSync([registered(rate)], [changed]))).toMatchObject({ code: 'BREAKING_CHANGE_WITHOUT_NEW_CODE', status: 422, detail: 'disbursement_rate' });
    // The grain, the unit, the kind and the numerator are what a number means as well.
    for (const overrides of [{ grain: 'unit' }, { unit: 'ratio' }, { numerator: sum('OTHER') }, { aggregation_type: 'additive', numerator: undefined, denominator: undefined, expression: sum('GIAI_NGAN') }]) {
      expect(thrown(() => planMetricSync([registered(rate)], [definition(overrides)])).code).toBe('BREAKING_CHANGE_WITHOUT_NEW_CODE');
    }
  });

  it('takes a change of the meaning as the next revision when it takes effect on a later day, and a change of anything else as a revision at once', () => {
    const rate = definition();
    const later = definition({ denominator: sum('KE_HOACH_TONG'), effective_from: '2027-01-01' });
    expect(planMetricSync([registered(rate)], [later]).revised).toEqual([{ definition: later, revision: 2, supersedes: 'id-disbursement_rate' }]);
    const relabelled = definition({ dimensions: ['unit'], null_policy: 'ZERO_IF_NO_ROWS' });
    expect(planMetricSync([registered(rate, { revision: 3 })], [relabelled]).revised).toEqual([{ definition: relabelled, revision: 4, supersedes: 'id-disbursement_rate' }]);
  });

  it('judges a retired code that comes back by what it means: the same definition returns, another meaning needs a later day', () => {
    const rate = definition();
    const retired = registered(rate, { status: 'RETIRED', revision: 2 });
    const dollars = definition({ unit: 'USD' });
    expect(thrown(() => planMetricSync([retired], [dollars]))).toMatchObject({ code: 'BREAKING_CHANGE_WITHOUT_NEW_CODE', detail: 'disbursement_rate' });
    const later = definition({ unit: 'USD', effective_from: '2027-01-01' });
    expect(planMetricSync([retired], [later]).revised).toEqual([{ definition: later, revision: 3, supersedes: 'id-disbursement_rate' }]);
    expect(planMetricSync([retired], [definition({ dimensions: ['unit'] })]).revised).toHaveLength(1);
  });

  it('brings back a retired code as a revision of it, and does not retire it twice', () => {
    const rate = definition();
    const retired = registered(rate, { status: 'RETIRED', revision: 2 });
    expect(planMetricSync([retired], [rate]).revised).toEqual([{ definition: rate, revision: 3, supersedes: 'id-disbursement_rate' }]);
    expect(planMetricSync([retired], []).retired).toEqual([]);
  });
});

describe('the value of a metric', () => {
  it('AC-ST-BI-001-3: BI01 shows 140 against 1,000 as 14%, from the sums and not from the mean of the ratios', () => {
    const rows = [
      { numerator: '60', denominator: '100' },
      { numerator: '40', denominator: '500' },
      { numerator: '40', denominator: '400' },
    ];
    expect(ratioOfSums(rows, 'NULL_NOT_ZERO')).toEqual({ percent: '14.00', numerator: '140', denominator: '1000', nullReason: null });
    // The mean of the three ratios (60%, 8%, 10%) is 26%: it is not what is shown.
    expect(ratioOfSums(rows, 'NULL_NOT_ZERO').percent).not.toBe('26.00');
  });

  it('AC-ST-BI-001-3: BI01 shows the value at the end of the period (150) when the snapshot moved from 100 to 150, not the sum (250), and refuses points of two snapshots', () => {
    const points = [
      { snapshotId: 's1', period: '2026-09', value: '100' },
      { snapshotId: 's1', period: '2026-10', value: '150' },
    ];
    expect(periodEndValue(points, '2026-10')).toEqual({ value: '150', period: '2026-10', nullReason: null });
    expect(periodEndValue(points, '2026-09').value).toBe('100');
    expect(periodEndValue(points, '2026-08')).toEqual({ value: null, period: null, nullReason: 'NO_DATA' });
    expect(thrown(() => periodEndValue([...points, { snapshotId: 's2', period: '2026-10', value: '1' }], '2026-10')).code).toBe('VALIDATION_FAILED');
    expect(thrown(() => periodEndValue([{ snapshotId: 's1', period: '2026-10', value: '1.5' }], '2026-10')).code).toBe('VALIDATION_FAILED');
  });

  it('AC-ST-BI-001-2: UAT-AC472 gives null with NO_DATA when there is no row and null with NOT_APPLICABLE for a denominator of zero, and zero only when the metric says so', () => {
    expect(ratioOfSums([], 'NULL_NOT_ZERO')).toEqual({ percent: null, numerator: '0', denominator: '0', nullReason: 'NO_DATA' });
    expect(ratioOfSums([], 'ZERO_IF_NO_ROWS').percent).toBe('0.00');
    expect(ratioOfSums([{ numerator: '5', denominator: '0' }], 'ZERO_IF_NO_ROWS')).toEqual({ percent: null, numerator: '5', denominator: '0', nullReason: 'NOT_APPLICABLE' });
  });

  it('rounds half up to two decimals, keeps the sign, and refuses an amount that is not whole', () => {
    expect(ratioOfSums([{ numerator: '1', denominator: '3' }], 'NULL_NOT_ZERO').percent).toBe('33.33');
    expect(ratioOfSums([{ numerator: '2', denominator: '3' }], 'NULL_NOT_ZERO').percent).toBe('66.67');
    expect(ratioOfSums([{ numerator: '1', denominator: '8000' }], 'NULL_NOT_ZERO').percent).toBe('0.01');
    expect(ratioOfSums([{ numerator: '-1', denominator: '4' }], 'NULL_NOT_ZERO').percent).toBe('-25.00');
    expect(ratioOfSums([{ numerator: '123456789012345678901234', denominator: '246913578024691357802468' }], 'NULL_NOT_ZERO').percent).toBe('50.00');
    expect(thrown(() => ratioOfSums([{ numerator: '1.5', denominator: '3' }], 'NULL_NOT_ZERO')).code).toBe('VALIDATION_FAILED');
  });
});
