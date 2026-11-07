import { csvOf, xlsxOf } from '../src/dis-export';
import { B1_DEFAULTS } from '../src/gov-b1-policy';
import { computeEvm, sCurve } from '../src/prj-evm';
import type { EvmLineFacts } from '../src/prj-evm';
import { buildSCurveExport } from '../src/prj-evm-export';

const line: EvmLineFacts = { key: 'c1', code: 'C1', name: 'Gói 1', bacVnd: '1000', plannedStart: '2026-01-01', plannedFinish: '2026-03-31', contracts: [{ contractId: 'k1', valueVnd: '900' }] };
const policy = B1_DEFAULTS.EVM_POLICY;

describe('the workbook of the S-curve (G1-5)', () => {
  const curve = sCurve({ v0: [line], current: [line], asOf: '2026-02-15', acceptances: [{ contractId: 'k1', day: '2026-02-01', amountVnd: '450' }], payments: [{ contractId: 'k1', day: '2026-02-10', reversedDay: null, grossVnd: '400' }] });
  const figures = computeEvm({ bac: 1000n, pv: 500n, ev: 500n, ac: 400n, missing: [] }, 'CPI_CUMULATIVE', policy, '2026-02-15');

  it('writes the header block, one row per day and no notice when everything is known', () => {
    const document = buildSCurveExport({ projectCode: 'DA-01', curve, figures, baselineVersion: 0, source: 'LIVE' });
    expect(document.title).toContain('DA-01');
    expect(document.columns.map((column) => column.key)).toEqual(['day', 'pv_v0_vnd', 'pv_current_vnd', 'ev_vnd', 'ac_vnd']);
    expect(document.rows).toHaveLength(curve.points.length);
    expect(document.rows[0]).toEqual(['2026-01-01', expect.any(String), expect.any(String), '0', '0']);
    expect(document.header.find((entry) => entry.key === 'baseline')?.value).toBe('v0');
    expect(document.header.find((entry) => entry.key === 'cpi')?.value).toBe(figures.cpi);
    expect(document.notice).toBeNull();
  });

  it('leaves the cells after the day of the view empty, not zero, and produces a csv and a workbook', () => {
    const document = buildSCurveExport({ projectCode: 'DA-01', curve, figures, baselineVersion: 1, source: 'FROZEN' });
    const last = document.rows[document.rows.length - 1] ?? [];
    expect(last[3]).toBe('');
    expect(last[4]).toBe('');
    expect(csvOf(document)).toContain('DA-01');
    const bytes = xlsxOf(document);
    expect(Buffer.from(bytes).subarray(0, 2).toString()).toBe('PK');
    expect(document.header.find((entry) => entry.key === 'source')?.value).toBe('FROZEN');
  });

  it('says why the figures are missing instead of writing zeros', () => {
    const none = computeEvm({ bac: 1000n, pv: 500n, ev: null, ac: null, missing: ['NO_CONTRACT_LINK'] }, 'CPI_CUMULATIVE', policy, '2026-02-15');
    const document = buildSCurveExport({ projectCode: 'DA-01', curve, figures: none, baselineVersion: 0, source: 'LIVE' });
    expect(document.notice).toContain('NO_CONTRACT_LINK');
    expect(document.header.find((entry) => entry.key === 'cpi')?.value).toBe('');
  });
});
