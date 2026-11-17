import type { ClockRow, DashboardDb, DisbursementRow, FundSourceRow, ProjectRow, TargetRow, UnitRow } from '../db';

/**
 * The capital bundle of the dashboard (the clock, the funding sources, the monthly target, the units, the projects and the disbursement of each project by source and
 * month) from what the system already reads for its own screens. Nothing here asks the server: `system.ts` reads, this file turns what was read into the tables.
 *
 * Money is whole đồng as decimal text in the system and million đồng in the tables. The engine of the template draws ten months, so the period of the tables is the
 * last whole month of the frozen snapshot, at most the tenth.
 */
export interface SystemUnit { id: string; code: string; name: string; unit_type: string; parent_id: string | null }
export interface SystemProject {
  id: string; code: string; name: string; status: string; project_group: string | null; total_investment_vnd: string | null; investor_unit_id: string | null;
  status_changed_at: string | null; area: { label: string } | null; sector: { label: string } | null;
}
export interface SystemLine { project_id: string; fund_source_version_id: string | null; budget_level: string | null; plan_total_vnd: string | null }
export interface SystemFundSource { version_id: string; business_key: string }
export interface SystemAppropriation { fund_source: SystemFundSource | null; origin: string; amount_vnd: string; status?: string }
export interface SystemCurvePoint { month: number; actual_cumulative_vnd: string | null }

export interface CapitalInput {
  /** The day the screen is read (ISO). */
  today: string;
  /** The frozen snapshot the figures are of. */
  asOfDate: string;
  treasuryCutoffDate: string | null;
  /** The expected cumulative disbursement of the province, percent of the plan, month by month. */
  targetCurve: readonly { month: number; cumulative_pct: number }[];
  units: readonly SystemUnit[];
  /** The units that have not filed the period (their figure is absent, never zero). */
  notReportingUnitIds: ReadonlySet<string>;
  projects: readonly SystemProject[];
  lines: readonly SystemLine[];
  appropriations: readonly SystemAppropriation[];
  /** The cumulative disbursement of each project by month, by project id; a project the Treasury has nothing for is absent. */
  curves: Readonly<Record<string, readonly SystemCurvePoint[]>>;
  /** Days a project runs behind (its baseline, or the most overdue task of its workflow), by project id; a project with neither measure is absent. */
  delays: Readonly<Record<string, number>>;
}

export type CapitalTables = Pick<DashboardDb, 'moc_thoi_gian' | 'nguon_von' | 'muc_tieu' | 'don_vi' | 'du_an' | 'giai_ngan'>;
export interface CapitalResult {
  /** The bundle, when the system holds enough to draw every page that reads it. */
  tables?: CapitalTables;
  /** Why the bundle stays on the template: what the system does not hold enough of. Empty when `tables` is given. */
  reasons: string[];
}

const MONTHS = 10;
const MILLION = 1_000_000n;
/** What a bundle needs before it replaces the template's: fewer would leave whole pages (the ranking of units, the heat map, the health matrix) with one row or none. */
export const CAPITAL_FLOOR = { projectsWithPlan: 10, unitsWithPlan: 5, curveCoverage: 0.8, projectsWithDelayMeasure: 5 } as const;

const SOURCE_CODES = ['NSTW', 'NSDP', 'SUPPORT', 'ODAV'] as const;
type SourceCode = (typeof SOURCE_CODES)[number];
const STAGE_NAME: Readonly<Record<string, string>> = {
  CONCEPT: 'Chuẩn bị đầu tư', PIPELINE: 'Chuẩn bị đầu tư', APPRAISAL: 'Thẩm định, phê duyệt', BUDGETED: 'Chuẩn bị thực hiện', IMPLEMENTATION: 'Thực hiện',
  COMPLETED: 'Hoàn thành, quyết toán', SUSPENDED: 'Tạm dừng', REJECTED: 'Không phê duyệt',
};
const WAITING_STAGES = new Set(['Chuẩn bị đầu tư', 'Thẩm định, phê duyệt', 'Chuẩn bị thực hiện']);
const STALE_DAYS = 120;

/** Whole đồng as text to million đồng, rounded half up; absent stays absent. */
export function millions(vnd: string | null | undefined): number | null {
  if (vnd === null || vnd === undefined || !/^-?\d+$/.test(vnd)) return null;
  const value = BigInt(vnd);
  const half = MILLION / 2n;
  return Number((value >= 0n ? value + half : value - half) / MILLION);
}

/** The four sources of the template: the system's sources are grouped into them by their business key (both kinds of foreign capital are the foreign source). */
export function sourceCodeOf(businessKey: string | undefined, budgetLevel: string | null): SourceCode {
  const key = (businessKey ?? '').toUpperCase();
  if (key.startsWith('ODA')) return 'ODAV';
  if (key.startsWith('NSTW')) return 'NSTW';
  if (key.startsWith('NSDP')) return 'NSDP';
  if (key !== '' && key !== 'UNSPECIFIED') return 'SUPPORT';
  return budgetLevel === 'CENTRAL' ? 'NSTW' : 'NSDP';
}

const KHOI: Readonly<Record<string, string>> = { PROJECT_MANAGEMENT_BOARD: 'Khối Ban quản lý dự án', COMMUNE: 'Xã, phường' };
/** The short name the charts write on an axis. */
export function shortUnitName(name: string): string {
  return name
    .replace(/ tỉnh Cà Mau$/u, '')
    .replace(/^Ủy ban nhân dân/u, 'UBND')
    .replace(/^Ban Quản lý dự án xây dựng công trình /u, 'Ban QLDA công trình ')
    .replace(/^Ban Quản lý dự án công trình /u, 'Ban QLDA công trình ')
    .replace(/^Ban Quản lý dự án /u, 'Ban QLDA ');
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

/** Splits a whole amount over weights so that the parts are whole and add up to it (the largest weight takes the remainder). */
export function splitWhole(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return weights.map(() => 0);
  const parts = weights.map((weight) => Math.floor((amount * weight) / total));
  let rest = amount - parts.reduce((sum, part) => sum + part, 0);
  const order = weights.map((weight, index) => [weight, index] as const).sort((a, b) => b[0] - a[0]);
  for (let i = 0; rest > 0; i = (i + 1) % order.length, rest -= 1) parts[(order[i] as readonly [number, number])[1]] = (parts[(order[i] as readonly [number, number])[1]] as number) + 1;
  return parts;
}

/**
 * The capital bundle from the system, or the reasons the system does not hold enough for it. `lastYearPct` is the one column the system cannot supply yet (it has no
 * figures of the year before): it is taken from the template, month by month.
 */
export function capitalFromSystem(input: CapitalInput, templateSources: readonly FundSourceRow[], lastYearPct: readonly number[]): CapitalResult {
  const reasons: string[] = [];
  const period = Math.min(MONTHS, Math.max(0, Number(input.asOfDate.slice(5, 7)) - 1));
  if (period < 1) reasons.push('the frozen snapshot is of January: no whole month of the year is closed yet');
  if (input.targetCurve.length < 12) reasons.push('the expected disbursement curve has fewer than twelve months');

  const unitById = new Map(input.units.map((unit) => [unit.id, unit]));
  const sourceByVersion = new Map(input.appropriations.flatMap((a) => (a.fund_source === null ? [] : [[a.fund_source.version_id, a.fund_source.business_key] as const])));

  // The plan of each project by source: the lines of the snapshot, grouped into the four sources.
  const planOf = new Map<string, Record<SourceCode, number>>();
  for (const line of input.lines) {
    const amount = millions(line.plan_total_vnd);
    if (amount === null || amount <= 0) continue;
    const code = sourceCodeOf(line.fund_source_version_id === null ? undefined : sourceByVersion.get(line.fund_source_version_id), line.budget_level);
    const row = planOf.get(line.project_id) ?? { NSTW: 0, NSDP: 0, SUPPORT: 0, ODAV: 0 };
    row[code] += amount;
    planOf.set(line.project_id, row);
  }

  const du_an: ProjectRow[] = [];
  const giai_ngan: DisbursementRow[] = [];
  let withPlan = 0;
  let withCurve = 0;
  let withBaseline = 0;
  const unitsWithPlan = new Set<string>();
  for (const project of input.projects) {
    const unit = project.investor_unit_id === null ? undefined : unitById.get(project.investor_unit_id);
    if (unit === undefined) continue;
    const plan = planOf.get(project.id) ?? { NSTW: 0, NSDP: 0, SUPPORT: 0, ODAV: 0 };
    const planned = SOURCE_CODES.reduce((sum, code) => sum + plan[code], 0);
    const stage = STAGE_NAME[project.status] ?? 'Chuẩn bị đầu tư';
    const inStage = project.status_changed_at === null ? 0 : Math.max(0, daysBetween(project.status_changed_at, input.today));
    const delay = input.delays[project.id];
    if (delay !== undefined) withBaseline += 1;
    du_an.push({
      ma: project.code, ten: project.name, dia_ban: project.area?.label ?? 'Chưa xác định', linh_vuc: project.sector?.label ?? 'Chưa xác định', tong_muc: millions(project.total_investment_vnd) ?? 0,
      giai_doan: stage, don_vi: unit.code, nhom: project.project_group ?? 'C', ngay_cham: Math.max(0, delay ?? 0), nguyen_nhan: null, dung_yen: WAITING_STAGES.has(stage) && inStage > STALE_DAYS ? 1 : 0,
      ngay_o_giai_doan: inStage, moi_chuyen_do: 0, kho_bac_sau_ky: 0, kho_bac_7_ngay: 0, kh_NSTW: plan.NSTW, kh_NSDP: plan.NSDP, kh_SUPPORT: plan.SUPPORT, kh_ODAV: plan.ODAV,
    });
    if (planned <= 0) continue;
    withPlan += 1;
    unitsWithPlan.add(unit.code);
    const curve = input.curves[project.id];
    const sources = SOURCE_CODES.filter((code) => plan[code] > 0);
    if (curve === undefined) {
      // The Treasury has nothing for the project: the months are absent (the engine then leaves the project out of the ranking), never zero.
      for (const code of sources) for (let month = 1; month <= period; month += 1) giai_ngan.push({ du_an: project.code, nguon: code, thang: month, so_tien: month === period ? null : 0 });
      continue;
    }
    withCurve += 1;
    const cumulative = Array.from({ length: MONTHS }, (_, index) => millions(curve.find((point) => point.month === index + 1)?.actual_cumulative_vnd ?? null) ?? 0);
    for (let month = 1; month <= period; month += 1) {
      const paid = Math.max(0, (cumulative[month - 1] as number) - (month === 1 ? 0 : (cumulative[month - 2] as number)));
      // The system knows the disbursement of a project by month, not by source: it is shared over the sources of the project in the proportion of their plan.
      const parts = splitWhole(paid, sources.map((code) => plan[code]));
      sources.forEach((code, index) => giai_ngan.push({ du_an: project.code, nguon: code, thang: month, so_tien: parts[index] as number }));
    }
  }

  if (withPlan < CAPITAL_FLOOR.projectsWithPlan) reasons.push(`${withPlan} projects have a capital plan (at least ${CAPITAL_FLOOR.projectsWithPlan} are needed)`);
  if (unitsWithPlan.size < CAPITAL_FLOOR.unitsWithPlan) reasons.push(`${unitsWithPlan.size} investor units hold the planned projects (at least ${CAPITAL_FLOOR.unitsWithPlan} are needed for the pages by unit)`);
  if (withPlan > 0 && withCurve / withPlan < CAPITAL_FLOOR.curveCoverage) reasons.push(`${withCurve} of ${withPlan} planned projects have a monthly disbursement series`);
  if (withBaseline < CAPITAL_FLOOR.projectsWithDelayMeasure) reasons.push(`${withBaseline} projects have a measure of delay, a baseline or a workflow (at least ${CAPITAL_FLOOR.projectsWithDelayMeasure} are needed for the health pages)`);
  if (reasons.length > 0) return { reasons };

  // The sources: what was assigned to the province, and what of it no project holds yet.
  const assigned: Record<SourceCode, number> = { NSTW: 0, NSDP: 0, SUPPORT: 0, ODAV: 0 };
  const byPrimeMinister: Record<SourceCode, number> = { NSTW: 0, NSDP: 0, SUPPORT: 0, ODAV: 0 };
  for (const appropriation of input.appropriations) {
    if (appropriation.status !== undefined && appropriation.status !== 'PUBLISHED') continue;
    const code = sourceCodeOf(appropriation.fund_source?.business_key, null);
    const amount = millions(appropriation.amount_vnd) ?? 0;
    assigned[code] += amount;
    if (appropriation.origin !== 'LOCAL_ADDED') byPrimeMinister[code] += amount;
  }
  const allocated: Record<SourceCode, number> = { NSTW: 0, NSDP: 0, SUPPORT: 0, ODAV: 0 };
  for (const project of du_an) for (const code of SOURCE_CODES) allocated[code] += project[`kh_${code}`];
  const nguon_von: FundSourceRow[] = SOURCE_CODES.map((code) => {
    const plan = Math.max(assigned[code], allocated[code]);
    return { ma: code, ten: templateSources.find((source) => source.ma === code)?.ten ?? code, thu_tuong_giao: Math.min(plan, byPrimeMinister[code]), ke_hoach: plan, chua_phan_bo: plan - allocated[code] };
  });

  const don_vi: UnitRow[] = input.units
    .filter((unit) => unit.parent_id !== null)
    .map((unit) => ({ ma: unit.code, ten: unit.name, ten_ngan: shortUnitName(unit.name), khoi: KHOI[unit.unit_type] ?? 'Sở, ban, ngành', da_nop_so: input.notReportingUnitIds.has(unit.id) ? 0 : 1 }));
  const known = new Set(don_vi.map((unit) => unit.ma));
  const projects = du_an.filter((project) => known.has(project.don_vi));
  const kept = new Set(projects.map((project) => project.ma));

  const muc_tieu: TargetRow[] = Array.from({ length: 13 }, (_, index) => ({
    thang: index + 1,
    muc_tieu_pct: index < 12 ? (input.targetCurve.find((point) => point.month === index + 1)?.cumulative_pct ?? 100) : 100,
    cung_ky_pct: lastYearPct[index] ?? 0,
  }));
  const moc_thoi_gian: ClockRow[] = [{ hom_nay: input.today, nam: Number(input.asOfDate.slice(0, 4)), thang_chot: period, ngay_chot_so: input.asOfDate, kho_bac_den: input.treasuryCutoffDate ?? input.asOfDate, nhiem_vu_den: input.today, ghi_chu: '' }];

  return { tables: { moc_thoi_gian, nguon_von, muc_tieu, don_vi, du_an: projects, giai_ngan: giai_ngan.filter((row) => kept.has(row.du_an)) }, reasons: [] };
}
