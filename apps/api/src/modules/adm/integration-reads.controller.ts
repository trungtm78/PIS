import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IntegrationConnectorStore, IntegrationInboxStore, TenantDatabase } from '@machvon/db';
import type { ConnectorRow, InboxEventRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from './tenant-authority';

const CONNECTOR_PERMISSION = PERMISSIONS.get_resources_integration_connector;
const INBOX_PERMISSION = PERMISSIONS.get_resources_integration_event_inbox;

type Page = { items: Array<Record<string, unknown>>; next_cursor: string | null };

/** openapi.json get_resources_integration_connector item. The configuration holds no secret (the store refuses one); a credential is a vault reference. */
function connectorViewOf(row: ConnectorRow): Record<string, unknown> {
  return {
    id: row.id,
    connector_code: row.connectorCode,
    adapter_status: row.adapterStatus,
    mode: row.mode,
    config: row.config,
    credential_secret_ref: row.credentialSecretRef,
    mapping_version: row.mappingVersion,
    status: row.status,
    last_test_at: row.lastTestAt,
    last_test_result: row.lastTestResult,
    version: row.version,
  };
}

/**
 * openapi.json get_resources_integration_event_inbox item. The payload and the reference to where it is kept are never part of it
 * (the row type does not even carry them); `payload_kept` says whether the payload still exists, which is what a replay needs to know.
 */
function inboxViewOf(row: InboxEventRow): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    event_key: row.eventKey,
    provider_event_type: row.eventType,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: row.nextAttemptAt,
    error_code: row.errorCode,
    received_at: row.receivedAt,
    processed_at: row.processedAt,
    payload_kept: row.payloadKept,
    replay_count: row.replayCount,
    version: row.version,
  };
}

/** Reads of the integration connectors (ST-ADM-018, ADM-09): by code, for the whole tenant (anyone else sees an empty list and 404). */
@Controller('resources/integration_connector')
export class IntegrationConnectorReadsController {
  private readonly store = new IntegrationConnectorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_integration_connector')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Page> {
    const request = parsePageRequest(limit, cursor);
    if (!holdsOnWholeTenant(access, CONNECTOR_PERMISSION)) return { items: [], next_cursor: null };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(connectorViewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.connectorCode, id: last.id }) : null };
  }

  @Get(':id')
  @OperationId('get_resources_integration_connector_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, CONNECTOR_PERMISSION)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return connectorViewOf(row);
  }
}

/** Reads of the integration inbox (ST-ADM-018, ADM-10): newest first, for the whole tenant, without any payload. */
@Controller('resources/integration_event_inbox')
export class IntegrationInboxReadsController {
  private readonly store = new IntegrationInboxStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_integration_event_inbox')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Page> {
    const request = parsePageRequest(limit, cursor);
    if (!holdsOnWholeTenant(access, INBOX_PERMISSION)) return { items: [], next_cursor: null };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, {}, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(inboxViewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.cursorKey, id: last.id }) : null };
  }

  @Get(':id')
  @OperationId('get_resources_integration_event_inbox_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, INBOX_PERMISSION)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return inboxViewOf(row);
  }
}
