import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { canApply, canImport, codesOf, describeImport, filterFaults, importIdOf, importRequest, toImportBatch, toStoredWorkbook } from './import-model';
import type { ImportFault } from './import-model';

const faults: ImportFault[] = [
  { line: 5, projectCode: 'NO-SUCH', field: 'project_code', code: 'PROJECT_NOT_FOUND' },
  { line: 9, projectCode: 'DA-009', field: 'cy_central_ctmtqg', code: 'SUBSET_EXCEEDS_PARENT' },
  { line: 12, projectCode: null, field: 'project_code', code: 'PROJECT_CODE_REQUIRED' },
];

describe('the batch of a bulk import as the page reads it (ST-DIS-008)', () => {
  const raw = { id: 'b1', period_id: 'p1', file_sha256: 'a'.repeat(64), mapping_version: 'DIS-WEEKLY-1', status: 'DRY_RUN', total_rows: 3, valid_rows: 0, error_rows: 3, errors: [{ line: 5, project_code: 'NO-SUCH', field: 'project_code', code: 'PROJECT_NOT_FOUND' }, { line: 12, project_code: null, field: 'project_code', code: 'PROJECT_CODE_REQUIRED' }, 'nothing'], drafts_created: 0, drafts_updated: 0, version: 1 };

  it('reads the counts and every fault, and leaves out what is not one', () => {
    expect(toImportBatch(raw)).toMatchObject({ id: 'b1', status: 'DRY_RUN', totalRows: 3, validRows: 0, errorRows: 3, version: 1 });
    expect(toImportBatch(raw)?.faults).toEqual([faults[0], faults[2]]);
    expect(toImportBatch({ ...raw, status: 'WHATEVER' })).toBeUndefined();
    expect(toImportBatch({ ...raw, version: undefined })).toBeUndefined();
    expect(toImportBatch(undefined)).toBeUndefined();
  });

  it('applies only a batch that was validated and has no error', () => {
    expect(canApply(toImportBatch({ ...raw, status: 'VALIDATED', valid_rows: 3, error_rows: 0 }) as never)).toBe(true);
    expect(canApply(toImportBatch(raw) as never)).toBe(false);
    expect(canApply(toImportBatch({ ...raw, status: 'APPLIED', valid_rows: 3, error_rows: 0 }) as never)).toBe(false);
  });

  it('reads the file the upload door took and names the request of the dry run', () => {
    const stored = toStoredWorkbook({ file_object_key: 'k', file_sha256: 'b'.repeat(64), row_count: 20, columns: ['a', 7, 'b'] }, 'w.xlsx');
    expect(stored).toEqual({ fileObjectKey: 'k', fileSha256: 'b'.repeat(64), rowCount: 20, columns: ['a', 'b'], fileName: 'w.xlsx' });
    expect(toStoredWorkbook({ file_object_key: 'k' }, 'w.xlsx')).toBeUndefined();
    expect(importRequest('p1', stored as never)).toEqual({ period_id: 'p1', file_object_key: 'k', file_sha256: 'b'.repeat(64), mapping_version: 'DIS-WEEKLY-1' });
    expect(importIdOf({ resource_id: 'x' })).toBe('x');
    expect(importIdOf({})).toBeUndefined();
  });

  it('filters the faults by one kind and by a part of the project code, any case', () => {
    expect(filterFaults(faults, '', '')).toHaveLength(3);
    expect(filterFaults(faults, 'PROJECT_NOT_FOUND', '').map((fault) => fault.line)).toEqual([5]);
    expect(filterFaults(faults, '', 'da-0').map((fault) => fault.line)).toEqual([9]);
    expect(filterFaults(faults, 'PROJECT_NOT_FOUND', 'da')).toEqual([]);
    expect(codesOf(faults)).toEqual(['PROJECT_CODE_REQUIRED', 'PROJECT_NOT_FOUND', 'SUBSET_EXCEEDS_PARENT']);
  });

  it('lets the holder of the right import in a tenant that is not read only, and names what the server refused', () => {
    expect(canImport(['report.import'], 'FULL')).toBe(true);
    expect(canImport(undefined, undefined)).toBe(true);
    expect(canImport(['report.read'], 'FULL')).toBe(false);
    expect(canImport(['report.import'], 'READ_ONLY')).toBe(false);
    const refused = (code: string) => describeImport(new ApiError({ status: 422, code, correlationId: 'c' }));
    expect([refused('IMPORT_FILE_ALREADY_APPLIED'), refused('IMPORT_HAS_ERRORS'), refused('MAPPING_VERSION_UNKNOWN'), refused('IMPORT_SCHEMA_INVALID'), refused('PERIOD_LOCKED'), refused('VERSION_CONFLICT'), refused('SCOPE_DENIED')]).toEqual([
      'alreadyApplied',
      'hasErrors',
      'mappingUnknown',
      'schemaInvalid',
      'periodLocked',
      'versionConflict',
      'scopeDenied',
    ]);
    expect([refused('FILE_NOT_CLEAN'), refused('FILE_TYPE_NOT_ALLOWED'), refused('PAYLOAD_TOO_LARGE'), refused('SCAN_PENDING'), refused('VALIDATION_FAILED'), refused('RESOURCE_NOT_FOUND'), refused('X')]).toEqual(['fileInfected', 'fileType', 'fileTooLarge', 'scanPending', 'validation', 'notFound', 'general']);
    expect(describeImport(new Error('network'))).toBe('general');
  });
});
