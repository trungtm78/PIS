import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { columnsOfProblem, describeImportProblem, toImportResult, toUploadedFile } from './import-model';

const UPLOADED = {
  file_object_id: '00000000-0000-4000-8000-0000000000aa',
  file_sha256: 'a'.repeat(64),
  size_bytes: 120,
  format: 'CSV',
  columns: ['parcel_code', 'land_use_group'],
  row_count: 3,
};
const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

describe('toUploadedFile', () => {
  it('reads what the upload answers: the id, the hash, the format, the columns and the rows', () => {
    expect(toUploadedFile(UPLOADED)).toEqual({
      fileObjectId: UPLOADED.file_object_id,
      fileSha256: UPLOADED.file_sha256,
      sizeBytes: 120,
      format: 'CSV',
      columns: ['parcel_code', 'land_use_group'],
      rowCount: 3,
    });
    expect(toUploadedFile({ ...UPLOADED, columns: 'x', format: undefined })).toMatchObject({ columns: [], format: '' });
  });

  it('does not read an answer that lacks the id, the hash, the size or the rows', () => {
    expect(toUploadedFile(null)).toBeUndefined();
    for (const field of ['file_object_id', 'file_sha256', 'size_bytes', 'row_count']) expect(toUploadedFile({ ...UPLOADED, [field]: undefined })).toBeUndefined();
  });
});

describe('columnsOfProblem', () => {
  it('reads the columns a parcel must not carry and the ones the file lacks from the refusal of the door', () => {
    expect(columnsOfProblem(problem('IMPORT_SCHEMA_INVALID', { unknown_columns: ['owner_name', 'phone'], missing_columns: ['land_use_group'] }))).toEqual({ unknown: ['owner_name', 'phone'], missing: ['land_use_group'] });
    expect(columnsOfProblem(problem('IMPORT_SCHEMA_INVALID', { unknown_columns: [1] }))).toEqual({ unknown: [], missing: [] });
    expect(columnsOfProblem(new Error('network'))).toEqual({ unknown: [], missing: [] });
  });
});

describe('toImportResult', () => {
  it('reads the three outcomes with the counts of the rows', () => {
    expect(toImportResult({ result: 'APPLIED', row_total: 3, row_created: 3, row_duplicate: 0, row_conflict: 0, row_refused: 0 })).toEqual({ outcome: 'APPLIED', total: 3, created: 3, duplicate: 0, conflict: 0, refused: 0 });
    expect(toImportResult({ result: 'PARTIALLY_APPLIED', row_total: 5, row_created: 1, row_duplicate: 1, row_conflict: 1, row_refused: 2 })).toMatchObject({ outcome: 'PARTIALLY_APPLIED', refused: 2, conflict: 1 });
    expect(toImportResult({ result: 'ALREADY_IMPORTED', row_total: 2 })).toEqual({ outcome: 'ALREADY_IMPORTED', total: 2, created: 0, duplicate: 0, conflict: 0, refused: 0 });
  });

  it('does not read an answer that is not one of the three outcomes or has no total', () => {
    expect(toImportResult(null)).toBeUndefined();
    expect(toImportResult({ result: 'DONE', row_total: 1 })).toBeUndefined();
    expect(toImportResult({ result: 'APPLIED' })).toBeUndefined();
  });
});

describe('describeImportProblem', () => {
  it('maps the codes of the server to what the panel says, and an unknown failure to the general one', () => {
    const expected: Record<string, string> = {
      HASH_MISMATCH: 'hashMismatch',
      IMPORT_SCHEMA_INVALID: 'schemaInvalid',
      IMPORT_EMPTY: 'empty',
      FILE_TYPE_NOT_ALLOWED: 'fileRefused',
      FILE_NOT_CLEAN: 'fileRefused',
      PAYLOAD_TOO_LARGE: 'fileRefused',
      SCAN_PENDING: 'fileRefused',
      RESOURCE_NOT_FOUND: 'notFound',
      SCOPE_DENIED: 'denied',
    };
    for (const [code, reason] of Object.entries(expected)) expect(describeImportProblem(problem(code))).toBe(reason);
    expect(describeImportProblem(problem('SOMETHING_NEW'))).toBe('general');
    expect(describeImportProblem(new Error('network'))).toBe('general');
  });
});
