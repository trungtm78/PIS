import { inflateRawSync } from 'node:zlib';
import { EXPORT_COLUMNS, EXPORT_ROW_CAP, PDF_ROW_CAP, buildExportDocument, csvOf, scaledMoney, selectColumns, signOffNotice, xlsxOf } from '../src/dis-export.ts';
import type { ExportDocument, ExportInput, ExportLine } from '../src/dis-export.ts';

const LINE: ExportLine = {
  projectCode: 'P-A-001',
  projectName: 'Cầu qua sông',
  unitCode: 'U-BQL1',
  unitName: 'Ban quản lý 1',
  bucket: 'CURRENT_YEAR',
  budgetLevel: 'CENTRAL',
  planPmVnd: '1000000000',
  planLocalVnd: '250000000',
  planTotalVnd: '1250000000',
  disbursedTreasuryVnd: '600000000',
  disbursedReportedVnd: '420000000',
  ctmtqgVnd: '40000000',
  ratePmPct: '60.0000',
  rateTotalPct: '48.0000',
  rateNullReason: null,
  coverage: 'COMPLETE',
};

const input = (over: Partial<ExportInput> = {}): ExportInput => ({
  snapshotId: '00000000-0000-4000-8000-0000000000a1',
  periodCode: 'W2027-40',
  snapshotKind: 'PERIOD_CLOSE',
  asOfDate: '2027-10-10',
  treasuryCutoffDate: '2027-10-10',
  definitionStatus: 'PROPOSED_PENDING_SIGNOFF',
  createdAt: new Date('2027-10-15T03:00:00Z'),
  unitCodes: ['U-BQL1'],
  lines: [LINE],
  ...over,
});

const headerOf = (document: ExportDocument): Record<string, string> => Object.fromEntries(document.header.map((entry) => [entry.key, entry.value]));

describe('the export of a frozen snapshot (ST-DIS-016, DIS 3 F9)', () => {
  it('AC-ST-DIS-016-1 / UAT-AC261: carries in its header the scope, the period, the snapshot id, the unit VND, the creation time and the definition status', () => {
    const document = buildExportDocument(input());
    expect(headerOf(document)).toMatchObject({
      scope: 'U-BQL1',
      period: 'W2027-40',
      snapshot_id: '00000000-0000-4000-8000-0000000000a1',
      currency_unit: 'VND',
      created_at: '2027-10-15T03:00:00.000Z',
      definition_status: 'PROPOSED_PENDING_SIGNOFF',
      snapshot_kind: 'PERIOD_CLOSE',
      as_of_date: '2027-10-10',
      treasury_cutoff_date: '2027-10-10',
    });
    expect(document.columns.map((column) => column.key)).toEqual(EXPORT_COLUMNS.map((column) => column.key));
    expect(document.rows).toHaveLength(1);
    expect(document.rows[0]).toEqual(['P-A-001', 'Cầu qua sông', 'U-BQL1', 'Ban quản lý 1', 'CURRENT_YEAR', 'CENTRAL', '1000000000', '250000000', '1250000000', '600000000', '420000000', '40000000', '60.0000', '48.0000', '', 'COMPLETE']);
  });

  it('AC-ST-DIS-016-3 / UAT-AC257: says the definitions await the D03 sign-off while they are not signed, and says nothing of it once they are', () => {
    expect(signOffNotice('PROPOSED_PENDING_SIGNOFF')).toMatch(/D03/);
    expect(buildExportDocument(input()).notice).toBe(signOffNotice('PROPOSED_PENDING_SIGNOFF'));
    expect(signOffNotice('SIGNED')).toBeNull();
    expect(buildExportDocument(input({ definitionStatus: 'SIGNED' })).notice).toBeNull();
  });

  it('writes a figure that is missing as empty, never as 0, and a rate that cannot be given with its reason', () => {
    const document = buildExportDocument(input({ lines: [{ ...LINE, disbursedTreasuryVnd: null, ratePmPct: null, rateTotalPct: null, rateNullReason: 'TREASURY_COVERAGE_NONE', coverage: 'NONE' }] }));
    const row = document.rows[0] as string[];
    const at = (key: string): string => row[EXPORT_COLUMNS.findIndex((column) => column.key === key)] as string;
    expect([at('disbursed_treasury_vnd'), at('rate_pm_pct'), at('rate_total_pct'), at('rate_null_reason')]).toEqual(['', '', '', 'TREASURY_COVERAGE_NONE']);
  });

  it('writes CSV with a byte-order mark, the header block, a blank line, the table and the notice, quoting what needs it', () => {
    const csv = csvOf(buildExportDocument(input({ lines: [{ ...LINE, projectName: 'Cầu, "qua" sông' }] })));
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('key,label,value');
    expect(lines.some((line) => line.startsWith('definition_status,') && line.endsWith(',PROPOSED_PENDING_SIGNOFF'))).toBe(true);
    const blank = lines.indexOf('');
    expect(lines[blank + 1]?.startsWith('project_code,project_name,unit_code')).toBe(true);
    expect(lines[blank + 2]).toContain('"Cầu, ""qua"" sông"');
    expect(lines[lines.length - 2]).toMatch(/^notice,/);
  });

  it('does not let a cell be read as a formula: text that begins with = + - @ is written with a quote in front, money keeps its sign', () => {
    const csv = csvOf(buildExportDocument(input({ lines: [{ ...LINE, projectName: '=HYPERLINK("x")', unitName: '+cmd', disbursedTreasuryVnd: '-5000' }] })));
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain(',-5000,');
  });

  it('writes an XLSX that is a zip of the parts of a workbook, whose sheet holds the header, the table and the notice with money kept as text', () => {
    const bytes = xlsxOf(buildExportDocument(input()));
    expect(Buffer.from(bytes.subarray(0, 4)).toString('latin1')).toBe('PK\u0003\u0004');
    const parts = unzip(bytes);
    expect(Object.keys(parts).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = parts['xl/worksheets/sheet1.xml'] as string;
    expect(sheet).toContain('PROPOSED_PENDING_SIGNOFF');
    expect(sheet).toContain('P-A-001');
    expect(sheet).toContain('<c r="G');
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('1250000000');
    expect(sheet).toContain('D03');
    expect(parts['xl/workbook.xml']).toContain('<sheet name="');
  });

  it('escapes what XML does not allow in a cell and leaves out characters it cannot hold', () => {
    const sheet = unzip(xlsxOf(buildExportDocument(input({ lines: [{ ...LINE, projectName: 'A & <B> \u0001 "c"' }] }))))['xl/worksheets/sheet1.xml'] as string;
    expect(sheet).toContain('A &amp; &lt;B&gt;  &quot;c&quot;');
    expect(sheet).not.toContain('\u0001');
  });

  it('writes the columns that were asked for, in the order of the table, and refuses an unknown column, a column named twice and an empty list naming the place', () => {
    const document = buildExportDocument(input({ columns: ['plan_total_vnd', 'project_code'] }));
    expect(document.columns.map((column) => column.key)).toEqual(['project_code', 'plan_total_vnd']);
    expect(document.rows[0]).toEqual(['P-A-001', '1250000000']);
    const refused = (keys: string[]): unknown => {
      try {
        selectColumns(keys);
      } catch (error) {
        const { code, status, detail } = error as { code: string; status: number; detail: string };
        return { code, status, detail };
      }
      return undefined;
    };
    expect(refused(['project_code', 'nope'])).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'columns[1]' });
    expect(refused(['project_code', 'project_code'])).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'columns[1]' });
    expect(refused([])).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'columns' });
    expect(selectColumns(undefined)).toBe(EXPORT_COLUMNS);
  });

  it('writes million dong exactly, without a float, says so in the header and the labels, and leaves a missing figure empty and the rates alone', () => {
    expect(scaledMoney('1250000000', 'MILLION_VND')).toBe('1250.000000');
    expect(scaledMoney('-5000', 'MILLION_VND')).toBe('-0.005000');
    expect(scaledMoney('0', 'MILLION_VND')).toBe('0.000000');
    expect(scaledMoney('123456789012345678901234', 'MILLION_VND')).toBe('123456789012345678.901234');
    expect(scaledMoney('42', 'VND')).toBe('42');
    const document = buildExportDocument(input({ unitScale: 'MILLION_VND', lines: [{ ...LINE, disbursedTreasuryVnd: null }] }));
    expect(headerOf(document).currency_unit).toBe('MILLION_VND');
    const row = document.rows[0] as string[];
    const at = (key: string): string => row[EXPORT_COLUMNS.findIndex((column) => column.key === key)] as string;
    expect([at('plan_total_vnd'), at('disbursed_treasury_vnd'), at('rate_pm_pct')]).toEqual(['1250.000000', '', '60.0000']);
    expect(document.columns.find((column) => column.key === 'plan_total_vnd')?.label).toContain('triệu VND');
  });

  it('has the caps the first release states: 200 thousand rows for a file, fewer for a PDF', () => {
    expect(EXPORT_ROW_CAP).toBe(200_000);
    expect(PDF_ROW_CAP).toBeLessThan(EXPORT_ROW_CAP);
  });
});

/** Reads a zip written with entries that are deflated (what the writer produces): name to text. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const buffer = Buffer.from(bytes);
  const files: Record<string, string> = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const data = buffer.subarray(offset + 30 + nameLength + extraLength, offset + 30 + nameLength + extraLength + compressed);
    files[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    offset += 30 + nameLength + extraLength + compressed;
  }
  return files;
}
