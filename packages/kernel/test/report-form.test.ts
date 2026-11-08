import { createHash } from 'node:crypto';
import { DIS_WEEKLY_CODE, DIS_WEEKLY_INDICATORS, DIS_WEEKLY_LAYOUT, KPI_HOME_DEFAULTS, assertDeliveryTarget, assertPeriodFitsForm, defaultBasisOf, fillGrid, headerRowsOf, packageDigestOf, previewOf, validateLayout, weeklySnapshotLine } from '../src/index.ts';
import type { ReportFillData, ReportIndicatorDefinition } from '../src/index.ts';

const sha = (letter: string): string => letter.repeat(64);

describe('the digest of a copy (R17)', () => {
  it('is the digest of the lines FORMAT:sha256 in the order XLSX, DOCX, whatever order the files are given in', () => {
    const expected = createHash('sha256').update(`XLSX:${sha('a')}\nDOCX:${sha('b')}`).digest('hex');
    expect(packageDigestOf([{ format: 'DOCX', sha256: sha('b') }, { format: 'XLSX', sha256: sha('a') }])).toBe(expected);
    expect(packageDigestOf([{ format: 'XLSX', sha256: sha('a') }, { format: 'DOCX', sha256: sha('b') }])).toBe(expected);
  });

  it('changes when either file changes, and a copy of one file is not the digest of the file itself', () => {
    const one = packageDigestOf([{ format: 'XLSX', sha256: sha('a') }]);
    expect(one).not.toBe(sha('a'));
    expect(packageDigestOf([{ format: 'XLSX', sha256: sha('c') }])).not.toBe(one);
    expect(packageDigestOf([{ format: 'XLSX', sha256: sha('a') }, { format: 'DOCX', sha256: sha('b') }])).not.toBe(one);
  });

  it('refuses no file, a badly formed hash, an unknown format and a format twice', () => {
    expect(() => packageDigestOf([])).toThrow();
    expect(() => packageDigestOf([{ format: 'XLSX', sha256: 'abc' }])).toThrow();
    expect(() => packageDigestOf([{ format: 'PDF' as 'XLSX', sha256: sha('a') }])).toThrow();
    expect(() => packageDigestOf([{ format: 'XLSX', sha256: sha('a') }, { format: 'XLSX', sha256: sha('b') }])).toThrow();
  });
});

describe('the period and the target of a delivery', () => {
  it('takes only a period of the kind the form is for', () => {
    expect(() => assertPeriodFitsForm('AS_OF', { kind: 'AS_OF', year: 2026, day: '2026-10-18' })).not.toThrow();
    expect(() => assertPeriodFitsForm('MONTH', { kind: 'MONTH', year: 2026, index: 10 })).not.toThrow();
    expect(() => assertPeriodFitsForm('MONTH', { kind: 'QUARTER', year: 2026, index: 3 })).toThrow();
    expect(() => assertPeriodFitsForm('MONTH', { kind: 'MONTH', year: 2026, index: 13 })).toThrow();
  });

  it('takes a receiver code and a known channel only', () => {
    expect(() => assertDeliveryTarget('MOF', 'EMAIL')).not.toThrow();
    expect(() => assertDeliveryTarget('UB-DTPT.KHCN_1', 'PORTAL')).not.toThrow();
    expect(() => assertDeliveryTarget('bad receiver', 'EMAIL')).toThrow();
    expect(() => assertDeliveryTarget('', 'EMAIL')).toThrow();
    expect(() => assertDeliveryTarget('MOF', 'FAX')).toThrow();
  });
});

describe('the weekly report of the public edition', () => {
  const definitions: Record<string, ReportIndicatorDefinition> = {};
  for (const one of DIS_WEEKLY_INDICATORS) {
    const params = KPI_HOME_DEFAULTS[one.code]?.params as { name: string; unit: ReportIndicatorDefinition['unit']; decimals: number; period: ReportIndicatorDefinition['period'] };
    definitions[one.code] = { code: one.code, name: params.name, unit: params.unit, decimals: params.decimals, period: params.period, version: 0 };
  }
  const data = (values: Record<string, string | null>): ReportFillData => ({
    period: { kind: 'AS_OF', year: 2026, day: '2026-10-18' },
    meta: { ORG_NAME: 'Org', SNAPSHOT_LINE: weeklySnapshotLine('2026-10-12') },
    definitions,
    figures: DIS_WEEKLY_INDICATORS.map((one) => ({ code: one.code, basis: defaultBasisOf(definitions[one.code]?.period ?? 'AS_OF_NOW'), value: values[one.code] ?? null })),
    datasets: {},
  });

  it('is a valid READY layout of a system report, bound to eight codes of the register, with no demo mark', () => {
    expect(() => validateLayout(DIS_WEEKLY_LAYOUT)).not.toThrow();
    expect(DIS_WEEKLY_LAYOUT).toMatchObject({ code: DIS_WEEKLY_CODE, status: 'READY', headerMode: 'WRITE' });
    expect(DIS_WEEKLY_LAYOUT.formRef).not.toBeNull();
    expect(DIS_WEEKLY_INDICATORS).toHaveLength(8);
    for (const one of DIS_WEEKLY_INDICATORS) expect(KPI_HOME_DEFAULTS[one.code]).toBeDefined();
    expect(headerRowsOf(DIS_WEEKLY_LAYOUT.columns)).toHaveLength(1);
  });

  it('fills the figures as the form writes them and leaves a cell with no figure empty with an issue, never zero', () => {
    const grid = fillGrid(DIS_WEEKLY_LAYOUT, data({ DISBURSEMENT_RATE_PM: '60.0000', DISBURSED_TREASURY: '600000000000', OPEN_WARNINGS: '3' }));
    expect(grid.stamp).toBeNull();
    const at = (row: number): { kind: string; number?: string | undefined } => grid.cells.find((cell) => cell.row === row && cell.col === 3) ?? { kind: 'MISSING' };
    expect(at(6)).toMatchObject({ kind: 'NUMBER', number: '60.00' });
    expect(at(8)).toMatchObject({ kind: 'NUMBER', number: '600000000000' });
    expect(at(11)).toMatchObject({ kind: 'NUMBER', number: '3' });
    expect(at(7).kind).toBe('EMPTY');
    expect(grid.issues.filter((issue) => issue.code === 'NO_DATA' || issue.code === 'NO_FIGURE')).toHaveLength(5);
  });

  it('writes the snapshot line with the day as day, month, year, and says there is no snapshot when there is none', () => {
    expect(weeklySnapshotLine('2026-10-12')).toContain('12/10/2026');
    expect(weeklySnapshotLine(null)).not.toContain('{day}');
    expect(weeklySnapshotLine(null)).not.toBe(weeklySnapshotLine('2026-10-12'));
  });

  it('gives the preview the cells as text: numbers grouped, empty cells empty, the stamp absent', () => {
    const preview = previewOf(fillGrid(DIS_WEEKLY_LAYOUT, data({ DISBURSED_TREASURY: '600000000000' })));
    const text = (row: number, col: number): string | undefined => preview.rows.find((one) => one.row === row)?.cells.find((cell) => cell.col === col)?.text;
    expect(text(8, 3)).toBe('600.000.000.000');
    expect(text(6, 3)).toBe('');
    expect(preview.stamp).toBeNull();
    expect(preview.truncated).toBe(false);
    expect(preview.columns).toBe(4);
  });
});
