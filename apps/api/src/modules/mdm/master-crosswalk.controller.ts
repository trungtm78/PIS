import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IntegrationCursorStore, MasterCrosswalkStore, TenantDatabase } from '@machvon/db';
import type { CrosswalkRow, CursorRow } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { dateOf, textOf } from './inputs';

const CROSSWALK_RESOURCE = 'master_crosswalk';
const CURSOR_RESOURCE = 'integration_cursor';
const CROSSWALK_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'RETIRED']);

function crosswalkViewOf(row: CrosswalkRow): Record<string, unknown> {
  return {
    id: row.id,
    master_record_id: row.masterRecordId,
    master_type: row.masterType,
    business_key: row.businessKey,
    source_system: row.sourceSystem,
    external_type: row.externalType,
    external_code: row.externalCode,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    match_method: row.matchMethod,
    confidence: row.confidence,
    status: row.status,
    version: row.version,
  };
}

/** What a connector shows in the list: where it stands, never the position itself (that is for the connector's own page). */
function cursorViewOf(row: CursorRow): Record<string, unknown> {
  return {
    id: row.id,
    connector_code: row.connectorCode,
    source_scope: row.sourceScope,
    last_success_at: row.lastSuccessAt,
    schema_version: row.schemaVersion,
    adapter_status: row.adapterStatus,
    status: row.status,
    last_file_sha256: row.lastFileSha256,
    last_error_code: row.lastErrorCode,
    reset_reason: row.resetReason,
    version: row.version,
    updated_at: row.updatedAt,
  };
}

/**
 * The mapping of the codes of other systems to master data, and the positions of the integration connectors (ST-MDM-007, MDM 3.1 F8). A code
 * stands for one entry at a time; a position is moved by hand only for a stated reason, by someone who holds the reset permission.
 */
@Controller()
export class MasterCrosswalkController {
  private readonly crosswalks = new MasterCrosswalkStore();
  private readonly cursors = new IntegrationCursorStore();

  @Post('master-crosswalks')
  @HttpCode(200)
  @OperationId('createMasterCrosswalk')
  @Command({ operation: 'createMasterCrosswalk' })
  async create(@Scope() scope: CommandScope, @Body() body: Schemas['MdmCrosswalk']): Promise<CommandResult> {
    const masterRecordId = asUuid(body.master_record_id);
    if (masterRecordId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'master_record_id');
    const created = await this.crosswalks.create(
      scope.tx,
      {
        masterRecordId,
        sourceSystem: body.source_system,
        externalType: body.external_type,
        externalCode: body.external_code,
        validFrom: dateOf(body.valid_from, 'valid_from'),
        matchMethod: body.match_method,
        confidence: body.confidence,
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'master.crosswalk_created',
      resourceType: CROSSWALK_RESOURCE,
      resourceId: created.id,
      diff: { master_record_id: masterRecordId, source_system: body.source_system, external_type: body.external_type, external_code: body.external_code, match_method: body.match_method },
    });
    return commandResult(scope, 'ACTIVE', created.version, created.id);
  }

  @Post('master-crosswalks/:id/retire')
  @HttpCode(200)
  @OperationId('retireMasterCrosswalk')
  @Command({ operation: 'retireMasterCrosswalk', versioned: true })
  async retire(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DisDraftDeletion']): Promise<CommandResult> {
    const retired = await this.crosswalks.retire(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({
      action: 'master.crosswalk_retired',
      resourceType: CROSSWALK_RESOURCE,
      resourceId: id,
      reason: body.reason,
      diff: { master_record_id: retired.row.masterRecordId, source_system: retired.row.sourceSystem, external_type: retired.row.externalType, external_code: retired.row.externalCode },
    });
    return commandResult(scope, 'RETIRED', retired.version, id);
  }

  @Post('integration-cursors/:id/reset')
  @HttpCode(200)
  @OperationId('resetIntegrationCursor')
  @Command({ operation: 'resetIntegrationCursor', versioned: true })
  async reset(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MdmCursorReset']): Promise<CommandResult> {
    const done = await this.cursors.reset(scope.tx, id, scope.expectedVersion ?? 0, { reason: body.reason, cursor: body.cursor_json as Record<string, unknown> }, scope.tenant.membershipId);
    await scope.audit({
      action: 'integration.cursor_reset',
      resourceType: CURSOR_RESOURCE,
      resourceId: id,
      reason: done.row.resetReason ?? body.reason,
      diff: { connector_code: done.row.connectorCode, source_scope: done.row.sourceScope, before: done.before.cursor, after: done.row.cursor, status_before: done.before.status },
    });
    return commandResult(scope, done.row.status, done.row.version, id);
  }
}

/** Reads of the crosswalks (for MDM-24 and MDM-16) and of the connectors with their positions. */
@Controller()
export class MasterCrosswalkReadsController {
  private readonly crosswalks = new MasterCrosswalkStore();
  private readonly cursors = new IntegrationCursorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('master-crosswalks')
  @OperationId('listMasterCrosswalks')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('source_system') sourceSystem?: unknown,
    @Query('external_type') externalType?: unknown,
    @Query('external_code') externalCode?: unknown,
    @Query('master_record_id') masterRecordId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !CROSSWALK_STATUSES.has(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const record = masterRecordId === undefined ? undefined : asUuid(masterRecordId);
    if (masterRecordId !== undefined && record === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'master_record_id');
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.crosswalks.list(
        tx,
        {
          sourceSystem: textOf(sourceSystem, 'source_system'),
          externalType: textOf(externalType, 'external_type'),
          externalCode: textOf(externalCode, 'external_code'),
          masterRecordId: record,
          status: status as 'ACTIVE' | 'RETIRED' | undefined,
        },
        { limit: request.limit + 1, after: request.after },
      ),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(crosswalkViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }

  @Get('resources/integration_cursor')
  @OperationId('get_resources_integration_cursor')
  async listCursors(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.cursors.list(tx, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(cursorViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.connectorCode, id: last.id }) : null,
    };
  }

  @Get('resources/integration_cursor/:id')
  @OperationId('get_resources_integration_cursor_id')
  async getCursor(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const row = await this.database.withTenant(tenant, (tx) => this.cursors.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...cursorViewOf(row), cursor_json: row.cursor };
  }
}
