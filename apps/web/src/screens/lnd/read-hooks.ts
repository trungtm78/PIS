import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useScopeKey } from './hooks';
import { toParcelLine, toSectionOption, toUnitOption } from './model';
import type { ParcelLine, SectionOption, UnitOption } from './model';

/** A project the caller may read: the screen shows the parcels of one of them at a time. */
export interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

function toProjectOption(raw: unknown): ProjectOption[] {
  const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return typeof row.id === 'string' && typeof row.code === 'string' ? [{ id: row.id, code: row.code, name: typeof row.name === 'string' ? row.name : '' }] : [];
}

/** The projects of the register in the scope of the caller, by internal code. */
export function useProjectOptions() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ProjectOption[]>({
    queryKey: [...key, 'projects'],
    queryFn: async () => (await client.readAll('get_resources_project')).flatMap(toProjectOption),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The parcels of a project in the scope of the caller, by code. */
export function useParcels(projectId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ParcelLine[]>({
    queryKey: [...key, 'parcels', projectId ?? ''],
    queryFn: async () => (await client.readAll('listLandParcels', { query: { project_id: projectId ?? '' } })).flatMap((raw) => toParcelLine(raw) ?? []),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The sections of a project: the filter of the list and the choice of the form. */
export function useSections(projectId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<SectionOption[]>({
    queryKey: [...key, 'sections', projectId ?? ''],
    queryFn: async () => (await client.readAll('listLandSections', { query: { project_id: projectId ?? '' } })).flatMap(toSectionOption),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The units that can answer for a parcel. */
export function useUnits(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<UnitOption[]>({
    queryKey: [...key, 'units'],
    queryFn: async () => (await client.readAll('get_resources_organization_unit')).flatMap(toUnitOption),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}
