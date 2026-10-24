import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { FileImportStore, PrjNationalCodeStore, previewFileImport, projectScope } from '@machvon/db';
import type { AssignedNationalCode, FileImportPreview, QuarantinedRow } from '@machvon/db';
import { DomainError, NATIONAL_CODE_ADAPTER_STATUS, NATIONAL_CODE_CONNECTOR, NATIONAL_CODE_FORMAT_VERSION, NOOP_METRICS, fileSha256, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { FileService } from '../files';
import { SHARED_PIPELINE_CACHE } from './pipeline-cache';
import type { PipelineCache } from './pipeline-cache';
import { PRJ_METRICS, PRJ_PIPELINE_CACHE } from './tokens';

const READ_PERMISSION = PERMISSIONS.get_resources_project;
const PROJECT_RESOURCE = 'project';
const IMPORT_RESOURCE = 'file_import';
/** The cursor of the position of the connector: the one the baseline gives each tenant. */
const CURSOR_SCOPE = 'DEFAULT';
/** How many rows of a result the answer carries: a file may have thousands, the screen shows the lines that need a person. */
const ROW_CAP = 500;

const adapterView = {
  connector_code: NATIONAL_CODE_CONNECTOR,
  format_version: NATIONAL_CODE_FORMAT_VERSION,
  // The adapter is a proposal: it reads the file a person hands over, and calls no system of the State.
  status: NATIONAL_CODE_ADAPTER_STATUS,
};

function errorView(row: QuarantinedRow): Record<string, unknown> {
  return { line: row.line, internal_code: row.businessKey, code: row.errorCode, field: row.field, preview: row.maskedPreview };
}

function previewRowView(row: FileImportPreview['rows'][number]): Record<string, unknown> {
  return {
    line: row.line,
    internal_code: row.businessKey,
    status: row.status,
    ...(row.outcome === undefined ? {} : { outcome: row.outcome }),
    ...(row.code === undefined ? {} : { code: row.code, field: row.field }),
    preview: row.preview ?? null,
  };
}

/**
 * The national project code (ST-PRJ-004, PRJ 3.1 F7). It is assigned by hand to one project, or taken from the reconciliation file that a planning officer
 * downloaded from the national system: the file is read as a dry run first, then applied once (the same bytes are never applied twice) through the file
 * import framework. No API of the national system is called. Both commands act on the projects inside the scope of `project.national_code.manage`.
 */
@Controller()
export class NationalCodeController {
  private readonly codes = new PrjNationalCodeStore();
  private readonly imports = new FileImportStore();
  private readonly metrics: MetricsSink;
  private readonly cache: PipelineCache;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(PRJ_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(PRJ_PIPELINE_CACHE) cache?: PipelineCache,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.cache = cache ?? SHARED_PIPELINE_CACHE;
  }

  /** Reads the file of an import from the object store: it must still be the file whose hash the caller names. */
  private async bytesOf(tenant: TenantContext, key: string, sha256: string): Promise<Uint8Array> {
    const { bytes } = await this.files.download(tenant, key);
    if (fileSha256(bytes) !== sha256) throw new DomainError('HASH_MISMATCH', 422, 'file');
    return bytes;
  }

  @Post('projects/:id/national-code')
  @HttpCode(200)
  @OperationId('assignNationalProjectCode')
  @Command({ operation: 'assignNationalProjectCode', versioned: true })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjNationalCode']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.codes.assign(scope.tx, {
      // The identifier travels on as the lower-case text the database writes: the audit row and the event are matched against ids as strings.
      projectId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, PERMISSIONS.assignNationalProjectCode, now), read: projectScope(access, READ_PERMISSION, now) },
      nationalCode: body.national_project_code,
      evidenceDocumentId: body.evidence_document_id,
      today: vietnamDateOf(now),
    });
    await this.record(scope, done, now);
    return commandResult(scope, done.status, done.version, done.projectId);
  }

  @Post('project-national-code-imports')
  @HttpCode(200)
  @OperationId('importNationalProjectCodes')
  @Command({ operation: 'importNationalProjectCodes' })
  async import(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PrjImportRequest']): Promise<Record<string, unknown>> {
    const now = new Date();
    // The layout of the file is versioned: a caller that names another layout than the one the adapter reads is refused before the file is opened.
    if (body.mapping_version !== undefined && body.mapping_version !== NATIONAL_CODE_FORMAT_VERSION) throw new DomainError('VALIDATION_FAILED', 422, 'mapping_version');
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const adapter = await this.codes.importAdapter(scope.tx, { scope: projectScope(access, PERMISSIONS.importNationalProjectCodes, now), actor: scope.tenant.membershipId, today: vietnamDateOf(now) });

    if (body.dry_run) {
      const preview = await previewFileImport(scope.tx, adapter, bytes);
      await scope.audit({
        action: 'project.national_code_import_previewed',
        resourceType: IMPORT_RESOURCE,
        resourceId: scope.tenant.tenantId,
        diff: { connector_code: preview.connectorCode, format_version: preview.formatVersion, file_sha256: preview.fileSha256, already_applied: preview.alreadyApplied, counts: preview.counts },
      });
      return {
        operation_id: scope.requestId,
        status: 'DRY_RUN',
        resource_version: 0,
        dry_run: true,
        adapter: adapterView,
        file_sha256: preview.fileSha256,
        already_applied: preview.alreadyApplied,
        counts: preview.counts,
        rows: preview.rows.slice(0, ROW_CAP).map(previewRowView),
        rows_truncated: preview.rows.length > ROW_CAP,
      };
    }

    const result = await this.imports.run(scope.tx, {
      adapter,
      bytes,
      fileObjectKey: body.file_object_key,
      expectedSha256: body.file_sha256,
      importedBy: scope.tenant.membershipId,
      fallbackOwnerId: scope.tenant.membershipId,
      correlationId: scope.correlationId,
      cursorScope: CURSOR_SCOPE,
      metrics: this.metrics,
      now,
    });
    // The same file is never applied twice; a file that cannot be read is told as the framework tells it. Both leave nothing behind (the command rolls back).
    if (result.outcome === 'ALREADY_IMPORTED') throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409, 'file');
    if (result.outcome === 'FAILED') throw new DomainError(result.errorCode ?? 'IMPORT_SCHEMA_INVALID', 422, 'file');
    const refused = await this.imports.quarantined(scope.tx, result.importId, ROW_CAP + 1);
    const errors = refused.slice(0, ROW_CAP).map(errorView);
    // A file none of whose rows can be taken is refused as a whole, with the line of each fault: the officer corrects it and sends it again.
    if (result.counts.applied === 0 && result.counts.duplicate === 0 && refused.length > 0) {
      throw new DomainError('IMPORT_HAS_ERRORS', 422, 'file', { extensions: { counts: result.counts, errors, errors_truncated: refused.length > ROW_CAP } });
    }
    await scope.audit({
      action: 'project.national_code_import_applied',
      resourceType: IMPORT_RESOURCE,
      resourceId: result.importId,
      diff: {
        connector_code: NATIONAL_CODE_CONNECTOR,
        format_version: NATIONAL_CODE_FORMAT_VERSION,
        file_sha256: body.file_sha256,
        counts: result.counts,
        assigned: adapter.assigned.length,
      },
    });
    for (const assigned of adapter.assigned) await this.record(scope, assigned, now);
    return {
      operation_id: scope.requestId,
      status: 'APPLIED',
      resource_version: 1,
      resource_id: result.importId,
      dry_run: false,
      adapter: adapterView,
      file_sha256: body.file_sha256,
      counts: result.counts,
      assigned: adapter.assigned.length,
      errors,
      errors_truncated: refused.length > ROW_CAP,
    };
  }

  /** The audit row, the event and the clearing of the pages of the project bank for a code that was set (a code left as it was only leaves the audit row). */
  private async record(scope: CommandScope, done: AssignedNationalCode, now: Date): Promise<void> {
    await scope.audit({
      action: done.changed ? 'project.national_code_assigned' : 'project.national_code_unchanged',
      resourceType: PROJECT_RESOURCE,
      resourceId: done.projectId,
      classification: done.classification,
      diff: {
        code: done.code,
        previous_national_project_code: done.previous,
        national_project_code: done.current,
        evidence_document_id: done.evidenceDocumentId,
        via: done.via,
        ...(done.importId === undefined ? {} : { import_id: done.importId }),
      },
    });
    if (!done.changed) return;
    await scope.emit({
      aggregateType: PROJECT_RESOURCE,
      aggregateId: done.projectId,
      aggregateVersion: done.version,
      type: 'project.national_code_assigned.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        project_id: done.projectId,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        national_project_code: done.current,
        previous_national_project_code: done.previous,
        via: done.via,
      },
      eventKey: `${PROJECT_RESOURCE}:${done.projectId}:${done.version}`,
    });
    scope.afterCommit(() => this.cache.invalidate(scope.tenant.tenantId));
  }
}
