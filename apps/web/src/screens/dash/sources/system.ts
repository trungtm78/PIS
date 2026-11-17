import type { ApiClient } from '@machvon/api-client';
import { CAPITAL_FLOOR } from './capital';
import type { CapitalInput, SystemAppropriation, SystemCurvePoint, SystemLine, SystemProject, SystemUnit } from './capital';

/**
 * Reads what the capital bundle is built from, with the reads the other screens of the product already use (the command center, the committee workspace, the register of
 * units and projects, the lines of the frozen snapshot, the appropriations, the forecast and the baseline of each project). The answers are taken loosely typed, field by
 * field: an answer of another shape gives an absent value, which `capitalFromSystem` then counts as "not enough" and never as a figure.
 */
const CONCURRENCY = 6;
const STAGES_WITH_BASELINE = new Set(['IMPLEMENTATION', 'BUDGETED', 'SUSPENDED']);

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => (typeof value === 'object' && value !== null ? (value as Raw) : {});
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.map(record) : []);
const labelOf = (value: unknown): { label: string } | null => { const label = text(record(value).label); return label === null ? null : { label }; };

async function inGroups<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const done: R[] = [];
  for (let from = 0; from < items.length; from += CONCURRENCY) done.push(...(await Promise.all(items.slice(from, from + CONCURRENCY).map(work))));
  return done;
}

/** The system was read and does not hold enough for the bundle: not a failure of the read. */
export class NotEnoughError extends Error {}

/** The answers are read through the operations by name; the typed client checks the names, the shapes are read here. */
type LooseClient = { read(operation: string, input?: unknown): Promise<unknown>; readAll(operation: string, input?: unknown): Promise<unknown[]> };

export async function readCapitalInput(apiClient: ApiClient, today: string): Promise<CapitalInput> {
  const client = apiClient as unknown as LooseClient;
  const [centerRaw, workspaceRaw, unitsRaw, projectsRaw, appropriationsRaw] = await Promise.all([
    client.read('getCommandCenter'),
    client.read('getCommitteeWorkspace'),
    client.readAll('get_resources_organization_unit'),
    client.readAll('get_resources_project'),
    client.readAll('listAppropriations'),
  ]);
  const center = record(centerRaw);
  const workspace = record(workspaceRaw);
  const asOfDate = text(center.as_of_date);
  const snapshotId = text(center.snapshot_id);
  if (asOfDate === null || snapshotId === null) throw new Error('the command center names no frozen snapshot');

  const units: SystemUnit[] = unitsRaw.map(record).flatMap((unit) => {
    const id = text(unit.id), code = text(unit.code), name = text(unit.name);
    return id === null || code === null || name === null ? [] : [{ id, code, name, unit_type: text(unit.unit_type) ?? 'OTHER', parent_id: text(unit.parent_id) }];
  });

  // The register of projects already says how many investor units there are: with too few of them the bundle cannot replace the template's, and the hundred reads below (one
  // or more for each project) would be asked of the server for nothing every time the leader home opens.
  const investors = new Set(projectsRaw.map(record).flatMap((project) => text(project.investor_unit_id) ?? []));
  if (investors.size < CAPITAL_FLOOR.unitsWithPlan) throw new NotEnoughError(`${investors.size} investor units hold the projects (at least ${CAPITAL_FLOOR.unitsWithPlan} are needed for the pages by unit)`);

  const ids = projectsRaw.map(record).flatMap((project) => text(project.id) ?? []);
  const details = await inGroups(ids, (id) => client.read('get_resources_project_id', { path: { id } }).catch(() => undefined));
  const projects: SystemProject[] = details.map(record).flatMap((project) => {
    const id = text(project.id), code = text(project.code), name = text(project.name), status = text(project.status);
    if (id === null || code === null || name === null || status === null) return [];
    return [{ id, code, name, status, project_group: text(project.project_group), total_investment_vnd: text(project.total_investment_vnd), investor_unit_id: text(project.investor_unit_id), status_changed_at: text(project.status_changed_at), area: labelOf(project.area), sector: labelOf(project.sector) }];
  });

  const lines: SystemLine[] = (await client.readAll('listPeriodSnapshotLines', { path: { id: snapshotId } })).map(record).flatMap((line) => {
    const projectId = text(line.project_id);
    return projectId === null ? [] : [{ project_id: projectId, fund_source_version_id: text(line.fund_source_version_id), budget_level: text(line.budget_level), plan_total_vnd: text(line.plan_total_vnd) }];
  });

  const appropriations: SystemAppropriation[] = appropriationsRaw.map(record).flatMap((row) => {
    const amount = text(row.amount_vnd), origin = text(row.origin);
    if (amount === null || origin === null) return [];
    const source = record(row.fund_source); const version = text(source.version_id), key = text(source.business_key);
    const status = text(row.status);
    return [{ fund_source: version === null || key === null ? null : { version_id: version, business_key: key }, origin, amount_vnd: amount, ...(status === null ? {} : { status }) }];
  });

  // The monthly series of every project that holds a plan, and the baseline of every project that is being carried out: one read each, a few at a time.
  const planned = new Set(lines.filter((line) => line.plan_total_vnd !== null && line.plan_total_vnd !== '0').map((line) => line.project_id));
  const curves: Record<string, SystemCurvePoint[]> = {};
  await inGroups(projects.filter((project) => planned.has(project.id)), async (project) => {
    const forecast = record(await client.read('getDisbursementForecast', { query: { project_id: project.id, snapshot_id: snapshotId } }).catch(() => undefined));
    if (text(forecast.disbursed_vnd) === null) return;
    const points = list(forecast.curve).flatMap((point) => (typeof point.month === 'number' ? [{ month: point.month, actual_cumulative_vnd: text(point.actual_cumulative_vnd) }] : []));
    if (points.length > 0) curves[project.id] = points;
  });
  const delays: Record<string, number> = {};
  await inGroups(projects.filter((project) => STAGES_WITH_BASELINE.has(project.status)), async (project) => {
    const baseline = record(await client.read('getProjectBaseline', { path: { id: project.id } }).catch(() => undefined));
    const slip = record(baseline.deviation).finish_slip_days;
    if (baseline.has_baseline === true && typeof slip === 'number') delays[project.id] = slip;
  });

  const targetCurve = list(record(workspace.policy).curve).flatMap((point) => (typeof point.month === 'number' && typeof point.cumulative_pct === 'number' ? [{ month: point.month, cumulative_pct: point.cumulative_pct }] : []));
  const notReportingUnitIds = new Set(list(workspace.units).flatMap((unit) => (unit.not_reporting === true ? (text(unit.unit_id) ?? []) : [])));

  return { today, asOfDate, treasuryCutoffDate: text(center.treasury_cutoff_date), targetCurve, units, notReportingUnitIds, projects, lines, appropriations, curves, delays };
}
