import { CATALOGUES } from '../../mdm/catalogues';
import { MASTER_READ_PERMISSION, recordLink } from '../../mdm/model';
import type { RecordView } from '../../mdm/model';

/** The master data routes that ADM-05 only points to: the data and its commands belong to MDM (ADM has no write command of its own). */
export const HUB_PATH = '/mdm/mdm-01';
export const DETAIL_PATH = '/mdm/mdm-27';
export { MASTER_READ_PERMISSION };

const SCREEN_OF_TYPE: ReadonlyMap<string, string> = new Map(Object.values(CATALOGUES).flatMap((catalogue) => catalogue.types.map((type) => [type, catalogue.id] as const)));

/** The route of the catalogue screen that holds the entries of a type; the types without a screen of their own are filtered on the hub. */
export function catalogueRoute(masterType: string): string {
  const screen = SCREEN_OF_TYPE.get(masterType);
  return screen === undefined ? `${HUB_PATH}?type=${encodeURIComponent(masterType)}` : `/mdm/${screen.toLowerCase()}`;
}

/** The route of one entry on the master data detail screen. */
export const entryRoute = (record: RecordView): string => recordLink(DETAIL_PATH, record.masterType, record.businessKey, record.namespace);

/** Whether the person may open the master data routes: reading the catalogues is the permission of the master data module. */
export const mayOpenCatalogues = (permissions: readonly string[] | undefined): boolean => permissions === undefined || permissions.includes(MASTER_READ_PERMISSION);

export interface CatalogueGroup {
  masterType: string;
  total: number;
  inForce: number;
}

/** The types the tenant holds entries of, with how many entries each has and how many are in force, by type. */
export function groupsOf(records: readonly RecordView[]): CatalogueGroup[] {
  const groups = new Map<string, CatalogueGroup>();
  for (const record of records) {
    const group = groups.get(record.masterType) ?? { masterType: record.masterType, total: 0, inForce: 0 };
    group.total += 1;
    if (record.status === 'EFFECTIVE') group.inForce += 1;
    groups.set(record.masterType, group);
  }
  return [...groups.values()].sort((left, right) => left.masterType.localeCompare(right.masterType));
}

/** The name a tenant sees: the alias it set on an entry of the platform, else the label of the version in force. */
export const nameOf = (record: RecordView): string => record.aliasLabel ?? record.label ?? '';

/** The revision of the version in force, as the catalogues write it (v3); empty for an entry that has none. */
export const versionOf = (record: RecordView): string => (record.revision === null ? '' : `v${record.revision}`);

export const validityOf = (record: RecordView): string => (record.validFrom === null ? '' : `${record.validFrom} → ${record.validUntil ?? ''}`);
