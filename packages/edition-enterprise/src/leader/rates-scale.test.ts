import { EnterpriseFigureReader, builtInPack, projectRowsFromBook } from '@machvon/kernel';
import type { EnterpriseSnapshotView, FigureBook, FigureQuery, StoredFigure } from '@machvon/kernel';
import { cutsOf } from './rates-reader.ts';
import { leaderRateBoard } from './rates.ts';

/**
 * The budget of reading the frozen enterprise snapshot (HT.05, `docs/qa/perf-budget.json` rows PB-F068 and PB-F069): p95 of 800 ms on a tenant 20 times the size of the demo of PVFCCo (22 projects in 9 owner units,
 * so 440 projects in 180 units, each with the plan of the year and twelve months of actuals). The part that is code of ours and not the database is built and read here: the one reader over the frozen rows, the three
 * cuts (company, unit, project) and the comparison with the same day of last year. The SQL read of the rows is measured against a real tenant by `scripts/perf-budget.mjs` (see `docs/qa/performance.md`).
 */

const SCALE = 20;
const DEMO_PROJECTS = 22;
const DEMO_UNITS = 9;
const PROJECTS = DEMO_PROJECTS * SCALE;
const UNITS = DEMO_UNITS * SCALE;
const BUDGET_MS = 800;
const SAMPLES = 20;
const PACK = builtInPack('ENTERPRISE');
const QUERY: Omit<FigureQuery, 'measure'> = { period: { grain: 'MONTH', planYear: 2026, ordinal: 10 }, asOf: '2026-11-05', view: 'AS_REPORTED' };

const figure = (index: number, over: Partial<StoredFigure> & Pick<StoredFigure, 'kind' | 'amountVnd'>): StoredFigure => {
  const yearly = over.kind === 'PLAN_YEAR';
  return {
    id: `f-${index}-${over.kind}-${over.ordinal ?? 0}`,
    classCode: 'EQUITY',
    tierCode: 'ALL',
    measure: 'DISBURSED',
    grain: yearly ? 'YEAR' : 'MONTH',
    planYear: 2026,
    ordinal: yearly ? 0 : 1,
    basis: over.kind === 'ACTUAL' ? 'REPORTED' : 'PLAN_DECISION',
    asOfDate: '2026-01-10',
    revision: 1,
    status: 'ACCEPTED',
    ...over,
  };
};

function bookOf(index: number): FigureBook {
  const figures: StoredFigure[] = [figure(index, { kind: 'PLAN_YEAR', amountVnd: String(1_000_000 + index * 1000) })];
  for (let month = 1; month <= 10; month += 1) figures.push(figure(index, { kind: 'ACTUAL', ordinal: month, amountVnd: String(50_000 + index * 10 + month), asOfDate: `2026-${String(month + 1).padStart(2, '0')}-05` }));
  return { pack: PACK, figures, tmdt: [], yearsClosed: new Set<number>() };
}

function viewOf(snapshotId: string, asOfDate: string): EnterpriseSnapshotView {
  const figures = Array.from({ length: PROJECTS }, (_, index) => projectRowsFromBook(bookOf(index), { projectId: `p-${index}`, unitId: `u-${index % UNITS}` }, QUERY)).flat();
  return { snapshotId, revision: 1, payloadSha256: `hash-${snapshotId}`, periodId: 'period-10', period: QUERY.period, asOfDate, pack: PACK, taxonomyVersion: 1, figures, indicators: [] };
}

const directory = {
  units: new Map(Array.from({ length: UNITS }, (_, index) => [`u-${index}`, { code: `BAN-${index}`, name: `Unit ${index}` }] as const)),
  projects: new Map(Array.from({ length: PROJECTS }, (_, index) => [`p-${index}`, { code: `DA-${index}`, name: `Project ${index}` }] as const)),
};

/** Nearest-rank p95, the figure `scripts/perf-budget.mjs` judges. */
const p95Of = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.ceil(0.95 * samples.length) - 1] as number;

describe('reading the frozen enterprise snapshot at 20 times the demo scale (HT.05)', () => {
  const current = viewOf('s-now', '2026-10-31');
  const previous = viewOf('s-prior', '2025-10-31');

  it('holds the volume it claims: 440 projects in 180 units, every one with a plan and actuals', () => {
    expect(new Set(current.figures.map((row) => row.projectId)).size).toBe(PROJECTS);
    expect(new Set(current.figures.map((row) => row.unitId)).size).toBe(UNITS);
    expect(current.figures.length).toBeGreaterThanOrEqual(PROJECTS * 11);
  });

  it('builds the company, unit and project cuts and the comparison with last year at the p95 budget of the snapshot read', () => {
    const readOnce = (): number => {
      const started = performance.now();
      const board = leaderRateBoard({ current: cutsOf(new EnterpriseFigureReader(current), directory, undefined), previous: cutsOf(new EnterpriseFigureReader(previous), directory, undefined) });
      const elapsed = performance.now() - started;
      expect(board.projects).toHaveLength(PROJECTS);
      expect(board.units).toHaveLength(UNITS);
      expect(board.company.ratePct).not.toBeNull();
      return elapsed;
    };
    readOnce();
    const samples = Array.from({ length: SAMPLES }, readOnce);
    expect(p95Of(samples)).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps the rate of the whole the sum over the sum at this size, not a mean of the rates', () => {
    const cuts = cutsOf(new EnterpriseFigureReader(current), directory, undefined);
    const plan = Array.from({ length: PROJECTS }, (_, index) => 1_000_000n + BigInt(index) * 1000n).reduce((a, b) => a + b, 0n);
    expect(cuts.whole.planVnd).toBe(plan.toString());
    expect(cuts.whole.projects).toBe(PROJECTS);
  });
});
