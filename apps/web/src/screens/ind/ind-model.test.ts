import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { applyGate, camelOf, describeProblem, factFault, factsOf, holds, lineFault, refusedApply, shortHash, sizeText, toApplied, toDictionary, toIndicator, toMappingDetail, toPreview, toRunPage, toVerdict, vietnamDateTime } from './ind-model';
import type { EntryLine, FactLine, Preview } from './ind-model';
import { APPLIED, PREVIEW, SHA, indicator, mapping, run, version, violation } from './test/ind-test-support';

const line = (indicatorCode: string, value: string): EntryLine => ({ indicatorCode, value, reason: '' });

describe('ind-model: words and small helpers', () => {
  it('writes a code as the lower camel segment of a key', () => {
    expect(camelOf('FIELD_REQUIRED')).toBe('fieldRequired');
    expect(camelOf('IND_FIGURE_DIFFERS')).toBe('indFigureDiffers');
    expect(camelOf('VND')).toBe('vnd');
  });

  it('writes a moment as a Vietnam wall clock and nothing for a bad one', () => {
    expect(vietnamDateTime('2026-11-12T03:00:00.000Z')).toBe('2026-11-12 10:00');
    expect(vietnamDateTime('2026-11-12T20:00:00.000Z')).toBe('2026-11-13 03:00');
    expect(vietnamDateTime(null)).toBe('');
    expect(vietnamDateTime('not a moment')).toBe('');
  });

  it('shortens a hash and writes a size in kilobytes or megabytes', () => {
    expect(shortHash(SHA)).toBe('aaaaaaaaaaaa');
    expect(sizeText(10, 'en')).toEqual({ value: '1', unit: 'KB' });
    expect(sizeText(2048, 'en')).toEqual({ value: '2', unit: 'KB' });
    expect(sizeText(3 * 1024 * 1024, 'en')).toEqual({ value: '3', unit: 'MB' });
  });

  it('holds a permission by name or by a wildcard, and leaves a session that does not say to the server', () => {
    expect(holds(['ind.read'], 'ind.read')).toBe(true);
    expect(holds(['ind.read'], 'ind.entry')).toBe(false);
    expect(holds(['ind.*'], 'ind.entry')).toBe(true);
    expect(holds(undefined, 'ind.entry')).toBe(true);
  });
});

describe('ind-model: the payloads', () => {
  it('reads an indicator with safe defaults and refuses one with no code', () => {
    expect(toIndicator(indicator('TOTAL_INVESTMENT'))).toMatchObject({ code: 'TOTAL_INVESTMENT', unit: 'VND', category: 'FUNDING', valueKind: 'ENTERED', enterable: true, origin: 'DEFAULT', unverified: true, version: 0 });
    expect(toIndicator({ code: 'X' })).toMatchObject({ valueKind: 'DERIVED', category: null, aliases: [], enterable: false, origin: 'DEFAULT' });
    expect(toIndicator({ name: 'no code' })).toBeUndefined();
    expect(toIndicator(null)).toBeUndefined();
  });

  it('reads the dictionary with its findings, and refuses what is not a list', () => {
    const read = toDictionary({ items: [indicator('A_CODE'), { nothing: true }], findings: [{ code: 'ALIAS_SHARED', indicators: ['A', 'B'], detail: 'x' }, {}], as_of: '2026-11-12T03:00:00.000Z' });
    expect(read?.items.map((one) => one.code)).toEqual(['A_CODE']);
    expect(read?.findings).toEqual([{ code: 'ALIAS_SHARED', indicators: ['A', 'B'], detail: 'x' }]);
    expect(toDictionary({ items: 'no' })).toBeUndefined();
  });

  it('reads a mapping with its lines and problems, and the versions with who approved them', () => {
    const read = toMappingDetail({ mapping: mapping('M_ONE', { problems: [{ code: 'INDICATOR_UNKNOWN', indicator: 'Q', line: 0 }] }), versions: [version(1), { nothing: true }], as_of: null });
    expect(read?.mapping).toMatchObject({ code: 'M_ONE', layout: 'COLUMNS', numberFormat: 'VN', lines: [{ indicator: 'TOTAL_INVESTMENT', scale: 'MILLION', required: true }, { indicator: 'CUMULATIVE_YTD' }], problems: [{ code: 'INDICATOR_UNKNOWN', line: 0 }] });
    expect(read?.versions).toEqual([expect.objectContaining({ version: 1, approvedByName: 'Lê Văn Cường', createdByName: 'Nguyễn Văn An' })]);
    expect(toMappingDetail({})).toBeUndefined();
  });

  it('reads the verdict of the rules, the preview, the apply and the page of runs', () => {
    expect(toVerdict({ allowed: false, violations: [violation()], evaluated: ['R'], skipped: [{ rule_code: 'S', reason: 'FACT_MISSING' }] })).toMatchObject({ allowed: false, violations: [{ ruleCode: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', severity: 'BLOCK' }], skipped: [{ ruleCode: 'S' }] });
    expect(toVerdict({})).toBeUndefined();
    const preview = toPreview(PREVIEW, '2026-11-12T03:00:00.000Z');
    expect(preview).toMatchObject({ mappingCode: 'MONTHLY_FORM', mappingVersion: 1, counts: { total: 5, valid: 3, errors: 1, duplicate: 1, conflict: 0 }, alreadyApplied: false });
    expect(preview?.rows.map((row) => [row.line, row.status, row.outcome])).toEqual([[2, 'VALID', 'CREATE'], [3, 'VALID', 'CREATE_AND_DIFFERENCE'], [4, 'VALID', 'UNCHANGED'], [5, 'ERROR', null], [6, 'DUPLICATE', null]]);
    expect(toApplied(APPLIED)).toMatchObject({ runId: expect.any(String), figuresWritten: 7, figuresUnchanged: 2, figuresDiffering: 1, counts: { applied: 3, quarantined: 1, differencesOpened: 1 } });
    expect(toApplied({})).toBeUndefined();
    const page = toRunPage({ items: [run(1), { id: 'no counts' }], next_cursor: '20', as_of: null });
    expect(page?.items).toHaveLength(1);
    expect(page?.nextCursor).toBe('20');
    expect(toRunPage({})).toBeUndefined();
  });
});

describe('ind-model: what is checked before a send', () => {
  it('faults a line with no indicator, a number written with a comma or a space, or an indicator used twice', () => {
    const all = [line('A_CODE', '10'), line('B_CODE', '1,5'), line('A_CODE', '3'), line('', '4'), line('C_CODE', ' 12.5 ')];
    expect(all.map((one) => lineFault(one, all))).toEqual(['duplicate', 'value', 'duplicate', 'indicator', undefined]);
    expect(lineFault(line('D_CODE', '-0.000001'), [line('D_CODE', '-0.000001')])).toBeUndefined();
    expect(lineFault(line('D_CODE', '1.1234567'), [line('D_CODE', '1.1234567')])).toBe('value');
    expect(lineFault(line('D_CODE', '012'), [line('D_CODE', '012')])).toBe('value');
  });

  it('faults a field of "try numbers" and keeps only the good ones as facts', () => {
    const lines: FactLine[] = [
      { field: 'CUMULATIVE', value: '5' },
      { field: 'cumulative', value: '6' },
      { field: 'TOTAL_INVESTMENT', value: ' ' },
      { field: ' TOTAL ', value: ' 10 ' },
    ];
    expect(lines.map((one) => factFault(one, lines))).toEqual([undefined, 'field', 'value', undefined]);
    expect(factsOf(lines)).toEqual({ CUMULATIVE: '5', TOTAL: '10' });
  });

  it('closes the apply for the first reason that holds and opens it for a current, valid, new file', () => {
    const preview = toPreview(PREVIEW, '2026-11-12T03:00:00.000Z') as Preview;
    const open = { preview, previewIsCurrent: true, canApply: true, applied: false, working: false };
    expect(applyGate(open)).toBeNull();
    expect(applyGate({ ...open, working: true })).toBe('working');
    expect(applyGate({ ...open, applied: true })).toBe('done');
    expect(applyGate({ ...open, canApply: false })).toBe('noAuthority');
    expect(applyGate({ ...open, preview: undefined })).toBe('noPreview');
    expect(applyGate({ ...open, previewIsCurrent: false })).toBe('stale');
    expect(applyGate({ ...open, preview: { ...preview, alreadyApplied: true } })).toBe('alreadyApplied');
    expect(applyGate({ ...open, preview: { ...preview, counts: { ...preview.counts, valid: 0 } } })).toBe('noValid');
  });
});

describe('ind-model: the problems of a send', () => {
  const error = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

  it('names the problem by its code and carries the rules that blocked an entry, the missing columns and the field of a validation', () => {
    expect(describeProblem(error('IND_ENTRY_RULE_VIOLATED', 422, { violations: [violation()] }, 'EQUITY_PLUS_DEBT_EQUALS_TOTAL'))).toMatchObject({ kind: 'ruleViolated', violations: [{ ruleCode: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', fields: ['EQUITY', 'DEBT', 'TOTAL'] }] });
    expect(describeProblem(error('IMPORT_SCHEMA_INVALID', 422, { missing_columns: ['Kỳ báo cáo'], missing_rows: ['Vốn vay'] }))).toMatchObject({ kind: 'schemaInvalid', missing: ['Kỳ báo cáo', 'Vốn vay'] });
    expect(describeProblem(error('VALIDATION_FAILED', 422, {}, 'figures[0].value'))).toMatchObject({ kind: 'validation', detail: 'figures[0].value' });
    expect(describeProblem(error('IND_MAPPING_NOT_APPROVED', 409)).kind).toBe('mappingNotApproved');
    expect(describeProblem(error('PERIOD_LOCKED', 409)).kind).toBe('periodLocked');
    expect(describeProblem(error('SOMETHING_NEW', 403)).kind).toBe('denied');
    expect(describeProblem(error('SOMETHING_NEW', 500)).kind).toBe('general');
    expect(describeProblem(new Error('plain')).kind).toBe('general');
  });

  it('reads the refusal of an apply for its rows, and nothing from another error', () => {
    const refused = refusedApply(error('IMPORT_HAS_ERRORS', 422, { counts: { total: 3, applied: 0, duplicate: 0, conflict: 0, quarantined: 3, differences_opened: 0 }, errors: [{ line: 2, code: 'ROW_EMPTY', field: 'row', business_key: null, preview: null }], errors_truncated: true }));
    expect(refused).toMatchObject({ runId: null, counts: { quarantined: 3 }, errors: [{ line: 2, code: 'ROW_EMPTY' }], errorsTruncated: true });
    expect(refusedApply(error('IMPORT_HAS_ERRORS', 422, {}))).toBeUndefined();
    expect(refusedApply(error('HASH_MISMATCH', 422))).toBeUndefined();
  });
});
