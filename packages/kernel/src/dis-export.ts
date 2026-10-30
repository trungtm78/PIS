import { crc32, deflateRawSync } from 'node:zlib';
import { DomainError } from './errors.ts';

/**
 * The export of a frozen snapshot (ST-DIS-016, DIS 3 F9, DIS-17): the lines of the snapshot that the caller may see, in a neutral layout (the official layout through DOC is a later story), under a header
 * that says what the numbers are: scope, period, snapshot, unit of account, time of the file and the status of the definitions. While the business owner has not signed the definitions (D03, CXN-03),
 * the file says so in a notice, so that a number taken out of the system is not taken for an executive figure.
 */
export const EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** An assumption of the first release: a file holds at most this many lines (a longer snapshot is asked for by unit), and a PDF, which is read by a person, far fewer. */
export const EXPORT_ROW_CAP = 200_000;
export const PDF_ROW_CAP = 5_000;
/** An assumption of the first release: the files of one export name at most this many projects, which is what the download checks the scope against. */
export const EXPORT_PROJECT_CAP = 20_000;

export type DefinitionStatus = 'PROPOSED_PENDING_SIGNOFF' | 'SIGNED';

/** The unit the money is written in: whole dong, or million dong (exact: a dong has no fraction, so a million has six decimals at most). */
export const UNIT_SCALES = ['VND', 'MILLION_VND'] as const;
export type UnitScale = (typeof UNIT_SCALES)[number];

export interface ExportLine {
  projectCode: string;
  projectName: string;
  unitCode: string;
  unitName: string;
  bucket: string;
  budgetLevel: string;
  planPmVnd: string;
  planLocalVnd: string;
  planTotalVnd: string;
  /** What the Treasury paid, or null when it booked nothing: empty in the file, never 0 (BR-DIS-08). */
  disbursedTreasuryVnd: string | null;
  disbursedReportedVnd: string | null;
  ctmtqgVnd: string | null;
  ratePmPct: string | null;
  rateTotalPct: string | null;
  rateNullReason: string | null;
  coverage: string;
}

export interface ExportInput {
  snapshotId: string;
  periodCode: string;
  snapshotKind: string;
  asOfDate: string;
  treasuryCutoffDate: string;
  definitionStatus: DefinitionStatus;
  createdAt: Date;
  /** The units of the lines that are in the file: the scope as the file states it. */
  unitCodes: readonly string[];
  lines: readonly ExportLine[];
  /** The columns the person asked for (keys of `EXPORT_COLUMNS`, already judged by `selectColumns`); all of them when none. */
  columns?: readonly string[] | undefined;
  unitScale?: UnitScale | undefined;
}

export interface ExportColumn {
  key: string;
  label: string;
  /** Money and rates: written as they are, never as a formula. */
  numeric: boolean;
}

export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { key: 'project_code', label: 'Mã dự án', numeric: false },
  { key: 'project_name', label: 'Tên dự án', numeric: false },
  { key: 'unit_code', label: 'Mã đơn vị', numeric: false },
  { key: 'unit_name', label: 'Đơn vị', numeric: false },
  { key: 'bucket', label: 'Nguồn vốn', numeric: false },
  { key: 'budget_level', label: 'Cấp ngân sách', numeric: false },
  { key: 'plan_pm_assigned_vnd', label: 'Kế hoạch TTg giao (VND)', numeric: true },
  { key: 'plan_local_added_vnd', label: 'Kế hoạch địa phương bổ sung (VND)', numeric: true },
  { key: 'plan_total_vnd', label: 'Tổng kế hoạch (VND)', numeric: true },
  { key: 'disbursed_treasury_vnd', label: 'Kho bạc đã chi (VND)', numeric: true },
  { key: 'disbursed_reported_vnd', label: 'Chủ đầu tư báo cáo (VND)', numeric: true },
  { key: 'ctmtqg_subset_vnd', label: 'Trong đó CTMTQG (VND)', numeric: true },
  { key: 'rate_pm_pct', label: 'Tỷ lệ theo kế hoạch TTg giao (%)', numeric: true },
  { key: 'rate_total_pct', label: 'Tỷ lệ theo tổng kế hoạch (%)', numeric: true },
  { key: 'rate_null_reason', label: 'Lý do không tính được tỷ lệ', numeric: false },
  { key: 'treasury_coverage', label: 'Độ phủ số Kho bạc', numeric: false },
];

/** Million dong from whole dong, without a float: `1250000000` is `1250.000000`, `-5000` is `-0.005000`. */
export function scaledMoney(value: string, scale: UnitScale): string {
  if (scale === 'VND') return value;
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).padStart(7, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

/** The columns asked for, in the order of the table whatever the order they were named in. An unknown key or a key named twice is refused (422 VALIDATION_FAILED naming `columns[i]`); none named is all of them. */
export function selectColumns(keys: readonly string[] | undefined): readonly ExportColumn[] {
  if (keys === undefined) return EXPORT_COLUMNS;
  if (keys.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'columns');
  const seen = new Set<string>();
  keys.forEach((key, index) => {
    if (!EXPORT_COLUMNS.some((column) => column.key === key) || seen.has(key)) throw new DomainError('VALIDATION_FAILED', 422, `columns[${index}]`);
    seen.add(key);
  });
  return EXPORT_COLUMNS.filter((column) => seen.has(column.key));
}

export interface ExportHeaderEntry {
  key: string;
  label: string;
  value: string;
}

export interface ExportDocument {
  title: string;
  header: ExportHeaderEntry[];
  columns: readonly ExportColumn[];
  rows: string[][];
  /** The line that says the definitions are not signed; null once they are. */
  notice: string | null;
}

/** The words of the notice, in the file and in the footer of a PDF: the definitions of the figures await the sign-off of the business owner. */
export function signOffNotice(status: DefinitionStatus): string | null {
  return status === 'SIGNED' ? null : 'Các định nghĩa chỉ tiêu (tỷ lệ giải ngân, kỳ/YTD/PTD) đang chờ ký D03 (CXN-03): số liệu mang tính đề xuất, chưa phải số điều hành.';
}

const orEmpty = (value: string | null): string => value ?? '';

export function buildExportDocument(input: ExportInput): ExportDocument {
  const scale = input.unitScale ?? 'VND';
  const chosen = selectColumns(input.columns);
  const indexes = chosen.map((column) => EXPORT_COLUMNS.indexOf(column));
  const units = [...new Set(input.unitCodes)].sort();
  const entry = (key: string, label: string, value: string): ExportHeaderEntry => ({ key, label, value });
  return {
    title: 'Báo cáo giải ngân từ snapshot đã chốt',
    header: [
      entry('scope', 'Phạm vi (đơn vị)', units.length === 0 ? '' : units.join('; ')),
      entry('period', 'Kỳ báo cáo', input.periodCode),
      entry('snapshot_id', 'Mã snapshot', input.snapshotId),
      entry('snapshot_kind', 'Loại snapshot', input.snapshotKind),
      entry('as_of_date', 'Ngày số liệu', input.asOfDate),
      entry('treasury_cutoff_date', 'Số Kho bạc tính đến hết ngày', input.treasuryCutoffDate),
      entry('currency_unit', 'Đơn vị tính', scale),
      entry('created_at', 'Thời điểm tạo tệp', input.createdAt.toISOString()),
      entry('definition_status', 'Trạng thái định nghĩa chỉ tiêu', input.definitionStatus),
      entry('row_count', 'Số dòng', String(input.lines.length)),
    ],
    columns: scale === 'VND' ? chosen : chosen.map((column) => (column.key.endsWith('_vnd') ? { ...column, label: column.label.replace('(VND)', '(triệu VND)') } : column)),
    rows: input.lines.map((line) => [
      line.projectCode,
      line.projectName,
      line.unitCode,
      line.unitName,
      line.bucket,
      line.budgetLevel,
      line.planPmVnd,
      line.planLocalVnd,
      line.planTotalVnd,
      orEmpty(line.disbursedTreasuryVnd),
      orEmpty(line.disbursedReportedVnd),
      orEmpty(line.ctmtqgVnd),
      orEmpty(line.ratePmPct),
      orEmpty(line.rateTotalPct),
      orEmpty(line.rateNullReason),
      line.coverage,
    ]).map((row) => indexes.map((index) => {
      const value = row[index] as string;
      const column = EXPORT_COLUMNS[index] as ExportColumn;
      return column.key.endsWith('_vnd') && value !== '' ? scaledMoney(value, scale) : value;
    })),
    notice: signOffNotice(input.definitionStatus),
  };
}

// ---- CSV ------------------------------------------------------------------------------------------------------------------------

const FORMULA_START = /^[=+\-@\t\r]/;

/** A text cell is never read as a formula by a spreadsheet: a quote goes in front of what begins like one. Money and rates are numbers and are written as they are. */
export function guarded(value: string, numeric: boolean): string {
  return !numeric && FORMULA_START.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const csvLine = (cells: readonly string[]): string => cells.map(csvCell).join(',');

/** UTF-8 with a byte-order mark (so that a spreadsheet reads the Vietnamese), CRLF lines: the header block, a blank line, the table, and the notice last. */
export function csvOf(document: ExportDocument): string {
  const lines = [csvLine(['key', 'label', 'value']), ...document.header.map((entry) => csvLine([entry.key, entry.label, entry.value])), ''];
  lines.push(csvLine(document.columns.map((column) => column.key)));
  for (const row of document.rows) lines.push(csvLine(row.map((value, index) => guarded(value, document.columns[index]?.numeric === true))));
  if (document.notice !== null) lines.push(csvLine(['notice', 'Ghi chú', document.notice]));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ---- XLSX -----------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- the characters XML 1.0 cannot hold are exactly the control ones
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const xmlText = (value: string): string => value.replace(XML_FORBIDDEN, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Money and rates are written as text: a whole dong has up to 24 digits, which a spreadsheet number (15 digits) would round. */
function sheetOf(document: ExportDocument): string {
  const rows: string[][] = [['key', 'label', 'value'], ...document.header.map((entry) => [entry.key, entry.label, entry.value]), [], document.columns.map((column) => column.key), ...document.rows];
  if (document.notice !== null) rows.push([], ['notice', 'Ghi chú', document.notice]);
  const body = rows
    .map((cells, r) => {
      const refs = cells.map((value, c) => `<c r="${columnName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`);
      return `<row r="${r + 1}">${refs.join('')}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

const SHEET_NAME = 'DIS-export';

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** A zip with every entry deflated; names and dates are fixed so that the same document gives the same bytes. */
function zipOf(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const packed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** The workbook: one sheet with the header block, the table and the notice. */
export function xlsxOf(document: ExportDocument): Uint8Array {
  const text = (value: string): Buffer => Buffer.from(value, 'utf8');
  return zipOf([
    {
      name: '[Content_Types].xml',
      data: text(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    },
    {
      name: 'xl/workbook.xml',
      data: text(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    },
    { name: 'xl/worksheets/sheet1.xml', data: text(sheetOf(document)) },
  ]);
}
