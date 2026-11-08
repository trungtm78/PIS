import { DomainError, versionConflict } from '@machvon/kernel';
import type { TenantTx } from '@machvon/db';
import { EBS_ADAPTER_STATUS, EBS_CONNECTOR_CODE, EBS_FILE_POSITION, EBS_LAYOUT_VERSION, EBS_SOURCE_SYSTEM, ebsConnectionMove } from './ebs-rules.ts';
import { HPM_ADAPTER_STATUS, HPM_CONNECTOR_CODE, HPM_PACKAGE_FORMAT, hpmConnectionMove } from './hpm-rules.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** What the application knows about one connection of the enterprise edition: its code, the layout it starts under, how it is registered with the connector registry, and the rule that moves it on or off. */
export interface EntConnectionDef {
  code: string;
  layoutVersion: string;
  mode: 'FILE_EXPORT' | 'FILE_IMPORT';
  adapterStatus: 'PROPOSED';
  config: Readonly<Record<string, unknown>>;
  /** The positions of the file import framework (`integration_cursor`) the connection keeps in step. */
  positions: readonly string[];
  move(current: { enabled: boolean }, target: { enabled: unknown; reason: unknown }): { enabled: boolean; reason: string };
}

export const HPM_CONNECTION: EntConnectionDef = {
  code: HPM_CONNECTOR_CODE,
  layoutVersion: HPM_PACKAGE_FORMAT,
  mode: 'FILE_EXPORT',
  adapterStatus: HPM_ADAPTER_STATUS,
  config: { adapter: 'file-writer', credentials: 'none' },
  positions: [],
  move: hpmConnectionMove,
};

export const EBS_CONNECTION: EntConnectionDef = {
  code: EBS_CONNECTOR_CODE,
  layoutVersion: EBS_LAYOUT_VERSION,
  mode: 'FILE_IMPORT',
  adapterStatus: EBS_ADAPTER_STATUS,
  config: { positions: { EBS_FILE: EBS_FILE_POSITION }, source_system: EBS_SOURCE_SYSTEM, credentials: 'none' },
  positions: [EBS_FILE_POSITION],
  move: ebsConnectionMove,
};

export interface EntConnectionRow {
  id: string | null;
  connectorCode: string;
  enabled: boolean;
  layoutVersion: string;
  stateReason: string | null;
  stateChangedBy: string | null;
  stateChangedAt: string | null;
  /** 1 for a tenant that never used the connection: the first command creates the row at version 1. */
  version: number;
  updatedAt: string | null;
}

interface ConnectionSql {
  id: string;
  connector_code: string;
  enabled: boolean;
  layout_version: string;
  state_reason: string | null;
  state_changed_by: string | null;
  state_changed_at: string | null;
  version: string;
  updated_at: string;
}

const SELECT = `select id, connector_code, enabled, layout_version, state_reason, state_changed_by, to_char(state_changed_at at time zone 'UTC', ${ISO}) as state_changed_at,
  version::text as version, to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at from machvon.ent_connection`;

const rowOf = (row: ConnectionSql): EntConnectionRow => ({
  id: row.id,
  connectorCode: row.connector_code,
  enabled: row.enabled,
  layoutVersion: row.layout_version,
  stateReason: row.state_reason,
  stateChangedBy: row.state_changed_by,
  stateChangedAt: row.state_changed_at,
  version: Number(row.version),
  updatedAt: row.updated_at,
});

export interface EntPositionRow {
  connectorCode: string;
  cursorStatus: string | null;
  adapterStatus: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastFileSha256: string | null;
}

/**
 * The connection of a tenant to one system around the enterprise (`hpm.reports`, `ebs.ledger`), after `egp.muasamcong` (EGP-1): the entry of the connector registry (ADM, Draft, adapter PROPOSED: only a VERIFIED adapter may
 * be Active), the switch with its reason and history, and for a file import the positions of the framework. Nothing here opens a connection to anything.
 */
export class EntConnectionStore {
  private readonly def: EntConnectionDef;

  constructor(def: EntConnectionDef) {
    this.def = def;
  }

  private get fallback(): EntConnectionRow {
    return { id: null, connectorCode: this.def.code, enabled: true, layoutVersion: this.def.layoutVersion, stateReason: null, stateChangedBy: null, stateChangedAt: null, version: 1, updatedAt: null };
  }

  /** The connection as the tenant has it, or the default a first command will create. A read never writes. */
  async current(tx: TenantTx): Promise<EntConnectionRow> {
    const rows = await tx.query<ConnectionSql>(`${SELECT} where connector_code = $1`, [this.def.code]);
    return rows[0] === undefined ? this.fallback : rowOf(rows[0]);
  }

  /** Gives the tenant the connection: the row of the switch (on, with a CREATED event), the entry of the registry (Draft, PROPOSED) and the positions of the file import. What the tenant already has is left as it is. */
  async ensure(tx: TenantTx, actor: string): Promise<{ row: EntConnectionRow; created: boolean }> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.ent_connection (tenant_id, id, connector_code, enabled, layout_version, version, created_by, updated_by)
       values (${TENANT}, gen_random_uuid(), $1, true, $2, 1, $3::uuid, $3::uuid)
       on conflict (tenant_id, connector_code) do nothing
       returning id`,
      [this.def.code, this.def.layoutVersion, actor],
    );
    if (inserted[0] !== undefined) {
      await tx.query(
        `insert into machvon.ent_connection_event (tenant_id, id, connection_id, action, reason, actor_id, connection_version) values (${TENANT}, gen_random_uuid(), $1::uuid, 'CREATED', null, $2::uuid, 1)`,
        [inserted[0].id, actor],
      );
    }
    await tx.query(
      `insert into machvon.integration_connector (tenant_id, id, connector_code, adapter_status, mode, config_json, mapping_version, status, version, created_by, updated_by)
       values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, 'Draft', 1, $6::uuid, $6::uuid)
       on conflict (tenant_id, connector_code) do nothing`,
      [this.def.code, this.def.adapterStatus, this.def.mode, JSON.stringify(this.def.config), this.def.layoutVersion, actor],
    );
    for (const code of this.def.positions) {
      await tx.query(
        `insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status, updated_by)
         values (${TENANT}, gen_random_uuid(), $1, 'DEFAULT', '{}'::jsonb, '1', 'PROPOSED', 'ACTIVE', $2::uuid)
         on conflict (tenant_id, connector_code, source_scope) do nothing`,
        [code, actor],
      );
    }
    return { row: await this.current(tx), created: inserted[0] !== undefined };
  }

  /** The registry entry of the connector, or undefined for a tenant that has not used it yet. */
  async registryEntry(tx: TenantTx): Promise<{ status: string; adapterStatus: string; mode: string; mappingVersion: string | null } | undefined> {
    const rows = await tx.query<{ status: string; adapter_status: string; mode: string; mapping_version: string | null }>('select status, adapter_status, mode, mapping_version from machvon.integration_connector where connector_code = $1', [this.def.code]);
    return rows[0] === undefined ? undefined : { status: rows[0].status, adapterStatus: rows[0].adapter_status, mode: rows[0].mode, mappingVersion: rows[0].mapping_version };
  }

  /** Switches the connection on or off (a versioned command): a stale version is 409 VERSION_CONFLICT, a move to the state it is already in is 422, and both directions need a reason. */
  async setState(tx: TenantTx, expectedVersion: number, move: { enabled: unknown; reason: unknown }, actor: string): Promise<{ before: EntConnectionRow; row: EntConnectionRow }> {
    await this.ensure(tx, actor);
    const locked = await tx.query<ConnectionSql>(`${SELECT} where connector_code = $1 for update`, [this.def.code]);
    if (locked[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const before = rowOf(locked[0]);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = this.def.move(before, move);
    await tx.query(
      `update machvon.ent_connection set enabled = $2, state_reason = $3, state_changed_by = $4::uuid, state_changed_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp(), updated_by = $4::uuid
        where id = $1::uuid`,
      [before.id, decided.enabled, decided.reason, actor],
    );
    await tx.query(
      `insert into machvon.ent_connection_event (tenant_id, id, connection_id, action, reason, actor_id, connection_version)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4::uuid, $5::bigint)`,
      [before.id, decided.enabled ? 'ENABLED' : 'DISABLED', decided.reason, actor, before.version + 1],
    );
    return { before, row: await this.current(tx) };
  }

  /** The newest events of the switch, for the history of the screen. */
  async events(tx: TenantTx, limit: number): Promise<Array<{ id: string; action: string; reason: string | null; actorId: string; version: number; occurredAt: string }>> {
    const rows = await tx.query<{ id: string; action: string; reason: string | null; actor_id: string; connection_version: string; occurred_at: string }>(
      `select e.id, e.action, e.reason, e.actor_id, e.connection_version::text as connection_version, to_char(e.occurred_at at time zone 'UTC', ${ISO}) as occurred_at
         from machvon.ent_connection_event e join machvon.ent_connection c on c.tenant_id = e.tenant_id and c.id = e.connection_id
        where c.connector_code = $1 order by e.connection_version desc, e.occurred_at desc, e.id desc limit $2`,
      [this.def.code, limit],
    );
    return rows.map((row) => ({ id: row.id, action: row.action, reason: row.reason, actorId: row.actor_id, version: Number(row.connection_version), occurredAt: row.occurred_at }));
  }

  /** The positions of the file import with what each last did (a position never used shows nulls, never "fine"). */
  async positions(tx: TenantTx): Promise<EntPositionRow[]> {
    if (this.def.positions.length === 0) return [];
    const rows = await tx.query<{ connector_code: string; status: string; adapter_status: string; last_success_at: string | null; last_error_code: string | null; last_file_sha256: string | null }>(
      `select connector_code, status, adapter_status, to_char(last_success_at at time zone 'UTC', ${ISO}) as last_success_at, last_error_code, last_file_sha256
         from machvon.integration_cursor where connector_code = any($1::text[]) and source_scope = 'DEFAULT'`,
      [[...this.def.positions]],
    );
    return this.def.positions.map((code) => {
      const found = rows.find((row) => row.connector_code === code);
      return { connectorCode: code, cursorStatus: found?.status ?? null, adapterStatus: found?.adapter_status ?? null, lastSuccessAt: found?.last_success_at ?? null, lastErrorCode: found?.last_error_code ?? null, lastFileSha256: found?.last_file_sha256 ?? null };
    });
  }
}
