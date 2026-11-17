import { describe, expect, it } from 'vitest';
import type { DashboardDb } from '../db';
import { E } from '../template/engine.js';
import { assemble } from './assemble';
import { CAPITAL_FLOOR, capitalFromSystem, millions, shortUnitName, sourceCodeOf, splitWhole } from './capital';
import type { CapitalInput, SystemProject } from './capital';
import { loadTemplateDb } from './template-db';

const BN = 1_000_000_000;
const dong = (billions: number): string => String(Math.round(billions * BN));
const LAST_YEAR = [1.8, 4.1, 7.6, 12, 17.5, 23.9, 31, 38.6, 46.9, 55.8, 66, 84.5, 93.1];
const SOURCES = [
  { version_id: 'fs-tw', business_key: 'NSTW-DTPT' },
  { version_id: 'fs-dp', business_key: 'NSDP-DTPT' },
  { version_id: 'fs-oda', business_key: 'ODA-ONLEND' },
];

/** A province with `units` investor units and `perUnit` projects each, every project planned on the central and the local budget, and the first two also on foreign capital. */
function province(units: number, perUnit: number, options: { baselines?: number; curves?: boolean } = {}): CapitalInput {
  const unitRows = [
    { id: 'u-root', code: 'CM-UBND', name: 'Ủy ban nhân dân tỉnh Cà Mau', unit_type: 'OTHER', parent_id: null },
    ...Array.from({ length: units }, (_, i) => ({ id: `u-${i}`, code: `CM-U${i}`, name: i === 0 ? 'Ban Quản lý dự án xây dựng tỉnh Cà Mau' : `Sở số ${i}`, unit_type: i === 0 ? 'PROJECT_MANAGEMENT_BOARD' : 'DEPARTMENT', parent_id: 'u-root' })),
  ];
  const projects: SystemProject[] = [];
  const lines: CapitalInput['lines'][number][] = [];
  const curves: Record<string, { month: number; actual_cumulative_vnd: string }[]> = {};
  const delays: Record<string, number> = {};
  for (let u = 0; u < units; u += 1) {
    for (let k = 0; k < perUnit; k += 1) {
      const id = `p-${u}-${k}`;
      const index = projects.length;
      projects.push({ id, code: `DA-${u}${k}`, name: `Dự án ${u}.${k}`, status: 'IMPLEMENTATION', project_group: 'B', total_investment_vnd: dong(400), investor_unit_id: `u-${u}`, status_changed_at: '2026-06-01T00:00:00Z', area: { label: 'Xã Tân Tiến' }, sector: { label: 'Giao thông' } });
      lines.push({ project_id: id, fund_source_version_id: 'fs-tw', budget_level: 'CENTRAL', plan_total_vnd: dong(60) }, { project_id: id, fund_source_version_id: 'fs-dp', budget_level: 'LOCAL', plan_total_vnd: dong(40) });
      if (index < 2) lines.push({ project_id: id, fund_source_version_id: 'fs-oda', budget_level: 'CENTRAL', plan_total_vnd: dong(50) });
      if (options.curves !== false) curves[id] = Array.from({ length: 11 }, (_, m) => ({ month: m + 1, actual_cumulative_vnd: dong((m + 1) * 5) }));
      if (index < (options.baselines ?? 99)) delays[id] = index % 3 === 0 ? 40 : index % 3 === 1 ? 12 : 0;
    }
  }
  return {
    today: '2026-11-17', asOfDate: '2026-11-13', treasuryCutoffDate: '2026-11-13',
    targetCurve: [4, 8, 15, 25, 35, 50, 60, 70, 80, 90, 95, 100].map((cumulative_pct, i) => ({ month: i + 1, cumulative_pct })),
    units: unitRows, notReportingUnitIds: new Set(['u-1']), projects, lines,
    appropriations: [
      { fund_source: SOURCES[0] ?? null, origin: 'PM_ASSIGNED', amount_vnd: dong(2000), status: 'PUBLISHED' },
      { fund_source: SOURCES[1] ?? null, origin: 'LOCAL_ADDED', amount_vnd: dong(1500), status: 'PUBLISHED' },
      { fund_source: SOURCES[2] ?? null, origin: 'CENTRAL_SUPPORT', amount_vnd: dong(500), status: 'PUBLISHED' },
      { fund_source: { version_id: 'fs-ctmt', business_key: 'CTMTQG-DTTS' }, origin: 'CENTRAL_SUPPORT', amount_vnd: dong(300), status: 'PUBLISHED' },
      { fund_source: SOURCES[1] ?? null, origin: 'REVENUE_INCREASE', amount_vnd: dong(20), status: 'DRAFT' },
    ],
    curves, delays,
  };
}

describe('the small rules of the capital bundle', () => {
  it('turns whole đồng into million đồng, and keeps an absent amount absent', () => {
    expect(millions('965414000000')).toBe(965_414);
    expect(millions('1499999')).toBe(1);
    expect(millions('1500000')).toBe(2);
    expect(millions(null)).toBeNull();
    expect(millions('12.5')).toBeNull();
  });

  it('groups the sources of the system into the four of the template', () => {
    expect(sourceCodeOf('NSTW-DTPT', 'CENTRAL')).toBe('NSTW');
    expect(sourceCodeOf('NSDP-DTPT', 'LOCAL')).toBe('NSDP');
    expect(sourceCodeOf('ODA-ONLEND', 'CENTRAL')).toBe('ODAV');
    expect(sourceCodeOf('ODA-NONLEND', 'CENTRAL')).toBe('SUPPORT');
    expect(sourceCodeOf('CTMTQG-DTTS', 'CENTRAL')).toBe('SUPPORT');
    // A line that names no source is read by the budget it is on.
    expect(sourceCodeOf(undefined, 'CENTRAL')).toBe('NSTW');
    expect(sourceCodeOf('UNSPECIFIED', 'LOCAL')).toBe('NSDP');
  });

  it('shares a whole amount over weights without losing a unit', () => {
    expect(splitWhole(100, [60, 40])).toEqual([60, 40]);
    expect(splitWhole(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(splitWhole(7, [0, 0])).toEqual([0, 0]);
    expect(splitWhole(101, [60, 40, 50]).reduce((a, b) => a + b, 0)).toBe(101);
  });

  it('shortens the name of a unit the way the charts write it', () => {
    expect(shortUnitName('Ban Quản lý dự án xây dựng công trình giao thông tỉnh Cà Mau')).toBe('Ban QLDA công trình giao thông');
    expect(shortUnitName('Ủy ban nhân dân phường Tân Thành')).toBe('UBND phường Tân Thành');
    expect(shortUnitName('Sở Tài chính')).toBe('Sở Tài chính');
  });
});

describe('the capital bundle from the system', () => {
  it('stays on the template, and says why, when one investor holds every project and no project has a baseline (the demo server today)', async () => {
    const template = await loadTemplateDb();
    const result = capitalFromSystem(province(1, 32, { baselines: 0 }), template.nguon_von, LAST_YEAR);
    expect(result.tables).toBeUndefined();
    expect(result.reasons.join(' | ')).toMatch(/1 investor units/);
    expect(result.reasons.join(' | ')).toMatch(/0 projects have a measure of delay/);
  });

  it('stays on the template when the Treasury has no monthly series for most projects, or too few projects are planned', async () => {
    const template = await loadTemplateDb();
    expect(capitalFromSystem(province(6, 3, { curves: false }), template.nguon_von, LAST_YEAR).reasons.join(' | ')).toMatch(/monthly disbursement series/);
    expect(capitalFromSystem(province(CAPITAL_FLOOR.unitsWithPlan, 1), template.nguon_von, LAST_YEAR).reasons.join(' | ')).toMatch(/projects have a capital plan/);
  });

  it('calls the support of the centre a foreign grant when it is made of grants alone, and stays on the template without a foreign loan', async () => {
    const template = await loadTemplateDb();
    const input = province(6, 3);
    const grant = { ...input, appropriations: [...input.appropriations.filter((row) => row.fund_source?.version_id !== 'fs-ctmt'), { fund_source: { version_id: 'fs-grant', business_key: 'ODA-NONLEND' }, origin: 'CENTRAL_SUPPORT', amount_vnd: dong(400), status: 'PUBLISHED' }] };
    const sources = capitalFromSystem(grant, template.nguon_von, LAST_YEAR).tables?.nguon_von ?? [];
    expect(sources.find((source) => source.ma === 'SUPPORT')).toMatchObject({ ten: 'Vốn nước ngoài (cấp phát)', ke_hoach: 400_000, chua_phan_bo: 400_000 });
    const noLoan = { ...input, lines: input.lines.filter((line) => line.fund_source_version_id !== 'fs-oda'), appropriations: input.appropriations.filter((row) => row.fund_source?.version_id !== 'fs-oda') };
    expect(capitalFromSystem(noLoan, template.nguon_von, LAST_YEAR).reasons.join(' | ')).toMatch(/no capital is planned on ODAV/);
  });

  it('reads a planned project the Treasury has paid nothing for as nothing paid, and as an absent figure when the snapshot names no Treasury day', async () => {
    const template = await loadTemplateDb();
    const input = province(6, 3);
    const unpaid = { ...input, curves: Object.fromEntries(Object.entries(input.curves).filter(([id]) => id !== 'p-5-2')), unpaidProjectIds: new Set(['p-5-2']) };
    const rowsOf = (tables: ReturnType<typeof capitalFromSystem>['tables']) => (tables?.giai_ngan ?? []).filter((row) => row.du_an === 'DA-52' && row.thang === 10).map((row) => row.so_tien);
    expect(rowsOf(capitalFromSystem(unpaid, template.nguon_von, LAST_YEAR).tables)).toEqual([0, 0]);
    expect(rowsOf(capitalFromSystem({ ...unpaid, treasuryCutoffDate: null }, template.nguon_von, LAST_YEAR).tables)).toEqual([null, null]);
    // A read that failed is not an answer: the figure stays absent.
    expect(rowsOf(capitalFromSystem({ ...unpaid, unpaidProjectIds: new Set<string>() }, template.nguon_von, LAST_YEAR).tables)).toEqual([null, null]);
  });

  it('is taken from the system when it holds enough, and the engine draws it with totals that add up', async () => {
    const template = await loadTemplateDb();
    const input = province(6, 3);
    const result = capitalFromSystem(input, template.nguon_von, LAST_YEAR);
    expect(result.reasons).toEqual([]);
    const tables = result.tables as NonNullable<typeof result.tables>;
    // The period is the last whole month of the snapshot of 13 November: October.
    expect(tables.moc_thoi_gian[0]).toMatchObject({ hom_nay: '2026-11-17', nam: 2026, thang_chot: 10, ngay_chot_so: '2026-11-13' });
    expect(tables.don_vi.map((unit) => unit.ma)).not.toContain('CM-UBND');
    expect(tables.don_vi.find((unit) => unit.ma === 'CM-U1')?.da_nop_so).toBe(0);
    expect(tables.don_vi.find((unit) => unit.ma === 'CM-U0')).toMatchObject({ khoi: 'Khối Ban quản lý dự án', ten_ngan: 'Ban QLDA xây dựng' });
    expect(tables.du_an).toHaveLength(18);
    expect(tables.du_an[0]).toMatchObject({ kh_NSTW: 60_000, kh_NSDP: 40_000, kh_ODAV: 50_000, giai_doan: 'Thực hiện', ngay_cham: 40, linh_vuc: 'Giao thông' });
    // Assigned 2.000 + 1.500 + 500 billion (the draft is not capital yet); what no project holds is the part not allocated.
    const bySource = Object.fromEntries(tables.nguon_von.map((source) => [source.ma, source]));
    expect(bySource.SUPPORT).toMatchObject({ ten: 'Trung ương hỗ trợ có mục tiêu', ke_hoach: 300_000, chua_phan_bo: 300_000 });
    expect(bySource.NSTW).toMatchObject({ ke_hoach: 2_000_000, thu_tuong_giao: 2_000_000, chua_phan_bo: 2_000_000 - 18 * 60_000 });
    expect(bySource.NSDP).toMatchObject({ ke_hoach: 1_500_000, thu_tuong_giao: 0, chua_phan_bo: 1_500_000 - 18 * 40_000 });
    expect(bySource.ODAV).toMatchObject({ ke_hoach: 500_000, chua_phan_bo: 400_000 });
    // 5 billion a month for ten months for each project, shared over its sources: nothing is lost in the sharing.
    const paid = tables.giai_ngan.reduce((sum, row) => sum + (row.so_tien ?? 0), 0);
    expect(paid).toBe(18 * 10 * 5_000);
    expect(tables.nguon_von.map((source) => source.ma)).toEqual(['NSTW', 'NSDP', 'SUPPORT', 'ODAV']);
    expect(tables.muc_tieu).toHaveLength(13);
    expect(tables.muc_tieu[9]).toEqual({ thang: 10, muc_tieu_pct: 90, cung_ky_pct: 55.8 });

    // The whole database: the capital bundle of the system beside the other bundles of the template, which name the units and the projects of the template.
    const db: DashboardDb = { ...template, ...tables, nhiem_vu: [], ho_so_trinh: [] };
    const data = assemble(template, { ...tables, nhiem_vu: [], ho_so_trinh: [] });
    expect(data.origins.du_an).toBe('system');
    expect(data.origins.nv_goc).toBe('template');
    const invest = E.invest(db) as unknown as { plan: number; disb: number; ps: unknown[]; units: { rank?: number }[]; ky: number };
    expect(invest.ky).toBe(10);
    expect(invest.plan).toBe(4_300_000);
    expect(invest.disb).toBe(18 * 10 * 5_000);
    expect(invest.ps).toHaveLength(18);
    // The unit that has not filed stands outside the ranking; the other five are ranked.
    expect(invest.units.filter((unit) => unit.rank !== undefined)).toHaveLength(6);
  });
});
