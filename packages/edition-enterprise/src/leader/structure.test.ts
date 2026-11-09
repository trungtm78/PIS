import { EnterpriseFigureReader, builtInPack, projectRowsFromBook } from '@machvon/kernel';
import type { EnterpriseSnapshotView, FigureBook, FigureQuery, StoredFigure } from '@machvon/kernel';
import { structureOf } from './structure.ts';

const PACK = builtInPack('ENTERPRISE');
let counter = 0;

const fig = (over: Partial<StoredFigure> & Pick<StoredFigure, 'kind' | 'amountVnd'>): StoredFigure => {
  counter += 1;
  const yearly = over.kind === 'PLAN_YEAR' || over.kind === 'PLAN_ADJUSTED';
  return { id: `f-${counter}`, classCode: 'EQUITY', tierCode: 'ALL', measure: 'DISBURSED', grain: yearly ? 'YEAR' : 'MONTH', planYear: 2026, ordinal: yearly ? 0 : 1, basis: over.kind === 'ACTUAL' ? 'REPORTED' : 'PLAN_DECISION', asOfDate: '2026-01-10', revision: 1, status: 'ACCEPTED', ...over };
};
const actual = (classCode: string, ordinal: number, amountVnd: string): StoredFigure => fig({ kind: 'ACTUAL', classCode, ordinal, amountVnd, asOfDate: `2026-${String(ordinal + 1).padStart(2, '0')}-05` });
const plan = (classCode: string, amountVnd: string): StoredFigure => fig({ kind: 'PLAN_YEAR', classCode, amountVnd });
const book = (figures: readonly StoredFigure[]): FigureBook => ({ pack: PACK, figures, tmdt: [], yearsClosed: new Set<number>() });
const March: Omit<FigureQuery, 'measure'> = { period: { grain: 'MONTH', planYear: 2026, ordinal: 3 }, asOf: '2026-04-05', view: 'AS_REPORTED' };

/** p1 holds equity 600 (paid 300) and loan 400 (paid 100); p2 holds equity 200 (paid 150) and no loan; nobody holds the class OTHER. */
const books: Record<string, FigureBook> = {
  p1: book([plan('EQUITY', '600'), actual('EQUITY', 1, '100'), actual('EQUITY', 2, '100'), actual('EQUITY', 3, '100'), plan('LOAN', '400'), actual('LOAN', 1, '50'), actual('LOAN', 2, '30'), actual('LOAN', 3, '20')]),
  p2: book([plan('EQUITY', '200'), actual('EQUITY', 1, '50'), actual('EQUITY', 2, '50'), actual('EQUITY', 3, '50')]),
};
const viewOf = (ids: string[]): EnterpriseSnapshotView => ({
  snapshotId: 's-1',
  revision: 1,
  payloadSha256: 'hash',
  periodId: 'period-3',
  period: March.period,
  asOfDate: '2026-10-31',
  pack: PACK,
  taxonomyVersion: 1,
  figures: ids.flatMap((id) => projectRowsFromBook(books[id] as FigureBook, { projectId: id, unitId: 'u1' }, March)),
  indicators: [],
});

describe('structureOf: equity, loan and the rest from the classes of the enterprise pack', () => {
  const reader = new EnterpriseFigureReader(viewOf(['p1', 'p2']));

  it('lists the classes of the pack in its order, with the shares on the plan and on the disbursed figure', () => {
    const structure = structureOf(reader, {});
    expect(structure.classes.map((one) => one.classCode)).toEqual(['EQUITY', 'LOAN', 'OTHER']);
    expect(structure).toMatchObject({ measure: 'DISBURSED', planTotalVnd: '1200', disbursedTotalVnd: '550' });
    // equity: plan 800 of 1200, paid 450 of 550; loan: plan 400 of 1200, paid 100 of 550
    expect(structure.classes[0]).toMatchObject({ planVnd: '800', disbursedVnd: '450', planSharePct: '66.6667', disbursedSharePct: '81.8182', ratePct: '56.2500' });
    expect(structure.classes[1]).toMatchObject({ planVnd: '400', disbursedVnd: '100', planSharePct: '33.3333', disbursedSharePct: '18.1818', ratePct: '25.0000' });
  });

  it('a class nobody has a figure for is null in every field, never 0', () => {
    const other = structureOf(reader, {}).classes[2];
    expect(other).toMatchObject({ classCode: 'OTHER', planVnd: null, disbursedVnd: null, planSharePct: null, disbursedSharePct: null, ratePct: null });
  });

  it('narrows to the projects the reader may read', () => {
    const structure = structureOf(reader, { projectIds: ['p2'] });
    expect(structure).toMatchObject({ planTotalVnd: '200', disbursedTotalVnd: '150' });
    expect(structure.classes[0]).toMatchObject({ planSharePct: '100.0000', ratePct: '75.0000' });
    expect(structure.classes[1]).toMatchObject({ planVnd: null, planSharePct: null });
  });

  it('a reader who may read no project gets no totals', () => {
    expect(structureOf(reader, { projectIds: [] })).toMatchObject({ planTotalVnd: null, disbursedTotalVnd: null });
  });
});
