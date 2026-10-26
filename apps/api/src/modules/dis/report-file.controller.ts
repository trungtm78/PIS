import { Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { DomainError, validateUpload } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { FileService } from '../files';
import { DocumentFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';

/** The purpose under which the shared upload pipeline stores the file of a report: the vouchers and scans a person attaches are documents. */
export const REPORT_FILE_PURPOSE = 'document';
const RESOURCE_TYPE = 'report_file';
const FALLBACK_NAME = 'file';

/**
 * The upload door of the files of a weekly report (ST-DIS-004, DIS 3 F1 step 6, MOB-19). A file is judged by its bytes (422 `FILE_TYPE_NOT_ALLOWED`, 413 `PAYLOAD_TOO_LARGE`), stored private to the
 * tenant and scanned; one the scan found infected is refused and stays out of every report (422 `FILE_NOT_CLEAN`), one the scan has not finished with is told to wait (409 `SCAN_PENDING`). Nothing is
 * attached here: the id and the hash it answers are what a save of the draft takes, and the save checks them again against the store.
 */
@Controller()
export class ReportFileController {
  constructor(@Inject(FileService) private readonly files: FileService) {}

  @Post('report-files')
  @HttpCode(200)
  @UseGuards(DocumentFileUploadGuard)
  @OperationId('uploadReportFile')
  @Command({ operation: 'uploadReportFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['DisReportFile']> {
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: REPORT_FILE_PURPOSE });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const stored = await this.files.upload(scope.tenant, { purpose: REPORT_FILE_PURPOSE, declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') {
      // A file the scan found infected is not kept: nothing can name it, so nothing would ever remove it.
      await this.files.remove(scope.tenant, stored.key);
      throw new DomainError('FILE_NOT_CLEAN', 422);
    }
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    const fileObjectId = stored.key.split('/').pop() ?? '';
    await scope.audit({
      action: 'dis.report_file_uploaded',
      resourceType: RESOURCE_TYPE,
      resourceId: fileObjectId,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, content_type: verdict.contentType },
    });
    return { file_object_id: fileObjectId, file_sha256: file.sha256, file_name: file.name ?? FALLBACK_NAME, content_type: verdict.contentType, size_bytes: file.bytes.length };
  }
}
