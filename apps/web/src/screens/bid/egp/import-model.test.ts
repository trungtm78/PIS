import { describe, expect, it } from 'vitest';
import '../../../i18n';
import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import {
  KINDS,
  ROW_CODES,
  applyGate,
  camelOf,
  columnNeed,
  describeProblem,
  effectiveCode,
  failureKind,
  filterRows,
  isForbidden,
  isInformation,
  kindFit,
  refusedApply,
  rowCodeKey,
  shortHash,
  sizeText,
  toApplied,
  toConnection,
  toPreview,
  toRun,
  toRunDetail,
  toRunPage,
  toUploadedFile,
  tooLarge,
  vietnamDateTime,
} from './import-model';
import type { ApplyGateInput, Preview } from './import-model';
import { APPLIED, AS_OF, PREVIEW, UPLOADED, connection, detail, problem, run, runId } from './import-test-support';

const preview = (over: Record<string, unknown> = {}): Preview => toPreview({ ...PREVIEW, ...over }, AS_OF) as Preview;
const gate = (over: Partial<ApplyGateInput> = {}) => applyGate({ preview: preview(), previewIsCurrent: true, canApply: true, connectionBlocked: false, applied: false, working: false, ...over });

describe('import-model: the answers of the connection, the upload, the dry run and the apply', () => {
  it('reads the connection: what the caller may do, whether the apply is blocked, the layouts and the acceptance word', () => {
    const read = toConnection(connection({}, { apply: false }, { apply_blocked: true }));
    expect(read?.canPreview).toBe(true);
    expect(read?.canApply).toBe(false);
    expect(read?.applyBlocked).toBe(true);
    expect(read?.acceptance).toBe('PENDING_EXTERNAL');
    expect(read?.layouts.map((layout) => layout.kind)).toEqual([...KINDS]);
    expect(read?.layouts[0]?.columns.map((column) => [column.name, columnNeed(column)])).toEqual([
      ['plan_code', 'required'],
      ['package_external_code', 'required'],
      ['selection_method', 'optional'],
    ]);
    expect(read?.layouts[1]?.columns[2]).toMatchObject({ headerRequired: true });
    expect(columnNeed(read!.layouts[1]!.columns[2]!)).toBe('header');
    expect(read?.layouts[0]?.columns[2]?.values).toEqual(['OPEN_BIDDING', 'LIMITED_BIDDING']);
    expect(toConnection(connection({ acceptance: 'ACCEPTABLE' }))?.acceptance).toBe('ACCEPTABLE');
    expect(toConnection(undefined)).toBeUndefined();
  });

  it('reads the upload and tells whether the file fits the chosen kind, never choosing for the person', () => {
    const file = toUploadedFile(UPLOADED);
    expect(file).toMatchObject({ fileObjectKey: expect.any(String), fileSha256: 'a'.repeat(64), sizeBytes: 2048, format: 'CSV', rowCount: 5, matchingKinds: ['KHLCNT'] });
    expect(kindFit(file!, 'KHLCNT')).toBe('fits');
    expect(kindFit(file!, 'TBMT')).toBe('other');
    expect(kindFit({ ...file!, matchingKinds: [] }, 'TBMT')).toBe('none');
    expect(toUploadedFile({ ...UPLOADED, matching_kinds: ['TBMT', 'NOT_A_KIND'] })?.matchingKinds).toEqual(['TBMT']);
    expect(toUploadedFile({ size_bytes: 1 })).toBeUndefined();
    expect(tooLarge({ size: 10 * 1024 * 1024 })).toBe(false);
    expect(tooLarge({ size: 10 * 1024 * 1024 + 1 })).toBe(true);
  });

  it('reads the dry run with its counts, rows, outcome and the moment of the dry run; a row of an unknown status is dropped', () => {
    const read = preview({ rows: [...PREVIEW.rows, { line: 9, status: 'WHATEVER' }], rows_truncated: true, already_applied: true, connection_enabled: false });
    expect(read).toMatchObject({ kind: 'KHLCNT', acceptance: 'PENDING_EXTERNAL', alreadyApplied: true, connectionEnabled: false, rowsTruncated: true, ranAt: AS_OF });
    expect(read.counts).toEqual({ total: 6, valid: 3, errors: 1, duplicate: 1, conflict: 1 });
    expect(read.rows.map((row) => [row.line, row.status, row.outcome])).toEqual([
      [2, 'VALID', 'RECORD'],
      [3, 'VALID', 'RECORD_AND_PROPOSE'],
      [4, 'VALID', 'RECORD_AND_DIFFERENCE'],
      [5, 'ERROR', null],
      [6, 'DUPLICATE', null],
      [7, 'CONFLICT', null],
    ]);
    expect(toPreview({ counts: {} }, AS_OF)).toBeUndefined();
  });

  it('filters the rows by verdict and gives a repeat and a clash their word when the server sent no code', () => {
    const rows = preview().rows;
    expect(filterRows(rows, '')).toHaveLength(6);
    expect(filterRows(rows, 'VALID').map((row) => row.line)).toEqual([2, 3, 4]);
    expect(filterRows(rows, 'ERROR').map((row) => row.line)).toEqual([5]);
    const bare = preview({ rows: [{ line: 2, status: 'DUPLICATE' }, { line: 3, status: 'CONFLICT' }, { line: 4, status: 'VALID' }] }).rows;
    expect(bare.map(effectiveCode)).toEqual(['ROW_DUPLICATE', 'ROW_CONFLICT', null]);
  });

  it('reads the apply and the refusal IMPORT_HAS_ERRORS, which carries the counts and the errors in its extensions', () => {
    const applied = toApplied(APPLIED);
    expect(applied).toMatchObject({ runId: runId(9), kind: 'KHLCNT', mappingsProposed: 2, restrictionsWritten: 0, errorsTruncated: false, refused: false });
    expect(applied?.counts).toEqual({ total: 6, applied: 3, duplicate: 1, conflict: 1, quarantined: 1, differencesOpened: 1 });
    expect(applied?.errors[0]).toMatchObject({ line: 5, code: 'MONEY_INVALID', field: 'estimated_price', preview: { plan_code: 'PL-5', estimated_price: '1.200.000' } });
    const refused = refusedApply(problem('IMPORT_HAS_ERRORS', 422, { counts: { total: 2, applied: 0, duplicate: 0, conflict: 0, quarantined: 2, differences_opened: 0 }, errors: [{ line: 2, code: 'FIELD_REQUIRED', field: 'plan_code', preview: null }], errors_truncated: true }));
    expect(refused).toMatchObject({ refused: true, errorsTruncated: true });
    expect(refused?.errors).toHaveLength(1);
    expect(refusedApply(problem('HASH_MISMATCH', 422))).toBeUndefined();
    expect(refusedApply(new Error('x'))).toBeUndefined();
  });

  it('reads the history page, a run and the detail of a run', () => {
    const page = toRunPage({ items: [run(1), { id: 'bad' }], next_cursor: 'c2', as_of: AS_OF });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('c2');
    expect(page.asOf).toBe(AS_OF);
    expect(toRunPage({ items: [run(1)], next_cursor: null }).nextCursor).toBeNull();
    const one = toRun(run(3, { status: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID' }));
    expect(one).toMatchObject({ kind: 'KHLCNT', status: 'FAILED', errorCode: 'IMPORT_SCHEMA_INVALID', openDifferences: 2, importedBy: 'Nguyễn Văn An' });
    expect(one?.counts).toMatchObject({ applied: 6, quarantined: 2, duplicate: 1, conflict: 1, differencesOpened: 2 });
    expect(toRun(run(1, { status: 'NOPE' }))).toBeUndefined();
    const read = toRunDetail(detail(1, { errors_truncated: true }));
    expect(read?.errors.map((error) => error.line)).toEqual([4, 7]);
    expect(read?.errorsTruncated).toBe(true);
    expect(toRunDetail({})).toBeUndefined();
  });
});

describe('import-model: the problems, the row codes and the gate of the apply', () => {
  it('names every problem the API can answer, with the details of the schema and the layout problems', () => {
    const kinds: Array<[string, number, string]> = [
      ['IMPORT_FILE_ALREADY_APPLIED', 409, 'alreadyApplied'],
      ['EGP_CONNECTION_DISABLED', 409, 'connectionDisabled'],
      ['IMPORT_HAS_ERRORS', 422, 'hasErrors'],
      ['HASH_MISMATCH', 422, 'hashMismatch'],
      ['IMPORT_SCHEMA_INVALID', 422, 'schemaInvalid'],
      ['IMPORT_EMPTY', 422, 'empty'],
      ['EGP_LAYOUT_VERSION_UNKNOWN', 422, 'layoutUnknown'],
      ['FILE_TYPE_NOT_ALLOWED', 422, 'fileRefused'],
      ['FILE_NOT_CLEAN', 422, 'fileRefused'],
      ['PAYLOAD_TOO_LARGE', 413, 'tooLarge'],
      ['SCAN_PENDING', 409, 'scanPending'],
      ['VALIDATION_FAILED', 422, 'validation'],
      ['RESOURCE_NOT_FOUND', 404, 'notFound'],
      ['SCOPE_DENIED', 403, 'scopeDenied'],
      ['PERMISSION_DENIED', 403, 'denied'],
      ['SOMETHING_ELSE', 500, 'general'],
    ];
    for (const [code, status, kind] of kinds) expect(describeProblem(problem(code, status)).kind).toBe(kind);
    expect(describeProblem(new Error('boom')).kind).toBe('general');
    expect(describeProblem(problem('IMPORT_SCHEMA_INVALID', 422, { missing_columns: ['plan_code', 'package_external_code'] })).missingColumns).toEqual(['plan_code', 'package_external_code']);
    const layout = describeProblem(problem('EGP_LAYOUT_VERSION_UNKNOWN', 422, { layout_version: 'V9', supported: ['WORKING-ASSUMPTION-2026.2'] }));
    expect(layout).toMatchObject({ layoutVersion: 'V9', supported: ['WORKING-ASSUMPTION-2026.2'] });
    expect(isInformation(describeProblem(problem('IMPORT_FILE_ALREADY_APPLIED', 409)))).toBe(true);
    expect(isInformation(describeProblem(problem('HASH_MISMATCH', 422)))).toBe(false);
    expect(isForbidden(problem('SCOPE_DENIED', 403))).toBe(true);
    expect(isForbidden(problem('X', 500))).toBe(false);
  });

  it('turns every code of section 4.6 into the last segment of a translation key that both catalogues hold, and any other code into "other"', () => {
    expect(ROW_CODES).toHaveLength(17);
    expect(camelOf('BID_DATES_ORDER_INVALID')).toBe('bidDatesOrderInvalid');
    expect(camelOf('ROW_DUPLICATE')).toBe('rowDuplicate');
    for (const code of ROW_CODES) {
      const key = `egp.import.rowCode.${rowCodeKey(code)}`;
      expect(rowCodeKey(code)).not.toBe('other');
      expect(key in vi, key).toBe(true);
      expect(key in en, key).toBe(true);
      expect((en as Record<string, string>)[key]).not.toBe((vi as Record<string, string>)[key]);
    }
    expect(rowCodeKey('SOMETHING_NEW')).toBe('other');
    expect(rowCodeKey(null)).toBe('other');
    expect('egp.import.rowCode.other' in vi && 'egp.import.rowCode.other' in en).toBe(true);
  });

  it('opens the apply only after a dry run of the same file with a valid row, a new file, an enabled connection and the right to apply', () => {
    expect(gate()).toBeNull();
    expect(gate({ preview: undefined })).toBe('noPreview');
    expect(gate({ previewIsCurrent: false })).toBe('noPreview');
    expect(gate({ preview: preview({ already_applied: true }) })).toBe('alreadyApplied');
    expect(gate({ preview: preview({ connection_enabled: false }) })).toBe('connectionDisabled');
    expect(gate({ connectionBlocked: true })).toBe('connectionDisabled');
    expect(gate({ canApply: false })).toBe('noAuthority');
    expect(gate({ preview: preview({ counts: { total: 2, valid: 0, errors: 2, duplicate: 0, conflict: 0 } }) })).toBe('noValid');
    expect(gate({ applied: true })).toBe('done');
    expect(gate({ working: true })).toBe('working');
  });

  it('says why a run failed from the code it kept, and writes times in Vietnam time and sizes in a readable unit', () => {
    expect(failureKind('IMPORT_SCHEMA_INVALID')).toBe('schemaInvalid');
    expect(failureKind('NOT_KNOWN')).toBeNull();
    expect(failureKind(null)).toBeNull();
    expect(vietnamDateTime('2026-11-10T20:30:00.000Z')).toBe('2026-11-11 03:30');
    expect(vietnamDateTime(null)).toBe('');
    expect(vietnamDateTime('not a time')).toBe('');
    expect(shortHash('abcdef0123456789')).toBe('abcdef012345');
    expect(sizeText(2048, 'en')).toEqual({ value: '2', unit: 'KB' });
    expect(sizeText(5 * 1024 * 1024, 'en')).toEqual({ value: '5', unit: 'MB' });
  });
});
