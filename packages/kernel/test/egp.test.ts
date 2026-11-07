import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { DomainError } from '../src/errors.ts';
import {
  EGP_ADAPTER_STATUS,
  EGP_ALERT_CODES,
  EGP_COMPARE_FIELDS,
  EGP_CONNECTOR_CODE,
  EGP_EXTERNAL_TYPES,
  EGP_FORMATS,
  EGP_LAYOUTS,
  EGP_LAYOUT_KINDS,
  EGP_LAYOUT_VERSION,
  EGP_MATCH_METHODS,
  EGP_OBLIGATION_STATES,
  EGP_PENDING_EXTERNAL_ITEMS,
  EGP_POSTING_FIELDS,
  EGP_POSTING_KINDS,
  EGP_RESOLUTION_FOLLOW_UP,
  EGP_RESOLUTION_KINDS,
  EGP_SOURCE_SYSTEM,
  EGP_SUBJECT_TYPES,
  EgpApiAdapter,
  EgpFileAdapter,
  crosswalkMethodOf,
  diffEgpRecords,
  dryRunEgpFile,
  egpAcceptance,
  egpAlertFor,
  egpConnectorHealth,
  egpDayOf,
  egpExternalTypeOf,
  egpLayoutColumns,
  egpMappingOutcome,
  egpMappingProposals,
  egpMoneyOf,
  egpNameSimilarity,
  egpObligationClock,
  egpPortFor,
  egpPostingRuleCode,
  egpPostingRuleOf,
  externalCodeOf,
  isWorkingAssumptionLayout,
  moveObligation,
  normaliseTaxCode,
  openObligation,
  openReconciliationItems,
  pickReconciliationOwner,
  postingDeadline,
  prepareEgpPostingPacket,
  resolveEgpMapping,
  resolveReconciliationItem,
  suggestPackageMatches,
  validateEgpMapping,
} from '../src/egp.ts';
import type { EgpFreshnessParams, EgpIdMapping, EgpLayoutKind, EgpObligation, EgpPort, EgpResolvedRule } from '../src/egp.ts';
import { activationBlock } from '../src/connector.ts';
import { defaultGovernanceRule, validateRuleParams } from '../src/governance-rules.ts';
import type { WorkCalendarContent } from '../src/working-time.ts';
import { addWorkingTime } from '../src/working-time.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Refusal {
  code: string;
  status: number;
  detail?: string | undefined;
  extensions?: Record<string, unknown> | undefined;
}
function refusal(work: () => unknown): Refusal {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status, detail: error.detail, extensions: error.extensions };
    throw error;
  }
  throw new Error('expected a DomainError');
}
async function refusalOf(work: () => Promise<unknown>): Promise<Refusal> {
  try {
    await work();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status, detail: error.detail, extensions: error.extensions };
    throw error;
  }
  throw new Error('expected a DomainError');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Fixtures: one valid file for every layout (the working-assumption layouts of docs/egp-connector.md).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const HEADERS: Record<EgpLayoutKind, string> = {
  KHLCNT: 'plan_code,package_external_code,package_name,estimated_price,selection_method,approved_on,decision_no,project_code,package_code',
  TBMT: 'notice_code,notice_version,notice_kind,package_external_code,plan_code,published_at,bid_closing_at,bid_opening_at,estimated_price,bid_security_amount,project_code,package_code',
  RESULT: 'result_code,notice_code,package_external_code,result_kind,published_at,approved_on,contractor_tax_code,contractor_name,award_price,project_code,package_code',
  CONTRACTOR: 'contractor_tax_code,contractor_name,external_contractor_code,legal_status,registered_address,violation_count,as_of',
  RESTRICTION: 'restriction_code,contractor_tax_code,contractor_name,restriction_kind,scope,valid_from,valid_until,decision_no,decision_date,legal_basis',
};

const ROWS: Record<EgpLayoutKind, string[]> = {
  KHLCNT: [
    'PL-2026-001,PK-001,Gói thầu xây lắp số 1,1200000000,open bidding,05/01/2026,QĐ-12/2026,DA-001,GT-0001',
    'PL-2026-001,PK-002,"Gói thầu tư vấn, giám sát",350000000.50,,2026-01-05,,DA-001,',
  ],
  TBMT: [
    'IB2600000001,00,invitation,PK-001,PL-2026-001,2026-02-01T08:00:00+07:00,2026-02-20T09:00:00+07:00,2026-02-20T09:00:00+07:00,1200000000,24000000,DA-001,GT-0001',
    'IB2600000002,,,PK-002,,01/02/2026,,,,,,',
  ],
  RESULT: [
    'KQ-001,IB2600000001,PK-001,awarded,2026-03-10T10:00:00+07:00,10/03/2026,0101234567,Công ty TNHH A,1150000000,DA-001,GT-0001',
    'KQ-002,IB2600000002,PK-002,NO_QUALIFIED_BID,2026-03-12,,,,,,',
  ],
  CONTRACTOR: ['0101234567,Công ty TNHH A,NT-0101234567,active,"12 Phố X, Hà Nội",0,2026-10-31', '0305678901 001,Công ty CP B,,,,2,31/10/2026'],
  RESTRICTION: [
    'CM-001,0101234567,Công ty TNHH A,debarment,nationwide,2026-01-01,2029-01-01,QĐ-100/BTC,2025-12-20,Điều 133 NĐ 214/2025',
    'CM-002,0305678901-001,,reputation listed,,2026-02-01,2028-02-01,QĐ-7,,',
  ],
};

const fileOf = (kind: EgpLayoutKind, rows: readonly string[] = ROWS[kind], header: string = HEADERS[kind]): Uint8Array => bytes([header, ...rows].join('\n'));

/** The first row of a layout with the given columns replaced. */
function rowWith(kind: EgpLayoutKind, overrides: Record<string, string>): string {
  const names = HEADERS[kind].split(',');
  const cells = parseCsvLine(ROWS[kind][0] as string);
  return names.map((name, index) => (name in overrides ? (overrides[name] as string) : (cells[index] ?? ''))).join(',');
}
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else cell += character;
  }
  cells.push(cell);
  return cells;
}

const verdicts = (kind: EgpLayoutKind, rows: readonly string[]): Array<[number, string, string | undefined, string | undefined]> =>
  dryRunEgpFile(kind, fileOf(kind, rows)).rows.map((row) => [row.line, row.status, row.code, row.field]);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Names and the honest status of the connector.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('the connector egp.muasamcong', () => {
  it('is named for the registry, reads the layout version that says it is a working assumption, and has the adapter status PROPOSED', () => {
    expect(EGP_CONNECTOR_CODE).toBe('egp.muasamcong');
    expect(EGP_SOURCE_SYSTEM).toBe('MUASAMCONG');
    expect(EGP_LAYOUT_VERSION).toBe('WORKING-ASSUMPTION-2026.2');
    expect(isWorkingAssumptionLayout(EGP_LAYOUT_VERSION)).toBe(true);
    expect(EGP_ADAPTER_STATUS).toBe('PROPOSED');
    // PROPOSED never activates: the entry of the registry stays Draft until an adapter is VERIFIED.
    expect(activationBlock(EGP_ADAPTER_STATUS, 'production')).toBe('ADAPTER_NOT_VERIFIED');
  });

  it('is PENDING-EXTERNAL while the layout is a working assumption, and acceptable only for a layout that is not (R18)', () => {
    expect(egpAcceptance(EGP_LAYOUT_VERSION)).toBe('PENDING_EXTERNAL');
    expect(egpAcceptance('NATIONAL-2027.1')).toBe('ACCEPTABLE');
    expect(dryRunEgpFile('CONTRACTOR', fileOf('CONTRACTOR')).acceptance).toBe('PENDING_EXTERNAL');
  });

  it('lists what it waits for from outside, with who gives it and what switches when it arrives', () => {
    const codes = EGP_PENDING_EXTERNAL_ITEMS.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(['SAMPLE_KHLCNT', 'SAMPLE_TBMT', 'SAMPLE_RESULT', 'SAMPLE_CONTRACTOR', 'SAMPLE_RESTRICTION', 'API_SPECIFICATION', 'POSTING_RECEIPT_FORMAT', 'LEGAL_TEXT_DEADLINES']));
    for (const item of EGP_PENDING_EXTERNAL_ITEMS) {
      expect(item.owner).not.toBe('');
      expect(item.workingAssumption).not.toBe('');
      expect(item.switchesWhenItArrives).not.toBe('');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The layouts and the dry run.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('the layouts of WORKING-ASSUMPTION-2026.2 read a valid file into typed records', () => {
  it('KHLCNT: a package of a plan, its price as an exact decimal, the method as a word, the day as YYYY-MM-DD', () => {
    const run = dryRunEgpFile('KHLCNT', fileOf('KHLCNT'));
    expect(run.counts).toEqual({ total: 2, valid: 2, errors: 0, duplicates: 0, conflicts: 0 });
    expect(run.layoutVersion).toBe(EGP_LAYOUT_VERSION);
    expect(run.rows.map((row) => row.businessKey)).toEqual(['PL-2026-001|PK-001', 'PL-2026-001|PK-002']);
    expect(run.rows[0]?.record).toEqual({
      planCode: 'PL-2026-001',
      packageExternalCode: 'PK-001',
      packageName: 'Gói thầu xây lắp số 1',
      estimatedPrice: '1200000000',
      selectionMethod: 'OPEN_BIDDING',
      approvedOn: '2026-01-05',
      decisionNo: 'QĐ-12/2026',
      projectCode: 'DA-001',
      packageCode: 'GT-0001',
    });
    expect(run.rows[1]?.record).toMatchObject({ packageName: 'Gói thầu tư vấn, giám sát', estimatedPrice: '350000000.5', selectionMethod: null, decisionNo: null, packageCode: null });
  });

  it('TBMT: the version of the notice defaults to 0, the kind to INVITATION, moments are UTC and a bare day is its first instant in Vietnam', () => {
    const run = dryRunEgpFile('TBMT', fileOf('TBMT'));
    expect(run.counts.valid).toBe(2);
    expect(run.rows.map((row) => row.businessKey)).toEqual(['IB2600000001|0', 'IB2600000002|0']);
    expect(run.rows[0]?.record).toMatchObject({ noticeVersion: 0, noticeKind: 'INVITATION', publishedAt: '2026-02-01T01:00:00.000Z', bidClosingAt: '2026-02-20T02:00:00.000Z', bidOpeningAt: '2026-02-20T02:00:00.000Z', bidSecurityAmount: '24000000' });
    expect(run.rows[1]?.record).toMatchObject({ noticeVersion: 0, noticeKind: 'INVITATION', publishedAt: '2026-01-31T17:00:00.000Z', bidClosingAt: null });
  });

  it('RESULT: an awarded result carries the winner and the price, a result nobody won carries neither', () => {
    const run = dryRunEgpFile('RESULT', fileOf('RESULT'));
    expect(run.counts.valid).toBe(2);
    expect(run.rows.map((row) => row.businessKey)).toEqual(['KQ-001|0101234567', 'KQ-002|']);
    expect(run.rows[0]?.record).toMatchObject({ resultKind: 'AWARDED', contractorTaxCode: '0101234567', awardPrice: '1150000000', approvedOn: '2026-03-10' });
    expect(run.rows[1]?.record).toMatchObject({ resultKind: 'NO_QUALIFIED_BID', contractorTaxCode: null, awardPrice: null });
  });

  it('CONTRACTOR: keyed by tax code, a branch written as 13 digits or with a space is the same code with a dash', () => {
    const run = dryRunEgpFile('CONTRACTOR', fileOf('CONTRACTOR'));
    expect(run.counts.valid).toBe(2);
    expect(run.rows.map((row) => row.businessKey)).toEqual(['0101234567', '0305678901-001']);
    expect(run.rows[0]?.record).toMatchObject({ contractorName: 'Công ty TNHH A', externalContractorCode: 'NT-0101234567', legalStatus: 'ACTIVE', registeredAddress: '12 Phố X, Hà Nội', violationCount: 0, asOf: '2026-10-31' });
    expect(run.rows[1]?.record).toMatchObject({ contractorTaxCode: '0305678901-001', externalContractorCode: null, legalStatus: null, violationCount: 2, asOf: '2026-10-31' });
  });

  it('RESTRICTION: a debarment has a scope and an end, a reputation listing needs no scope, the key is the decision and the contractor', () => {
    const run = dryRunEgpFile('RESTRICTION', fileOf('RESTRICTION'));
    expect(run.counts.valid).toBe(2);
    expect(run.rows.map((row) => row.businessKey)).toEqual(['CM-001|0101234567', 'CM-002|0305678901-001']);
    expect(run.rows[0]?.record).toMatchObject({ restrictionKind: 'DEBARMENT', scope: 'NATIONWIDE', validFrom: '2026-01-01', validUntil: '2029-01-01', decisionNo: 'QĐ-100/BTC', decisionDate: '2025-12-20' });
    expect(run.rows[1]?.record).toMatchObject({ restrictionKind: 'REPUTATION_LISTED', scope: null, contractorName: null });
  });

  it('reads headers without regard to case, space and hyphens, any of comma, semicolon or tab, and ignores columns it does not know', () => {
    const file = bytes('Plan Code;Package-External-Code;Ghi chú\nPL-1;PK-1;bỏ qua');
    const run = dryRunEgpFile('KHLCNT', file);
    expect(run.rows[0]?.status).toBe('VALID');
    expect(run.rows[0]?.record).toMatchObject({ planCode: 'PL-1', packageExternalCode: 'PK-1', packageName: null });
    const tabs = dryRunEgpFile('CONTRACTOR', bytes('contractor_tax_code\tcontractor_name\tas_of\n0101234567\tA\t2026-10-31'));
    expect(tabs.rows[0]?.status).toBe('VALID');
  });

  it('exposes the same layouts as formats of the file import framework, with one connector code each and the layout version', () => {
    expect(EGP_LAYOUT_KINDS.map((kind) => EGP_FORMATS[kind].connectorCode)).toEqual(['EGP_KHLCNT_FILE', 'EGP_TBMT_FILE', 'EGP_RESULT_FILE', 'EGP_CONTRACTOR_FILE', 'EGP_RESTRICTION_FILE']);
    for (const kind of EGP_LAYOUT_KINDS) expect(EGP_FORMATS[kind].formatVersion).toBe(EGP_LAYOUT_VERSION);
    expect(EGP_LAYOUTS.RESULT.kind).toBe('RESULT');
    const columns = egpLayoutColumns('RESULT');
    expect(columns.find((column) => column.name === 'contractor_tax_code')).toMatchObject({ required: false, headerRequired: true });
    expect(columns.find((column) => column.name === 'result_kind')).toMatchObject({ required: true, values: ['AWARDED', 'NO_QUALIFIED_BID', 'CANCELLED'] });
  });
});

describe('a dry run says why a file or a row is refused', () => {
  it('refuses a file that lacks a required column as 422 IMPORT_SCHEMA_INVALID naming the columns, for every layout', () => {
    const required: Record<EgpLayoutKind, string[]> = {
      KHLCNT: ['plan_code', 'package_external_code'],
      TBMT: ['notice_code', 'package_external_code', 'published_at'],
      RESULT: ['result_code', 'notice_code', 'package_external_code', 'result_kind', 'published_at', 'contractor_tax_code', 'award_price'],
      CONTRACTOR: ['contractor_tax_code', 'contractor_name', 'as_of'],
      RESTRICTION: ['restriction_code', 'contractor_tax_code', 'restriction_kind', 'valid_from', 'valid_until', 'decision_no'],
    };
    for (const kind of EGP_LAYOUT_KINDS) {
      for (const column of required[kind]) {
        const names = HEADERS[kind].split(',');
        const keep = names.map((name, index) => ({ name, index })).filter((entry) => entry.name !== column);
        const cells = parseCsvLine(ROWS[kind][0] as string);
        const file = bytes(`${keep.map((entry) => entry.name).join(',')}\n${keep.map((entry) => cells[entry.index] ?? '').join(',')}`);
        expect(refusal(() => dryRunEgpFile(kind, file))).toMatchObject({ code: 'IMPORT_SCHEMA_INVALID', status: 422, detail: 'file', extensions: { missing_columns: [column] } });
      }
    }
  });

  it('accepts a file without the optional columns, and one whose header names a column twice is refused', () => {
    expect(dryRunEgpFile('KHLCNT', bytes('plan_code,package_external_code\nPL-1,PK-1')).counts.valid).toBe(1);
    expect(refusal(() => dryRunEgpFile('KHLCNT', bytes('plan_code,Plan Code,package_external_code\nPL-1,PL-1,PK-1')))).toMatchObject({ code: 'IMPORT_SCHEMA_INVALID', extensions: { duplicate_columns: true } });
  });

  it('refuses a file with no row (IMPORT_EMPTY), an empty file and bytes that are not a table (422)', () => {
    expect(refusal(() => dryRunEgpFile('KHLCNT', bytes(HEADERS.KHLCNT)))).toMatchObject({ code: 'IMPORT_EMPTY', status: 422 });
    expect(refusal(() => dryRunEgpFile('KHLCNT', new Uint8Array()))).toMatchObject({ status: 422 });
    expect(refusal(() => dryRunEgpFile('KHLCNT', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])))).toMatchObject({ status: 422 });
  });

  it('refuses a layout version it does not know before it opens the file', () => {
    expect(refusal(() => dryRunEgpFile('KHLCNT', fileOf('KHLCNT'), 'WORKING-ASSUMPTION-2026.1'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mapping_version', extensions: undefined });
    expect(refusal(() => dryRunEgpFile('KHLCNT', new Uint8Array(), 'NATIONAL-1'))).toMatchObject({ detail: 'mapping_version' });
  });

  it('gives each cell its own code and names the field: required, too long, control character, word, day, moment, amount, integer, tax code', () => {
    const cases: Array<[EgpLayoutKind, Record<string, string>, string, string]> = [
      ['KHLCNT', { plan_code: '' }, 'FIELD_REQUIRED', 'plan_code'],
      ['KHLCNT', { package_external_code: 'x'.repeat(101) }, 'FIELD_TOO_LONG', 'package_external_code'],
      ['KHLCNT', { package_code: 'x'.repeat(51) }, 'FIELD_TOO_LONG', 'package_code'],
      ['KHLCNT', { decision_no: 'x'.repeat(101) }, 'FIELD_TOO_LONG', 'decision_no'],
      ['KHLCNT', { plan_code: 'PL\u0001' }, 'CHARACTER_INVALID', 'plan_code'],
      ['KHLCNT', { selection_method: 'RAFFLE' }, 'ENUM_INVALID', 'selection_method'],
      ['KHLCNT', { approved_on: '2026-02-30' }, 'DAY_INVALID', 'approved_on'],
      ['KHLCNT', { approved_on: '2026-01-05T00:00:00Z' }, 'DAY_INVALID', 'approved_on'],
      ['KHLCNT', { approved_on: '1999-01-05' }, 'DAY_INVALID', 'approved_on'],
      ['KHLCNT', { estimated_price: '1.200.000.000' }, 'MONEY_INVALID', 'estimated_price'],
      ['KHLCNT', { estimated_price: '"12,5"' }, 'MONEY_INVALID', 'estimated_price'],
      ['KHLCNT', { estimated_price: '-1' }, 'MONEY_INVALID', 'estimated_price'],
      ['KHLCNT', { estimated_price: '1.234' }, 'MONEY_INVALID', 'estimated_price'],
      ['TBMT', { published_at: '2026-02-01T08:00:00' }, 'MOMENT_INVALID', 'published_at'],
      ['TBMT', { published_at: '' }, 'FIELD_REQUIRED', 'published_at'],
      ['TBMT', { notice_version: '100' }, 'INTEGER_INVALID', 'notice_version'],
      ['TBMT', { notice_version: 'a' }, 'INTEGER_INVALID', 'notice_version'],
      ['TBMT', { notice_kind: 'REPLACE' }, 'ENUM_INVALID', 'notice_kind'],
      ['RESULT', { result_kind: 'WON' }, 'ENUM_INVALID', 'result_kind'],
      ['RESULT', { contractor_tax_code: '12345' }, 'TAX_CODE_INVALID', 'contractor_tax_code'],
      ['CONTRACTOR', { contractor_tax_code: '01012345678' }, 'TAX_CODE_INVALID', 'contractor_tax_code'],
      ['CONTRACTOR', { contractor_name: '' }, 'FIELD_REQUIRED', 'contractor_name'],
      ['CONTRACTOR', { violation_count: '-1' }, 'INTEGER_INVALID', 'violation_count'],
      ['CONTRACTOR', { legal_status: 'GONE' }, 'ENUM_INVALID', 'legal_status'],
      ['RESTRICTION', { decision_no: '' }, 'FIELD_REQUIRED', 'decision_no'],
      ['RESTRICTION', { valid_until: '' }, 'FIELD_REQUIRED', 'valid_until'],
      ['RESTRICTION', { restriction_kind: 'BAN' }, 'ENUM_INVALID', 'restriction_kind'],
      ['RESTRICTION', { scope: 'WORLD' }, 'ENUM_INVALID', 'scope'],
    ];
    for (const [kind, overrides, code, field] of cases) {
      const [verdict] = verdicts(kind, [rowWith(kind, overrides)]);
      expect([kind, overrides, verdict]).toEqual([kind, overrides, [2, 'ERROR', code, field]]);
    }
  });

  it('judges the rules across cells: the order of the dates of a notice, the winner of a result, the range and the scope of a restriction, the date of approval', () => {
    const cases: Array<[EgpLayoutKind, Record<string, string>, string, string]> = [
      ['TBMT', { bid_closing_at: '2026-01-15T09:00:00+07:00' }, 'BID_DATES_ORDER_INVALID', 'bid_closing_at'],
      ['TBMT', { bid_opening_at: '2026-02-19T09:00:00+07:00' }, 'BID_DATES_ORDER_INVALID', 'bid_opening_at'],
      ['TBMT', { bid_closing_at: '', bid_opening_at: '2026-01-15T09:00:00+07:00' }, 'BID_DATES_ORDER_INVALID', 'bid_opening_at'],
      ['RESULT', { contractor_tax_code: '' }, 'AWARD_FIELDS_REQUIRED', 'contractor_tax_code'],
      ['RESULT', { award_price: '' }, 'AWARD_FIELDS_REQUIRED', 'award_price'],
      ['RESULT', { result_kind: 'CANCELLED' }, 'AWARD_FIELDS_NOT_ALLOWED', 'contractor_tax_code'],
      ['RESULT', { result_kind: 'NO_QUALIFIED_BID', contractor_tax_code: '', award_price: '1' }, 'AWARD_FIELDS_NOT_ALLOWED', 'award_price'],
      ['RESULT', { approved_on: '2026-03-11' }, 'RESULT_DATES_ORDER_INVALID', 'approved_on'],
      ['RESTRICTION', { valid_until: '2025-12-31' }, 'VALID_RANGE_INVALID', 'valid_until'],
      ['RESTRICTION', { scope: '' }, 'SCOPE_REQUIRED', 'scope'],
    ];
    for (const [kind, overrides, code, field] of cases) {
      const [verdict] = verdicts(kind, [rowWith(kind, overrides)]);
      expect([kind, overrides, verdict]).toEqual([kind, overrides, [2, 'ERROR', code, field]]);
    }
    // The same moment is allowed (the bid closes and opens at once, and the first fixture says so).
    expect(verdicts('TBMT', [ROWS.TBMT[0] as string])[0]?.[1]).toBe('VALID');
  });

  it('tells a row repeated with the same content (DUPLICATE, ignored) from one repeated with other content (CONFLICT, refused); the first row stands', () => {
    const first = ROWS.KHLCNT[0] as string;
    const same = first;
    // 2026-01-05 and 05/01/2026 are one day, and 1200000000.00 is the same amount: the same content written another way.
    const samePerhapsWrittenOtherwise = rowWith('KHLCNT', { approved_on: '2026-01-05', estimated_price: '1200000000.00' });
    const other = rowWith('KHLCNT', { estimated_price: '1300000000' });
    const run = dryRunEgpFile('KHLCNT', fileOf('KHLCNT', [first, same, samePerhapsWrittenOtherwise, other]));
    expect(run.rows.map((row) => [row.line, row.status, row.code])).toEqual([
      [2, 'VALID', undefined],
      [3, 'DUPLICATE', 'ROW_DUPLICATE'],
      [4, 'DUPLICATE', 'ROW_DUPLICATE'],
      [5, 'CONFLICT', 'ROW_CONFLICT'],
    ]);
    expect(run.counts).toEqual({ total: 4, valid: 1, errors: 0, duplicates: 2, conflicts: 1 });
  });

  it('keeps one row for each winner of a result, and one for each contractor of a decision (a joint venture), and counts a version of a notice apart', () => {
    const second = rowWith('RESULT', { contractor_tax_code: '0305678901', award_price: '500000000' });
    expect(dryRunEgpFile('RESULT', fileOf('RESULT', [ROWS.RESULT[0] as string, second])).counts).toMatchObject({ valid: 2, duplicates: 0, conflicts: 0 });
    const other = rowWith('RESTRICTION', { contractor_tax_code: '0305678901' });
    expect(dryRunEgpFile('RESTRICTION', fileOf('RESTRICTION', [ROWS.RESTRICTION[0] as string, other])).counts).toMatchObject({ valid: 2 });
    const v1 = rowWith('TBMT', { notice_version: '1', notice_kind: 'MODIFICATION' });
    expect(dryRunEgpFile('TBMT', fileOf('TBMT', [ROWS.TBMT[0] as string, v1])).rows.map((row) => row.businessKey)).toEqual(['IB2600000001|0', 'IB2600000001|1']);
  });

  it('reports a row error beside a row that is fine, with the line of the file, the same hash for the same row, and a hash of the file', () => {
    const bad = rowWith('CONTRACTOR', { contractor_tax_code: '12' });
    const run = dryRunEgpFile('CONTRACTOR', fileOf('CONTRACTOR', [ROWS.CONTRACTOR[0] as string, bad, ROWS.CONTRACTOR[1] as string]));
    expect(run.rows.map((row) => [row.line, row.status])).toEqual([
      [2, 'VALID'],
      [3, 'ERROR'],
      [4, 'VALID'],
    ]);
    expect(run.counts).toEqual({ total: 3, valid: 2, errors: 1, duplicates: 0, conflicts: 0 });
    expect(run.rows[1]?.record).toBeUndefined();
    expect(run.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dryRunEgpFile('CONTRACTOR', fileOf('CONTRACTOR', [ROWS.CONTRACTOR[0] as string, bad, ROWS.CONTRACTOR[1] as string])).fileSha256).toBe(run.fileSha256);
    expect(dryRunEgpFile('CONTRACTOR', fileOf('CONTRACTOR')).fileSha256).not.toBe(run.fileSha256);
  });

  it('does not show free text of a refused row (a sole trader address is personal): the mask keeps codes, dates, amounts and words only', () => {
    const format = EGP_FORMATS.CONTRACTOR;
    const [row] = format.parse(fileOf('CONTRACTOR'));
    const shown = format.mask?.(row?.values ?? {}) ?? {};
    expect(shown).toMatchObject({ contractor_tax_code: '0101234567', as_of: '2026-10-31' });
    expect(Object.keys(shown)).not.toContain('registered_address');
    expect(Object.keys(shown)).not.toContain('contractor_name');
  });
});

describe('the readers of a cell', () => {
  it('reads a day, a tax code and an amount as the register keeps them', () => {
    expect(egpDayOf('05/01/2026')).toBe('2026-01-05');
    expect(egpDayOf(' 2026-12-31 ')).toBe('2026-12-31');
    expect(egpDayOf('2026-13-01')).toBeUndefined();
    expect(egpDayOf('31/04/2026')).toBeUndefined();
    expect(egpDayOf('2101-01-01')).toBeUndefined();
    expect(normaliseTaxCode('0101234567')).toBe('0101234567');
    expect(normaliseTaxCode('0101234567-001')).toBe('0101234567-001');
    expect(normaliseTaxCode('0101234567001')).toBe('0101234567-001');
    expect(normaliseTaxCode(' 0101 234 567 ')).toBe('0101234567');
    expect(normaliseTaxCode('010123456')).toBeUndefined();
    expect(normaliseTaxCode('0101234567-01')).toBeUndefined();
    expect(normaliseTaxCode('01012345AB')).toBeUndefined();
    expect(egpMoneyOf('0012')).toBe('12');
    expect(egpMoneyOf('0')).toBe('0');
    expect(egpMoneyOf('12.50')).toBe('12.5');
    expect(egpMoneyOf('12.00')).toBe('12');
    expect(egpMoneyOf('1234567890123456789')).toBeUndefined();
    expect(egpMoneyOf('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The id mapping on top of master_crosswalk.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const mapping = (overrides: Partial<EgpIdMapping> = {}): EgpIdMapping => ({
  subjectType: 'PACKAGE',
  subjectId: 'GT-0001',
  sourceSystem: 'MUASAMCONG',
  externalType: 'EGP_PACKAGE',
  externalCode: 'PK-001',
  validFrom: '2026-01-01',
  validUntil: null,
  matchMethod: 'EXACT_CODE',
  confidence: null,
  status: 'ACTIVE',
  ...overrides,
});

describe('the id mapping on master_crosswalk (structure B, no new table)', () => {
  it('has the seven subjects of the plan, each with its own external type, and four match methods that map to the three the crosswalk holds today', () => {
    expect([...EGP_SUBJECT_TYPES]).toEqual(['PROJECT', 'PLAN', 'PACKAGE', 'NOTICE', 'RESULT', 'CONTRACT', 'CONTRACTOR']);
    expect(new Set(Object.values(EGP_EXTERNAL_TYPES)).size).toBe(7);
    expect(egpExternalTypeOf('CONTRACTOR')).toBe('EGP_CONTRACTOR');
    expect([...EGP_MATCH_METHODS]).toEqual(['EXACT_CODE', 'TAX_CODE', 'NAME_SUGGESTION', 'MANUAL']);
    expect(EGP_MATCH_METHODS.map(crosswalkMethodOf)).toEqual(['IMPORT', 'RULE', 'MANUAL', 'MANUAL']);
  });

  it('accepts a good mapping and names the fields of a bad one', () => {
    expect(validateEgpMapping(mapping())).toEqual([]);
    expect(validateEgpMapping(mapping({ validUntil: '2027-01-01' }))).toEqual([]);
    const fields = (overrides: Partial<EgpIdMapping>): string[] => validateEgpMapping(mapping(overrides)).map((finding) => `${finding.field}:${finding.code}`);
    expect(fields({ externalType: 'EGP_NOTICE' })).toEqual(['external_type:EXTERNAL_TYPE_MISMATCH']);
    expect(fields({ sourceSystem: 'TREASURY' })).toEqual(['source_system:SOURCE_SYSTEM_INVALID']);
    expect(fields({ subjectId: '' })).toEqual(['subject_id:SUBJECT_ID_INVALID']);
    expect(fields({ externalCode: ' PK-001' })).toEqual(['external_code:EXTERNAL_CODE_INVALID']);
    expect(fields({ externalCode: 'x'.repeat(101) })).toEqual(['external_code:EXTERNAL_CODE_INVALID']);
    expect(fields({ validFrom: '01/01/2026' })).toEqual(['valid_from:DAY_INVALID']);
    expect(fields({ validUntil: '2026-01-01' })).toEqual(['valid_until:VALID_RANGE_INVALID']);
    expect(fields({ validUntil: '2025-01-01' })).toEqual(['valid_until:VALID_RANGE_INVALID']);
    expect(fields({ confidence: 0.9 })).toEqual(['confidence:CONFIDENCE_NOT_ALLOWED']);
    expect(fields({ matchMethod: 'NAME_SUGGESTION' })).toEqual(['confidence:CONFIDENCE_INVALID']);
    expect(fields({ matchMethod: 'NAME_SUGGESTION', confidence: 0 })).toEqual(['confidence:CONFIDENCE_INVALID']);
    expect(fields({ matchMethod: 'NAME_SUGGESTION', confidence: 0.87 })).toEqual([]);
    expect(fields({ subjectType: 'CONTRACTOR', externalType: 'EGP_CONTRACTOR', matchMethod: 'NAME_SUGGESTION', confidence: 0.9 })).toEqual(['match_method:CONTRACTOR_BY_TAX_CODE_ONLY']);
    expect(fields({ subjectType: 'CONTRACTOR', externalType: 'EGP_CONTRACTOR', matchMethod: 'TAX_CODE', subjectId: '0101234567' })).toEqual([]);
  });

  it('says what writing a mapping would do: create, nothing (the same import again), refuse a code held by another subject, never relink a subject silently', () => {
    expect(egpMappingOutcome([], mapping())).toBe('CREATE');
    expect(egpMappingOutcome([mapping()], mapping())).toBe('UNCHANGED');
    expect(egpMappingOutcome([mapping({ subjectId: 'GT-0002' })], mapping())).toBe('EXTERNAL_CODE_TAKEN');
    expect(egpMappingOutcome([mapping({ externalCode: 'PK-009' })], mapping())).toBe('SUBJECT_HAS_OTHER_CODE');
    // A retired mapping and another source system are not in the way; a period that has ended does not overlap.
    expect(egpMappingOutcome([mapping({ status: 'RETIRED', subjectId: 'GT-0002' })], mapping())).toBe('CREATE');
    expect(egpMappingOutcome([mapping({ sourceSystem: 'OTHER', subjectId: 'GT-0002' })], mapping())).toBe('CREATE');
    expect(egpMappingOutcome([mapping({ externalCode: 'PK-009', validFrom: '2025-01-01', validUntil: '2026-01-01' })], mapping())).toBe('CREATE');
    expect(egpMappingOutcome([mapping({ externalCode: 'PK-009', validFrom: '2025-01-01', validUntil: '2026-01-02' })], mapping())).toBe('SUBJECT_HAS_OTHER_CODE');
    // The same code under another external type is another thing.
    expect(egpMappingOutcome([mapping({ subjectType: 'NOTICE', externalType: 'EGP_NOTICE' })], mapping())).toBe('CREATE');
  });

  it('resolves an external code and our code on a day inside the validity of an ACTIVE mapping only', () => {
    const list = [mapping({ validFrom: '2026-01-01', validUntil: '2026-06-01' }), mapping({ subjectId: 'GT-0002', externalCode: 'PK-002', status: 'RETIRED' })];
    expect(resolveEgpMapping(list, { subjectType: 'PACKAGE', externalCode: 'PK-001', onDay: '2026-03-01' })?.subjectId).toBe('GT-0001');
    expect(resolveEgpMapping(list, { subjectType: 'PACKAGE', externalCode: 'PK-001', onDay: '2026-06-01' })).toBeUndefined();
    expect(resolveEgpMapping(list, { subjectType: 'PACKAGE', externalCode: 'PK-001', onDay: '2025-12-31' })).toBeUndefined();
    expect(resolveEgpMapping(list, { subjectType: 'PACKAGE', externalCode: 'PK-002', onDay: '2026-03-01' })).toBeUndefined();
    expect(resolveEgpMapping(list, { subjectType: 'NOTICE', externalCode: 'PK-001', onDay: '2026-03-01' })).toBeUndefined();
    expect(externalCodeOf(list, { subjectType: 'PACKAGE', subjectId: 'GT-0001', onDay: '2026-03-01' })).toBe('PK-001');
    expect(externalCodeOf(list, { subjectType: 'PACKAGE', subjectId: 'GT-0001', onDay: '2026-07-01' })).toBeUndefined();
  });

  it('derives the mappings a valid row asks for: exact when the row names our code, open when it does not, a contractor by its tax code, a restriction none', () => {
    const plan = dryRunEgpFile('KHLCNT', fileOf('KHLCNT')).rows.map((row) => row.record);
    expect(egpMappingProposals('KHLCNT', plan[0] as NonNullable<(typeof plan)[0]>)).toEqual([
      { subjectType: 'PACKAGE', ourCode: 'GT-0001', ourProjectCode: 'DA-001', externalType: 'EGP_PACKAGE', externalCode: 'PK-001', method: 'EXACT_CODE' },
      { subjectType: 'PLAN', ourCode: 'DA-001', ourProjectCode: 'DA-001', externalType: 'EGP_PLAN', externalCode: 'PL-2026-001', method: 'EXACT_CODE' },
    ]);
    expect(egpMappingProposals('KHLCNT', plan[1] as NonNullable<(typeof plan)[1]>)[0]).toMatchObject({ subjectType: 'PACKAGE', ourCode: null, externalCode: 'PK-002' });
    const notices = dryRunEgpFile('TBMT', fileOf('TBMT')).rows.map((row) => row.record);
    expect(egpMappingProposals('TBMT', notices[0] as NonNullable<(typeof notices)[0]>).map((p) => [p.subjectType, p.externalCode])).toEqual([
      ['PACKAGE', 'PK-001'],
      ['NOTICE', 'IB2600000001'],
    ]);
    const results = dryRunEgpFile('RESULT', fileOf('RESULT')).rows.map((row) => row.record);
    expect(egpMappingProposals('RESULT', results[0] as NonNullable<(typeof results)[0]>).map((p) => p.subjectType)).toEqual(['PACKAGE', 'RESULT']);
    const contractors = dryRunEgpFile('CONTRACTOR', fileOf('CONTRACTOR')).rows.map((row) => row.record);
    expect(egpMappingProposals('CONTRACTOR', contractors[0] as NonNullable<(typeof contractors)[0]>)).toEqual([
      { subjectType: 'CONTRACTOR', ourCode: '0101234567', ourProjectCode: null, externalType: 'EGP_CONTRACTOR', externalCode: 'NT-0101234567', method: 'TAX_CODE' },
    ]);
    expect(egpMappingProposals('CONTRACTOR', contractors[1] as NonNullable<(typeof contractors)[1]>)[0]).toMatchObject({ ourCode: '0305678901-001', externalCode: '0305678901-001' });
    const restrictions = dryRunEgpFile('RESTRICTION', fileOf('RESTRICTION')).rows.map((row) => row.record);
    expect(egpMappingProposals('RESTRICTION', restrictions[0] as NonNullable<(typeof restrictions)[0]>)).toEqual([]);
  });

  it('suggests a package only when the price is the same and the names are alike, never by name alone, and a person confirms it', () => {
    expect(egpNameSimilarity('Gói thầu xây lắp số 1', 'GOI THAU XAY LAP SO 1')).toBe(1);
    expect(egpNameSimilarity('Gói thầu xây lắp số 1', 'Gói thầu tư vấn')).toBeLessThan(0.5);
    expect(egpNameSimilarity('', 'x')).toBe(0);
    const ours = [
      { id: 'a', code: 'GT-0001', name: 'Xây lắp đường số 1 (gói 1)', budget: '1200000000' },
      { id: 'b', code: 'GT-0002', name: 'Xây lắp đường số 1 (gói 1)', budget: '1300000000' },
      { id: 'c', code: 'GT-0003', name: 'Tư vấn giám sát', budget: '1200000000' },
      { id: 'd', code: 'GT-0004', name: 'Xây lắp đường số 1 gói 1', budget: null },
    ];
    const found = suggestPackageMatches({ name: 'Xây lắp đường số 1, gói 1', estimatedPrice: '1200000000' }, ours);
    expect(found.map((entry) => entry.code)).toEqual(['GT-0001']);
    expect(found[0]?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(suggestPackageMatches({ name: 'Xây lắp đường số 1, gói 1', estimatedPrice: null }, ours)).toEqual([]);
    expect(suggestPackageMatches({ name: null, estimatedPrice: '1200000000' }, ours)).toEqual([]);
    expect(suggestPackageMatches({ name: 'Xây lắp đường số 1, gói 1', estimatedPrice: '1200000000' }, ours, 1.01)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The difference between our record and the imported one, and who settles it.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('the difference between our record and the imported one', () => {
  it('compares only the fields of the subject, in order, and says nothing when the two agree (text without case, an amount exactly, a day in Vietnam)', () => {
    expect(EGP_COMPARE_FIELDS.PACKAGE.map((entry) => entry.field)).toEqual(['package_name', 'estimated_price', 'selection_method']);
    expect(
      diffEgpRecords(
        'PACKAGE',
        { package_name: 'Gói  thầu  Xây lắp', estimated_price: '1200000000', selection_method: 'open_bidding', ignored: 'a' },
        { package_name: 'gói thầu xây lắp', estimated_price: '1200000000.00', selection_method: 'OPEN_BIDDING', ignored: 'b' },
      ),
    ).toEqual([]);
    expect(diffEgpRecords('NOTICE', { published_at: '2026-02-01', bid_closing_at: '2026-02-20T09:00:00+07:00' }, { published_at: '2026-01-31T17:00:00.000Z', bid_closing_at: '2026-02-20T16:59:00.000Z' })).toEqual([]);
  });

  it('finds a value that differs with the signed amount, and a value that one side lacks', () => {
    expect(diffEgpRecords('PACKAGE', { package_name: 'A', estimated_price: '1200000000', selection_method: 'OPEN_BIDDING' }, { package_name: 'B', estimated_price: '1100000000.5', selection_method: null })).toEqual([
      { field: 'package_name', kind: 'VALUE_MISMATCH', ours: 'A', theirs: 'B', delta: null },
      { field: 'estimated_price', kind: 'VALUE_MISMATCH', ours: '1200000000', theirs: '1100000000.5', delta: '-99999999.5' },
      { field: 'selection_method', kind: 'MISSING_THEIRS', ours: 'OPEN_BIDDING', theirs: null, delta: null },
    ]);
    expect(diffEgpRecords('RESULT', { award_price: null }, { award_price: '5', contractor_tax_code: '0101234567' })).toEqual([
      { field: 'contractor_tax_code', kind: 'MISSING_OURS', ours: null, theirs: '0101234567', delta: null },
      { field: 'award_price', kind: 'MISSING_OURS', ours: null, theirs: '5', delta: null },
    ]);
    expect(diffEgpRecords('RESULT', { contractor_tax_code: '0101234567001' }, { contractor_tax_code: '0101234567-001' })).toEqual([]);
    expect(diffEgpRecords('CONTRACT', { signed_on: '2026-03-01' }, { signed_on: '2026-03-02' })).toMatchObject([{ field: 'signed_on', kind: 'VALUE_MISMATCH' }]);
  });
});

describe('reconciliation: every difference has an owner, and the maker never settles it', () => {
  const NOW = new Date('2026-11-08T03:00:00Z');
  const DUE = new Date('2026-11-18T03:00:00Z');
  const open = () =>
    openReconciliationItems({
      subjectType: 'PACKAGE',
      subjectKey: 'GT-0001',
      differences: diffEgpRecords('PACKAGE', { estimated_price: '1200000000' }, { estimated_price: '1100000000' }),
      ownerId: 'reviewer-1',
      makerIds: ['planner-1', 'loader-1'],
      openedAt: NOW,
      dueAt: DUE,
    })[0] as ReturnType<typeof openReconciliationItems>[number];

  it('has the four ways to settle one and says what each one makes the next step', () => {
    expect([...EGP_RESOLUTION_KINDS]).toEqual(['ACCEPT_EXTERNAL', 'CORRECT_OURS', 'DISPUTE', 'WAIVE']);
    expect(EGP_RESOLUTION_FOLLOW_UP).toEqual({ ACCEPT_EXTERNAL: 'CHANGE_OURS_BY_OWNER_COMMAND', CORRECT_OURS: 'CHECK_POSTING_CORRECTION_DUE', DISPUTE: 'ESCALATE_TO_OPERATOR', WAIVE: 'REVIEW_ON_DAY' });
  });

  it('opens one OPEN item for each difference with an owner and a due time', () => {
    const item = open();
    expect(item).toMatchObject({ subjectType: 'PACKAGE', subjectKey: 'GT-0001', field: 'estimated_price', delta: '-100000000', state: 'OPEN', ownerId: 'reviewer-1', dueAt: DUE.toISOString(), resolution: null });
    expect(
      openReconciliationItems({ subjectType: 'PACKAGE', subjectKey: 'GT-0001', differences: [], ownerId: 'reviewer-1', makerIds: [], openedAt: NOW, dueAt: DUE }),
    ).toEqual([]);
  });

  it('refuses an owner who is a maker, an empty owner and a due time that is not after the opening', () => {
    const base = { subjectType: 'PACKAGE' as const, subjectKey: 'GT-0001', differences: [], ownerId: 'reviewer-1', makerIds: ['planner-1'], openedAt: NOW, dueAt: DUE };
    expect(refusal(() => openReconciliationItems({ ...base, ownerId: 'planner-1' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owner_id' });
    expect(refusal(() => openReconciliationItems({ ...base, ownerId: ' ' }))).toMatchObject({ detail: 'owner_id' });
    expect(refusal(() => openReconciliationItems({ ...base, dueAt: NOW }))).toMatchObject({ detail: 'due_at' });
  });

  it('picks the first candidate who is not a maker, and none when every candidate is', () => {
    expect(pickReconciliationOwner(['planner-1', 'lead-1', 'lead-2'], ['planner-1'])).toBe('lead-1');
    expect(pickReconciliationOwner(['planner-1'], ['planner-1'])).toBeUndefined();
    expect(pickReconciliationOwner([], [])).toBeUndefined();
  });

  it('settles an item by each of the four kinds, keeping who, when and why', () => {
    const at = new Date('2026-11-09T02:00:00Z');
    const accepted = resolveReconciliationItem(open(), { kind: 'ACCEPT_EXTERNAL', resolvedById: 'reviewer-1', at, reason: 'The network is right: the price was revised.' });
    expect(accepted).toMatchObject({ state: 'RESOLVED', resolution: { kind: 'ACCEPT_EXTERNAL', resolvedById: 'reviewer-1', resolvedAt: at.toISOString(), reviewOn: null, evidenceRef: null } });
    expect(resolveReconciliationItem(open(), { kind: 'CORRECT_OURS', resolvedById: 'reviewer-1', at, reason: 'Our price is the approved one.' }).state).toBe('RESOLVED');
    const disputed = resolveReconciliationItem(open(), { kind: 'DISPUTE', resolvedById: 'reviewer-1', at, reason: 'The price on the network is wrong; we asked for a correction.', evidenceRef: 'CV-45/2026' });
    expect(disputed.resolution).toMatchObject({ kind: 'DISPUTE', evidenceRef: 'CV-45/2026' });
    const waived = resolveReconciliationItem(open(), { kind: 'WAIVE', resolvedById: 'reviewer-1', at, reason: 'Rounding of a few dong, not worth a correction.', reviewOn: '2027-05-08' });
    expect(waived.resolution).toMatchObject({ kind: 'WAIVE', reviewOn: '2027-05-08' });
  });

  it('refuses a maker (SELF_APPROVAL_DENIED), a second settlement, a short reason, a dispute without a reference and a waiver without a review day inside a year', () => {
    const at = new Date('2026-11-09T02:00:00Z');
    const ok = { kind: 'ACCEPT_EXTERNAL' as const, resolvedById: 'reviewer-1', at, reason: 'The network is right.' };
    expect(refusal(() => resolveReconciliationItem(open(), { ...ok, resolvedById: 'planner-1' }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(refusal(() => resolveReconciliationItem(open(), { ...ok, resolvedById: 'loader-1' }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    const done = resolveReconciliationItem(open(), ok);
    expect(refusal(() => resolveReconciliationItem(done, ok))).toMatchObject({ code: 'EGP_RECONCILIATION_STATE_INVALID', status: 409 });
    expect(refusal(() => resolveReconciliationItem(open(), { ...ok, reason: 'short' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
    expect(refusal(() => resolveReconciliationItem(open(), { ...ok, kind: 'WAIVE', reason: 'Nineteen chars here', reviewOn: '2027-05-08' }))).toMatchObject({ detail: 'reason' });
    expect(refusal(() => resolveReconciliationItem(open(), { ...ok, kind: 'DISPUTE', reason: 'The network is wrong, we wrote to them.' }))).toMatchObject({ detail: 'evidence_ref' });
    const waive = { ...ok, kind: 'WAIVE' as const, reason: 'Rounding of a few dong, not worth a correction.' };
    expect(refusal(() => resolveReconciliationItem(open(), waive))).toMatchObject({ detail: 'review_on' });
    expect(refusal(() => resolveReconciliationItem(open(), { ...waive, reviewOn: '2026-11-09' }))).toMatchObject({ detail: 'review_on' });
    expect(refusal(() => resolveReconciliationItem(open(), { ...waive, reviewOn: '2027-11-10' }))).toMatchObject({ detail: 'review_on' });
    expect(resolveReconciliationItem(open(), { ...waive, reviewOn: '2027-11-09' }).state).toBe('RESOLVED');
    expect(refusal(() => resolveReconciliationItem(open(), { ...ok, kind: 'SHRUG' as never }))).toMatchObject({ detail: 'kind' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The obligations to post.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const calendar = (year: number, holidays: string[] = []): WorkCalendarContent => ({ calendar_code: 'VN', year, working_days: [1, 2, 3, 4, 5], holidays: holidays.map((date) => ({ date, name: 'Holiday' })), legal_basis_ref: 'test' });
const calendars = { forYear: (year: number): WorkCalendarContent | undefined => (year === 2026 ? calendar(2026, ['2026-11-09']) : year === 2027 ? calendar(2027, ['2027-03-01']) : undefined) };
const vn = (iso: string): string => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().replace('Z', '+07:00');

describe('the deadline of a posting, counted on the working calendar', () => {
  it('counts working days after the trigger day, holidays and weekends never counted, to the end of the office day', () => {
    // Wednesday 4 November, 7 working days: 5, 6, [weekend, 9 holiday] 10, 11, 12, 13, 16.
    expect(vn(postingDeadline({ unit: 'WORKING_DAYS', amount: 7 }, new Date('2026-11-04T15:00:00+07:00'), calendars).toISOString())).toBe('2026-11-16T17:00:00.000+07:00');
    // A trigger on a day nobody works counts from the next day.
    expect(vn(postingDeadline({ unit: 'WORKING_DAYS', amount: 1 }, new Date('2026-11-07T10:00:00+07:00'), calendars).toISOString())).toBe('2026-11-10T17:00:00.000+07:00');
    // The time of the trigger does not matter, the Vietnam day does: 01:00 of the 4th is 18:00 UTC of the 3rd.
    expect(postingDeadline({ unit: 'WORKING_DAYS', amount: 1 }, new Date('2026-11-04T01:00:00+07:00'), calendars).toISOString()).toBe(postingDeadline({ unit: 'WORKING_DAYS', amount: 1 }, new Date('2026-11-04T23:59:00+07:00'), calendars).toISOString());
  });

  it('agrees with addWorkingTime of the working-time module: the end of the trigger day plus 8 hours for each working day', () => {
    for (const [from, days] of [['2026-11-04T17:00:00+07:00', 7], ['2026-11-12T17:00:00+07:00', 5], ['2026-11-13T17:00:00+07:00', 3]] as const) {
      const expected = addWorkingTime(calendars, new Date(from), { hours: 8 * days });
      expect(postingDeadline({ unit: 'WORKING_DAYS', amount: days }, new Date(from), calendars).toISOString()).toBe(expected.toISOString());
    }
  });

  it('counts calendar days and moves a last day that is not worked to the next working day (20 days of the response of a contractor)', () => {
    // 8 November plus 20 days is Saturday 28th: Monday 30th.
    expect(vn(postingDeadline({ unit: 'CALENDAR_DAYS', amount: 20 }, new Date('2026-11-08T10:00:00+07:00'), calendars).toISOString())).toBe('2026-11-30T17:00:00.000+07:00');
    // 4 November plus 20 days is Tuesday 24th, worked.
    expect(vn(postingDeadline({ unit: 'CALENDAR_DAYS', amount: 20 }, new Date('2026-11-04T01:00:00+07:00'), calendars).toISOString())).toBe('2026-11-24T17:00:00.000+07:00');
  });

  it('counts months to the same day of the month, to the last day of a month that is too short, and moves a last day that is not worked (6 months after completion)', () => {
    // 31 August plus 6 months is 28 February 2027 (a Sunday), 1 March is a holiday here: Tuesday 2 March.
    expect(vn(postingDeadline({ unit: 'MONTHS', amount: 6 }, new Date('2026-08-31T10:00:00+07:00'), calendars).toISOString())).toBe('2027-03-02T17:00:00.000+07:00');
    // 15 March plus 6 months is Wednesday 15 September (the calendar of 2026 has no other holiday).
    expect(vn(postingDeadline({ unit: 'MONTHS', amount: 6 }, new Date('2026-03-15T10:00:00+07:00'), calendars).toISOString())).toBe('2026-09-15T17:00:00.000+07:00');
  });

  it('is the moment of the trigger itself when the amount is zero, and never guesses a year that has no calendar', () => {
    const at = new Date('2026-11-04T08:30:00Z');
    expect(postingDeadline({ unit: 'WORKING_DAYS', amount: 0 }, at, calendars).toISOString()).toBe(at.toISOString());
    expect(refusal(() => postingDeadline({ unit: 'MONTHS', amount: 6 }, new Date('2027-08-31T10:00:00+07:00'), calendars))).toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE', status: 422 });
    expect(refusal(() => postingDeadline({ unit: 'WORKING_DAYS', amount: 5 }, new Date('2026-12-28T10:00:00+07:00'), { forYear: (year) => (year === 2026 ? calendar(2026) : undefined) }))).toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE' });
    expect(refusal(() => postingDeadline({ unit: 'WORKING_DAYS', amount: -1 }, at, calendars))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount' });
    expect(refusal(() => postingDeadline({ unit: 'WORKING_DAYS', amount: 1 }, new Date('x'), calendars))).toMatchObject({ detail: 'triggered_at' });
  });

  it('takes the calendar of one year as it is, and a working window of its own', () => {
    expect(postingDeadline({ unit: 'WORKING_DAYS', amount: 1 }, new Date('2026-03-02T10:00:00+07:00'), calendar(2026)).toISOString()).toBe('2026-03-03T10:00:00.000Z');
    expect(vn(postingDeadline({ unit: 'WORKING_DAYS', amount: 1 }, new Date('2026-03-02T10:00:00+07:00'), calendar(2026), [{ from: '07:30', to: '16:30' }]).toISOString())).toBe('2026-03-03T16:30:00.000+07:00');
  });
});

const ruleOf = (code: string): EgpResolvedRule => {
  const resolved = defaultGovernanceRule('EGP_POSTING_DEADLINES', code);
  if (resolved === undefined) throw new Error(`no default for ${code}`);
  return { code: resolved.code, version: resolved.version, params: resolved.params, unverified: resolved.unverified };
};

describe('the rule EGP_POSTING_DEADLINES as the governance registry holds it', () => {
  it('has a default for every kind, each flagged unverified, each valid under its own schema, with the numbers the plan names', () => {
    for (const kind of EGP_POSTING_KINDS) {
      const rule = ruleOf(egpPostingRuleCode(kind));
      expect(rule.unverified).toBe(true);
      expect(() => validateRuleParams('EGP_POSTING_DEADLINES', rule.params)).not.toThrow();
      expect(egpPostingRuleOf(rule.params).legal_basis).not.toBe('');
    }
    expect(egpPostingRuleOf(ruleOf('CONTRACTOR_PERFORMANCE').params)).toMatchObject({ due_in: 6, due_unit: 'MONTHS', starts_on: 'CONTRACT_COMPLETED' });
    expect(egpPostingRuleOf(ruleOf('VIOLATION').params)).toMatchObject({ due_in: 7, due_unit: 'WORKING_DAYS' });
    expect(egpPostingRuleOf(ruleOf('CONTRACTOR_RESPONSE').params)).toMatchObject({ due_in: 20, due_unit: 'CALENDAR_DAYS' });
    expect(egpPostingRuleOf(ruleOf('REPUTATION_EVENT').params)).toMatchObject({ due_in: 7, due_unit: 'WORKING_DAYS', starts_on: 'EVENT_OCCURRED' });
  });

  it('has the two alert types and the freshness rule of the connector, registered by the lane INT', () => {
    expect([...EGP_ALERT_CODES]).toEqual(['EGP_POSTING_DUE', 'EGP_POSTING_OVERDUE']);
    for (const code of EGP_ALERT_CODES) {
      const alert = defaultGovernanceRule('ALERT_TYPE', code);
      expect(alert?.params).toMatchObject({ source: 'EGP_POSTING' });
      expect(String(alert?.params['owner'])).not.toBe('');
      expect(String(alert?.params['expected_action'])).not.toBe('');
      expect(String(alert?.params['consequence'])).not.toBe('');
    }
    expect(defaultGovernanceRule('CONNECTOR_FRESHNESS', 'EGP_FILE')?.params).toMatchObject({ max_age_hours: 168, warn_after_hours: 120 });
  });

  it('refuses params that are not the rule: a missing field, a word that is not a unit, a number that is not whole', () => {
    const good = ruleOf('VIOLATION').params;
    expect(refusal(() => egpPostingRuleOf({ ...good, due_unit: 'FORTNIGHTS' }))).toMatchObject({ code: 'GOVERNANCE_RULE_PARAMS_INVALID', detail: 'due_unit' });
    expect(refusal(() => egpPostingRuleOf({ ...good, starts_on: 'TUESDAY' }))).toMatchObject({ detail: 'starts_on' });
    expect(refusal(() => egpPostingRuleOf({ ...good, due_in: 1.5 }))).toMatchObject({ detail: 'due_in' });
    expect(refusal(() => egpPostingRuleOf({ ...good, due_in: 0 }))).toMatchObject({ detail: 'due_in' });
    const without = { ...good } as Record<string, unknown>;
    delete without['legal_basis'];
    expect(refusal(() => egpPostingRuleOf(without))).toMatchObject({ detail: 'legal_basis' });
  });
});

describe('an obligation to post', () => {
  const at = (iso: string): Date => new Date(iso);
  const violation = (): EgpObligation =>
    openObligation({ kind: 'VIOLATION', subjectId: '0101234567', triggeredAt: at('2026-11-04T08:00:00+07:00'), ownerId: 'officer-1', rule: ruleOf('VIOLATION'), calendars });

  it('opens DUE with the deadline from its rule, the rule it came from and the legal status of the number', () => {
    const obligation = violation();
    expect(obligation).toMatchObject({
      kind: 'VIOLATION',
      subjectType: 'CONTRACTOR',
      subjectId: '0101234567',
      triggerEvent: 'EVENT_OCCURRED',
      dueAt: '2026-11-16T10:00:00.000Z',
      ruleCode: 'VIOLATION',
      ruleVersion: 0,
      remindBeforeDays: 2,
      legalStatus: 'UNVERIFIED',
      state: 'DUE',
      ownerId: 'officer-1',
      receiptRef: null,
    });
    const performance = openObligation({ kind: 'CONTRACTOR_PERFORMANCE', subjectId: 'C-07', triggeredAt: at('2026-08-31T10:00:00+07:00'), ownerId: 'officer-1', rule: ruleOf('CONTRACTOR_PERFORMANCE'), calendars });
    expect(performance).toMatchObject({ subjectType: 'CONTRACT', triggerEvent: 'CONTRACT_COMPLETED', dueAt: '2027-03-02T10:00:00.000Z', remindBeforeDays: 14 });
    const verified = openObligation({ kind: 'VIOLATION', subjectId: 'x', triggeredAt: at('2026-11-04T08:00:00+07:00'), ownerId: 'o', rule: { ...ruleOf('VIOLATION'), version: 3, unverified: false }, calendars });
    expect(verified).toMatchObject({ legalStatus: 'VERIFIED', ruleVersion: 3 });
  });

  it('has a subject type and a rule for each of the eight kinds', () => {
    expect(EGP_POSTING_KINDS).toHaveLength(8);
    expect(EGP_OBLIGATION_STATES).toEqual(['DUE', 'PREPARED', 'SUBMITTED', 'RECEIPTED', 'REJECTED', 'CANCELLED']);
    const starts: Record<string, string> = {};
    for (const kind of EGP_POSTING_KINDS) {
      const obligation = openObligation({ kind, subjectId: 's', triggeredAt: at('2026-11-04T08:00:00+07:00'), ownerId: 'o', rule: ruleOf(egpPostingRuleCode(kind)), calendars: { forYear: (y) => (y === 2026 ? calendar(2026) : calendar(2027)) } });
      expect(EGP_SUBJECT_TYPES).toContain(obligation.subjectType);
      starts[kind] = obligation.triggerEvent;
    }
    expect(starts).toMatchObject({ PLAN: 'DECISION_APPROVED', RESULT: 'RESULT_ISSUED', CONTRACT_INFO: 'CONTRACT_SIGNED', CONTRACTOR_PERFORMANCE: 'CONTRACT_COMPLETED', CONTRACTOR_RESPONSE: 'CONTRACTOR_NOTIFIED' });
  });

  it('refuses a rule of another kind, an empty subject or owner', () => {
    const base = { kind: 'VIOLATION' as const, subjectId: 's', triggeredAt: at('2026-11-04T08:00:00+07:00'), ownerId: 'o', rule: ruleOf('VIOLATION'), calendars };
    expect(refusal(() => openObligation({ ...base, rule: ruleOf('PLAN') }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'rule' });
    expect(refusal(() => openObligation({ ...base, subjectId: ' ' }))).toMatchObject({ detail: 'subject_id' });
    expect(refusal(() => openObligation({ ...base, ownerId: '' }))).toMatchObject({ detail: 'owner_id' });
  });

  it('goes DUE to PREPARED to SUBMITTED to RECEIPTED, each step keeping who and when, and a second person submits', () => {
    const prepared = moveObligation(violation(), { move: 'PREPARE', actorId: 'officer-1', at: at('2026-11-05T02:00:00Z') });
    expect(prepared).toMatchObject({ state: 'PREPARED', preparedById: 'officer-1', preparedAt: '2026-11-05T02:00:00.000Z' });
    expect(refusal(() => moveObligation(prepared, { move: 'SUBMIT', actorId: 'officer-1', at: at('2026-11-05T03:00:00Z') }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    const submitted = moveObligation(prepared, { move: 'SUBMIT', actorId: 'lead-1', at: at('2026-11-05T03:00:00Z') });
    expect(submitted).toMatchObject({ state: 'SUBMITTED', submittedById: 'lead-1', submittedAt: '2026-11-05T03:00:00.000Z' });
    const receipted = moveObligation(submitted, { move: 'RECEIPT', actorId: 'officer-1', at: at('2026-11-05T04:00:00Z'), receiptRef: '  BN-2026-001  ' });
    expect(receipted).toMatchObject({ state: 'RECEIPTED', receiptRef: 'BN-2026-001', receiptedAt: '2026-11-05T04:00:00.000Z' });
  });

  it('refuses a move from a state it does not start from (409 EGP_OBLIGATION_STATE_INVALID), including anything after a receipt or a cancellation', () => {
    const due = violation();
    const prepared = moveObligation(due, { move: 'PREPARE', actorId: 'a', at: at('2026-11-05T02:00:00Z') });
    const submitted = moveObligation(prepared, { move: 'SUBMIT', actorId: 'b', at: at('2026-11-05T03:00:00Z') });
    const receipted = moveObligation(submitted, { move: 'RECEIPT', actorId: 'a', at: at('2026-11-05T04:00:00Z'), receiptRef: 'BN-1' });
    const cancelled = moveObligation(due, { move: 'CANCEL', actorId: 'lead', at: at('2026-11-05T02:00:00Z'), reason: 'The package was cancelled, nothing to post.' });
    const step = (state: EgpObligation, move: 'PREPARE' | 'SUBMIT' | 'RECEIPT' | 'REJECT' | 'CANCEL'): Refusal =>
      refusal(() => moveObligation(state, { move, actorId: 'c', at: at('2026-11-06T02:00:00Z'), receiptRef: 'BN-2', reason: 'a reason that is long enough here' }));
    expect(step(due, 'SUBMIT')).toMatchObject({ code: 'EGP_OBLIGATION_STATE_INVALID', status: 409, extensions: { state: 'DUE', move: 'SUBMIT' } });
    expect(step(due, 'RECEIPT').code).toBe('EGP_OBLIGATION_STATE_INVALID');
    expect(step(due, 'REJECT').code).toBe('EGP_OBLIGATION_STATE_INVALID');
    expect(step(prepared, 'PREPARE').code).toBe('EGP_OBLIGATION_STATE_INVALID');
    expect(step(prepared, 'RECEIPT').code).toBe('EGP_OBLIGATION_STATE_INVALID');
    expect(step(submitted, 'CANCEL').code).toBe('EGP_OBLIGATION_STATE_INVALID');
    for (const move of ['PREPARE', 'SUBMIT', 'RECEIPT', 'REJECT', 'CANCEL'] as const) {
      expect(step(receipted, move).code).toBe('EGP_OBLIGATION_STATE_INVALID');
      expect(step(cancelled, move).code).toBe('EGP_OBLIGATION_STATE_INVALID');
    }
  });

  it('needs a receipt reference not after the submission, a reason for a rejection and a longer one for a cancellation; a rejected posting is prepared again', () => {
    const prepared = moveObligation(violation(), { move: 'PREPARE', actorId: 'a', at: at('2026-11-05T02:00:00Z') });
    const submitted = moveObligation(prepared, { move: 'SUBMIT', actorId: 'b', at: at('2026-11-05T03:00:00Z') });
    expect(refusal(() => moveObligation(submitted, { move: 'RECEIPT', actorId: 'a', at: at('2026-11-05T04:00:00Z'), receiptRef: ' ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'receipt_ref' });
    expect(refusal(() => moveObligation(submitted, { move: 'RECEIPT', actorId: 'a', at: at('2026-11-05T04:00:00Z'), receiptRef: 'x'.repeat(101) }))).toMatchObject({ detail: 'receipt_ref' });
    expect(refusal(() => moveObligation(submitted, { move: 'RECEIPT', actorId: 'a', at: at('2026-11-05T02:59:00Z'), receiptRef: 'BN-1' }))).toMatchObject({ detail: 'receipted_at' });
    expect(refusal(() => moveObligation(submitted, { move: 'REJECT', actorId: 'a', at: at('2026-11-05T04:00:00Z'), reason: 'no' }))).toMatchObject({ detail: 'reason' });
    const rejected = moveObligation(submitted, { move: 'REJECT', actorId: 'a', at: at('2026-11-05T04:00:00Z'), reason: 'The network refused: wrong tax code.' });
    expect(rejected).toMatchObject({ state: 'REJECTED', rejectionReason: 'The network refused: wrong tax code.' });
    const again = moveObligation(rejected, { move: 'PREPARE', actorId: 'a', at: at('2026-11-06T02:00:00Z') });
    expect(again).toMatchObject({ state: 'PREPARED', rejectionReason: null });
    expect(refusal(() => moveObligation(violation(), { move: 'CANCEL', actorId: 'a', at: at('2026-11-05T02:00:00Z'), reason: 'too short a reason' }))).toMatchObject({ detail: 'reason' });
  });
});

describe('the clock of an obligation and its alert', () => {
  const clockAt = (obligation: EgpObligation, iso: string) => egpObligationClock(obligation, new Date(iso));
  const violation = (): EgpObligation => openObligation({ kind: 'VIOLATION', subjectId: 'x', triggeredAt: new Date('2026-11-04T08:00:00+07:00'), ownerId: 'o', rule: ruleOf('VIOLATION'), calendars });
  // dueAt 2026-11-16T10:00Z, a reminder 2 days before.

  it('is ON_TIME, DUE_SOON within the reminder window, and OVERDUE past the deadline, never a millisecond early', () => {
    const due = violation();
    expect(clockAt(due, '2026-11-10T00:00:00Z')).toMatchObject({ status: 'ON_TIME', dueAt: '2026-11-16T10:00:00.000Z' });
    expect(clockAt(due, '2026-11-14T10:00:00Z').status).toBe('DUE_SOON');
    expect(clockAt(due, '2026-11-14T09:59:59Z').status).toBe('ON_TIME');
    expect(clockAt(due, '2026-11-16T10:00:00Z')).toMatchObject({ status: 'DUE_SOON', msToDue: 0 });
    expect(clockAt(due, '2026-11-16T10:00:01Z')).toMatchObject({ status: 'OVERDUE', msToDue: -1000 });
  });

  it('raises EGP_POSTING_DUE when due soon, EGP_POSTING_OVERDUE when overdue, and nothing otherwise', () => {
    const due = violation();
    expect(egpAlertFor(clockAt(due, '2026-11-10T00:00:00Z'))).toBeUndefined();
    expect(egpAlertFor(clockAt(due, '2026-11-15T00:00:00Z'))).toBe('EGP_POSTING_DUE');
    expect(egpAlertFor(clockAt(due, '2026-11-17T00:00:00Z'))).toBe('EGP_POSTING_OVERDUE');
    // A prepared posting still raises them: nothing has been posted.
    const prepared = moveObligation(due, { move: 'PREPARE', actorId: 'a', at: new Date('2026-11-05T02:00:00Z') });
    expect(egpAlertFor(clockAt(prepared, '2026-11-17T00:00:00Z'))).toBe('EGP_POSTING_OVERDUE');
  });

  it('is MET when submitted by the deadline, MET_LATE after it, and raises no alert once submitted; a rejection puts the clock back', () => {
    const prepared = moveObligation(violation(), { move: 'PREPARE', actorId: 'a', at: new Date('2026-11-05T02:00:00Z') });
    const inTime = moveObligation(prepared, { move: 'SUBMIT', actorId: 'b', at: new Date('2026-11-16T10:00:00Z') });
    const late = moveObligation(prepared, { move: 'SUBMIT', actorId: 'b', at: new Date('2026-11-16T10:00:01Z') });
    expect(clockAt(inTime, '2026-12-01T00:00:00Z')).toMatchObject({ status: 'MET', msToDue: null });
    expect(clockAt(late, '2026-12-01T00:00:00Z')).toMatchObject({ status: 'MET_LATE', msToDue: null });
    expect(egpAlertFor(clockAt(late, '2026-12-01T00:00:00Z'))).toBeUndefined();
    const receipted = moveObligation(inTime, { move: 'RECEIPT', actorId: 'a', at: new Date('2026-11-20T00:00:00Z'), receiptRef: 'BN-1' });
    expect(clockAt(receipted, '2026-12-01T00:00:00Z').status).toBe('MET');
    const rejected = moveObligation(inTime, { move: 'REJECT', actorId: 'a', at: new Date('2026-11-17T00:00:00Z'), reason: 'The network refused it.' });
    expect(clockAt(rejected, '2026-11-17T00:00:00Z').status).toBe('OVERDUE');
    expect(egpAlertFor(clockAt(rejected, '2026-11-17T00:00:00Z'))).toBe('EGP_POSTING_OVERDUE');
  });

  it('has no clock once cancelled', () => {
    const cancelled = moveObligation(violation(), { move: 'CANCEL', actorId: 'a', at: new Date('2026-11-05T02:00:00Z'), reason: 'The package was cancelled, nothing to post.' });
    expect(clockAt(cancelled, '2030-01-01T00:00:00Z')).toMatchObject({ status: 'CANCELLED', msToDue: null });
    expect(egpAlertFor(clockAt(cancelled, '2030-01-01T00:00:00Z'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The health of the connector.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('the health of the connector: the age of the last import against CONNECTOR_FRESHNESS', () => {
  const params: EgpFreshnessParams = { max_age_hours: 168, warn_after_hours: 120, stale_severity: 'WATCH', figures_blocked_when_stale: false };
  const now = new Date('2026-11-08T00:00:00Z');
  const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * 3_600_000);

  it('is FRESH up to the warning age, AGING up to the maximum, STALE beyond it, with the age in hours', () => {
    expect(egpConnectorHealth({ lastImportAt: hoursAgo(2), now, params })).toMatchObject({ status: 'FRESH', ageHours: 2, alert: null, figuresBlocked: false });
    expect(egpConnectorHealth({ lastImportAt: hoursAgo(120), now, params }).status).toBe('FRESH');
    expect(egpConnectorHealth({ lastImportAt: hoursAgo(120.1), now, params }).status).toBe('AGING');
    expect(egpConnectorHealth({ lastImportAt: hoursAgo(168), now, params }).status).toBe('AGING');
    expect(egpConnectorHealth({ lastImportAt: hoursAgo(168.1), now, params })).toMatchObject({ status: 'STALE', ageHours: 168.1, alert: { code: 'CONNECTOR_STALE', severity: 'WATCH' } });
  });

  it('blocks the figures that rest on it while stale only when the rule says so, and says it has never been used', () => {
    const strict = { ...params, stale_severity: 'ACTION' as const, figures_blocked_when_stale: true };
    expect(egpConnectorHealth({ lastImportAt: hoursAgo(200), now, params: strict })).toMatchObject({ status: 'STALE', figuresBlocked: true, alert: { severity: 'ACTION' } });
    expect(egpConnectorHealth({ lastImportAt: hoursAgo(100), now, params: strict }).figuresBlocked).toBe(false);
    expect(egpConnectorHealth({ lastImportAt: null, now, params: strict })).toMatchObject({ status: 'NEVER_IMPORTED', ageHours: null, alert: null, figuresBlocked: false });
    // A clock set back does not make a negative age.
    expect(egpConnectorHealth({ lastImportAt: new Date(now.getTime() + 3_600_000), now, params })).toMatchObject({ status: 'FRESH', ageHours: 0 });
  });

  it('always says what the adapter is and that what it reads is pending acceptance', () => {
    expect(egpConnectorHealth({ lastImportAt: hoursAgo(1), now, params })).toMatchObject({ adapterStatus: 'PROPOSED', layoutVersion: EGP_LAYOUT_VERSION, acceptance: 'PENDING_EXTERNAL' });
    expect(egpConnectorHealth({ lastImportAt: hoursAgo(1), now, params, adapterStatus: 'VERIFIED', layoutVersion: 'NATIONAL-2027.1' })).toMatchObject({ adapterStatus: 'VERIFIED', acceptance: 'ACCEPTABLE' });
    expect(defaultGovernanceRule('CONNECTOR_FRESHNESS', 'EGP_FILE')?.unverified).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The port and its two adapters.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('the file adapter and the refusing API adapter', () => {
  it('reads every kind of file through the port, and reports what it is', async () => {
    const port = new EgpFileAdapter();
    expect(port).toMatchObject({ code: 'egp.muasamcong', mode: 'FILE_IMPORT', adapterStatus: 'PROPOSED', opensNetwork: false });
    expect((await port.readPlans({ file: fileOf('KHLCNT') })).counts.valid).toBe(2);
    expect((await port.readNotices({ file: fileOf('TBMT') })).counts.valid).toBe(2);
    expect((await port.readResults({ file: fileOf('RESULT') })).counts.valid).toBe(2);
    expect((await port.readContractors({ file: fileOf('CONTRACTOR') })).counts.valid).toBe(2);
    expect((await port.readRestrictions({ file: fileOf('RESTRICTION') })).counts.valid).toBe(2);
  });

  it('refuses a read with no file, a layout it does not know and a file that is not the layout, as 422', async () => {
    const port = new EgpFileAdapter();
    expect(await refusalOf(() => port.readPlans({}))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'file' });
    expect(await refusalOf(() => port.readPlans({ file: fileOf('KHLCNT'), layoutVersion: 'OTHER' }))).toMatchObject({ detail: 'mapping_version' });
    expect(await refusalOf(() => port.readNotices({ file: fileOf('KHLCNT') }))).toMatchObject({ code: 'IMPORT_SCHEMA_INVALID' });
  });

  it('prepares the posting a person makes by hand: the fields in a fixed order and the hash of what is to be posted, never a call', async () => {
    const port = new EgpFileAdapter();
    const obligation = { kind: 'VIOLATION' as const, subjectType: 'CONTRACTOR' as const, subjectId: '0101234567', dueAt: '2026-11-16T10:00:00.000Z' };
    const fields = { evidence_ref: 'BB-12', occurred_on: '2026-11-03', behaviour_code: 'KHONG_KY_HOP_DONG', contractor_tax_code: '0101234567' };
    const outcome = await port.publish({ obligation, fields });
    expect(outcome.outcome).toBe('PREPARED');
    expect(outcome.packet).toMatchObject({ kind: 'VIOLATION', subjectId: '0101234567', dueAt: obligation.dueAt, layoutVersion: EGP_LAYOUT_VERSION, acceptance: 'PENDING_EXTERNAL' });
    expect(Object.keys(outcome.packet.fields)).toEqual(EGP_POSTING_FIELDS.VIOLATION);
    expect(outcome.packet.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    // The order the person typed the fields in does not change the hash; another value does.
    expect(prepareEgpPostingPacket({ obligation, fields: { contractor_tax_code: '0101234567', behaviour_code: 'KHONG_KY_HOP_DONG', occurred_on: '2026-11-03', evidence_ref: 'BB-12' } }).payloadSha256).toBe(outcome.packet.payloadSha256);
    expect(prepareEgpPostingPacket({ obligation, fields: { ...fields, evidence_ref: 'BB-13' } }).payloadSha256).not.toBe(outcome.packet.payloadSha256);
  });

  it('asks for every field of the kind, none other, and no control character', async () => {
    const port = new EgpFileAdapter();
    const obligation = { kind: 'CONTRACTOR_RESPONSE' as const, subjectType: 'CONTRACTOR' as const, subjectId: 'x', dueAt: '2026-11-16T10:00:00.000Z' };
    const fields = { contractor_tax_code: '0101234567', response_received_on: '2026-11-01', outcome: 'UPDATED' };
    expect((await port.publish({ obligation, fields })).packet.fields).toEqual(fields);
    expect(await refusalOf(() => port.publish({ obligation, fields: { ...fields, outcome: ' ' } }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'fields.outcome' });
    expect(await refusalOf(() => port.publish({ obligation, fields: { contractor_tax_code: '0101234567', response_received_on: '2026-11-01' } }))).toMatchObject({ detail: 'fields.outcome' });
    expect(await refusalOf(() => port.publish({ obligation, fields: { ...fields, note: 'x' } }))).toMatchObject({ detail: 'fields.note' });
    expect(await refusalOf(() => port.publish({ obligation, fields: { ...fields, outcome: 'a\u0000b' } }))).toMatchObject({ detail: 'fields.outcome' });
    for (const kind of EGP_POSTING_KINDS) expect(EGP_POSTING_FIELDS[kind].length).toBeGreaterThan(0);
  });

  it('refuses every call of the API adapter with 503 EGP_API_UNAVAILABLE, and says its status is MISSING', async () => {
    const api: EgpPort = new EgpApiAdapter();
    expect(api).toMatchObject({ code: 'egp.muasamcong', mode: 'API', adapterStatus: 'MISSING', opensNetwork: false });
    const expected = { code: 'EGP_API_UNAVAILABLE', status: 503, detail: 'adapter', extensions: { adapter_status: 'MISSING', reason: 'OPERATOR_SPECIFICATION_PENDING' } };
    const file = fileOf('KHLCNT');
    expect(await refusalOf(() => api.readPlans({ file }))).toEqual(expected);
    expect(await refusalOf(() => api.readNotices({ since: '2026-01-01' }))).toEqual(expected);
    expect(await refusalOf(() => api.readResults({}))).toEqual(expected);
    expect(await refusalOf(() => api.readContractors({}))).toEqual(expected);
    expect(await refusalOf(() => api.readRestrictions({}))).toEqual(expected);
    const publish = { obligation: { kind: 'PLAN' as const, subjectType: 'PLAN' as const, subjectId: 'x', dueAt: '2026-11-16T10:00:00.000Z' }, fields: { plan_name: 'a', decision_no: 'b', approved_on: '2026-01-01' } };
    expect(await refusalOf(() => api.publish(publish))).toEqual(expected);
  });

  it('chooses the adapter by the mode of the connector', () => {
    expect(egpPortFor('FILE_IMPORT')).toBeInstanceOf(EgpFileAdapter);
    expect(egpPortFor('FILE_EXPORT')).toBeInstanceOf(EgpFileAdapter);
    expect(egpPortFor('API')).toBeInstanceOf(EgpApiAdapter);
    expect(egpPortFor('LGSP')).toBeInstanceOf(EgpApiAdapter);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// No connection leaves the machine (the test of the plan: "test chứng minh không có kết nối nào ra muasamcong").
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('no connection is opened to the national network', () => {
  const attempts: string[] = [];
  const fail =
    (name: string) =>
    (): never => {
      attempts.push(name);
      throw new Error(`network call attempted: ${name}`);
    };
  const spies: jest.SpyInstance[] = [];
  const watch = (target: object, property: string, name: string): void => {
    spies.push(jest.spyOn(target as Record<string, (...args: unknown[]) => unknown>, property).mockImplementation(fail(name)));
  };

  beforeEach(() => {
    attempts.length = 0;
    watch(globalThis, 'fetch', 'fetch');
    watch(net, 'connect', 'net.connect');
    watch(net, 'createConnection', 'net.createConnection');
    watch(net.Socket.prototype, 'connect', 'net.Socket#connect');
    watch(tls, 'connect', 'tls.connect');
    watch(http, 'request', 'http.request');
    watch(http, 'get', 'http.get');
    watch(https, 'request', 'https.request');
    watch(https, 'get', 'https.get');
    watch(dns, 'lookup', 'dns.lookup');
    watch(dns, 'resolve', 'dns.resolve');
    watch(dgram, 'createSocket', 'dgram.createSocket');
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('proves the watch works: every way out of the machine that it covers fails and is counted', () => {
    expect(() => fetch('https://muasamcong.mof.gov.vn/')).toThrow('network call attempted: fetch');
    expect(() => net.connect(443, 'muasamcong.mof.gov.vn')).toThrow('network call attempted');
    expect(() => tls.connect(443, 'muasamcong.mof.gov.vn')).toThrow('network call attempted');
    expect(() => https.request('https://muasamcong.mof.gov.vn/')).toThrow('network call attempted');
    expect(() => dns.lookup('muasamcong.mof.gov.vn', () => undefined)).toThrow('network call attempted');
    expect(attempts).toEqual(['fetch', 'net.connect', 'tls.connect', 'https.request', 'dns.lookup']);
  });

  it('reads all five kinds of file, the dry runs, the mapping, the difference, the obligations, the clock and the health, and opens none', async () => {
    const file = new EgpFileAdapter();
    const api: EgpPort = new EgpApiAdapter();
    for (const adapter of [file, egpPortFor('FILE_IMPORT'), egpPortFor('FILE_EXPORT')]) {
      await adapter.readPlans({ file: fileOf('KHLCNT') });
      await adapter.readNotices({ file: fileOf('TBMT') });
      await adapter.readResults({ file: fileOf('RESULT') });
      await adapter.readContractors({ file: fileOf('CONTRACTOR') });
      await adapter.readRestrictions({ file: fileOf('RESTRICTION') });
      await adapter.publish({ obligation: { kind: 'PLAN', subjectType: 'PLAN', subjectId: 'p', dueAt: '2026-11-16T10:00:00.000Z' }, fields: { plan_name: 'a', decision_no: 'b', approved_on: '2026-01-01' } });
    }
    // A refused call is still no call.
    for (const read of [() => api.readPlans({}), () => api.readNotices({}), () => api.readContractors({})]) await expect(read()).rejects.toMatchObject({ code: 'EGP_API_UNAVAILABLE' });
    for (const kind of EGP_LAYOUT_KINDS) dryRunEgpFile(kind, fileOf(kind));
    const rule = ruleOf('VIOLATION');
    const obligation = openObligation({ kind: 'VIOLATION', subjectId: 'x', triggeredAt: new Date('2026-11-04T08:00:00+07:00'), ownerId: 'o', rule, calendars });
    egpAlertFor(egpObligationClock(obligation, new Date('2026-11-17T00:00:00Z')));
    egpConnectorHealth({ lastImportAt: null, now: new Date(), params: { max_age_hours: 168, warn_after_hours: 120, stale_severity: 'WATCH', figures_blocked_when_stale: false } });
    egpMappingOutcome([], mapping());
    diffEgpRecords('PACKAGE', { package_name: 'a' }, { package_name: 'b' });
    expect(attempts).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('does not import a module that can open a connection and calls no fetch: the source of the module says so', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'egp.ts'), 'utf8');
    // Comments explain the rule and may name what is forbidden; the code may not use it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/from\s+'node:(net|tls|http|https|http2|dns|dgram|child_process|cluster|worker_threads)'/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|require\s*\(|import\s*\(/);
    // The only imports are the pure modules of the kernel and the standard library of the data it reads.
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] as string);
    expect(imports.filter((specifier) => !specifier.startsWith('./'))).toEqual([]);
  });
});
