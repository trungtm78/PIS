import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { delayCauseGroups, delayCauseOptions } from '@machvon/kernel/src/delay-cause.ts';
import type { DelayCauseGroupList, DelayCauseOption, IssueCategoryEntry } from '@machvon/kernel/src/delay-cause.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** An ISSUE_CATEGORY entry (MDM-17) as the catalogue read returns it; an entry that is not in force is dropped. */
export function toIssueCategoryEntry(raw: unknown): IssueCategoryEntry[] {
  if (!isRecord(raw)) return [];
  const key = text(raw.business_key);
  const versionId = text(raw.version_id);
  const recordId = text(raw.id);
  if (key === undefined || versionId === undefined || recordId === undefined || raw.status !== 'EFFECTIVE') return [];
  return [{ key, label: text(raw.label) ?? key, versionId, recordId, parentRecordId: text(raw.parent_id) ?? null, attributes: isRecord(raw.attributes) ? raw.attributes : {} }];
}

export interface DelayCauses {
  options: DelayCauseOption[];
  groups: DelayCauseGroupList[];
}

/**
 * The standard causes of delay (MD.02, ENT-4e): the entries of the catalogue ISSUE_CATEGORY (MDM-17) that carry `delay_cause`. The project issue form and the narrative forms of the enterprise edition read this one list and cite a cause
 * by its `key`, never by its label, so a rename of the label does not change what a report says.
 */
export function useDelayCauses(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DelayCauses>({
    queryKey: ['mdm', tenant?.id, 'delay-causes'],
    queryFn: async () => {
      const entries = (await client.readAll('searchMasterRecords', { query: { master_type: 'ISSUE_CATEGORY' } })).flatMap(toIssueCategoryEntry);
      const options = delayCauseOptions(entries);
      return { options, groups: delayCauseGroups(options) };
    },
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
