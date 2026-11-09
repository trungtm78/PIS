import { builtInPack } from '../src/fnd-taxonomy.ts';
import type { StoredFigure } from '../src/fnd-actuals.ts';
import { figuresOfProject } from '../src/fnd-figures.ts';
import type { FigureBook, FigureQuery } from '../src/fnd-figures.ts';
import { indicatorsOf, moneyIndicatorsOf } from '../src/fnd-indicators.ts';
import { snapshotHashFor } from '../src/fnd-snapshot.ts';
import type { SnapshotIndicator } from '../src/fnd-snapshot.ts';
import { EnterpriseFigureReader, PROJECT_TOTAL_CLASS, TMDT_KIND, completenessOf, completenessProjectOf, enterpriseRowsOf, enterpriseSnapshotHash, projectRowsFromBook } from '../src/enterprise-snapshot.ts';
import type { EnterpriseSnapshotView } from '../src/enterprise-snapshot.ts';

const PACK = builtInPack('ENTERPRISE');
let counter = 0;

const fig = (over: Partial<StoredFigure> & Pick<StoredFigure, 'kind' | 'amountVnd'>): StoredFigure => {
  counter += 1;
  const yearly = over.kind === 'PLAN_YEAR' || over.kind === 'PLAN_ADJUSTED';
  return {
    id: `f-${counter}`,
    classCode: 'EQUITY',
    tierCode: 'ALL',
    measure: 'DISBURSED',
    grain: yearly ? 'YEAR' : 'MONTH',
    planYear: 2026,
    ordinal: yearly ? 0 : 1,
    basis: over.kind === 'ACTUAL' ? 'REPORTED' : over.kind === 'ESTIMATE' ? 'OWNER_ESTIMATE' : 'PLAN_DECISION',
    asOfDate: '2026-01-10',
    revision: 1,
    status: 'ACCEPTED',
    ...over,
  };
};
const actual = (ordinal: number, amountVnd: string, over: Partial<StoredFigure> = {}): StoredFigure => fig({ kind: 'ACTUAL', ordinal, amountVnd, asOfDate: `2026-${String(ordinal + 1).padStart(2, '0')}-05`, ...over });
const book = (figures: readonly StoredFigure[], tmdt: ReadonlyArray<{ effectiveOn: string; amountVnd: string }> = []): FigureBook => ({ pack: PACK, figures, tmdt, yearsClosed: new Set<number>() });
const March: Omit<FigureQuery, 'measure'> = { period: { grain: 'MONTH', planYear: 2026, ordinal: 3 }, asOf: '2026-04-05', view: 'AS_REPORTED' };

/** Project one: equity and loan plans of the year, three months of actuals; project two (another unit): equity only. */
const projectOne = book(
  [
    fig({ kind: 'PLAN_YEAR', amountVnd: '1000' }),
    fig({ kind: 'PLAN_YEAR', amountVnd: '500', classCode: 'LOAN' }),
    fig({ kind: 'PLAN_YEAR', amountVnd: '300', measure: 'EXECUTED' }),
    actual(1, '100'),
    actual(2, '150'),
    actual(3, '200'),
    actual(1, '40', { classCode: 'LOAN' }),
    actual(2, '60', { classCode: 'LOAN' }),
    actual(3, '80', { classCode: 'LOAN' }),
    actual(1, '10', { measure: 'EXECUTED' }),
    actual(2, '10', { measure: 'EXECUTED' }),
    actual(3, '10', { measure: 'EXECUTED' }),
    fig({ kind: 'PLAN_MONTH', ordinal: 3, amountVnd: '120' }),
    fig({ kind: 'ESTIMATE', ordinal: 3, amountVnd: '180', asOfDate: '2026-03-20' }),
  ],
  [{ effectiveOn: '2025-01-01', amountVnd: '9000' }],
);
const projectTwo = book([fig({ kind: 'PLAN_YEAR', amountVnd: '2000' }), actual(1, '200'), actual(2, '250'), actual(3, '300')], [{ effectiveOn: '2025-01-01', amountVnd: '5000' }]);

const people = [
  { projectId: 'p1', unitId: 'u1', projectCode: 'P-1', unitCode: 'U-1', book: projectOne },
  { projectId: 'p2', unitId: 'u2', projectCode: 'P-2', unitCode: 'U-2', book: projectTwo },
];

const viewOf = (indicators: SnapshotIndicator[] = []): EnterpriseSnapshotView => ({
  snapshotId: 's-1',
  revision: 1,
  payloadSha256: null,
  periodId: 'period-3',
  period: March.period,
  asOfDate: March.asOf,
  pack: PACK,
  taxonomyVersion: 1,
  figures: people.flatMap((one) => projectRowsFromBook(one.book, { projectId: one.projectId, unitId: one.unitId }, March)),
  indicators,
});

describe('completeness of the input points (DL.03)', () => {
  const judge = (q: Omit<FigureQuery, 'measure'>) => completenessOf(people.map((one) => completenessProjectOf(one.book, one, q)));

  it('a period with an accepted actual in every planned cell is complete', () => {
    expect(judge(March)).toMatchObject({ complete: true, missingUnits: [], projects: 2 });
  });

  it('lists the units that have not submitted, with their projects, cells and months, in a stable order', () => {
    const lacking = [...people].reverse().map((one) => (one.projectId === 'p2' ? { ...one, book: book(projectTwo.figures.filter((figure) => figure.ordinal !== 2), projectTwo.tmdt) } : one));
    const result = completenessOf(lacking.map((one) => completenessProjectOf(one.book, one, March)));
    expect(result.complete).toBe(false);
    expect(result.missingUnits).toEqual([{ unitId: 'u2', unitCode: 'U-2', projects: [{ projectId: 'p2', projectCode: 'P-2', cells: [{ classCode: 'EQUITY', tierCode: 'ALL', measure: 'DISBURSED', months: [2] }] }] }]);
  });

  it('an absent actual is a gap and an accepted zero is a submission (absent is not zero)', () => {
    const none = book([fig({ kind: 'PLAN_YEAR', amountVnd: '100' })]);
    expect(completenessOf([completenessProjectOf(none, { projectId: 'p9', projectCode: 'P-9', unitId: 'u9', unitCode: 'U-9' }, March)]).missingUnits[0]?.projects[0]?.cells[0]?.months).toEqual([1, 2, 3]);
    const zero = book([fig({ kind: 'PLAN_YEAR', amountVnd: '100' }), actual(1, '0'), actual(2, '0'), actual(3, '0')]);
    expect(completenessOf([completenessProjectOf(zero, { projectId: 'p9', projectCode: 'P-9', unitId: 'u9', unitCode: 'U-9' }, March)]).complete).toBe(true);
  });

  it('a cell nobody planned is not demanded', () => {
    const unplanned = book([]);
    expect(completenessOf([completenessProjectOf(unplanned, { projectId: 'p9', projectCode: 'P-9', unitId: 'u9', unitCode: 'U-9' }, March)])).toMatchObject({ complete: true, plannedCells: 0 });
  });
});

describe('the reader gives back what the figure engine says (R21)', () => {
  const reader = new EnterpriseFigureReader(viewOf());
  const engine = (ids: string[]) =>
    ids.map((id) => {
      const one = people.find((entry) => entry.projectId === id) as (typeof people)[number];
      return figuresOfProject(one.book, one.projectId, { ...March, measure: 'DISBURSED' });
    });

  it('the ratios of the tenant, of a unit and of a project equal indicatorsOf over the same books', () => {
    const query: FigureQuery = { ...March, measure: 'DISBURSED' };
    expect(reader.rates({}, 'DISBURSED')).toEqual(indicatorsOf(PACK, engine(['p1', 'p2']), query));
    expect(reader.rates({ unitId: 'u1' }, 'DISBURSED')).toEqual(indicatorsOf(PACK, engine(['p1']), query));
    expect(reader.rates({ projectIds: ['p2'] }, 'DISBURSED')).toEqual(indicatorsOf(PACK, engine(['p2']), query));
  });

  it('the money figures are additive: the tenant is the sum of its units and of its classes', () => {
    const total = BigInt(reader.amountOf({}, 'DISBURSED', 'CUMULATIVE_YTD') as string);
    expect(total).toBe(BigInt(reader.amountOf({ unitId: 'u1' }, 'DISBURSED', 'CUMULATIVE_YTD') as string) + BigInt(reader.amountOf({ unitId: 'u2' }, 'DISBURSED', 'CUMULATIVE_YTD') as string));
    expect(total).toBe(BigInt(reader.amountOf({}, 'DISBURSED', 'CUMULATIVE_YTD', 'EQUITY') as string) + BigInt(reader.amountOf({}, 'DISBURSED', 'CUMULATIVE_YTD', 'LOAN') as string));
    expect(reader.money({}, 'DISBURSED')).toEqual(moneyIndicatorsOf(PACK, engine(['p1', 'p2']), { ...March, measure: 'DISBURSED' }));
  });

  it('the year rate of a group is the sum of the cumulatives over the sum of the plans, not the mean of the rates', () => {
    const rate = reader.rate({}, 'DISBURSED', 'RATE_YEAR_IN_FORCE');
    // Cumulatives: equity of p1 450, loan of p1 180, equity of p2 750 (1380); plans in force 1000 + 500 + 2000 (3500).
    expect(rate).toMatchObject({ numeratorVnd: '1380', denominatorVnd: '3500', ratePct: '39.4286', nullReason: null });
    const meanOfRates = (45 + 36 + 37.5) / 3;
    expect(Number(rate?.ratePct)).not.toBeCloseTo(meanOfRates, 2);
  });

  it('a figure nobody has is null with a reason, never zero', () => {
    expect(reader.amountOf({ projectIds: ['p2'] }, 'EXECUTED', 'CUMULATIVE_YTD')).toBeNull();
    expect(reader.rate({ projectIds: ['p2'] }, 'EXECUTED', 'RATE_YEAR_IN_FORCE')).toMatchObject({ ratePct: null, nullReason: 'ZERO_DENOMINATOR' });
    expect(reader.amountOf({ projectIds: ['p-unknown'] }, 'DISBURSED', 'ACTUAL')).toBeNull();
  });

  it('keeps the estimate and its conversion, the phased plan of the period and the since-start figures', () => {
    expect(reader.amountOf({ projectIds: ['p1'] }, 'DISBURSED', 'PLAN_PERIOD', 'EQUITY')).toBe('120');
    expect(reader.amountOf({ projectIds: ['p1'] }, 'DISBURSED', 'ESTIMATE_AS_REPORTED', 'EQUITY')).toBe('180');
    expect(reader.amountOf({ projectIds: ['p1'] }, 'DISBURSED', 'CONVERSION_DELTA', 'EQUITY')).toBe('20');
    expect(reader.amountOf({ projectIds: ['p1'] }, 'DISBURSED', 'CUMULATIVE_SINCE_START', 'EQUITY')).toBe('450');
  });

  it('the total investment is a project figure: it never enters a class sum and gives the since-start rate', () => {
    expect(reader.totalInvestment({})).toBe('14000');
    expect(reader.totalInvestment({ unitId: 'u2' })).toBe('5000');
    expect(reader.rateSinceStart({ unitId: 'u2' }, 'DISBURSED')).toEqual({ ratePct: '15.0000', nullReason: null });
    expect(reader.view.figures.filter((row) => row.classCode === PROJECT_TOTAL_CLASS).every((row) => row.figureKind === TMDT_KIND)).toBe(true);
    expect(reader.amountOf({}, 'DISBURSED', 'CUMULATIVE_YTD')).toBe('1380');
  });

  it('the reader lists the units and the projects the snapshot holds and the indicator figures with their sum', () => {
    const indicators: SnapshotIndicator[] = [
      { projectId: 'p1', unitId: 'u1', indicatorCode: 'PHYSICAL_PROGRESS', value: '40', unit: 'PERCENT', definitionVersion: 1, revision: 2, sourceFigureId: 'i-1' },
      { projectId: 'p2', unitId: 'u2', indicatorCode: 'PHYSICAL_PROGRESS', value: '25', unit: 'PERCENT', definitionVersion: 1, revision: 1, sourceFigureId: 'i-2' },
    ];
    const withIndicators = new EnterpriseFigureReader(viewOf(indicators));
    expect(withIndicators.projectIds()).toEqual(['p1', 'p2']);
    expect(withIndicators.unitIds()).toEqual(['u1', 'u2']);
    expect(withIndicators.indicatorFigures({ unitId: 'u2' })).toHaveLength(1);
    expect(withIndicators.indicatorSum({}, 'PHYSICAL_PROGRESS')).toBe('65');
    expect(withIndicators.indicatorSum({}, 'UNKNOWN')).toBeNull();
    expect(withIndicators.range()).toEqual({ start: '2026-03-01', end: '2026-03-31' });
  });
});

describe('the rows and the hash of an enterprise snapshot (R17)', () => {
  const rows = viewOf().figures;

  it('the rows are deterministic and leave out a cell with no figure at all', () => {
    expect(viewOf().figures).toEqual(rows);
    expect(rows.some((row) => row.projectId === 'p2' && row.classCode === 'LOAN')).toBe(false);
    expect(rows.filter((row) => row.figureKind === TMDT_KIND)).toHaveLength(2);
  });

  const header = { periodId: 'period-3', snapshotKind: 'PERIOD_CLOSE', asOfDate: '2026-04-05', metricSetVersion: 'X', definitionStatus: 'PROPOSED_PENDING_SIGNOFF', taxonomyPack: 'ENTERPRISE', taxonomyVersion: 1, actualsPrecedence: 'REPORTED_UNTIL_RECONCILED' };

  it('the hash does not depend on the order the rows were read in and changes with a figure', () => {
    const first = enterpriseSnapshotHash({ ...header, figures: rows, indicators: [] });
    expect(enterpriseSnapshotHash({ ...header, figures: [...rows].reverse(), indicators: [] })).toBe(first);
    const changed = rows.map((row, index) => (index === 3 ? { ...row, amountVnd: '1' } : row));
    expect(enterpriseSnapshotHash({ ...header, figures: changed, indicators: [] })).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a snapshot without an indicator keeps the schema 2 hash it always had; an indicator figure is covered by the hash', () => {
    const plain = enterpriseSnapshotHash({ ...header, figures: rows, indicators: [] });
    const direct = snapshotHashFor(2, { periodId: 'period-3', snapshotKind: 'PERIOD_CLOSE', asOfDate: '2026-04-05', treasuryCutoffDate: '2026-04-05', metricSetVersion: 'X', definitionStatus: 'PROPOSED_PENDING_SIGNOFF' }, [], { taxonomyPack: 'ENTERPRISE', taxonomyVersion: 1, actualsPrecedence: 'REPORTED_UNTIL_RECONCILED', figures: rows });
    expect(plain).toBe(direct);
    const one: SnapshotIndicator = { projectId: 'p1', unitId: 'u1', indicatorCode: 'PHYSICAL_PROGRESS', value: '40', unit: 'PERCENT', definitionVersion: 1, revision: 1, sourceFigureId: null };
    const withOne = enterpriseSnapshotHash({ ...header, figures: rows, indicators: [one] });
    expect(withOne).not.toBe(plain);
    expect(enterpriseSnapshotHash({ ...header, figures: rows, indicators: [{ ...one, value: '41' }] })).not.toBe(withOne);
  });

  it('enterpriseRowsOf writes the total investment once per project and a plan to date for every cell it keeps', () => {
    const per = PACK.measures.map((measure) => ({ measure, figures: figuresOfProject(projectOne, 'p1', { ...March, measure }) }));
    const made = enterpriseRowsOf({ projectId: 'p1', unitId: 'u1' }, per, March.period);
    expect(made.filter((row) => row.figureKind === TMDT_KIND)).toHaveLength(1);
    expect(made.filter((row) => row.figureKind === 'PLAN_TO_DATE').length).toBeGreaterThan(0);
  });
});
