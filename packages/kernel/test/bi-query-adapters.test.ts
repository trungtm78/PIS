import { expressionProblem, validateMetric } from '../src/bi-metric.ts';
import {
  CONTRACT_ADAPTER,
  DISBURSEMENT_ADAPTER,
  DISBURSEMENT_DIMENSIONS,
  DISBURSEMENT_FIELDS,
  adaptersReadingFields,
  assembleSeries,
  datasetAdapterOf,
  datasetAdapters,
  fieldsOfTree,
  figureOf,
  knownDimensionNames,
  measurePlanOf,
  reconcile,
  registerDatasetAdapter,
  seriesPeriods,
  stageTwoSums,
} from '../src/bi-query.ts';
import type { GroupSums, MeasurePlan } from '../src/bi-query.ts';

const field = (name: string) => ({ op: 'field', name });
const sum = (name: string) => ({ op: 'sum', args: [field(name)] });
const num = (value: number) => ({ op: 'const', value });
const hhi = (name: string, multiplier = 100) => ({
  numerator: { op: 'mul', args: [num(multiplier), { op: 'sum_of_squares', args: [sum(name)] }] },
  denominator: { op: 'mul', args: [sum(name), sum(name)] },
});
const topN = (name: string, n: number) => ({ numerator: { op: 'top_n_sum', args: [sum(name), num(n)] }, denominator: sum(name) });
const ratioMetric = (sides: { numerator: unknown; denominator: unknown }) => ({ aggregationType: 'ratio' as const, expressionAst: { op: 'div', args: [sides.numerator, sides.denominator] } as never, numeratorAst: sides.numerator as never, denominatorAst: sides.denominator as never });

const thrown = (run: () => unknown): { code?: string; status?: number; detail?: string } | undefined => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; status?: number; detail?: string };
  }
  return undefined;
};

const sums = (numerator: string | null, denominator: string | null = null, lines: string | null = '1'): GroupSums => ({ numerator, denominator, distinct: null, lines });

describe('CA-1 the datasets a query can read are adapters, DS-DISB through the same door as the rest', () => {
  it('registers DS-DISB with the allowlists it always had, and DS-CTR beside it', () => {
    expect(datasetAdapters().map((adapter) => adapter.code)).toEqual(['DS-CTR', 'DS-DISB']);
    expect(datasetAdapterOf('DS-DISB')).toBe(DISBURSEMENT_ADAPTER);
    expect(DISBURSEMENT_ADAPTER.fields).toBe(DISBURSEMENT_FIELDS);
    expect(DISBURSEMENT_ADAPTER.dimensions).toBe(DISBURSEMENT_DIMENSIONS);
    expect(DISBURSEMENT_ADAPTER).toMatchObject({ sourceKind: 'PERIOD_SNAPSHOT', grain: 'project', identifierFields: ['DU_AN', 'DON_VI'] });
    expect(datasetAdapterOf('DS-CTR')).toBe(CONTRACT_ADAPTER);
    expect(CONTRACT_ADAPTER.sourceKind).toBe('CONTRACT_FACT');
    expect(datasetAdapterOf('DS-NOPE')).toBeUndefined();
    expect(Object.isFrozen(DISBURSEMENT_ADAPTER)).toBe(true);
  });

  it('refuses a second registration of a code, and every dimension and field of an adapter names a column', () => {
    expect(() => registerDatasetAdapter(DISBURSEMENT_ADAPTER)).toThrow('already registered');
    for (const adapter of datasetAdapters()) {
      for (const [name, dimension] of Object.entries(adapter.dimensions)) {
        expect(dimension.column).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(['uuid', 'text']).toContain(dimension.kind);
        expect(name).toMatch(/^[a-z_]+$/);
      }
      for (const column of Object.values(adapter.fields)) expect(column).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const identifier of adapter.identifierFields) expect(adapter.fields[identifier]).toBeDefined();
    }
  });

  it('knows the dimension names of every dataset, and which datasets can read the fields of a metric', () => {
    expect([...knownDimensionNames()].sort()).toEqual(['bucket', 'budget_level', 'contract_status', 'contract_type', 'contractor', 'fund_source', 'investor', 'project', 'unit']);
    expect(adaptersReadingFields(['GIAI_NGAN', 'KE_HOACH_TTG']).map((adapter) => adapter.code)).toEqual(['DS-DISB']);
    expect(adaptersReadingFields(['PAID', 'ACCEPTED']).map((adapter) => adapter.code)).toEqual(['DS-CTR']);
    expect(adaptersReadingFields(['PAID', 'GIAI_NGAN'])).toEqual([]);
    expect(fieldsOfTree(ratioMetric(hhi('ACTIVE_VALUE')).numeratorAst)).toEqual(['ACTIVE_VALUE']);
    expect(fieldsOfTree({ op: 'div', args: [sum('PAID'), sum('ACCEPTED')] } as never)).toEqual(['PAID', 'ACCEPTED']);
    expect(fieldsOfTree(null)).toEqual([]);
  });

  it('plans a metric by the adapter it is asked of: a field of the other dataset is not computable, the same code and status as before', () => {
    const paid = { aggregationType: 'additive' as const, expressionAst: sum('PAID') as never, numeratorAst: null, denominatorAst: null };
    expect(measurePlanOf(paid, CONTRACT_ADAPTER)).toEqual({ kind: 'ADDITIVE', numeratorColumn: 'paid_vnd', denominatorColumn: null, nullPolicy: 'NULL_NOT_ZERO' });
    expect(thrown(() => measurePlanOf(paid))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'metric_version_id' });
    expect(thrown(() => measurePlanOf({ ...paid, expressionAst: sum('GIAI_NGAN') as never }, CONTRACT_ADAPTER))).toMatchObject({ code: 'VALIDATION_FAILED' });
    // The contract identifiers are counted, never summed.
    expect(thrown(() => measurePlanOf({ ...paid, expressionAst: sum('CONTRACT') as never }, CONTRACT_ADAPTER))).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(measurePlanOf({ ...paid, aggregationType: 'distinct', expressionAst: { op: 'count_distinct', args: [field('CONTRACT')] } as never }, CONTRACT_ADAPTER)).toMatchObject({ kind: 'DISTINCT', numeratorColumn: 'contract_id' });
    expect(measurePlanOf(ratioMetric({ numerator: sum('PAID'), denominator: sum('ACCEPTED') }), CONTRACT_ADAPTER)).toEqual({ kind: 'RATIO', numeratorColumn: 'paid_vnd', denominatorColumn: 'accepted_vnd', nullPolicy: 'NULL_NOT_ZERO' });
  });
});

describe('CA-1 the planner reads a metric of two stages: group, then aggregate (R16)', () => {
  it('the grammar takes sum_of_squares and top_n_sum and nothing like them', () => {
    expect(expressionProblem(ratioMetric(hhi('A')).numeratorAst, 'numerator')).toBeUndefined();
    expect(expressionProblem(topN('A', 5).numerator, 'numerator')).toBeUndefined();
    expect(expressionProblem({ op: 'top_n_sum', args: [sum('A')] }, 'e')).toEqual({ code: 'EXPRESSION_NOT_ALLOWED', field: 'e' });
    expect(expressionProblem({ op: 'sum_of_squares', args: [sum('A'), sum('B')] }, 'e')).toBeDefined();
    expect(expressionProblem({ op: 'toString', args: [sum('A')] }, 'e')).toBeDefined();
    expect(expressionProblem({ op: 'constructor', args: [] }, 'e')).toBeDefined();
    const made = validateMetric({ code: 'ctr_hhi', grain: 'contract', aggregationType: 'ratio', expressionAst: undefined, numeratorAst: hhi('ACTIVE_VALUE').numerator, denominatorAst: hhi('ACTIVE_VALUE').denominator, unit: 'index', nullPolicy: 'NULL_NOT_ZERO', dimensionCodes: ['investor'], glossaryTerm: null, effectiveFrom: '2026-01-01' });
    expect(made.ok).toBe(true);
  });

  it('plans the HHI as the sum of the squares of the groups over the square of the total, times 100 (the percent of the ratio times 100 is the index)', () => {
    const plan = measurePlanOf(ratioMetric(hhi('ACTIVE_VALUE')), CONTRACT_ADAPTER);
    expect(plan).toEqual({
      kind: 'RATIO',
      numeratorColumn: 'active_value_vnd',
      denominatorColumn: 'active_value_vnd',
      nullPolicy: 'NULL_NOT_ZERO',
      twoStage: { numerator: { op: 'SUM_OF_SQUARES', n: null, multiplier: '100' }, denominator: { op: 'TOTAL_SQUARED', n: null, multiplier: '1' } },
    });
    // 600 and 400 of 1000: 60^2 + 40^2 = 5200.
    const second = stageTwoSums(plan, ['600', '400']);
    expect(second).toEqual({ numerator: '52000000', denominator: '1000000' });
    expect(figureOf(plan, { ...second, distinct: null, lines: '2' })).toEqual({ value: '5200.00', numerator: '52000000', denominator: '1000000', nullReason: null });
  });

  it('plans the share of the N largest groups, over the sum of all of them', () => {
    const plan = measurePlanOf(ratioMetric(topN('ACTIVE_VALUE', 2)), CONTRACT_ADAPTER);
    expect(plan.twoStage).toEqual({ numerator: { op: 'TOP_N_SUM', n: 2, multiplier: '1' }, denominator: { op: 'SUM', n: null, multiplier: '1' } });
    // 50, 30, 20, 10 of 110: the two largest are 80, 80/110 = 72.73 percent.
    const second = stageTwoSums(plan, ['10', '50', '20', '30']);
    expect(second).toEqual({ numerator: '80', denominator: '110' });
    expect(figureOf(plan, { ...second, distinct: null, lines: '4' }).value).toBe('72.73');
    expect(stageTwoSums(plan, ['7']).numerator).toBe('7');
  });

  it('has the same plan over the disbursement dataset: a two-stage metric is not tied to a dataset', () => {
    const plan = measurePlanOf(ratioMetric(hhi('GIAI_NGAN', 1)), DISBURSEMENT_ADAPTER);
    expect(plan.twoStage?.numerator).toEqual({ op: 'SUM_OF_SQUARES', n: null, multiplier: '1' });
    expect(plan.numeratorColumn).toBe('disbursed_treasury_vnd');
  });

  it('is computable only in the shapes a person can read: one column, a share or an index, whole multipliers, a bounded N', () => {
    const bad = (sides: { numerator: unknown; denominator: unknown }) => thrown(() => measurePlanOf(ratioMetric(sides), CONTRACT_ADAPTER));
    // Two columns in one share.
    expect(bad({ numerator: topN('ACTIVE_VALUE', 3).numerator, denominator: sum('PAID') })).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(bad({ numerator: hhi('PAID').numerator, denominator: { op: 'mul', args: [sum('PAID'), sum('ACCEPTED')] } })).toMatchObject({ code: 'VALIDATION_FAILED' });
    // Pairs that mean nothing.
    expect(bad({ numerator: topN('PAID', 3).numerator, denominator: hhi('PAID').denominator })).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(bad({ numerator: hhi('PAID').numerator, denominator: sum('PAID') })).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(bad({ numerator: sum('PAID'), denominator: hhi('PAID').denominator })).toMatchObject({ code: 'VALIDATION_FAILED' });
    // A multiplier on a plain share is not a share.
    expect(bad({ numerator: { op: 'mul', args: [num(100), sum('PAID')] }, denominator: sum('ACCEPTED') })).toMatchObject({ code: 'VALIDATION_FAILED' });
    // N and the multiplier are whole numbers in range; a term is multiplied once.
    expect(bad({ numerator: { op: 'top_n_sum', args: [sum('PAID'), num(0)] }, denominator: sum('PAID') })).toBeDefined();
    expect(bad({ numerator: { op: 'top_n_sum', args: [sum('PAID'), num(1001)] }, denominator: sum('PAID') })).toBeDefined();
    expect(bad({ numerator: { op: 'top_n_sum', args: [sum('PAID'), num(2.5)] }, denominator: sum('PAID') })).toBeDefined();
    expect(bad({ numerator: { op: 'mul', args: [num(100), { op: 'mul', args: [num(2), { op: 'sum_of_squares', args: [sum('PAID')] }] }] }, denominator: hhi('PAID').denominator })).toBeDefined();
    expect(bad({ numerator: { op: 'mul', args: [num(0), { op: 'sum_of_squares', args: [sum('PAID')] }] }, denominator: hhi('PAID').denominator })).toBeDefined();
    // The squares of an identifier, or of a field of another dataset.
    expect(bad({ numerator: { op: 'sum_of_squares', args: [sum('CONTRACT')] }, denominator: { op: 'mul', args: [sum('CONTRACT'), sum('CONTRACT')] } })).toBeDefined();
    expect(thrown(() => measurePlanOf(ratioMetric(hhi('GIAI_NGAN')), CONTRACT_ADAPTER))).toMatchObject({ code: 'VALIDATION_FAILED' });
    // A dataset that does not offer two stages refuses them.
    const plain = { ...CONTRACT_ADAPTER, capabilities: { twoStage: false, periodSeries: true } };
    expect(thrown(() => measurePlanOf(ratioMetric(hhi('PAID')), plain))).toMatchObject({ code: 'VALIDATION_FAILED' });
    // The metric a stage cannot be read as an additive or a distinct one.
    expect(thrown(() => measurePlanOf({ aggregationType: 'additive', expressionAst: { op: 'sum_of_squares', args: [sum('PAID')] } as never, numeratorAst: null, denominatorAst: null }, CONTRACT_ADAPTER))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a second stage over no group has no figure, over zero is NOT_APPLICABLE, never 0', () => {
    const plan = measurePlanOf(ratioMetric(hhi('ACTIVE_VALUE')), CONTRACT_ADAPTER);
    expect(stageTwoSums(plan, [])).toEqual({ numerator: null, denominator: null });
    expect(stageTwoSums(plan, [null, null])).toEqual({ numerator: null, denominator: null });
    expect(figureOf(plan, { numerator: null, denominator: null, distinct: null, lines: '2' })).toMatchObject({ value: null, nullReason: 'NO_DATA' });
    const zero = stageTwoSums(plan, ['0', '0']);
    expect(figureOf(plan, { ...zero, distinct: null, lines: '2' })).toMatchObject({ value: null, nullReason: 'NOT_APPLICABLE' });
    // A group with no figure is not a group of the second stage: it neither counts nor dilutes.
    expect(stageTwoSums(measurePlanOf(ratioMetric(topN('ACTIVE_VALUE', 1)), CONTRACT_ADAPTER), ['5', null, '5'])).toEqual({ numerator: '5', denominator: '10' });
    expect(thrown(() => stageTwoSums(plan, ['1.5']))).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(thrown(() => stageTwoSums({ kind: 'ADDITIVE', numeratorColumn: 'a', denominatorColumn: null, nullPolicy: 'NULL_NOT_ZERO' }, ['1']))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('agrees with a recomputation from the raw groups, and says so when it does not (R16)', () => {
    const plan = measurePlanOf(ratioMetric(hhi('ACTIVE_VALUE')), CONTRACT_ADAPTER);
    const groups = ['600', '400'];
    const parent = stageTwoSums(plan, groups);
    // The rows of a two-stage answer carry the value of the group and the total (their figure is the share); the parent carries the sums of the second stage.
    const children: GroupSums[] = groups.map((value) => ({ numerator: value, denominator: '1000', distinct: null, lines: '1' }));
    expect(reconcile(plan, children, { ...parent, distinct: null })).toEqual({ reconcilesToParent: true, nonAdditiveReason: null });
    expect(reconcile(plan, children, { numerator: '52000001', denominator: '1000000', distinct: null })).toEqual({ reconcilesToParent: false, nonAdditiveReason: 'TWO_STAGE_NOT_RECOMPUTED' });
    expect(reconcile(plan, children.slice(0, 1), { ...parent, distinct: null }).reconcilesToParent).toBe(false);
    // An additive metric is still the sum of its groups.
    const additive: MeasurePlan = { kind: 'ADDITIVE', numeratorColumn: 'a', denominatorColumn: null, nullPolicy: 'NULL_NOT_ZERO' };
    expect(reconcile(additive, [sums('600'), sums('400')], sums('1000')).reconcilesToParent).toBe(true);
    expect(figureOf(plan, children[0] as GroupSums)).toMatchObject({ value: '60.00' });
  });
});

describe('CA-1 a series over periods', () => {
  const plan: MeasurePlan = { kind: 'RATIO', numeratorColumn: 'a', denominatorColumn: 'b', nullPolicy: 'NULL_NOT_ZERO' };
  const version = (period: string, snapshot: string) => ({ period, versionId: `v-${period}`, sourceSnapshotId: snapshot, qualityBadge: 'PASSED' });

  it('takes the periods in order, once each, at most 36', () => {
    expect(seriesPeriods(['2026-03', '2026-01', '2026-02'])).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(thrown(() => seriesPeriods([]))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'periods' });
    expect(thrown(() => seriesPeriods(['2026-01', '2026-01']))).toMatchObject({ detail: 'periods' });
    expect(thrown(() => seriesPeriods(['2026-01', 5]))).toMatchObject({ detail: 'periods' });
    expect(thrown(() => seriesPeriods(['2026 01']))).toMatchObject({ detail: 'periods' });
    expect(thrown(() => seriesPeriods('2026-01'))).toMatchObject({ detail: 'periods' });
    expect(seriesPeriods(Array.from({ length: 36 }, (_, i) => `P${String(i).padStart(2, '0')}`))).toHaveLength(36);
    expect(thrown(() => seriesPeriods(Array.from({ length: 37 }, (_, i) => `P${String(i).padStart(2, '0')}`)))).toMatchObject({ detail: 'periods' });
  });

  it('makes one point per requested period with the figure of its version, a gap with no figure for a period with no version, and the change between points that have one', () => {
    const points = assembleSeries(
      plan,
      ['2026-01', '2026-02', '2026-03', '2026-04'],
      [version('2026-01', 's1'), version('2026-03', 's3'), version('2026-04', 's4')],
      new Map([
        ['s1', sums('50', '100')],
        ['s3', sums('90', '100')],
        ['s4', sums('45', '100')],
      ]),
    );
    expect(points.map((point) => [point.period, point.figure.value, point.missing, point.changeFromPrevious, point.versionId])).toEqual([
      ['2026-01', '50.00', false, null, 'v-2026-01'],
      ['2026-02', null, true, null, null],
      ['2026-03', '90.00', false, null, 'v-2026-03'],
      ['2026-04', '45.00', false, '-45.00', 'v-2026-04'],
    ]);
    expect(points[1]).toMatchObject({ figure: { nullReason: 'NO_DATA' }, sums: null, qualityBadge: null });
    expect(points[0]?.sums).toEqual(sums('50', '100'));
  });

  it('reads a point by the same figureOf as one query: a ratio over zero is NOT_APPLICABLE in the series too, and a version with no line is no data, or zero when the metric says so', () => {
    const points = assembleSeries(plan, ['a', 'b'], [version('a', 'sa'), version('b', 'sb')], new Map([['sa', sums('5', '0')]]));
    expect(points[0]?.figure).toMatchObject({ value: null, nullReason: 'NOT_APPLICABLE' });
    expect(points[1]?.figure).toMatchObject({ value: null, nullReason: 'NO_DATA', numerator: null });
    expect(points[1]?.missing).toBe(false);
    const additive: MeasurePlan = { kind: 'ADDITIVE', numeratorColumn: 'a', denominatorColumn: null, nullPolicy: 'ZERO_IF_NO_ROWS' };
    expect(assembleSeries(additive, ['a'], [version('a', 'sa')], new Map())[0]?.figure).toMatchObject({ value: '0', nullReason: null });
    const whole = assembleSeries({ ...additive, nullPolicy: 'NULL_NOT_ZERO' }, ['a', 'b'], [version('a', 'sa'), version('b', 'sb')], new Map([['sa', sums('1000')], ['sb', sums('1250')]]));
    expect(whole.map((point) => point.changeFromPrevious)).toEqual([null, '250']);
  });

  it('is the same number as asking the period alone, and a series of a two-stage metric is the second stage of each period', () => {
    const hhiPlan = measurePlanOf(ratioMetric(hhi('ACTIVE_VALUE')), CONTRACT_ADAPTER);
    const jan = stageTwoSums(hhiPlan, ['600', '400']);
    const feb = stageTwoSums(hhiPlan, ['500', '500']);
    const points = assembleSeries(
      hhiPlan,
      ['2026-01', '2026-02'],
      [version('2026-01', 's1'), version('2026-02', 's2')],
      new Map([
        ['s1', { ...jan, distinct: null, lines: '2' }],
        ['s2', { ...feb, distinct: null, lines: '2' }],
      ]),
    );
    expect(points.map((point) => point.figure.value)).toEqual(['5200.00', '5000.00']);
    expect(points[1]?.changeFromPrevious).toBe('-200.00');
    expect(points[0]?.figure).toEqual(figureOf(hhiPlan, { ...jan, distinct: null, lines: '2' }));
  });
});
