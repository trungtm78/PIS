import { EnterpriseFigureReader, projectRowsFromBook } from '@machvon/kernel/src/enterprise-snapshot.ts';
import type { EnterpriseSnapshotView } from '@machvon/kernel/src/enterprise-snapshot.ts';
import type { StoredFigure } from '@machvon/kernel/src/fnd-actuals.ts';
import type { FigureBook, FigureQuery } from '@machvon/kernel/src/fnd-figures.ts';
import { builtInPack } from '@machvon/kernel/src/fnd-taxonomy.ts';
import { DEMO_MARK, REPORT_FORM_CATALOGUE, fillGrid } from '@machvon/kernel/src/report-layout.ts';
import type { FormPeriod } from '@machvon/kernel/src/report-layout.ts';
import { DEMO_FORMS, ENTERPRISE_SNAPSHOT_PROVIDER, enterpriseReportBundles, illustrativeFillData, snapshotFigures, snapshotFillData } from '../src/report-forms/exports.ts';
import type { DemoFormSpec, SnapshotProjectName } from '../src/report-forms/exports.ts';

const PACK = builtInPack('ENTERPRISE');
let counter = 0;
const fig = (over: Partial<StoredFigure> & Pick<StoredFigure, 'kind' | 'amountVnd'>): StoredFigure => {
  counter += 1;
  const yearly = over.kind === 'PLAN_YEAR' || over.kind === 'PLAN_ADJUSTED';
  return { id: `f-${counter}`, classCode: 'EQUITY', tierCode: 'ALL', measure: 'DISBURSED', grain: yearly ? 'YEAR' : 'MONTH', planYear: 2026, ordinal: yearly ? 0 : 1, basis: over.kind === 'ACTUAL' ? 'REPORTED' : 'PLAN_DECISION', asOfDate: '2026-01-10', revision: 1, status: 'ACCEPTED', ...over };
};
const actual = (ordinal: number, amountVnd: string, over: Partial<StoredFigure> = {}): StoredFigure => fig({ kind: 'ACTUAL', ordinal, amountVnd, asOfDate: `2026-${String(ordinal + 1).padStart(2, '0')}-05`, ...over });

const book = (figures: StoredFigure[], tmdt: string): FigureBook => ({ pack: PACK, figures, tmdt: [{ effectiveOn: '2025-01-01', amountVnd: tmdt }], yearsClosed: new Set<number>() });
const QUERY: Omit<FigureQuery, 'measure'> = { period: { grain: 'MONTH', planYear: 2026, ordinal: 10 }, asOf: '2026-11-05', view: 'AS_REPORTED' };
const months = (measure: 'DISBURSED' | 'EXECUTED', amounts: number[], classCode = 'EQUITY'): StoredFigure[] => amounts.map((amount, index) => actual(index + 1, String(amount), { measure, classCode }));

const one = book([fig({ kind: 'PLAN_YEAR', amountVnd: '10000' }), fig({ kind: 'PLAN_YEAR', amountVnd: '5000', classCode: 'LOAN' }), ...months('DISBURSED', [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]), ...months('DISBURSED', [10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 'LOAN'), fig({ kind: 'PLAN_YEAR', amountVnd: '9000', measure: 'EXECUTED' }), ...months('EXECUTED', [200, 200, 200, 200, 200, 200, 200, 200, 200, 200])], '90000');
// The second project has a disbursed plan and nothing was executed: its executed figures must stay empty, never zero.
const two = book([fig({ kind: 'PLAN_YEAR', amountVnd: '20000' }), ...months('DISBURSED', [300, 300, 300, 300, 300, 300, 300, 300, 300, 300])], '40000');

const names = new Map<string, SnapshotProjectName>([
  ['p1', { code: 'P-1', name: 'Project one', group: 'A', unitName: 'Unit one' }],
  ['p2', { code: 'P-2', name: 'Project two', group: 'B', unitName: 'Unit two' }],
]);

const viewOf = (period: FormPeriod): EnterpriseSnapshotView => ({
  snapshotId: 's-1',
  revision: 2,
  payloadSha256: 'a'.repeat(64),
  periodId: 'period-1',
  period: period.kind === 'QUARTER' ? { grain: 'QUARTER', planYear: 2026, ordinal: 3 } : { grain: 'MONTH', planYear: 2026, ordinal: 10 },
  asOfDate: '2026-11-05',
  pack: PACK,
  taxonomyVersion: 1,
  figures: [
    ...projectRowsFromBook(one, { projectId: 'p1', unitId: 'u1' }, period.kind === 'QUARTER' ? { ...QUERY, period: { grain: 'QUARTER', planYear: 2026, ordinal: 3 } } : QUERY),
    ...projectRowsFromBook(two, { projectId: 'p2', unitId: 'u2' }, period.kind === 'QUARTER' ? { ...QUERY, period: { grain: 'QUARTER', planYear: 2026, ordinal: 3 } } : QUERY),
  ],
  indicators: [],
});

const periodOf = (form: DemoFormSpec): FormPeriod => (REPORT_FORM_CATALOGUE.find((entry) => entry.code === form.layout.code)?.period === 'QUARTER' ? { kind: 'QUARTER', year: 2026, index: 3 } : { kind: 'MONTH', year: 2026, index: 10 });
const figureOf = (figures: ReturnType<typeof snapshotFigures>, code: string) => figures.find((one) => one.code === code);

describe('the six enterprise forms filled from a frozen snapshot (ENT-3a, R21)', () => {
  it('every demo form names the snapshot provider and stays a DEMO form with its illustrative data', () => {
    const bundles = enterpriseReportBundles();
    expect(bundles).toHaveLength(6);
    for (const bundle of bundles) {
      expect(bundle).toMatchObject({ dataSource: 'ILLUSTRATIVE', provider: null, snapshotProvider: ENTERPRISE_SNAPSHOT_PROVIDER });
      expect(bundle.layout.status).toBe('DEMO');
      expect(bundle.illustrative).toBeDefined();
    }
  });

  describe('the headline figures', () => {
    const reader = new EnterpriseFigureReader(viewOf({ kind: 'MONTH', year: 2026, index: 10 }));
    const figures = snapshotFigures(reader, '2026-11-05');

    it('are sums over the whole snapshot read through the one reader, and the rates are sums over sums', () => {
      expect(figureOf(figures, 'ENT_PLAN_IN_FORCE')?.value).toBe('35000');
      expect(figureOf(figures, 'ENT_DISBURSED_YTD')?.value).toBe('4100');
      expect(figureOf(figures, 'ENT_EXECUTED_YTD')?.value).toBe('2000');
      expect(figureOf(figures, 'ENT_TOTAL_INVESTMENT')?.value).toBe('130000');
      expect(figureOf(figures, 'ENT_RATE_DISBURSED_YTD')?.value).toBe('11.7143');
      expect(figureOf(figures, 'ENT_RATE_EXECUTED_YTD')?.value).toBe('5.7143');
      expect(figureOf(figures, 'ENT_CAPITAL_EQUITY')?.value).toBe('30000');
      expect(figureOf(figures, 'ENT_CAPITAL_DEBT')?.value).toBe('5000');
      expect(figureOf(figures, 'ENT_SHARE_EQUITY')?.value).toBe('85.7143');
      expect(figureOf(figures, 'ENT_PROJECTS_TOTAL')?.value).toBe('2');
    });

    it('leave a figure nobody has empty: the schedule counts and the outlook of a year nobody estimated are null, never zero', () => {
      expect(figureOf(figures, 'ENT_PROJECTS_ON_TRACK')?.value).toBeNull();
      expect(figureOf(figures, 'ENT_PROJECTS_DELAYED')?.value).toBeNull();
      expect(figureOf(figures, 'ENT_OUTLOOK_YEAR')?.value).toBeNull();
      expect(figureOf(figures, 'ENT_RATE_OUTLOOK_YEAR')?.value).toBeNull();
    });
  });

  for (const form of DEMO_FORMS) {
    describe(form.layout.code, () => {
      const period = periodOf(form);
      const reader = new EnterpriseFigureReader(viewOf(period));
      const data = snapshotFillData(form, period, reader, names, 'Enterprise');
      const first = form.groups[0]?.dataset as string;

      it('lists every project of the snapshot once, in the order of their codes, with the figures of the snapshot and an empty cell where nobody has a figure', () => {
        const rows = data.datasets[first] ?? [];
        expect(rows.map((row) => row['code'])).toEqual(['P-1', 'P-2']);
        expect(rows[0]).toMatchObject({ name: 'Project one', grp: 'A', owner_unit: 'Unit one', tmdt: '90000', plan_force: '15000', disb_ytd: String(period.kind === 'QUARTER' ? 990 : 1100), exec_ytd: String(period.kind === 'QUARTER' ? 1800 : 2000), cap_equity: '10000', cap_debt: '5000' });
        expect(rows[1]).toMatchObject({ plan_force: '20000', disb_ytd: String(period.kind === 'QUARTER' ? 2700 : 3000), exec_ytd: null, exec_p: null, est_p: null, outlook: null });
        for (const group of form.groups.slice(1)) if (group.dataset !== 'items') expect(data.datasets[group.dataset]).toEqual([]);
      });

      it('carries the figures of the datasets: the strip and the table cannot disagree', () => {
        const rows = data.datasets[first] ?? [];
        const sum = (field: string): string => rows.reduce((total, row) => total + BigInt(String(row[field] ?? '0')), 0n).toString();
        expect(figureOf([...data.figures], 'ENT_DISBURSED_YTD')?.value).toBe(sum('disb_ytd'));
        expect(figureOf([...data.figures], 'ENT_PLAN_IN_FORCE')?.value).toBe(sum('plan_force'));
      });

      it('fills the grid of the DEMO layout, keeps the demo mark, and says what it lacks instead of writing zero', () => {
        const grid = fillGrid(form.layout, data);
        expect(grid.status).toBe('DEMO');
        expect(grid.stamp).toBe(DEMO_MARK);
        expect(grid.issues.length).toBeGreaterThan(0);
        // The illustrative data of the same form has no gap; the snapshot does, and the grid reports it.
        expect(fillGrid(form.layout, illustrativeFillData(form, period)).issues).toHaveLength(0);
        const empties = grid.cells.filter((cell) => cell.kind === 'NUMBER' && cell.number === '0');
        expect(empties.filter((cell) => cell.text === undefined || cell.text === null).length).toBe(empties.length);
      });
    });
  }
});
