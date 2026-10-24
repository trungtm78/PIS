import type { RecordView } from './model';
import type { EdgeView } from './succession-model';

/** What a cell of the structure tables can look up: the entries by id and the successions that touch an entry. */
export interface StructureContext {
  byId: ReadonlyMap<string, RecordView>;
  /** The successions in force on the date that hand an entry over to others (the first step only). */
  successorsOf(record: RecordView): EdgeView[];
  /** The successions in force on the date that brought other entries into this one. */
  predecessorsOf(record: RecordView): EdgeView[];
  /** The name of a kind of succession. */
  kind(edge: EdgeView): string;
  /** The name of an entry: its own on the date, else the one it had when it handed over. */
  nameOf(record: RecordView): string;
}

export interface StructureColumn {
  key: string;
  read(record: RecordView, context: StructureContext): string;
}

export interface StructureConfig {
  id: string;
  /** The segment of the keys of the screen: `mdm.<slug>.page.title`. */
  slug: string;
  types: readonly string[];
  /** The entries are shown as a tree under their parents. */
  tree: boolean;
  columns: readonly StructureColumn[];
}

const column = (key: string, read: StructureColumn['read']): StructureColumn => ({ key, read });
const attribute = (record: RecordView, name: string): string => {
  const value = record.attributes[name];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};
const keysOf = (edges: readonly EdgeView[], side: 'successor' | 'predecessor'): string =>
  [...new Set(edges.map((edge) => (side === 'successor' ? edge.successorKey : edge.predecessorKey)))].join(', ');

const KEY = column('key', (record) => record.businessKey);
const NAME = column('name', (record, { nameOf }) => nameOf(record));
const VALIDITY = column('validity', (record) => (record.validFrom === null ? '' : `${record.validFrom} → ${record.validUntil ?? ''}`));
const SUCCESSOR = column('successor', (record, { successorsOf }) => keysOf(successorsOf(record), 'successor'));
const INHERITED = column('inherited', (record, { predecessorsOf }) => keysOf(predecessorsOf(record), 'predecessor'));
const KIND = column('successionKind', (record, { successorsOf, kind }) => [...new Set(successorsOf(record).map(kind))].join(', '));
const BASIS = column('reformBasis', (record, { successorsOf }) => [...new Set(successorsOf(record).map((edge) => edge.legalBasis))].join(' · '));
const PARENT = column('parent', (record, { byId }) => (record.parentRecordId === null ? '' : (byId.get(record.parentRecordId)?.businessKey ?? '')));

/** MDM-02 (areas and their history of mergers) and MDM-03 (agencies and investors with their successor). */
export const STRUCTURES: Readonly<Record<string, StructureConfig>> = {
  'MDM-02': {
    id: 'MDM-02',
    slug: 'area',
    types: ['AREA', 'ADMIN_UNIT'],
    tree: true,
    columns: [KEY, NAME, column('level', (record) => attribute(record, 'level')), VALIDITY, SUCCESSOR, KIND, BASIS, INHERITED],
  },
  'MDM-03': {
    id: 'MDM-03',
    slug: 'agency',
    types: ['AGENCY'],
    tree: false,
    columns: [
      KEY,
      column('legalName', (record, { nameOf }) => nameOf(record)),
      column('agencyKind', (record) => attribute(record, 'kind')),
      PARENT,
      VALIDITY,
      SUCCESSOR,
      column('validUntil', (record) => record.validUntil ?? ''),
    ],
  },
};
