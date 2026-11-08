import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_PROPOSE,
  EMPTY_RESOLUTION,
  addDays,
  amountText,
  applyGate,
  camelOf,
  commandBlock,
  dayText,
  defaultFiscalYear,
  describeProblem,
  differenceFiltersOf,
  differenceQueryOf,
  differenceSearchOf,
  filterRows,
  generatorBlock,
  generatorBody,
  generatorFormOf,
  indicatorTone,
  isOverdue,
  kindFit,
  mappingFiltersOf,
  mappingQueryOf,
  mappingSearchOf,
  numberText,
  percentText,
  proposeBody,
  proposeFromUnmapped,
  reasonProblem,
  reconcileBody,
  recordRows,
  refusedApply,
  resolutionBody,
  rowCodeKey,
  runFiltersOf,
  runQueryOf,
  runSearchOf,
  sizeText,
  toApplied,
  toConnection,
  toDifferencePage,
  toGeneratorReceipt,
  toMappingPage,
  toPreview,
  toQuality,
  toReconciliation,
  toRunDetail,
  toRunPage,
  toUnmappedList,
  toUploadedFile,
  total,
  validateGenerator,
  validatePropose,
  validateReconcile,
  validateResolution,
  vietnamStamp,
  vietnamToday,
} from './feed-model';
import type { Difference, GeneratorForm, Indicator, PreviewRow } from './feed-model';
import { APPLIED, PREVIEW, UPLOADED, connection, detail, difference, health, indicator, mapping, neverHealth, quality, resolvedDifference, run, runId, unmapped } from './test/feed-test-support';

const ind = (code: string, pct: string | null, numerator: number, denominator: number): Indicator => ({ code, pct, numerator, denominator, asOf: '2026-11-08' });

const problemOf = (code: string, status: number, detail?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions });

describe('reading the connection', () => {
  it('reads every part of a connection the way the server writes it', () => {
    const read = toConnection(connection());
    expect(read.connectorCode).toBe('fin.sotaichinh');
    expect(read.enabled).toBe(true);
    expect(read.version).toBe(7);
    expect(read.channels.map((one) => one.channel)).toEqual(['FILE', 'API_PUSH', 'GENERATOR']);
    expect(read.channels[1]).toMatchObject({ adapterStatus: 'MISSING', reason: 'MACHINE_ACCOUNT_PENDING', opensNetwork: false });
    expect(read.health).toMatchObject({ status: 'FRESH', ageHours: 12.5, lastRunChannel: 'FILE' });
    expect(read.health.rule).toMatchObject({ warnAfterHours: 48, maxAgeHours: 96, unverified: true, legalStatus: 'UNVERIFIED' });
    expect(read.health.policy).toMatchObject({ tolerancePct: 0.5, largeDiscrepancyPct: 5, reportDueDays: 5, differenceDueDays: 7 });
    expect(read.quality.indicators).toHaveLength(3);
    expect(read.quality.lateUnits).toHaveLength(2);
    expect(read.differenceCounts).toEqual({ open: 3, openLarge: 1, resolved: 5 });
    expect(read.actions.controlGenerator).toBe(true);
    expect(read.layouts[0]?.columns[2]?.values).toEqual(['ACTIVE', 'SUSPENDED']);
    expect(read.lastRuns.map((one) => one.channel)).toEqual(['FILE', 'GENERATOR']);
  });

  it('keeps the generator parameters with the count of anchors, and a generator that never started has none', () => {
    const started = toConnection(connection({ generator: { state: 'RUNNING', epoch: 2, parameters: { seed: 57, fiscal_year: 2026, current_month: 10, project_count: 120, late_units: 3, delayed_pct: 22, ahead_pct: 12, discrepancies: 6, anchor_count: 4 } } }));
    expect(started.generator.state).toBe('RUNNING');
    expect(started.generator.parameters).toMatchObject({ seed: 57, currentMonth: 10, anchorCount: 4 });
    expect(toConnection(connection()).generator.parameters).toBeNull();
  });

  it.each([
    ['not an object', 'text'],
    ['a missing list', { ...connection(), channels: undefined }],
    ['a missing object', { ...connection(), health: undefined }],
    ['a health without its rule', { ...connection(), health: { status: 'FRESH' } }],
    ['a health with a state nobody knows', { ...connection(), health: health({ status: 'ALIVE' }) }],
    ['a quality without indicators', { ...connection(), quality: { fiscal_year: 2026, month: 10 } }],
  ])('refuses %s as a wrong shape (the screen shows an error, never an empty page)', (_name, raw) => {
    expect(() => toConnection(raw)).toThrow();
  });

  it('reads a connection that never was used', () => {
    const read = toConnection(connection({ registered: false, health: neverHealth() }));
    expect(read.registered).toBe(false);
    expect(read.health.status).toBe('NEVER_RECEIVED');
    expect(read.health.ageHours).toBeNull();
    expect(read.health.lastRunAt).toBeNull();
  });

  it('reads a quality reading and ignores an indicator without a code', () => {
    const read = toQuality(quality({ indicators: [indicator('FEED_COMPLETENESS', null, 0, 0), { pct: '1' }] }));
    expect(read?.indicators).toEqual([{ code: 'FEED_COMPLETENESS', pct: null, numerator: 0, denominator: 0, asOf: '2026-11-08' }]);
    expect(toQuality({ fiscal_year: 2026 })).toBeUndefined();
  });
});

describe('time, numbers and amounts', () => {
  it('writes the Vietnam day and minute of an instant, and leaves an unreadable one as it came', () => {
    expect(vietnamStamp('2026-11-08T03:05:00.000Z')).toBe('08/11/2026 10:05');
    expect(vietnamStamp('2026-12-31T20:00:00.000Z')).toBe('01/01/2027 03:00');
    expect(vietnamStamp('soon')).toBe('soon');
    expect(vietnamStamp(null)).toBe('');
    expect(vietnamStamp(undefined)).toBe('');
  });

  it('writes a day from a day or from an instant', () => {
    expect(dayText('2026-11-08')).toBe('08/11/2026');
    expect(dayText('2026-11-08T20:00:00.000Z')).toBe('09/11/2026');
    expect(dayText(null)).toBe('');
  });

  it('groups the digits of an amount the way the locale does, without turning it into a float', () => {
    expect(amountText('1500000000', 'vi')).toBe('1.500.000.000');
    expect(amountText('1500000000.25', 'vi')).toBe('1.500.000.000,25');
    expect(amountText('-5000', 'en')).toBe('-5,000');
    expect(amountText('12345678901234567890.5', 'en')).toBe('12,345,678,901,234,567,890.5');
    expect(amountText('abc', 'en')).toBe('abc');
    expect(amountText(null, 'en')).toBe('');
  });

  it('writes a percent with its digits and says nothing for a value that is not there', () => {
    expect(percentText('87.5', 'en')).toBe('87.5%');
    expect(percentText('87.5', 'vi')).toBe('87,5%');
    expect(percentText('0', 'en')).toBe('0%');
    expect(percentText(null, 'en')).toBe('');
    expect(percentText('n/a', 'en')).toBe('n/a');
  });

  it('writes counts and sizes', () => {
    expect(numberText(1234.56, 'en')).toBe('1,234.6');
    expect(sizeText(500, 'en')).toEqual({ value: '1', unit: 'KB' });
    expect(sizeText(2048, 'en')).toEqual({ value: '2', unit: 'KB' });
    expect(sizeText(3 * 1024 * 1024, 'en')).toEqual({ value: '3', unit: 'MB' });
  });

  it('counts the days of Vietnam', () => {
    expect(vietnamToday(new Date('2026-11-08T20:00:00.000Z'))).toBe('2026-11-09');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('the figures of the connection', () => {
  it('judges an indicator by its direction: completeness high, discrepancy low, and not computable is neutral', () => {
    expect(indicatorTone('FEED_COMPLETENESS', ind('FEED_COMPLETENESS', '100', 5, 5))).toBe('success');
    expect(indicatorTone('FEED_COMPLETENESS', ind('FEED_COMPLETENESS', '85', 17, 20))).toBe('info');
    expect(indicatorTone('FEED_TIMELINESS', ind('FEED_TIMELINESS', '40', 4, 10))).toBe('warning');
    expect(indicatorTone('FEED_DISCREPANCY_RATE', ind('FEED_DISCREPANCY_RATE', '0', 0, 10))).toBe('success');
    expect(indicatorTone('FEED_DISCREPANCY_RATE', ind('FEED_DISCREPANCY_RATE', '4', 4, 100))).toBe('info');
    expect(indicatorTone('FEED_DISCREPANCY_RATE', ind('FEED_DISCREPANCY_RATE', '30', 30, 100))).toBe('warning');
    expect(indicatorTone('FEED_COMPLETENESS', ind('FEED_COMPLETENESS', null, 0, 0))).toBe('neutral');
    expect(indicatorTone('FEED_COMPLETENESS', undefined)).toBe('neutral');
  });

  it('lists the four kinds first and in their order, then any kind the server adds', () => {
    expect(recordRows({ PLAN: 2, ZETA: 1, PROJECT: 5, ALPHA: 3 })).toEqual([
      { kind: 'PROJECT', count: 5 },
      { kind: 'PLAN', count: 2 },
      { kind: 'DISBURSEMENT', count: 0 },
      { kind: 'MILESTONE', count: 0 },
      { kind: 'ALPHA', count: 3 },
      { kind: 'ZETA', count: 1 },
    ]);
    expect(total({ PROJECT: 5, PLAN: 2 })).toBe(7);
  });

  it('closes a command for a read-only workspace first, then for a missing right', () => {
    expect(commandBlock(true, 'READ_ONLY')).toBe('MODE');
    expect(commandBlock(false, 'FULL')).toBe('RIGHT');
    expect(commandBlock(false, 'READ_ONLY')).toBe('MODE');
    expect(commandBlock(true, 'FULL')).toBeNull();
    expect(commandBlock(true, undefined)).toBeNull();
  });
});

describe('refusals', () => {
  it.each([
    ['IMPORT_FILE_ALREADY_APPLIED', 409, 'alreadyApplied'],
    ['FEED_CONNECTION_DISABLED', 409, 'connectionDisabled'],
    ['IMPORT_HAS_ERRORS', 422, 'hasErrors'],
    ['HASH_MISMATCH', 422, 'hashMismatch'],
    ['IMPORT_SCHEMA_INVALID', 422, 'schemaInvalid'],
    ['IMPORT_EMPTY', 422, 'empty'],
    ['FEED_LAYOUT_VERSION_UNKNOWN', 422, 'layoutUnknown'],
    ['FILE_NOT_CLEAN', 422, 'fileRefused'],
    ['PAYLOAD_TOO_LARGE', 413, 'tooLarge'],
    ['SCAN_PENDING', 409, 'scanPending'],
    ['VALIDATION_FAILED', 422, 'validation'],
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
    ['SCOPE_DENIED', 403, 'scopeDenied'],
    ['SELF_APPROVAL_DENIED', 403, 'selfApproval'],
    ['VERSION_CONFLICT', 409, 'versionConflict'],
    ['FEED_MAPPING_STATE_INVALID', 409, 'mappingState'],
    ['FEED_DIFFERENCE_STATE_INVALID', 409, 'differenceState'],
    ['FEED_GENERATOR_STATE_INVALID', 409, 'generatorState'],
    ['CROSSWALK_DUPLICATE', 409, 'duplicate'],
    ['FEED_API_UNAVAILABLE', 503, 'apiUnavailable'],
    ['SOMETHING_ELSE', 403, 'forbidden'],
    ['SOMETHING_ELSE', 500, 'general'],
  ])('reads %s (%i) as %s', (code, status, kind) => {
    expect(describeProblem(problemOf(code, status)).kind).toBe(kind);
  });

  it('keeps what the server said more: the field of a validation, the missing columns, the layouts that are read', () => {
    expect(describeProblem(problemOf('VALIDATION_FAILED', 422, 'evidence_ref')).field).toBe('evidence_ref');
    expect(describeProblem(problemOf('IMPORT_SCHEMA_INVALID', 422, undefined, { missing_columns: ['a', 'b', 3] })).missingColumns).toEqual(['a', 'b']);
    expect(describeProblem(problemOf('FEED_LAYOUT_VERSION_UNKNOWN', 422, undefined, { layout_version: 'V9', supported: ['V1'] }))).toMatchObject({ layoutVersion: 'V9', supported: ['V1'] });
    expect(describeProblem(problemOf('FEED_GENERATOR_STATE_INVALID', 409, 'year_complete')).detail).toBe('year_complete');
    expect(describeProblem(new Error('x')).kind).toBe('general');
  });

  it('reads the refusal of a whole file as an apply that took nothing', () => {
    const refused = refusedApply(problemOf('IMPORT_HAS_ERRORS', 422, 'file', { counts: { total: 3, applied: 0, duplicate: 0, conflict: 0, quarantined: 3, differences_opened: 0 }, errors: [{ line: 2, business_key: 'K', code: 'MONEY_INVALID', field: 'x', preview: null }], errors_truncated: true }));
    expect(refused).toMatchObject({ refused: true, errorsTruncated: true });
    expect(refused?.counts.quarantined).toBe(3);
    expect(refused?.errors[0]).toMatchObject({ line: 2, code: 'MONEY_INVALID' });
    expect(refusedApply(problemOf('VERSION_CONFLICT', 409))).toBeUndefined();
    expect(refusedApply(new Error('x'))).toBeUndefined();
  });

  it('judges a reason by its length after trimming', () => {
    expect(reasonProblem('   ')).toBe('EMPTY');
    expect(reasonProblem('short')).toBe('SHORT');
    expect(reasonProblem('  long enough reason  ')).toBeNull();
    expect(reasonProblem('x'.repeat(2001))).toBe('LONG');
    expect(reasonProblem('twenty characters!!', 20)).toBe('SHORT');
  });
});

describe('a file import', () => {
  it('reads the answer of the upload and tells which kinds the file fits, without changing the choice', () => {
    const uploaded = toUploadedFile(UPLOADED);
    expect(uploaded).toMatchObject({ fileObjectKey: expect.any(String), format: 'CSV', rowCount: 6, matchingKinds: ['DISBURSEMENT'] });
    expect(toUploadedFile({ file_sha256: 'x' })).toBeUndefined();
    if (uploaded === undefined) throw new Error('no upload');
    expect(kindFit(uploaded, 'DISBURSEMENT')).toBe('fits');
    expect(kindFit(uploaded, 'PLAN')).toBe('other');
    expect(kindFit({ ...uploaded, matchingKinds: [] }, 'PLAN')).toBe('none');
  });

  it('reads a dry run with its counts and rows, and drops a row that has no verdict', () => {
    const read = toPreview({ ...PREVIEW, rows: [...PREVIEW.rows, { line: 9 }] }, '2026-11-08T03:00:00.000Z');
    expect(read?.counts).toEqual({ total: 6, valid: 3, errors: 1, duplicate: 1, conflict: 1 });
    expect(read?.rows).toHaveLength(6);
    expect(read?.rows[3]).toMatchObject({ status: 'ERROR', code: 'MONEY_INVALID', field: 'disbursed_month', preview: { feed_project_code: 'FIN-0004', disbursed_month: '12x' } });
    expect(read?.connectionEnabled).toBe(true);
    expect(toPreview({ kind: 'PLAN' }, 'x')).toBeUndefined();
  });

  it('filters the rows of a dry run by verdict', () => {
    const rows = (toPreview(PREVIEW, 'x')?.rows ?? []) as PreviewRow[];
    expect(filterRows(rows, '')).toHaveLength(6);
    expect(filterRows(rows, 'ERROR').map((row) => row.line)).toEqual([4]);
    expect(filterRows(rows, 'VALID').map((row) => row.line)).toEqual([1, 2, 3]);
  });

  it('reads what an apply did', () => {
    const read = toApplied(APPLIED);
    expect(read).toMatchObject({ runId: runId(9), mappingsProposed: 2, refused: false });
    expect(read?.counts).toEqual({ total: 6, applied: 3, duplicate: 1, conflict: 1, quarantined: 1, differencesOpened: 2 });
    expect(toApplied({})).toBeUndefined();
  });

  it('opens the apply only after a dry run of that file, for a person who may, with a valid row, a connection that is on and a file not applied before', () => {
    const preview = toPreview(PREVIEW, 'x');
    const open = { preview, previewIsCurrent: true, canApply: true, connectionBlocked: false, applied: false, working: false };
    expect(applyGate(open)).toBeNull();
    expect(applyGate({ ...open, applied: true })).toBe('done');
    expect(applyGate({ ...open, working: true })).toBe('working');
    expect(applyGate({ ...open, preview: undefined })).toBe('noPreview');
    expect(applyGate({ ...open, previewIsCurrent: false })).toBe('noPreview');
    expect(applyGate({ ...open, preview: preview === undefined ? undefined : { ...preview, alreadyApplied: true } })).toBe('alreadyApplied');
    expect(applyGate({ ...open, connectionBlocked: true })).toBe('connectionDisabled');
    expect(applyGate({ ...open, preview: preview === undefined ? undefined : { ...preview, connectionEnabled: false } })).toBe('connectionDisabled');
    expect(applyGate({ ...open, canApply: false })).toBe('noAuthority');
    expect(applyGate({ ...open, preview: preview === undefined ? undefined : { ...preview, counts: { ...preview.counts, valid: 0 } } })).toBe('noValid');
  });

  it('writes the key of the reason of a row from its code', () => {
    expect(camelOf('FIELD_TOO_LONG')).toBe('fieldTooLong');
    expect(rowCodeKey('MONEY_INVALID')).toBe('moneyInvalid');
    expect(rowCodeKey('WEIRD_CODE')).toBe('other');
    expect(rowCodeKey(null)).toBe('other');
  });

  it('reads the pages of runs and one run with its refused rows, and refuses a wrong shape', () => {
    const page = toRunPage({ items: [run(1), { id: 'x', channel: 'NOWHERE' }], next_cursor: '20', as_of: '2026-11-08T03:00:00.000Z' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('20');
    expect(() => toRunPage({})).toThrow();
    const read = toRunDetail(detail(1, { errors_truncated: true }));
    expect(read.errors).toHaveLength(2);
    expect(read.errorsTruncated).toBe(true);
    expect(read.run.counts).toEqual({ total: 40, written: 30, skipped: 8, rejected: 2 });
    expect(() => toRunDetail({})).toThrow();
  });

  it('keeps the filters of the run list in the address and drops a value nobody knows', () => {
    expect(runFiltersOf(new URLSearchParams('channel=GENERATOR&kind=PLAN'))).toEqual({ channel: 'GENERATOR', kind: 'PLAN' });
    expect(runFiltersOf(new URLSearchParams('channel=PIGEON&kind=x'))).toEqual({});
    expect(runSearchOf({ channel: 'FILE', kind: 'PROJECT' }).toString()).toBe('channel=FILE&kind=PROJECT');
    expect(runQueryOf({ channel: 'FILE' }, '20')).toEqual({ channel: 'FILE', cursor: '20', limit: 20 });
    expect(runQueryOf({}, undefined)).toEqual({ limit: 20 });
  });
});

describe('the code mapping', () => {
  it('reads a page of mappings with the counts by state, and the rights of each row', () => {
    const page = toMappingPage({ items: [mapping(1), { id: 'x' }], next_cursor: null, counts: { PROPOSED: 1, ACTIVE: 2 }, as_of: '2026-11-08T03:00:00.000Z' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ externalCode: 'FIN-0001', ourCode: 'DA-1', status: 'PROPOSED', canDecide: true, canRetire: false, version: 3 });
    expect(page.counts).toEqual({ PROPOSED: 1, ACTIVE: 2, REJECTED: 0, RETIRED: 0 });
    expect(() => toMappingPage({ items: [] })).toThrow();
  });

  it('reads the codes that wait for a mapping', () => {
    const list = toUnmappedList({ items: [unmapped(1), { project_name: 'no code' }], total: 80, as_of: 'x' });
    expect(list.items).toEqual([{ feedProjectCode: 'FIN-901', projectName: 'Dự án mới 1', investorCode: 'CDT-1', ourCodeHint: 'DA-HINT', asOfStatement: '2026-10-31' }]);
    expect(list.total).toBe(80);
    expect(() => toUnmappedList(null)).toThrow();
  });

  it('keeps the filters in the address and the query in step with them', () => {
    const filters = mappingFiltersOf(new URLSearchParams('status=ACTIVE&q=%20FIN-1%20'));
    expect(filters).toEqual({ status: 'ACTIVE', q: 'FIN-1' });
    expect(mappingFiltersOf(new URLSearchParams('status=BOGUS&q='))).toEqual({});
    expect(mappingSearchOf(filters).toString()).toBe('status=ACTIVE&q=FIN-1');
    expect(mappingQueryOf(filters, '20')).toEqual({ status: 'ACTIVE', q: 'FIN-1', cursor: '20', limit: 20 });
  });

  it('checks a proposal as the server does, field by field', () => {
    expect(validatePropose(EMPTY_PROPOSE)).toEqual({ ourCode: 'required', externalCode: 'required' });
    expect(validatePropose({ ourCode: 'DA-1', externalCode: 'FIN-1', validFrom: '', validUntil: '' })).toEqual({});
    expect(validatePropose({ ourCode: 'x'.repeat(101), externalCode: 'FIN-1', validFrom: '', validUntil: '' })).toEqual({ ourCode: 'tooLong' });
    expect(validatePropose({ ourCode: 'DA\u0007', externalCode: 'FIN-1', validFrom: '', validUntil: '' })).toEqual({ ourCode: 'invalid' });
    expect(validatePropose({ ourCode: 'A', externalCode: 'B', validFrom: '2026-02-30', validUntil: 'x' })).toEqual({ validFrom: 'invalid', validUntil: 'invalid' });
    expect(validatePropose({ ourCode: 'A', externalCode: 'B', validFrom: '2026-05-01', validUntil: '2026-05-01' })).toEqual({ validUntil: 'order' });
    expect(validatePropose({ ourCode: 'A', externalCode: 'B', validFrom: '2026-05-01', validUntil: '2026-05-02' })).toEqual({});
  });

  it('writes the body of a proposal trimmed and without the days that are empty', () => {
    expect(proposeBody({ ourCode: ' DA-1 ', externalCode: ' FIN-1 ', validFrom: '', validUntil: '' }, ' Trùng tên và vốn ')).toEqual({ our_code: 'DA-1', external_code: 'FIN-1', reason: 'Trùng tên và vốn' });
    expect(proposeBody({ ourCode: 'A', externalCode: 'B', validFrom: '2026-05-01', validUntil: '2026-06-01' }, 'reason reason')).toMatchObject({ valid_from: '2026-05-01', valid_until: '2026-06-01' });
  });

  it('opens a proposal from an unmapped code with the hint of the server as our code', () => {
    expect(proposeFromUnmapped({ feedProjectCode: 'FIN-901', projectName: null, investorCode: null, ourCodeHint: 'DA-HINT', asOfStatement: null })).toEqual({ ourCode: 'DA-HINT', externalCode: 'FIN-901', validFrom: '', validUntil: '' });
    expect(proposeFromUnmapped({ feedProjectCode: 'FIN-902', projectName: null, investorCode: null, ourCodeHint: null, asOfStatement: null }).ourCode).toBe('');
  });
});

describe('the differences', () => {
  const page = (items: unknown[]) => toDifferencePage({ items, next_cursor: null, counts: { open: 2, open_large: 1, resolved: 1, figures_compared: 120 }, as_of: 'x' });

  it('reads a page of differences with the resolution of the settled ones', () => {
    const read = page([difference(1), resolvedDifference(3), { id: 'x' }]);
    expect(read.items).toHaveLength(2);
    expect(read.items[0]).toMatchObject({ feedProjectCode: 'FIN-0001', ourCode: 'DA-1', feedValue: '1500000000', ourValue: '1200000000', delta: '300000000', deltaPct: '25', large: true, state: 'OPEN', canResolve: true, resolution: null });
    expect(read.items[1]?.resolution).toEqual({ kind: 'DISPUTE', resolvedByName: 'Nguyễn Văn An', resolvedAt: '2026-11-07T03:00:00.000Z', reason: 'Số của Sở chưa tính đợt hai', evidenceRef: 'CV-123/STC', reviewOn: null });
    expect(read.counts).toEqual({ open: 2, openLarge: 1, resolved: 1, figuresCompared: 120 });
    expect(() => toDifferencePage({ items: [] })).toThrow();
  });

  it('reads a figure that we do not have as missing, not as zero', () => {
    const [read] = page([difference(1, { kind: 'MISSING_OURS', our_value: null, delta: null, delta_pct: null })]).items;
    expect(read).toMatchObject({ kind: 'MISSING_OURS', ourValue: null, delta: null, deltaPct: null });
  });

  it('keeps the filters in the address and drops a value nobody knows', () => {
    const filters = differenceFiltersOf(new URLSearchParams('state=OPEN&large=true&fiscal_year=2026&q=FIN'));
    expect(filters).toEqual({ state: 'OPEN', large: true, fiscalYear: 2026, q: 'FIN' });
    expect(differenceFiltersOf(new URLSearchParams('state=DONE&large=maybe&fiscal_year=1900'))).toEqual({});
    expect(differenceFiltersOf(new URLSearchParams('large=false'))).toEqual({ large: false });
    expect(differenceSearchOf(filters).toString()).toBe('state=OPEN&large=true&fiscal_year=2026&q=FIN');
    expect(differenceQueryOf(filters, '20')).toEqual({ state: 'OPEN', large: 'true', fiscal_year: 2026, q: 'FIN', cursor: '20', limit: 20 });
  });

  it('calls an open difference past its day overdue, and a settled one never', () => {
    const [open, settled] = page([difference(1, { due_at: '2026-11-01T00:00:00.000Z' }), resolvedDifference(3, { due_at: '2026-11-01T00:00:00.000Z' })]).items as [Difference, Difference];
    const now = new Date('2026-11-08T00:00:00.000Z');
    expect(isOverdue(open, now)).toBe(true);
    expect(isOverdue({ ...open, dueAt: '2026-11-20T00:00:00.000Z' }, now)).toBe(false);
    expect(isOverdue(settled, now)).toBe(false);
  });

  it('asks a reason as long as the kind needs, a reference for a dispute and a day for a waiver', () => {
    const today = '2026-11-08';
    expect(validateResolution(EMPTY_RESOLUTION, today)).toEqual({ kind: 'required' });
    expect(validateResolution({ kind: 'ACCEPT_FEED', reason: 'Đã kiểm tra sổ', evidenceRef: '', reviewOn: '' }, today)).toEqual({});
    expect(validateResolution({ kind: 'KEEP_OURS', reason: 'ngắn', evidenceRef: '', reviewOn: '' }, today)).toEqual({ reason: 'short' });
    expect(validateResolution({ kind: 'DISPUTE', reason: 'x'.repeat(19), evidenceRef: '', reviewOn: '' }, today)).toEqual({ reason: 'short', evidenceRef: 'required' });
    expect(validateResolution({ kind: 'DISPUTE', reason: 'x'.repeat(20), evidenceRef: 'CV-1', reviewOn: '' }, today)).toEqual({});
    expect(validateResolution({ kind: 'DISPUTE', reason: 'x'.repeat(20), evidenceRef: 'e'.repeat(201), reviewOn: '' }, today)).toEqual({ evidenceRef: 'long' });
    expect(validateResolution({ kind: 'WAIVE', reason: 'x'.repeat(20), evidenceRef: '', reviewOn: '' }, today)).toEqual({ reviewOn: 'required' });
    expect(validateResolution({ kind: 'WAIVE', reason: 'x'.repeat(20), evidenceRef: '', reviewOn: '2026-11-08' }, today)).toEqual({ reviewOn: 'past' });
    expect(validateResolution({ kind: 'WAIVE', reason: 'x'.repeat(20), evidenceRef: '', reviewOn: '2027-11-09' }, today)).toEqual({ reviewOn: 'far' });
    expect(validateResolution({ kind: 'WAIVE', reason: 'x'.repeat(20), evidenceRef: '', reviewOn: '2027-11-08' }, today)).toEqual({});
    expect(validateResolution({ kind: 'WAIVE', reason: 'x'.repeat(20), evidenceRef: '', reviewOn: '2026-13-40' }, today)).toEqual({ reviewOn: 'invalid' });
    expect(validateResolution({ kind: 'ACCEPT_FEED', reason: 'x'.repeat(1001), evidenceRef: '', reviewOn: '' }, today)).toEqual({ reason: 'long' });
  });

  it('writes the body of a resolution with only the fields its kind takes', () => {
    expect(resolutionBody(EMPTY_RESOLUTION)).toBeUndefined();
    expect(resolutionBody({ kind: 'ACCEPT_FEED', reason: ' đúng rồi đó ', evidenceRef: 'ignored?', reviewOn: '2027-01-01' })).toEqual({ kind: 'ACCEPT_FEED', reason: 'đúng rồi đó', evidence_ref: 'ignored?' });
    expect(resolutionBody({ kind: 'DISPUTE', reason: 'r'.repeat(20), evidenceRef: ' CV-1 ', reviewOn: '' })).toEqual({ kind: 'DISPUTE', reason: 'r'.repeat(20), evidence_ref: 'CV-1' });
    expect(resolutionBody({ kind: 'WAIVE', reason: 'r'.repeat(20), evidenceRef: 'CV-1', reviewOn: '2027-01-01' })).toEqual({ kind: 'WAIVE', reason: 'r'.repeat(20), review_on: '2027-01-01' });
  });

  it('checks the year and the owner of a reconciliation and writes its body', () => {
    expect(validateReconcile({ fiscalYear: '', ownerId: '' })).toEqual({ fiscalYear: 'required' });
    expect(validateReconcile({ fiscalYear: '26', ownerId: '' })).toEqual({ fiscalYear: 'range' });
    expect(validateReconcile({ fiscalYear: '2101', ownerId: '' })).toEqual({ fiscalYear: 'range' });
    expect(validateReconcile({ fiscalYear: '2026', ownerId: 'someone' })).toEqual({ ownerId: 'invalid' });
    expect(validateReconcile({ fiscalYear: '2026', ownerId: '00000000-0000-4000-8000-0000000000e1' })).toEqual({});
    expect(reconcileBody({ fiscalYear: ' 2026 ', ownerId: '' })).toEqual({ fiscal_year: 2026 });
    expect(reconcileBody({ fiscalYear: '2026', ownerId: ' 00000000-0000-4000-8000-0000000000e1 ' })).toEqual({ fiscal_year: 2026, owner_id: '00000000-0000-4000-8000-0000000000e1' });
  });

  it('reads the result of a reconciliation and counts its large items', () => {
    const read = toReconciliation({ fiscal_year: 2026, projects_compared: 30, figures_compared: 90, existing: 2, skipped_owner_is_maker: ['a'], opened: [difference(1), difference(2, { large: false })] });
    expect(read).toEqual({ fiscalYear: 2026, projectsCompared: 30, figuresCompared: 90, existing: 2, opened: 2, openedLarge: 1, skippedOwnerIsMaker: 1 });
    expect(toReconciliation({})).toBeUndefined();
  });

  it('proposes the fiscal year of the quality reading, else the year of today', () => {
    expect(defaultFiscalYear(toQuality(quality()), '2027-01-02')).toBe('2026');
    expect(defaultFiscalYear(undefined, '2027-01-02')).toBe('2027');
  });
});

describe('the data generator', () => {
  const gen = (over: Partial<Record<'enabled' | 'state' | 'month', unknown>> = {}) =>
    toConnection(
      connection({
        enabled: over.enabled ?? true,
        generator: { state: over.state ?? 'STOPPED', epoch: 1, parameters: over.month === undefined ? null : { seed: 57, fiscal_year: 2026, current_month: over.month, project_count: 120, late_units: 3, delayed_pct: 22, ahead_pct: 12, discrepancies: 6, anchor_count: 0 } },
      }),
    );

  it('opens each move by the state, the way the server judges it', () => {
    expect(generatorBlock('START', gen())).toBeNull();
    expect(generatorBlock('START', gen({ state: 'RUNNING', month: 5 }))).toBe('running');
    expect(generatorBlock('START', gen({ enabled: false }))).toBe('connection');
    expect(generatorBlock('STOP', gen({ state: 'RUNNING', month: 5 }))).toBeNull();
    expect(generatorBlock('STOP', gen())).toBe('stopped');
    expect(generatorBlock('RESEED', gen())).toBeNull();
    expect(generatorBlock('RESEED', gen({ enabled: false }))).toBe('connection');
    expect(generatorBlock('TICK', gen({ state: 'RUNNING', month: 5 }))).toBeNull();
    expect(generatorBlock('TICK', gen({ state: 'RUNNING', month: 12 }))).toBe('yearComplete');
    expect(generatorBlock('TICK', gen())).toBe('neverStarted');
    expect(generatorBlock('TICK', gen({ month: 4 }))).toBe('stopped');
    expect(generatorBlock('TICK', gen({ enabled: false, state: 'RUNNING', month: 4 }))).toBe('connection');
  });

  it('opens the form on the stored parameters, else on the defaults of the generator', () => {
    expect(generatorFormOf(null)).toMatchObject({ seed: '57', projectCount: '120', lateUnits: '3', delayedPct: '22', aheadPct: '12', discrepancies: '6', anchorCount: '0', fiscalYear: '', currentMonth: '', reason: '' });
    const stored = generatorFormOf(gen({ month: 10 }).generator.parameters);
    expect(stored).toMatchObject({ seed: '57', fiscalYear: '2026', currentMonth: '10' });
  });

  const form = (over: Partial<GeneratorForm> = {}): GeneratorForm => ({ ...generatorFormOf(null), ...over });

  it('checks the numbers of a move in the limits of the generator and only the fields the move takes', () => {
    expect(validateGenerator('START', form())).toEqual({});
    expect(validateGenerator('START', form({ projectCount: '5' }))).toEqual({ projectCount: 'range' });
    expect(validateGenerator('START', form({ lateUnits: '21', discrepancies: '101' }))).toEqual({ lateUnits: 'range', discrepancies: 'range' });
    expect(validateGenerator('START', form({ seed: 'abc', currentMonth: '13', fiscalYear: '1999' }))).toEqual({ seed: 'integer', currentMonth: 'range', fiscalYear: 'range' });
    expect(validateGenerator('START', form({ seed: '-1' }))).toEqual({ seed: 'integer' });
    expect(validateGenerator('START', form({ delayedPct: '80', aheadPct: '20' }))).toEqual({ aheadPct: 'share' });
    expect(validateGenerator('START', form({ fiscalYear: '', currentMonth: '' }))).toEqual({});
    expect(validateGenerator('RESEED', form({ seed: '' }))).toEqual({ seed: 'required' });
    expect(validateGenerator('RESEED', form({ seed: '9' }))).toEqual({});
    expect(validateGenerator('STOP', form({ seed: 'abc', projectCount: '1' }))).toEqual({});
    expect(validateGenerator('TICK', form({ seed: 'abc' }))).toEqual({});
  });

  it('writes the body of a move with only its fields and the reason, and leaves an empty field to the server', () => {
    expect(generatorBody('STOP', form({ reason: ' xong việc kiểm tra ' }))).toEqual({ action: 'STOP', reason: 'xong việc kiểm tra' });
    expect(generatorBody('TICK', form({ reason: 'đi tiếp tháng sau' }))).toEqual({ action: 'TICK', reason: 'đi tiếp tháng sau' });
    expect(generatorBody('START', form({ reason: 'khởi động thử', fiscalYear: '2026', currentMonth: '', seed: '7' }))).toEqual({
      action: 'START',
      reason: 'khởi động thử',
      seed: 7,
      fiscal_year: 2026,
      project_count: 120,
      late_units: 3,
      delayed_pct: 22,
      ahead_pct: 12,
      discrepancies: 6,
      anchor_count: 0,
    });
    const reseed = generatorBody('RESEED', form({ reason: 'đổi hạt giống', seed: '99', fiscalYear: '2026', currentMonth: '5' }));
    expect(reseed).toMatchObject({ action: 'RESEED', seed: 99 });
    expect(reseed).not.toHaveProperty('fiscal_year');
    expect(reseed).not.toHaveProperty('current_month');
  });

  it('reads the receipt of a move', () => {
    expect(toGeneratorReceipt({ generator: { state: 'RUNNING', epoch: 3, current_month: 11, seed: 57 }, run: { id: 'r', records_written: 600, records_skipped: 4 }, mappings_proposed: 5 })).toEqual({ state: 'RUNNING', epoch: 3, month: 11, seed: 57, recordsWritten: 600, recordsSkipped: 4, mappingsProposed: 5 });
    expect(toGeneratorReceipt({ generator: { state: 'STOPPED', epoch: 3 }, run: null })).toMatchObject({ recordsWritten: null, month: null });
    expect(toGeneratorReceipt({})).toBeUndefined();
  });
});
