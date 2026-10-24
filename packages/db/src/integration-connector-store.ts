import { DomainError, assertActivatable, assertConnectorSettings, mayMove, versionConflict } from '@machvon/kernel';
import type { AdapterStatus, ConnectorMode, ConnectorStatus } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export interface ConnectorRow {
  id: string;
  connectorCode: string;
  adapterStatus: AdapterStatus;
  mode: ConnectorMode;
  /** The configuration without any secret: a credential is a reference to the vault (`credentialSecretRef`) and nothing more. */
  config: Record<string, unknown>;
  credentialSecretRef: string | null;
  mappingVersion: string | null;
  status: ConnectorStatus;
  lastTestAt: string | null;
  lastTestResult: string | null;
  version: number;
  createdBy: string | null;
  updatedAt: string;
}

export interface NewConnector {
  connectorCode: string;
  mode: ConnectorMode;
  adapterStatus: AdapterStatus;
  config: Record<string, unknown>;
  credentialSecretRef?: string | undefined;
  mappingVersion?: string | undefined;
}

export interface ConnectorChange {
  config?: Record<string, unknown> | undefined;
  credentialSecretRef?: string | undefined;
  mappingVersion?: string | undefined;
  status?: ConnectorStatus | undefined;
}

interface Row {
  id: string;
  connector_code: string;
  adapter_status: AdapterStatus;
  mode: ConnectorMode;
  config_json: Record<string, unknown>;
  credential_secret_ref: string | null;
  mapping_version: string | null;
  status: ConnectorStatus;
  last_test_at: string | null;
  last_test_result: string | null;
  version: string;
  created_by: string | null;
  updated_at: string;
}

const COLUMNS = `id, connector_code, adapter_status, mode, config_json, credential_secret_ref, mapping_version, status,
  to_char(last_test_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_test_at, last_test_result, version::text as version, created_by,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at`;

const toRow = (row: Row): ConnectorRow => ({
  id: row.id,
  connectorCode: row.connector_code,
  adapterStatus: row.adapter_status,
  mode: row.mode,
  config: row.config_json,
  credentialSecretRef: row.credential_secret_ref,
  mappingVersion: row.mapping_version,
  status: row.status,
  lastTestAt: row.last_test_at,
  lastTestResult: row.last_test_result,
  version: Number(row.version),
  createdBy: row.created_by,
  updatedAt: row.updated_at,
});

/** The ordering key of the last row of a page: connectors come by code, then id. */
export interface ConnectorPageAnchor {
  code: string;
  id: string;
}

/**
 * Integration connectors (ST-ADM-018, ADM 3.13, BR-ADM-10). A connector is honest about its adapter: it can be Active only with a VERIFIED
 * adapter, or a MOCK one outside production; PROPOSED and MISSING connectors are kept (the agency has no public API yet) but never run.
 * The verdict on the adapter is the same word list as the integration cursors of master data; where the platform already records a cursor
 * for the same connector (the code in lower case), a connector cannot claim VERIFIED unless the cursor does.
 * Every query runs inside the caller's tenant transaction, so row-level security keeps tenants apart.
 */
export class IntegrationConnectorStore {
  async find(tx: TenantTx, id: string): Promise<ConnectorRow | undefined> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.integration_connector where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** Keyset page by connector code. The caller asks for one more row than it shows. */
  async list(tx: TenantTx, request: { limit: number; after: ConnectorPageAnchor | undefined }): Promise<ConnectorRow[]> {
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.integration_connector
        where ($1::text is null or (connector_code, id) > ($1::text, $2::uuid))
        order by connector_code, id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /** The verdict that the platform recorded for the cursor of a connector (its code in lower case), if it has one. */
  async cursorAdapter(tx: TenantTx, connectorCode: string): Promise<AdapterStatus | undefined> {
    const rows = await tx.query<{ adapter_status: AdapterStatus }>('select adapter_status from machvon.integration_cursor where lower(connector_code) = $1 limit 1', [connectorCode]);
    return rows[0]?.adapter_status;
  }

  /**
   * Declares a connector as a draft. 409 CONNECTOR_CODE_TAKEN for a code the tenant has; 422 VALIDATION_FAILED for a configuration that holds a secret
   * (a credential is a reference to the vault), and for VERIFIED where the platform's own record of the cursor says otherwise.
   */
  async create(tx: TenantTx, input: NewConnector, actor: string): Promise<ConnectorRow> {
    assertConnectorSettings({ config: input.config, credentialSecretRef: input.credentialSecretRef, mappingVersion: input.mappingVersion });
    if (input.adapterStatus === 'VERIFIED') {
      const recorded = await this.cursorAdapter(tx, input.connectorCode);
      if (recorded !== undefined && recorded !== 'VERIFIED') throw new DomainError('VALIDATION_FAILED', 422, 'adapter_status');
    }
    const inserted = await tx.query<Row>(
      `insert into machvon.integration_connector
         (tenant_id, id, connector_code, adapter_status, mode, config_json, credential_secret_ref, mapping_version, status, version, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, $6, 'Draft', 1, $7::uuid, $7::uuid)
       on conflict (tenant_id, connector_code) do nothing
       returning ${COLUMNS}`,
      [input.connectorCode, input.adapterStatus, input.mode, JSON.stringify(input.config), input.credentialSecretRef ?? null, input.mappingVersion ?? null, actor],
    );
    if (inserted[0] === undefined) throw new DomainError('CONNECTOR_CODE_TAKEN', 409);
    return toRow(inserted[0]);
  }

  /**
   * Changes the settings or the status of a connector. A missing connector is 404, a stale version 409 VERSION_CONFLICT. A move to Active is
   * refused with 422 CONNECTOR_NOT_ACTIVATABLE unless the adapter is VERIFIED, or MOCK outside production (AC-ST-ADM-018-1), and a VERIFIED
   * connector also needs the cursor the platform recorded for it, if any, to say VERIFIED. The adapter status itself is never changed here:
   * it is a fact about the agency's format.
   */
  async update(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    change: ConnectorChange,
    actor: string,
    environment: string | undefined,
  ): Promise<{ before: ConnectorRow; row: ConnectorRow }> {
    assertConnectorSettings({ config: change.config, credentialSecretRef: change.credentialSecretRef, mappingVersion: change.mappingVersion });
    const locked = await tx.query<Row>(`select ${COLUMNS} from machvon.integration_connector where id = $1::uuid for update`, [id]);
    const before = locked[0] === undefined ? undefined : toRow(locked[0]);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const target = change.status ?? before.status;
    const moving = target !== before.status;
    const changed = moving || change.config !== undefined || change.credentialSecretRef !== undefined || change.mappingVersion !== undefined;
    if (!changed) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (moving && !mayMove(before.status, target)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (target === 'Active' && (moving || before.status === 'Active')) {
      assertActivatable(before.adapterStatus, environment);
      if (before.adapterStatus === 'VERIFIED') {
        const recorded = await this.cursorAdapter(tx, before.connectorCode);
        if (recorded !== undefined && recorded !== 'VERIFIED') throw new DomainError('CONNECTOR_NOT_ACTIVATABLE', 422, 'ADAPTER_NOT_VERIFIED');
      }
    }
    await tx.query(
      `update machvon.integration_connector
          set config_json = coalesce($2::jsonb, config_json), credential_secret_ref = coalesce($3, credential_secret_ref),
              mapping_version = coalesce($4, mapping_version), status = $5, version = version + 1, updated_by = $6::uuid
        where id = $1::uuid`,
      [id, change.config === undefined ? null : JSON.stringify(change.config), change.credentialSecretRef ?? null, change.mappingVersion ?? null, target, actor],
    );
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, row };
  }
}
