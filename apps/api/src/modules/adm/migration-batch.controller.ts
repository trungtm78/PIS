import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AdmMigrationStore, MIGRATION_BATCH_RESOURCE, TenantDatabase } from '@machvon/db';
import type { MigrationBatch } from '@machvon/db';
import { DomainError, MIGRATION_TABULAR_LIMITS, asUuid, objectKey, readTabularFile, validateUpload } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { holdsOnWholeTenant } from './tenant-authority';

const MANAGE_PERMISSION = PERMISSIONS.registerMigrationBatch;
const APPROVE_PERMISSION = PERMISSIONS.applyMigrationBatch;
const READ_PERMISSION = PERMISSIONS.listMigrationBatches;
/** The kind the conversion files are stored under: they go up through the shared import pipeline, which judges them by their bytes and scans them. */
const FILE_KIND = 'import';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'string' || !/^[0-9]{1,4}$/.test(value) || Number(value) < 1 || Number(value) > MAX_PAGE) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return Number(value);
}

/** Conversion of the data of a tenant is tenant administration (ADM 3.10): a grant on the whole tenant reaches it, a grant on a subtree does not. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/** openapi.json listMigrationBatches item: a batch with its control totals. */
function batchViewOf(batch: MigrationBatch): Record<string, unknown> {
  return {
    id: batch.id,
    source_system: batch.sourceSystem,
    target_entity: batch.targetEntity,
    file_sha256: batch.fileSha256,
    mapping_version: batch.mappingVersion,
    row_count: batch.rowCount,
    error_count: batch.errorCount,
    status: batch.status,
    dry_run_report_ref: batch.dryRunReportRef,
    control_totals: batch.controlTotals,
    rows_applied: batch.rowsApplied,
    failure_code: batch.failureCode,
    created_by: batch.createdBy,
    approved_by: batch.approvedBy,
    applied_at: batch.appliedAt,
    rolled_back_by: batch.rolledBackBy,
    rolled_back_at: batch.rolledBackAt,
    rollback_reason: batch.rollbackReason,
    created_at: batch.createdAt,
    version: batch.version,
  };
}

/**
 * The commands over conversion batches (ST-ADM-020, ADM.md 3.10, BR-ADM-01, BR-ADM-12): the file is registered once for an entity (its hash is read from the object store, never taken on trust); a dry run and an apply
 * are asked for and carried out by the job `adm-migration` (202); the apply is approved by somebody other than who registered the file; a rollback marks the rows of an applied batch invalid.
 */
@Controller('migration-batches')
export class MigrationBatchesController {
  private readonly store = new AdmMigrationStore();

  constructor(@Inject(FileService) private readonly files: FileService) {}

  /**
   * The file of a conversion goes up through the shared pipeline of import files - judged by its bytes, not its name, then scanned - and is read as a table here, so that the registrar sees its columns and rows before registering it. The
   * answer carries the id to register it by.
   */
  @Post('files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadMigrationFile')
  @Command({ operation: 'uploadMigrationFile' })
  async upload(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @UploadedBytes() file: UploadedFile): Promise<Schemas['MigrationFileUpload']> {
    assertHolds(access, MANAGE_PERMISSION);
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: FILE_KIND });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const stored = await this.files.upload(scope.tenant, { purpose: FILE_KIND, declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    const table = readTabularFile(file.bytes, MIGRATION_TABULAR_LIMITS);
    await scope.audit({
      action: 'adm.migration_batch.file_uploaded',
      resourceType: MIGRATION_BATCH_RESOURCE,
      resourceId: scope.tenant.tenantId,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length },
    });
    return { file_id: stored.key.split('/').pop() as string, file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length };
  }

  @Post()
  @OperationId('registerMigrationBatch')
  @Command({ operation: 'registerMigrationBatch' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['MigrationBatchRegister']): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    if (asUuid(body.file_id) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'file_id');
    const key = objectKey(scope.tenant.tenantId, FILE_KIND, body.file_id);
    const { bytes } = await this.files.download(scope.tenant, key);
    const batch = await this.store.register(
      scope.tx,
      { sourceSystem: body.source_system, targetEntity: body.target_entity, fileSha256: createHash('sha256').update(bytes).digest('hex'), fileStorageKey: key, mappingVersion: body.mapping_version },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'adm.migration_batch.registered',
      resourceType: MIGRATION_BATCH_RESOURCE,
      resourceId: batch.id,
      diff: { source_system: batch.sourceSystem, target_entity: batch.targetEntity, file_sha256: batch.fileSha256, mapping_version: batch.mappingVersion },
    });
    return commandResult(scope, batch.status, batch.version, batch.id);
  }

  @Post(':batchId/dry-run')
  @HttpCode(202)
  @OperationId('dryRunMigrationBatch')
  @Command({ operation: 'dryRunMigrationBatch', versioned: true })
  async dryRun(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('batchId', ParseUUIDPipe) batchId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const batch = await this.store.requestDryRun(scope.tx, batchId, scope.expectedVersion ?? 0);
    await scope.audit({
      action: 'adm.migration_batch.dry_run_requested',
      resourceType: MIGRATION_BATCH_RESOURCE,
      resourceId: batch.id,
      diff: { reason: body.reason, target_entity: batch.targetEntity },
    });
    return commandResult(scope, batch.status, batch.version, batch.id);
  }

  @Post(':batchId/apply')
  @HttpCode(202)
  @OperationId('applyMigrationBatch')
  @Command({ operation: 'applyMigrationBatch', versioned: true })
  async apply(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('batchId', ParseUUIDPipe) batchId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    assertHolds(access, APPROVE_PERMISSION);
    const batch = await this.store.requestApply(scope.tx, batchId, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({
      action: 'adm.migration_batch.apply_approved',
      resourceType: MIGRATION_BATCH_RESOURCE,
      resourceId: batch.id,
      diff: { reason: body.reason, target_entity: batch.targetEntity, control_totals: batch.controlTotals?.expected ?? null, registered_by: batch.createdBy },
    });
    return commandResult(scope, batch.status, batch.version, batch.id);
  }

  @Post(':batchId/rollback')
  @HttpCode(202)
  @OperationId('rollbackMigrationBatch')
  @Command({ operation: 'rollbackMigrationBatch', versioned: true })
  async rollback(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: Schemas['ReasonOnly'],
  ): Promise<CommandResult> {
    assertHolds(access, APPROVE_PERMISSION);
    const done = await this.store.rollback(scope.tx, batchId, scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId);
    await scope.audit({
      action: 'adm.migration_batch.rolled_back',
      resourceType: MIGRATION_BATCH_RESOURCE,
      resourceId: batchId,
      diff: { reason: done.batch.rollbackReason, target_entity: done.batch.targetEntity, rows_marked_invalid: done.rows },
    });
    return commandResult(scope, done.batch.status, done.batch.version, batchId);
  }
}

/** Reads of the conversion batches (ADM-13): the list, and one batch with the errors the dry run found row by row. */
@Controller('migration-batches')
export class MigrationBatchReadsController {
  private readonly store = new AdmMigrationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listMigrationBatches')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('target_entity') targetEntity?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    assertHolds(access, READ_PERMISSION);
    const page = await this.database.withTenant(tenant, (tx) =>
      this.store.list(tx, {
        status: typeof status === 'string' ? status : undefined,
        targetEntity: typeof targetEntity === 'string' ? targetEntity : undefined,
        cursor: typeof cursor === 'string' ? cursor : undefined,
        limit: limitOf(limit),
      }),
    );
    return { items: page.items.map(batchViewOf), next_cursor: page.next };
  }

  @Get(':batchId')
  @OperationId('getMigrationBatch')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('batchId', ParseUUIDPipe) batchId: string): Promise<Record<string, unknown>> {
    assertHolds(access, READ_PERMISSION);
    return this.database.withTenant(tenant, async (tx) => {
      const batch = await this.store.find(tx, batchId);
      if (batch === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const errors = await this.store.errorsOf(tx, batchId);
      return {
        ...batchViewOf(batch),
        errors: errors.map((error) => ({ row_number: error.rowNumber, line_number: error.lineNumber, field: error.field, code: error.code, message: error.message })),
      };
    });
  }
}
