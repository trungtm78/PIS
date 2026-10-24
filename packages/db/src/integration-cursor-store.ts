import { DomainError, versionConflict } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { AdapterStatus } from './outgoing-document-store.ts';
import type { TenantTx } from './tenant-database.ts';

const MIN_REASON = 10;
const MAX_REASON = 2000;
/** A position is a few fields (a file name, a date, an offset); a cursor above this is a file pretending to be one. */
const MAX_CURSOR_BYTES = 8192;

export type CursorStatus = 'ACTIVE' | 'PAUSED' | 'FAILED';

export interface CursorRow {
  id: string;
  connectorCode: string;
  sourceScope: string;
  cursor: Record<string, unknown>;
  lastSuccessAt: string | null;
  schemaVersion: string;
  adapterStatus: AdapterStatus;
  status: CursorStatus;
  lastFileSha256: string | null;
  lastErrorCode: string | null;
  resetReason: string | null;
  version: number;
  updatedAt: string;
  /** The update time to the microsecond (UTC): the ordering key of the list and its cursor. */
  updatedAtKey: string;
}

/**
 * The connectors that the platform expects to feed master data, each with a position of its own. The adapter of each is PROPOSED until the
 * agency that owns the file format confirms it: the platform never calls a format verified on its own authority.
 */
export const DEFAULT_CURSORS: ReadonlyArray<{ connectorCode: string; sourceScope: string }> = [
  { connectorCode: 'NATIONAL_PIM_FILE', sourceScope: 'DEFAULT' },
  { connectorCode: 'TREASURY_STATEMENT_FILE', sourceScope: 'DEFAULT' },
  { connectorCode: 'PROCUREMENT_FILE', sourceScope: 'DEFAULT' },
  { connectorCode: 'BUDGET_CODE_FILE', sourceScope: 'DEFAULT' },
];

interface SqlRow {
  id: string;
  connector_code: string;
  source_scope: string;
  cursor_json: Record<string, unknown>;
  last_success_at: string | null;
  schema_version: string;
  adapter_status: AdapterStatus;
  status: CursorStatus;
  last_file_sha256: string | null;
  last_error_code: string | null;
  reset_reason: string | null;
  version: string;
  updated_at: string;
  updated_at_key: string;
}

const SELECT = `select id, connector_code, source_scope, cursor_json, to_char(last_success_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_success_at,
  schema_version, adapter_status, status, last_file_sha256, last_error_code, reset_reason, version::text as version,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at, ${timestampKey('updated_at')} as updated_at_key
  from machvon.integration_cursor`;

const toRow = (row: SqlRow): CursorRow => ({
  id: row.id,
  connectorCode: row.connector_code,
  sourceScope: row.source_scope,
  cursor: row.cursor_json,
  lastSuccessAt: row.last_success_at,
  schemaVersion: row.schema_version,
  adapterStatus: row.adapter_status,
  status: row.status,
  lastFileSha256: row.last_file_sha256,
  lastErrorCode: row.last_error_code,
  resetReason: row.reset_reason,
  version: Number(row.version),
  updatedAt: row.updated_at,
  updatedAtKey: row.updated_at_key,
});

/**
 * Where each integration connector has read to (ST-MDM-007, MDM 3.1 F8). A position moves forward by the connector itself; moving it by
 * hand is a reset, which needs its own permission and a reason, and is the only way a FAILED connector starts again. A reset never changes
 * the verdict on the adapter (VERIFIED/PROPOSED/MOCK/MISSING): that is a fact about the agency's format, not a setting.
 */
export class IntegrationCursorStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<CursorRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The connectors of the tenant, by name; the cursor is the connector code, then the id. */
  async list(tx: TenantTx, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<CursorRow[]> {
    const rows = await tx.query<SqlRow>(
      `${SELECT} where ($1::text is null or (connector_code, id) > ($1::text, $2::uuid)) order by connector_code, id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /** Gives the tenant the connectors it is expected to have; one it already has is left as it is. Returns how many were created. */
  async ensureDefaults(tx: TenantTx, actor: string): Promise<number> {
    let created = 0;
    for (const item of DEFAULT_CURSORS) {
      const inserted = await tx.query(
        `insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, '{}'::jsonb, '1', 'PROPOSED', 'ACTIVE', $3::uuid)
         on conflict (tenant_id, connector_code, source_scope) do nothing returning id`,
        [item.connectorCode, item.sourceScope, actor],
      );
      created += inserted.length;
    }
    return created;
  }

  /**
   * Puts the position of a connector where the caller says, for the stated reason. The connector is active again and the last error and the
   * last file are forgotten: the file that failed (or the one the position is taken back past) must be readable once more.
   */
  async reset(tx: TenantTx, id: string, expectedVersion: number, input: { reason: string; cursor: Record<string, unknown> }, actor: string): Promise<{ before: CursorRow; row: CursorRow }> {
    const reason = input.reason.trim();
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    if (typeof input.cursor !== 'object' || input.cursor === null || Array.isArray(input.cursor) || Buffer.byteLength(JSON.stringify(input.cursor)) > MAX_CURSOR_BYTES) {
      throw new DomainError('VALIDATION_FAILED', 422, 'cursor_json');
    }
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    await tx.query(
      `update machvon.integration_cursor
          set cursor_json = $2::jsonb, reset_reason = $3, status = 'ACTIVE', last_error_code = null, last_file_sha256 = null,
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [id, JSON.stringify(input.cursor), reason, actor],
    );
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, row };
  }
}
