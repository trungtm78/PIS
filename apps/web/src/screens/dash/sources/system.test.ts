import type { ApiClient } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { readDashboard } from '../hooks';
import { referenceProblems } from './assemble';
import { readCapitalInput } from './system';

const BN = 1_000_000_000;
const dong = (billions: number): string => String(Math.round(billions * BN));
const TODAY = '2026-11-17';
const SNAPSHOT = 's-1';
const ROOT = { id: 'u-root', code: 'CM-UBND', name: 'Ủy ban nhân dân tỉnh Cà Mau', unit_type: 'OTHER', parent_id: null };

interface World {
  units: number;
  perUnit: number;
  baselines: boolean;
  /** Operations that fail. */
  broken?: readonly string[];
}

/** A stand-in for the API of a province: `units` investor units of the demo tenant, `perUnit` planned projects each. The codes are the ones the template uses, so its other bundles stand beside the system's. */
function clientOf(world: World): { client: ApiClient; calls: string[] } {
  const calls: string[] = [];
  const unitCodes = ['CM-BQLDAGT', 'CM-BQLDAXD', 'CM-BQLDANN', 'CM-STC', 'CM-SXD', 'CM-SYT', 'CM-SGDDT'].slice(0, world.units);
  const units = [ROOT, ...unitCodes.map((code, i) => ({ id: `u-${i}`, code, name: `Đơn vị ${code}`, unit_type: i < 3 ? 'PROJECT_MANAGEMENT_BOARD' : 'DEPARTMENT', parent_id: 'u-root' }))];
  const projectCodes = ['DA-DT205', 'DA-TH012', 'DA-YT007', 'DA-NN031', 'DA-MT019', 'DA-CN026', 'DA-VH044', 'DA-GT118', 'DA-GD022', 'DA-ICT03', 'DA-TL001', 'DA-DC071', 'DA-TT015', 'DA-MT101', 'DA-MT102', 'DA-NN103', 'DA-NN104', 'DA-GT105', 'DA-GT106', 'DA-GT107', 'DA-CN108'];
  const projects = Array.from({ length: world.units * world.perUnit }, (_, i) => ({ id: `p-${i}`, code: projectCodes[i] ?? `DA-X${i}`, name: `Dự án ${i}`, status: 'IMPLEMENTATION', project_group: 'B', total_investment_vnd: dong(300), investor_unit_id: `u-${i % world.units}`, status_changed_at: '2026-05-01T00:00:00Z', area: { label: 'Xã Tân Tiến' }, sector: { label: 'Giao thông' } }));
  const answer = (operation: string, input: { path?: { id?: string }; query?: Record<string, string> } = {}): unknown => {
    calls.push(operation);
    if (world.broken?.includes(operation)) throw new Error(`${operation} failed`);
    const id = input.path?.id ?? input.query?.project_id ?? '';
    switch (operation) {
      case 'getCommandCenter': return { snapshot_id: SNAPSHOT, as_of_date: '2026-11-13', treasury_cutoff_date: '2026-11-12' };
      case 'getCommitteeWorkspace': return { policy: { curve: [4, 8, 15, 25, 35, 50, 60, 70, 80, 90, 95, 100].map((cumulative_pct, i) => ({ month: i + 1, cumulative_pct })) }, units: [{ unit_id: 'u-1', not_reporting: true }] };
      case 'get_resources_organization_unit': return units;
      case 'get_resources_project': return projects.map(({ id: projectId, code, name, investor_unit_id }) => ({ id: projectId, code, name, investor_unit_id }));
      case 'get_resources_project_id': return projects.find((project) => project.id === id);
      case 'listPeriodSnapshotLines': return projects.flatMap((project) => [{ project_id: project.id, fund_source_version_id: 'fs-tw', budget_level: 'CENTRAL', plan_total_vnd: dong(60) }, { project_id: project.id, fund_source_version_id: null, budget_level: 'LOCAL', plan_total_vnd: dong(40) }, { project_id: project.id, fund_source_version_id: 'fs-oda', budget_level: 'CENTRAL', plan_total_vnd: dong(20) }]);
      case 'listAppropriations': return [{ fund_source: { version_id: 'fs-tw', business_key: 'NSTW-DTPT' }, origin: 'PM_ASSIGNED', amount_vnd: dong(2000), status: 'PUBLISHED' }, { fund_source: { version_id: 'fs-oda', business_key: 'ODA-ONLEND' }, origin: 'CENTRAL_SUPPORT', amount_vnd: dong(500), status: 'PUBLISHED' }];
      case 'getDisbursementForecast': return { disbursed_vnd: dong(55), curve: Array.from({ length: 11 }, (_, m) => ({ month: m + 1, actual_cumulative_vnd: dong((m + 1) * 5), forecast_cumulative_vnd: null })) };
      case 'getProjectBaseline': return world.baselines ? { has_baseline: true, deviation: { finish_slip_days: 21 } } : { has_baseline: false, deviation: null };
      default: throw new Error(`unexpected operation ${operation}`);
    }
  };
  const client = { read: (operation: string, input?: never) => Promise.resolve().then(() => answer(operation, input)), readAll: (operation: string, input?: never) => Promise.resolve().then(() => answer(operation, input) as unknown[]) };
  return { client: client as unknown as ApiClient, calls };
}

describe('what the capital bundle is read from', () => {
  it('reads the snapshot, the curve, the units, every project with its plan lines, monthly series and baseline', async () => {
    const { client, calls } = clientOf({ units: 5, perUnit: 2, baselines: true });
    const input = await readCapitalInput(client, TODAY);
    expect(input).toMatchObject({ today: TODAY, asOfDate: '2026-11-13', treasuryCutoffDate: '2026-11-12' });
    expect(input.targetCurve).toHaveLength(12);
    expect(input.units).toHaveLength(6);
    expect([...input.notReportingUnitIds]).toEqual(['u-1']);
    expect(input.projects).toHaveLength(10);
    expect(input.projects[0]).toMatchObject({ code: 'DA-DT205', investor_unit_id: 'u-0', area: { label: 'Xã Tân Tiến' }, sector: { label: 'Giao thông' } });
    expect(input.lines).toHaveLength(30);
    expect(Object.keys(input.curves)).toHaveLength(10);
    expect(input.delays['p-0']).toBe(21);
    // One read of the detail, of the series and of the baseline for each project, and no more.
    expect(calls.filter((name) => name === 'get_resources_project_id')).toHaveLength(10);
    expect(calls.filter((name) => name === 'getDisbursementForecast')).toHaveLength(10);
    expect(calls.filter((name) => name === 'getProjectBaseline')).toHaveLength(10);
  });

  it('fails when the command center names no frozen snapshot', async () => {
    const client = { read: () => Promise.resolve({}), readAll: () => Promise.resolve([]) } as unknown as ApiClient;
    await expect(readCapitalInput(client, TODAY)).rejects.toThrow(/no frozen snapshot/);
  });
});

describe('the dashboard: real figures where there are enough, the template where there are not', () => {
  it('takes the capital bundle from the system when it holds enough, and keeps the other bundles of the template that still name its units and projects', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: true });
    const read = await readDashboard(client, TODAY);
    expect(read.notes).toEqual([]);
    expect(read.origins).toMatchObject({ du_an: 'system', don_vi: 'system', giai_ngan: 'system', nguon_von: 'system', muc_tieu: 'system', moc_thoi_gian: 'system', nhiem_vu: 'template', ho_so_trinh: 'template', nv_goc: 'template', luot_giao: 'template' });
    expect(read.db.du_an).toHaveLength(10);
    expect(read.db.moc_thoi_gian[0]).toMatchObject({ hom_nay: TODAY, thang_chot: 10, ngay_chot_so: '2026-11-13', kho_bac_den: '2026-11-12' });
    // The tasks of the template that name a unit or a project the system does not have are left out; what is left holds together.
    expect(read.db.nhiem_vu.length).toBeGreaterThan(0);
    expect(read.db.nhiem_vu.length).toBeLessThan(930);
    expect(referenceProblems(read.db)).toEqual([]);
    expect(read.db.nv_goc).toHaveLength(60);
  });

  it('keeps the template, and says what is missing, when one investor holds every project and no project has a baseline', async () => {
    const { client, calls } = clientOf({ units: 1, perUnit: 12, baselines: false });
    const read = await readDashboard(client, TODAY);
    expect(new Set(Object.values(read.origins))).toEqual(new Set(['template']));
    expect(read.db.du_an).toHaveLength(45);
    expect(read.notes.join(' | ')).toMatch(/1 investor units/);
    // The register of projects already shows it: the projects are not read one by one for a bundle that cannot be used.
    expect(calls.filter((name) => name === 'get_resources_project_id' || name === 'getDisbursementForecast' || name === 'getProjectBaseline')).toHaveLength(0);
  });

  it('keeps the template when the projects are spread over enough units but none has a baseline', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: false });
    const read = await readDashboard(client, TODAY);
    expect(new Set(Object.values(read.origins))).toEqual(new Set(['template']));
    expect(read.notes.join(' | ')).toMatch(/0 projects have a baseline/);
  });

  it('keeps the template, and says so, when the system cannot be read', async () => {
    const { client } = clientOf({ units: 5, perUnit: 2, baselines: true, broken: ['getCommitteeWorkspace'] });
    const read = await readDashboard(client, TODAY);
    expect(new Set(Object.values(read.origins))).toEqual(new Set(['template']));
    expect(read.notes.join(' | ')).toMatch(/could not be read/);
    expect(read.db.nhiem_vu).toHaveLength(930);
  });
});
