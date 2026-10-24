import { vi } from 'vitest';
import { PLATFORM_TENANT, harness as baseHarness, mount as baseMount, routeOf as baseRoute } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export { PLATFORM_TENANT };
export type { Harness };

/** The membership of the person who is signed in; a change request made by it is the person's own. */
export const ME = PLATFORM_TENANT.membershipId;
export const OTHER = '00000000-0000-4000-8000-0000000000f1';

export const STEWARD = ['master.propose', 'master.read'];
export const REVIEWER = ['master.review', 'master.read'];
export const PUBLISHER = ['master.publish', 'master.read'];
export const READER = ['master.read'];
export const CROSSWALK_MANAGER = ['master.crosswalk.manage', 'master.read', 'integration_cursor.read'];

export const routeOf = (id: string, req: string) => ({ ...baseRoute(id, req), module: 'MDM', path: `/mdm/${id.toLowerCase()}` });

export const record = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000a0${String(n).padStart(2, '0')}`,
  namespace: 'TENANT',
  master_type: 'SECTOR',
  business_key: `GT-${n}`,
  status: 'EFFECTIVE',
  label: `Giao thông ${n}`,
  valid_from: '2024-01-01',
  valid_until: null,
  version_id: `00000000-0000-4000-8000-00000000b0${String(n).padStart(2, '0')}`,
  open_change_request_id: null,
  version: 3,
  ...overrides,
});

export const version = (n: number, revision: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000b0${String(n).padStart(2, '0')}`,
  master_record_id: record(n).id,
  master_type: 'SECTOR',
  code: `GT-${n}`,
  revision,
  label: `Giao thông ${n}`,
  attributes: { group: 'infrastructure' },
  parent_record_id: null,
  valid_from: '2024-01-01',
  valid_until: null,
  status: 'EFFECTIVE',
  legal_basis: null,
  approved_by: OTHER,
  change_request_id: null,
  ...overrides,
});

export const change = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000c0${String(n).padStart(2, '0')}`,
  business_key: `GT-${n}`,
  master_record_version: 3,
  master_record_status: 'EFFECTIVE',
  master_record_namespace: 'TENANT',
  change_kind: 'UPDATE',
  master_type: 'SECTOR',
  master_record_id: record(n).id,
  status: 'IN_REVIEW',
  proposed: { label: 'Giao thông vận tải' },
  before: { label: 'Giao thông' },
  reason: 'Renamed by decision 12',
  evidence_document_id: null,
  impact: { counts: { 'project.sector_master_version_id': 2 }, total: 2, computed_at: '2026-10-24T00:00:00.000Z' },
  effective_from: '2025-06-01',
  created_by: OTHER,
  reviewed_by: null,
  decided_at: null,
  published_by: null,
  decision_document_id: null,
  version: 2,
  ...overrides,
});

export const batch = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000d0${String(n).padStart(2, '0')}`,
  master_type: 'FUND_SOURCE',
  file_object_key: `tenants/t/import/${n}`,
  file_sha256: 'a'.repeat(64),
  mapping: {},
  mode: 'ATOMIC',
  status: 'VALIDATED',
  total_rows: 10,
  error_rows: 0,
  errors: [],
  applied_at: null,
  reviewed_by: null,
  published_by: null,
  decision_document_id: null,
  created_by: OTHER,
  version: 1,
  changes: {},
  ...overrides,
});

export const crosswalk = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000e0${String(n).padStart(2, '0')}`,
  master_record_id: record(n).id,
  master_type: 'SECTOR',
  business_key: `GT-${n}`,
  source_system: 'TREASURY',
  external_type: 'AGENCY_CODE',
  external_code: `KB-${n}`,
  valid_from: '2024-01-01',
  valid_until: null,
  match_method: 'MANUAL',
  confidence: null,
  status: 'ACTIVE',
  version: 1,
  ...overrides,
});

export const cursor = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000f0${String(n).padStart(2, '0')}`,
  connector_code: `CONNECTOR_${n}`,
  source_scope: 'DEFAULT',
  last_success_at: null,
  schema_version: '1',
  adapter_status: 'PROPOSED',
  status: 'ACTIVE',
  last_file_sha256: null,
  last_error_code: null,
  reset_reason: null,
  version: 1,
  updated_at: '2026-10-24T00:00:00.000000Z',
  ...overrides,
});

export interface World {
  records: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  changes: Array<Record<string, unknown>>;
  usage: Record<string, unknown>;
  policies: Array<Record<string, unknown>>;
  /** The import batches of the tenant, the newest first. */
  imports: Array<Record<string, unknown>>;
  /** The mappings of codes of other systems, the newest first. */
  crosswalks: Array<Record<string, unknown>>;
  /** The integration connectors; the read of one adds its position (`cursor_json`). */
  cursors: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
  /** Reads of the entries of these master types fail (the other types are answered). */
  failingTypes?: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    records: [record(1), record(2, { master_type: 'FUND_SOURCE', business_key: 'NSTW', label: 'Nguồn vốn' })],
    versions: [version(1, 1)],
    changes: [],
    usage: { master_record_id: record(1).id, as_of: null, counts: {}, total: 0, samples: [] },
    policies: [],
    imports: [],
    crosswalks: [],
    cursors: [],
    failing: new Set(),
    ...overrides,
  };
}

type Query = Record<string, string | undefined>;

/** A client over `state`: every read is answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness(
    (operation, input) => {
      if (state.failing.has(operation)) return new Error(`${operation} failed`);
      const path = (input as { path?: { id?: string } } | undefined)?.path;
      if (operation === 'getMasterChangeRequest') return state.changes.find((item) => item.id === path?.id) ?? new Error('not found');
      if (operation === 'getMasterRecordUsages') return state.usage;
      if (operation === 'listMasterTypePolicies') return { items: state.policies };
      if (operation === 'getMasterImport') return state.imports.find((item) => item.id === path?.id) ?? new Error('not found');
      if (operation === 'get_resources_integration_cursor_id') return state.cursors.find((item) => item.id === path?.id) ?? new Error('not found');
      return new Error(`unexpected read ${operation}`);
    },
    command,
  );
  (h.client as unknown as { readAll: (operation: string, input?: { query?: Query }) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: { query?: Query }) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    const query = input?.query ?? {};
    if (operation === 'searchMasterRecords' && query.master_type !== undefined && state.failingTypes?.has(query.master_type) === true) return Promise.reject(new Error(`${operation} failed for ${query.master_type}`));
    switch (operation) {
      case 'searchMasterRecords':
        return Promise.resolve(state.records.filter((item) => (query.master_type === undefined || item.master_type === query.master_type) && (query.business_key === undefined || item.business_key === query.business_key) && (query.namespace === undefined || item.namespace === query.namespace)));
      case 'listMasterImports':
        return Promise.resolve(state.imports);
      case 'listMasterCrosswalks':
        return Promise.resolve(
          state.crosswalks.filter(
            (item) =>
              (query.source_system === undefined || item.source_system === query.source_system) &&
              (query.external_type === undefined || item.external_type === query.external_type) &&
              (query.status === undefined || item.status === query.status),
          ),
        );
      case 'get_resources_integration_cursor':
        return Promise.resolve(state.cursors.map((item) => Object.fromEntries(Object.entries(item).filter(([name]) => name !== 'cursor_json'))));
      case 'listMasterChangeRequests':
        return Promise.resolve(state.changes.filter((item) => query.status === undefined || item.status === query.status));
      case 'get_resources_master_record_version':
        return Promise.resolve(state.versions.filter((item) => query.master_record_id === undefined || item.master_record_id === query.master_record_id));
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

export const mount = baseMount;
