import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_IMPORT_FORM,
  amountText,
  describeProblem,
  importBody,
  instantText,
  isImportId,
  ownerOfRow,
  quarantinedRows,
  signedAmountText,
  toImportAnswer,
  toImportListItem,
  toImportView,
  toStagedFile,
  validateImport,
} from './model';
import { FILE_ID, IMPORT_ID, ME, OTHER, SHA, answer, difference, importView, listItem, row, stagedFile } from './test-support';

const problem = (code: string, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

describe('the import view as the server answers it', () => {
  it('reads the header, the counts, the adapter, the certified total, the lines and the differences', () => {
    const view = toImportView(importView());
    expect(view).toMatchObject({
      id: IMPORT_ID,
      sourceKind: 'STATEMENT_FILE',
      fileSha256: SHA,
      statementDate: '2026-10-16',
      status: 'PARTIALLY_APPLIED',
      counts: { total: 6, new: 3, duplicate: 1, conflict: 1, error: 1 },
      importedBy: ME,
      importedByName: 'Nguyễn Văn An',
      adapter: { connectorCode: 'TREASURY_STATEMENT_FILE', formatVersion: 'ASSUMED-2026.1', fileStatus: 'PROPOSED', apiStatus: 'MISSING', connectorStatus: 'ACTIVE', lastErrorCode: null },
      certifiedRows: 3,
      certifiedAmountVnd: '12000',
      openDifferences: 1,
      rowsTruncated: false,
    });
    expect(view?.rows.map((line) => [line.rowNo, line.outcome, line.errorCode])).toEqual([
      [2, 'NEW', null],
      [3, 'NEW', null],
      [4, 'NEW', null],
      [5, 'DUPLICATE', null],
      [6, 'CONFLICT', null],
      [7, 'ERROR', 'AMOUNT_INVALID'],
    ]);
    expect(view?.rows[5]?.masked).toEqual({ document_no: 'CT-7', amount_vnd: '12x', payee_account: '***012' });
    expect(view?.differences).toEqual([
      { id: difference(6).id, code: 'DUPLICATE_CONFLICT', businessKey: difference(6).business_key, rowNo: 6, expected: '2000', actual: '2500', difference: '500', ownerMembershipId: ME, ownerName: 'Nguyễn Văn An', dueAt: difference(6).due_at, status: 'OPEN' },
    ]);
  });

  it('defaults what an older answer does not carry, drops lines and differences it cannot read, and refuses an answer that is not an import', () => {
    const sparse = toImportView(importView({ certified_total: undefined, rows: [row(2, 'NEW'), { row_no: 'x' }, row(3, 'SIDEWAYS'), 5], differences: [difference(2, { status: 'RESOLVED' }), { id: 'x' }, null], file_name: undefined, statement_date: undefined, imported_by_name: undefined }));
    expect(sparse).toMatchObject({ certifiedRows: 0, certifiedAmountVnd: '0', openDifferences: 0, fileName: '', statementDate: null, importedByName: null });
    expect(sparse?.rows.map((line) => line.rowNo)).toEqual([2]);
    expect(sparse?.differences.map((item) => item.status)).toEqual(['RESOLVED']);
    expect(toImportView(importView({ rows: undefined, differences: undefined, rows_truncated: true }))).toMatchObject({ rows: [], differences: [], rowsTruncated: true });
    for (const broken of [undefined, null, [], 'text', {}, importView({ id: undefined }), importView({ source_kind: 'OTHER' }), importView({ status: 'FAILED' }), importView({ file_sha256: undefined }), importView({ row_error: -1 }), importView({ row_total: 1.5 }), importView({ adapter: undefined }), importView({ adapter: { connector_code: 'X' } }), importView({ imported_at: undefined })]) {
      expect(toImportView(broken)).toBeUndefined();
    }
  });

  it('keeps only text values of a masked row', () => {
    const view = toImportView(importView({ rows: [row(2, 'ERROR', { raw_masked: { document_no: 'CT-2', amount_vnd: 12, nested: { a: 1 } } })] }));
    expect(view?.rows[0]?.masked).toEqual({ document_no: 'CT-2' });
    expect(toImportView(importView({ rows: [row(2, 'ERROR', { raw_masked: undefined })] }))?.rows[0]?.masked).toEqual({});
  });

  it('reads the answer of the import command and refuses one that is not an answer', () => {
    expect(toImportAnswer(answer())).toEqual({ importId: IMPORT_ID, result: 'PARTIALLY_APPLIED', counts: { total: 6, new: 3, duplicate: 1, conflict: 1, error: 1 }, differencesOpened: 1 });
    expect(toImportAnswer(answer({ result: 'ALREADY_IMPORTED', differences_opened: undefined }))).toMatchObject({ result: 'ALREADY_IMPORTED', differencesOpened: 0 });
    for (const broken of [undefined, {}, answer({ resource_id: undefined }), answer({ result: 'DONE' }), answer({ row_total: undefined })]) expect(toImportAnswer(broken)).toBeUndefined();
  });

  it('finds the quarantined rows and the owner of each: the owner of its open item, else the person who imported the file', () => {
    const view = toImportView(importView({ rows: [row(2, 'ERROR'), row(3, 'ERROR')], differences: [difference(3, { owner_membership_id: OTHER, owner_name: null })] }));
    if (view === undefined) throw new Error('view');
    const [first, second] = quarantinedRows(view);
    expect(quarantinedRows(toImportView(importView()) ?? view).map((line) => line.rowNo)).toEqual([7]);
    expect(ownerOfRow(view, first!)).toEqual({ id: ME, name: 'Nguyễn Văn An' });
    expect(ownerOfRow(view, second!)).toEqual({ id: OTHER, name: null });
  });
});

describe('the file and the form', () => {
  const staged = toStagedFile(stagedFile());
  if (staged === undefined) throw new Error('the staged file of the fixture does not read');

  it('reads the answer of the upload: where the file is stored, its hash, what it holds and whether it has the columns of the layout', () => {
    expect(staged).toEqual({
      fileObjectId: FILE_ID,
      fileSha256: SHA,
      fileName: 'sao-ke.csv',
      sizeBytes: 2048,
      format: 'CSV',
      columns: ['document_no', 'document_date', 'project_code', 'treasury_office_code', 'amount_vnd', 'confirmed_at'],
      rowCount: 2,
      layoutOk: true,
      missingColumns: [],
    });
    expect(toStagedFile(stagedFile({ format: 'XLSX', layout_ok: false, missing_columns: ['document_no', 7], columns: 'x' }))).toMatchObject({ format: 'XLSX', layoutOk: false, missingColumns: ['document_no'], columns: [] });
    for (const broken of [undefined, {}, stagedFile({ file_object_id: undefined }), stagedFile({ format: 'PDF' }), stagedFile({ layout_ok: 'yes' }), stagedFile({ row_count: -1 }), stagedFile({ file_name: '' })]) {
      expect(toStagedFile(broken)).toBeUndefined();
    }
  });

  it('needs a file, and a file that has the columns of the layout', () => {
    expect(validateImport(EMPTY_IMPORT_FORM, undefined)).toEqual({ file: 'required' });
    expect(validateImport(EMPTY_IMPORT_FORM, { ...staged, layoutOk: false, missingColumns: ['document_no'] })).toEqual({ file: 'layout' });
    expect(validateImport(EMPTY_IMPORT_FORM, staged)).toEqual({});
  });

  it('judges the statement date only when one is given, and as a real calendar day', () => {
    expect(validateImport({ ...EMPTY_IMPORT_FORM, statementDate: '2026-10-16' }, staged)).toEqual({});
    expect(validateImport({ ...EMPTY_IMPORT_FORM, statementDate: '2026-02-30' }, staged)).toEqual({ statementDate: 'invalid' });
    expect(validateImport({ ...EMPTY_IMPORT_FORM, statementDate: '16/10/2026' }, staged)).toEqual({ statementDate: 'invalid' });
    expect(validateImport({ ...EMPTY_IMPORT_FORM, statementDate: '   ' }, staged)).toEqual({});
  });

  it('builds the request with the stored file by its id and hash in lower case, its name, and the date only when given', () => {
    expect(importBody({ sourceKind: 'EXPORT_FILE', statementDate: ' 2026-10-16 ' }, { ...staged, fileObjectId: FILE_ID.toUpperCase(), fileSha256: SHA.toUpperCase() })).toEqual({
      file_object_id: FILE_ID,
      file_sha256: SHA,
      source_kind: 'EXPORT_FILE',
      statement_date: '2026-10-16',
      file_name: 'sao-ke.csv',
    });
    expect(importBody(EMPTY_IMPORT_FORM, staged)).toEqual({ file_object_id: FILE_ID, file_sha256: SHA, source_kind: 'STATEMENT_FILE', file_name: 'sao-ke.csv' });
  });

  it('reads a line of the list of imports, and leaves out one that is not an import', () => {
    expect(toImportListItem(listItem(1))).toEqual([
      {
        id: IMPORT_ID,
        fileName: 'sao-ke.csv',
        fileSha256: SHA,
        sourceKind: 'STATEMENT_FILE',
        statementDate: '2026-10-16',
        status: 'PARTIALLY_APPLIED',
        counts: { total: 6, new: 3, duplicate: 1, conflict: 1, error: 1 },
        importedBy: ME,
        importedByName: 'Nguyễn Văn An',
        importedAt: '2026-10-24T03:00:00.000000Z',
      },
    ]);
    expect(toImportListItem(listItem(2, { file_name: undefined, statement_date: undefined, imported_by_name: undefined }))[0]).toMatchObject({ fileName: '', statementDate: null, importedByName: null });
    for (const broken of [undefined, null, 'x', {}, listItem(1, { id: undefined }), listItem(1, { source_kind: 'OTHER' }), listItem(1, { status: 'FAILED' }), listItem(1, { file_sha256: undefined }), listItem(1, { imported_by: undefined }), listItem(1, { imported_at: undefined }), listItem(1, { row_total: undefined })]) {
      expect(toImportListItem(broken)).toEqual([]);
    }
  });
});

describe('problems and numbers', () => {
  it.each([
    ['HASH_MISMATCH', 'hashMismatch'],
    ['TREASURY_IMPORT_SCHEMA_INVALID', 'schemaInvalid'],
    ['FILE_NOT_CLEAN', 'fileNotClean'],
    ['SCAN_PENDING', 'scanPending'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SCOPE_DENIED', 'denied'],
    ['STAGE_TRANSITION_DENIED', 'connectorStopped'],
    ['VALIDATION_FAILED', 'validation'],
    ['FILE_TYPE_NOT_ALLOWED', 'fileType'],
    ['PAYLOAD_TOO_LARGE', 'tooLarge'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeProblem(problem(code, 'file_sha256'))).toEqual({ reason, field: 'file_sha256' });
  });

  it('maps anything that is not an API error to the general message', () => {
    expect(describeProblem(new Error('boom'))).toEqual({ reason: 'general', field: undefined });
    expect(describeProblem('boom')).toEqual({ reason: 'general', field: undefined });
  });

  it('groups the digits of an amount by the language and never turns it into a float', () => {
    expect(amountText('1250000', 'en')).toBe('1,250,000');
    expect(amountText('1250000', 'vi')).toBe('1.250.000');
    expect(amountText('9007199254740993123', 'en')).toBe('9,007,199,254,740,993,123');
    expect(amountText('12x', 'en')).toBe('12x');
    expect(amountText('-5', 'en')).toBe('-5');
  });

  it('shows the sign of a difference', () => {
    expect(signedAmountText('500', 'en')).toBe('+500');
    expect(signedAmountText('-1500', 'en')).toBe('-1,500');
    expect(signedAmountText('0', 'en')).toBe('0');
    expect(signedAmountText('n/a', 'en')).toBe('+n/a');
  });

  it('shows an instant in the time zone of the business, and a value that is not an instant as it came', () => {
    expect(instantText('2026-10-24T03:00:00.000000Z', 'en')).toMatch(/10\/24\/26.*10:00:00/);
    expect(instantText('soon', 'en')).toBe('soon');
  });

  it('takes the import from the address only when it is an id', () => {
    expect(isImportId(IMPORT_ID)).toBe(true);
    expect(isImportId(null)).toBe(false);
    expect(isImportId('../../x')).toBe(false);
  });
});
