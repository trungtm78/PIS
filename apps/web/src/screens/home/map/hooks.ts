import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '@machvon/api-client';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toStructure } from '../../mdm/succession-model';
import type { StructureView } from '../../mdm/succession-model';
import { toProjectLine, toProjectView } from '../../prj/model';
import { MAX_PROJECTS, toMapProject } from './model';
import type { MapData, MapProject } from './model';

const CONCURRENCY = 8;

export const mapKey = (tenantId: string | undefined, membershipId: string | undefined, asOf: string) => ['home', 'map', tenantId, membershipId, asOf] as const;

/** The items done in groups of a few at a time, in order: a register of hundreds is not asked for all at once. */
async function inGroups<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const done: R[] = [];
  for (let from = 0; from < items.length; from += CONCURRENCY) done.push(...(await Promise.all(items.slice(from, from + CONCURRENCY).map(work))));
  return done;
}

const recordOf = (raw: unknown): string | undefined => {
  const id = (raw as { master_record_id?: unknown } | null)?.master_record_id;
  return typeof id === 'string' ? id : undefined;
};

/**
 * The placing of the projects on the structure of a date: the register of projects (`get_resources_project`), each project for the area it pins (`get_resources_project_id`), the entry that area version belongs to
 * (`get_resources_master_record_version_id`), and how the entry stands on the date (`getMasterRecordAsOf`). Each distinct area is read once. A read that fails fails the whole placing: a project is never put in a wrong area.
 */
async function loadMap(client: ApiClient, asOf: string): Promise<MapData> {
  const lines = (await client.readAll('get_resources_project')).flatMap((raw) => toProjectLine(raw) ?? []);
  const shown = lines.slice(0, MAX_PROJECTS);
  const views = (await inGroups(shown, (line) => client.read('get_resources_project_id', { path: { id: line.id } }))).flatMap((raw) => toProjectView(raw) ?? []);
  const versions = [...new Set(views.map((view) => view.area.versionId))];
  const recordByVersion = new Map<string, string>();
  await inGroups(versions, async (versionId) => {
    const record = recordOf(await client.read('get_resources_master_record_version_id', { path: { id: versionId } }));
    if (record !== undefined) recordByVersion.set(versionId, record);
  });
  const projects: MapProject[] = views.flatMap((view) => {
    const record = recordByVersion.get(view.area.versionId);
    return record === undefined ? [] : [toMapProject(view, record)];
  });
  const structures: Record<string, StructureView> = {};
  await inGroups([...new Set(projects.map((project) => project.areaRecordId))], async (recordId) => {
    const structure = toStructure(await client.read('getMasterRecordAsOf', { path: { id: recordId }, query: { date: asOf } }));
    if (structure !== undefined) structures[recordId] = structure;
  });
  return { projects, structures, truncated: lines.length > MAX_PROJECTS, asOf };
}

export function useProjectMap(asOf: string, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<MapData>({
    queryKey: mapKey(tenant?.id, tenant?.membershipId, asOf),
    queryFn: () => loadMap(client, asOf),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
