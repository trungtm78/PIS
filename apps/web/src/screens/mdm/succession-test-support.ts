import { record } from './test-support';
import fixtureText from './fixture-text.vi.json';

export const DISTRICT = record(1, { master_type: 'AREA', business_key: 'HUYEN-X', label: fixtureText['area.district.label'], attributes: { level: 'DISTRICT' }, valid_until: '2025-07-01' });
export const PROVINCE = record(2, { master_type: 'AREA', business_key: 'TINH-X', label: fixtureText['area.province.label'], attributes: { level: 'PROVINCE' } });
export const COMMUNE_A = record(3, { master_type: 'AREA', business_key: 'XA-A', label: fixtureText['area.communeA.label'], parent_record_id: DISTRICT.id, valid_until: '2025-07-01', attributes: { level: 'COMMUNE' } });
export const COMMUNE_B = record(4, { master_type: 'AREA', business_key: 'XA-B', label: fixtureText['area.communeB.label'], parent_record_id: DISTRICT.id, valid_until: '2025-07-01', attributes: { level: 'COMMUNE' } });
export const MERGED = record(5, { master_type: 'AREA', business_key: 'XA-Y', label: fixtureText['area.merged.label'], parent_record_id: PROVINCE.id, valid_from: '2025-07-01', attributes: { level: 'COMMUNE' } });

export const BASIS = 'Resolution of the 2025 reform (working assumption awaiting CXN-34)';

type Entry = { id: string; business_key: string; label?: unknown };

export const edge = (n: number, from: Entry, to: Entry, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000f1${String(n).padStart(2, '0')}`,
  predecessor_record_id: from.id,
  predecessor_key: from.business_key,
  predecessor_label: typeof from.label === 'string' ? from.label : null,
  successor_record_id: to.id,
  successor_key: to.business_key,
  successor_label: typeof to.label === 'string' ? to.label : null,
  master_type: 'AREA',
  succession_kind: 'MERGE',
  effective_date: '2025-07-01',
  share_pct: null,
  legal_basis: BASIS,
  change_request_id: `00000000-0000-4000-8000-00000000c1${String(n).padStart(2, '0')}`,
  ...overrides,
});

export const versionOf = (entry: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  id: entry.version_id,
  revision: 1,
  label: entry.label,
  parent_record_id: entry.parent_record_id ?? null,
  attributes: entry.attributes ?? {},
  valid_from: entry.valid_from ?? '2020-01-01',
  valid_until: entry.valid_until ?? null,
  status: 'EFFECTIVE',
  legal_basis: null,
  ...overrides,
});

export const target = (entry: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  record_id: entry.id,
  master_type: entry.master_type,
  business_key: entry.business_key,
  succession_kind: null,
  effective_date: null,
  share_pct: '100.00',
  in_force: true,
  version: versionOf(entry),
  ...overrides,
});

/** The answer of getMasterRecordSuccessors for an entry. */
export const conversion = (entry: Record<string, unknown>, asOf: string, edges: Array<Record<string, unknown>>, targets: Array<Record<string, unknown>>) => ({
  master_record_id: entry.id,
  master_type: entry.master_type,
  business_key: entry.business_key,
  as_of: asOf,
  edges,
  targets,
});

/** The answer of getMasterRecordAsOf for an entry. */
export const structure = (entry: Record<string, unknown>, asOf: string, overrides: Record<string, unknown> = {}) => ({
  master_record_id: entry.id,
  master_type: entry.master_type,
  business_key: entry.business_key,
  namespace: 'TENANT',
  as_of: asOf,
  state: 'IN_FORCE',
  structure_date: '2020-01-01',
  version: versionOf(entry),
  predecessors: [],
  successors: [],
  targets: [target(entry)],
  ...overrides,
});

/** An entry as a search answers it for a date on which it has no version in force. */
export const outside = (entry: Record<string, unknown>) => ({ ...entry, version_id: null, label: null, valid_from: null, valid_until: null, parent_record_id: null, attributes: null, revision: null });
