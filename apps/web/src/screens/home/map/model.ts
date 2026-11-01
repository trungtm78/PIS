import { isCalendarDate } from '../../mdm/model';
import type { StructureView, TargetView } from '../../mdm/succession-model';
import type { ProjectStatus, ProjectView } from '../../prj/model';

/**
 * HOME-05: the project map by the administrative structure of a date (ST-HOME-006, BR-HOME-07, CXN-34, UAT-AC277). A project is placed in the area it names, as that area stands on the date asked for: an area that was merged or split
 * before then is shown as the area or areas it became, with the date of the structure. A project with no coordinates is listed apart and never put at the centre of a province. The API holds no coordinates for a project yet, so every
 * project is in that list and the placing is by area.
 */
export const HOME_PERMISSION = 'home.read';
/** What the placing reads: the register of projects, the area each names, the version of the master entry, and how the entry stands on the date. */
export const READ_PERMISSIONS = ['home.read', 'project.read', 'master_record_version.read', 'master.read'] as const;
/** Each project is read one by one for its area; the map shows this many and says when there are more. */
export const MAX_PROJECTS = 200;

export interface MapProject {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  sectorKey: string | null;
  sectorLabel: string | null;
  /** The master entry (not the version) of the area the project is in. */
  areaRecordId: string;
}

/** The area of a project from its workspace: the version it pins names the entry whose structure is read. */
export function toMapProject(view: ProjectView, areaRecordId: string): MapProject {
  return { id: view.id, code: view.code, name: view.name, status: view.status, sectorKey: view.sector?.businessKey ?? null, sectorLabel: view.sector?.label ?? null, areaRecordId };
}

export interface MapData {
  projects: MapProject[];
  /** How each area entry stands on the date, by the id of the entry. */
  structures: Record<string, StructureView>;
  /** There were more projects than the map reads. */
  truncated: boolean;
  asOf: string;
}

export interface ClusterProject {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  /** The part of the area the project sat in that went to this area, in percent; 100.00 unless the area was split. */
  sharePct: string;
}

export interface Cluster {
  /** The id of the area entry on the date, or the empty key of the projects whose area is not in any structure on it. */
  key: string;
  label: string;
  /** The date of the structure the area belongs to: when it began or last took part in a succession. */
  structureDate: string | null;
  /** Whether the area has a version in force on the date; an area that does not is shown by its key, with that said. */
  inForce: boolean;
  projects: ClusterProject[];
}

export const OUTSIDE = '';

const labelOf = (target: TargetView): string => target.version?.label ?? target.businessKey;

/** The projects placed under the areas of the structure of the date, areas in order of name, projects in order of code. An area that stood on the date is itself the one it converts to. */
export function clustersOf(projects: readonly MapProject[], structures: Readonly<Record<string, StructureView>>): Cluster[] {
  const clusters = new Map<string, Cluster>();
  for (const project of projects) {
    const structure = structures[project.areaRecordId];
    const targets = structure?.targets ?? [];
    if (structure === undefined || targets.length === 0) {
      const outside = clusters.get(OUTSIDE) ?? { key: OUTSIDE, label: '', structureDate: null, inForce: false, projects: [] };
      outside.projects.push({ id: project.id, code: project.code, name: project.name, status: project.status, sharePct: '100.00' });
      clusters.set(OUTSIDE, outside);
      continue;
    }
    for (const target of targets) {
      const cluster = clusters.get(target.recordId) ?? { key: target.recordId, label: labelOf(target), structureDate: structure.structureDate, inForce: target.inForce, projects: [] };
      cluster.projects.push({ id: project.id, code: project.code, name: project.name, status: project.status, sharePct: target.sharePct });
      clusters.set(target.recordId, cluster);
    }
  }
  return [...clusters.values()]
    .map((cluster) => ({ ...cluster, projects: [...cluster.projects].sort((left, right) => left.code.localeCompare(right.code)) }))
    .sort((left, right) => (left.key === OUTSIDE ? 1 : right.key === OUTSIDE ? -1 : left.label.localeCompare(right.label)));
}

export interface Filters {
  status: ProjectStatus | '';
  sector: string;
}

export const NO_FILTER: Filters = { status: '', sector: '' };

export function filterProjects(projects: readonly MapProject[], filters: Filters): MapProject[] {
  return projects.filter((project) => (filters.status === '' || project.status === filters.status) && (filters.sector === '' || project.sectorKey === filters.sector));
}

/** The sectors among the projects, once each, in order of name. */
export function sectorsOf(projects: readonly MapProject[]): Array<{ key: string; label: string }> {
  const seen = new Map<string, string>();
  for (const project of projects) if (project.sectorKey !== null) seen.set(project.sectorKey, project.sectorLabel ?? project.sectorKey);
  return [...seen].map(([key, label]) => ({ key, label })).sort((left, right) => left.label.localeCompare(right.label));
}

/** A date for the address: a real calendar date, or nothing. */
export const validDate = (value: string | null): string | undefined => (value !== null && isCalendarDate(value) ? value : undefined);
