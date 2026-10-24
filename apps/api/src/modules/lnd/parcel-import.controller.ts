import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndLandSource, LndParcelImportStore, checkParcelLayout } from '@machvon/db';
import { DomainError, asUuid, objectKey, readTabularFile, validateUpload } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { holdsOnProject } from './reach';

const IMPORT_PERMISSION = PERMISSIONS.importLandParcels;
const RESOURCE_TYPE = 'land_parcel_import';
const CLASSIFICATION = 'INTERNAL';
/** The purpose under which the shared upload pipeline stores the file of an import. */
const UPLOAD_PURPOSE = 'import';

/**
 * The import of a parcel list (ST-LND-001, LND 3.1 step 1, NFR-OPERABILITY-06). The file is the one the upload pipeline stored (judged by its bytes,
 * scanned, private to the tenant); its SHA-256 is its identity within the project, so the same file again answers ALREADY_IMPORTED with the first
 * import and changes nothing, and two calls at once give exactly one application. A file covers every unit of the project and uses its identity up
 * once, so only a caller who holds `land.manage` over the whole project or the whole tenant may import: a narrower grant could shadow a file for a
 * wider one. The layout is a working assumption (the land registry gives no API, LND 7) and carries no owner, no user and no household of the land.
 */
@Controller()
export class LandParcelImportController {
  private readonly source = new LndLandSource();
  private readonly store = new LndParcelImportStore();

  constructor(@Inject(FileService) private readonly files: FileService) {}

  /**
   * The upload door of a parcel list: judged by its bytes, scanned, then read as a table and checked against the columns of the layout. A file with a column that a
   * parcel must not carry (a name, an identity number, an owner...) is refused and removed again at once, so it is kept nowhere (data minimisation, AC-ST-LND-001-2);
   * the refusal names the columns in its extensions. The table reader parses the sender's bytes (it inflates a workbook), so it reads only a file the scan found clean.
   * Nothing is imported here: the id and the hash are what `importLandParcels` takes.
   */
  @Post('land-parcels/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadLandParcelFile')
  @Command({ operation: 'uploadLandParcelFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['LndParcelFile']> {
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: UPLOAD_PURPOSE });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const stored = await this.files.upload(scope.tenant, { purpose: UPLOAD_PURPOSE, declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    try {
      const table = readTabularFile(file.bytes);
      const layout = checkParcelLayout(table.headers);
      if (!layout.ok) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'columns', { extensions: { unknown_columns: layout.unknown, missing_columns: layout.missing } });
      await scope.audit({
        action: 'land.parcel_file_uploaded',
        resourceType: RESOURCE_TYPE,
        resourceId: scope.tenant.tenantId,
        classification: CLASSIFICATION,
        diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length },
      });
      return { file_object_id: stored.key.split('/').pop() ?? '', file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length };
    } catch (error) {
      // A file that was just stored and is refused is not kept (no legal hold can contain a file that no record names yet).
      await this.files.remove(scope.tenant, stored.key);
      // A file that is not a table is a file in the wrong layout, whatever the reader calls it.
      if (error instanceof DomainError && error.code !== 'IMPORT_SCHEMA_INVALID') throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file');
      throw error;
    }
  }

  @Post('land-parcels/import')
  @HttpCode(200)
  @OperationId('importLandParcels')
  @Command({ operation: 'importLandParcels', ttl: 'extended' })
  async import(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LndImportLandParcels']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const projectId = body.project_id.toLowerCase();
    const project = await this.source.projectRef(scope.tx, projectId);
    // A project of another tenant is indistinguishable from one that does not exist.
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!holdsOnProject(access, IMPORT_PERMISSION, projectId, now)) throw new DomainError('SCOPE_DENIED', 403);
    const fileId = asUuid(body.file_object_id);
    if (fileId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'file_object_id');
    const fileObjectKey = objectKey(scope.tenant.tenantId, UPLOAD_PURPOSE, fileId);
    // The bytes are read again from the store (a file the scan did not find clean is refused there): the hash recorded at the upload must still be theirs.
    const { bytes } = await this.files.download(scope.tenant, fileObjectKey);
    const done = await this.store.import(scope.tx, {
      projectId,
      bytes,
      fileObjectKey,
      expectedSha256: body.file_sha256,
      importedBy: scope.tenant.membershipId,
      correlationId: scope.correlationId,
      now,
    });
    const repeated = done.outcome === 'ALREADY_IMPORTED';
    const figures = {
      import_id: done.importId,
      project_id: projectId,
      file_sha256: body.file_sha256,
      row_total: done.counts.total,
      row_created: done.counts.created,
      row_duplicate: done.counts.duplicate,
      row_conflict: done.counts.conflict,
      row_refused: done.counts.refused,
    };
    // A file that was imported already changes nothing: the trail records only that it was asked again.
    await scope.audit({
      action: repeated ? 'land.parcels_import_repeated' : 'land.parcels_imported',
      resourceType: RESOURCE_TYPE,
      resourceId: done.importId,
      classification: CLASSIFICATION,
      diff: repeated ? { import_id: done.importId, project_id: projectId, file_sha256: body.file_sha256 } : figures,
    });
    if (!repeated) {
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: done.importId,
        aggregateVersion: 1,
        type: 'lnd.parcel.imported.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), status: done.outcome, ...figures },
        eventKey: `${RESOURCE_TYPE}:${done.importId}:applied`,
      });
    }
    return {
      ...commandResult(scope, done.outcome, 1, done.importId),
      result: done.outcome,
      duplicate: repeated,
      row_total: done.counts.total,
      row_created: done.counts.created,
      row_duplicate: done.counts.duplicate,
      row_conflict: done.counts.conflict,
      row_refused: done.counts.refused,
    };
  }
}
