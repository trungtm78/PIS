import type { EnterpriseFigureReader } from '@machvon/kernel';
import type { RateCuts, RateGroup, RateReading } from './rates.ts';

/** The ratio of the pack the board shows: what was disbursed since the start of the year over the plan in force for the year (HSKT BC.02 "ty le giai ngan so voi ke hoach nam"). */
export const LEADER_RATE_INDICATOR = 'RATE_YEAR_IN_FORCE';
export const LEADER_RATE_MEASURE = 'DISBURSED' as const;

/** The code and name of a unit or project, read from the register by the store (the snapshot holds ids only). */
export interface NamedRef {
  code: string;
  name: string;
}

export interface RateDirectory {
  units: ReadonlyMap<string, NamedRef>;
  projects: ReadonlyMap<string, NamedRef>;
}

const NOTHING: RateReading = { projects: 0, planVnd: '0', disbursedVnd: null, ratePct: null, nullReason: 'NO_DATA' };

function readingOf(reader: EnterpriseFigureReader, scope: { unitId?: string; projectIds?: readonly string[] }): RateReading {
  const indicator = reader.rate(scope, LEADER_RATE_MEASURE, LEADER_RATE_INDICATOR);
  if (indicator === undefined) return NOTHING;
  return { projects: indicator.projects, planVnd: indicator.denominatorVnd, disbursedVnd: indicator.numeratorVnd, ratePct: indicator.ratePct, nullReason: indicator.nullReason };
}

const byCode = (a: RateGroup, b: RateGroup): number => (a.code ?? '').localeCompare(b.code ?? '', 'en') || (a.id ?? '').localeCompare(b.id ?? '', 'en');

/**
 * The three cuts of a frozen enterprise snapshot, all through the one reader (R21): the whole, each unit, each project. `visible` is the projects the reader of the dashboard may read (undefined for the whole tenant),
 * so a unit head sees the company figure of their own scope and never a figure that includes a project they cannot read; a unit or a project outside it is not listed.
 */
export function cutsOf(reader: EnterpriseFigureReader, directory: RateDirectory, visible: readonly string[] | undefined): RateCuts {
  const allowed = visible === undefined ? undefined : new Set(visible);
  const projectIds = reader.projectIds().filter((id) => allowed === undefined || allowed.has(id));
  const scoped = visible === undefined ? {} : { projectIds };
  const units: RateGroup[] = reader
    .unitIds()
    .filter((unitId) => projectIds.some((projectId) => reader.unitOfProject(projectId) === unitId))
    .map((unitId) => ({ id: unitId, code: directory.units.get(unitId)?.code ?? null, name: directory.units.get(unitId)?.name ?? null, reading: readingOf(reader, { unitId, ...scoped }) }))
    .sort(byCode);
  const projects: RateGroup[] = projectIds
    .map((projectId) => ({ id: projectId, code: directory.projects.get(projectId)?.code ?? null, name: directory.projects.get(projectId)?.name ?? null, reading: readingOf(reader, { projectIds: [projectId] }) }))
    .sort(byCode);
  return { snapshotId: reader.view.snapshotId, asOfDate: reader.view.asOfDate, revision: reader.view.revision, hash: reader.hash, whole: readingOf(reader, scoped), units, projects };
}
