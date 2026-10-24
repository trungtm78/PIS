import { HttpCode, Inject, Post, UseGuards, Controller } from '@nestjs/common';
import { DomainError, nationalCodeFileFormat, planFileImport, readTabularFile, validateUpload } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';

const RESOURCE_TYPE = 'file_import';

/**
 * The door of the reconciliation file of PRJ-21 (ST-PRJ-004): the file goes through the shared upload pipeline (judged by its bytes, scanned, stored
 * for the tenant), and what it holds is read at once, so that the screen can tell the layout is wrong before the dry run. Nothing is written to the
 * register here; `importNationalProjectCodes` reads the stored file by its key and its hash.
 */
@Controller()
export class NationalCodeFileController {
  constructor(@Inject(FileService) private readonly files: FileService) {}

  @Post('project-national-code-imports/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadNationalCodeFile')
  @Command({ operation: 'uploadNationalCodeFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['PrjNationalCodeFileUpload']> {
    // What the file is comes first (its bytes, not its name), then whether it is a table with the two columns of the layout.
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: 'import' });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const table = readTabularFile(file.bytes);
    const stored = await this.files.upload(scope.tenant, { purpose: 'import', declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    // The layout is checked on the whole file once it is known to be clean: an unreadable or empty file, or one without the columns, is 422 IMPORT_SCHEMA_INVALID or IMPORT_EMPTY.
    planFileImport(nationalCodeFileFormat, file.bytes);
    await scope.audit({
      action: 'project.national_code_file_uploaded',
      resourceType: RESOURCE_TYPE,
      resourceId: scope.tenant.tenantId,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length },
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length };
  }
}
