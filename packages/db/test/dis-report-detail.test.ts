import { reportFiguresDetail } from '../src/dis-report-detail';
import type { FundingFigure } from '../src/dis-report-detail';

const line = (bucket: string, budgetLevel: string, cumulativeVnd: string, overrides: Partial<FundingFigure> = {}): FundingFigure =>
  ({ bucket, budgetLevel, cumulativeVnd, ctmtqgVnd: null, nextMonthVnd: '0', nextMonthCtmtqgVnd: null, sourceYear: null, ...overrides }) as FundingFigure;

describe('the figures of a report as the audit detail keeps them (HT.06)', () => {
  it('keys each line by its bucket and budget level, in a fixed order, with every figure and the measurement basis', () => {
    const detail = reportFiguresDetail('TREASURY', [line('LOAN', 'ALL', '30'), line('EQUITY', 'ALL', '10', { ctmtqgVnd: '4', nextMonthVnd: '2', nextMonthCtmtqgVnd: '1', sourceYear: 2026 })]);
    expect(Object.keys(detail.lines)).toEqual(['EQUITY|ALL', 'LOAN|ALL']);
    expect(detail).toEqual({
      measurement_basis: 'TREASURY',
      lines: {
        'EQUITY|ALL': { cumulative_vnd: '10', ctmtqg_vnd: '4', next_month_vnd: '2', next_month_ctmtqg_vnd: '1', source_year: 2026 },
        'LOAN|ALL': { cumulative_vnd: '30', ctmtqg_vnd: null, next_month_vnd: '0', next_month_ctmtqg_vnd: null, source_year: null },
      },
    });
  });

  it('is the same for the same figures in any order, so a before and an after differ only where a figure moved', () => {
    const one = reportFiguresDetail('TREASURY', [line('A', 'ALL', '1'), line('B', 'ALL', '2')]);
    const other = reportFiguresDetail('TREASURY', [line('B', 'ALL', '2'), line('A', 'ALL', '1')]);
    expect(other).toEqual(one);
    expect(JSON.stringify(other)).toBe(JSON.stringify(one));
  });

  it('holds no line for a report without figures', () => {
    expect(reportFiguresDetail('ACCEPTANCE', [])).toEqual({ measurement_basis: 'ACCEPTANCE', lines: {} });
  });
});
