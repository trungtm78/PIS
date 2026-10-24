import { inflateRawSync } from 'node:zlib';
import { DomainError } from './errors.ts';

export type TabularFormat = 'CSV' | 'XLSX';

export interface TabularFile {
  format: TabularFormat;
  /** The first row: the names of the columns, trimmed. */
  headers: string[];
  /** The rows after the header, as text; a short row is padded with empty cells to the width of the header. */
  rows: string[][];
  /**
   * The line of the source of each row, in the order of `rows` (the first line of the file is 1): the line a CSV row starts on, even when a
   * quoted cell runs over several, and the number of the row in the worksheet. Blank lines are dropped from `rows` but always counted.
   */
  lines: number[];
}

/** A row of the source with the line it starts on. */
interface SourceRow {
  cells: string[];
  line: number;
}

/** What a file may weigh before it is read: the framework answers a file beyond these with 422, never runs out of memory on it. */
export interface TabularLimits {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCellLength: number;
  /** The size that an archive may inflate to (a zip bomb stays below it). */
  maxInflatedBytes: number;
}

export const DEFAULT_TABULAR_LIMITS: TabularLimits = { maxBytes: 25 * 1024 * 1024, maxRows: 5000, maxColumns: 100, maxCellLength: 10_000, maxInflatedBytes: 50 * 1024 * 1024 };

const unreadable = (): DomainError => new DomainError('VALIDATION_FAILED', 422, 'file');
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const isZip = (bytes: Uint8Array): boolean => ZIP_MAGIC.every((value, index) => bytes[index] === value);

// ---- CSV ------------------------------------------------------------------------------------------------------------------

const DELIMITERS = [',', ';', '\t'] as const;

/** The delimiter that the first line uses most; a comma when none occurs. */
function delimiterOf(text: string): string {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  let best = ',';
  let most = 0;
  for (const candidate of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const character of firstLine) {
      if (character === '"') quoted = !quoted;
      else if (character === candidate && !quoted) count += 1;
    }
    if (count > most) {
      best = candidate;
      most = count;
    }
  }
  return best;
}

/** RFC 4180 rows: quoted cells may hold the delimiter, line breaks and doubled quotes. Blank lines are skipped, but counted. */
function csvRows(text: string, limits: TabularLimits): SourceRow[] {
  const delimiter = delimiterOf(text);
  const rows: SourceRow[] = [];
  let line = 1;
  let startLine = 1;
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let touched = false;
  const endCell = (): void => {
    if (cell.length > limits.maxCellLength) throw unreadable();
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    if (row.length > limits.maxColumns) throw unreadable();
    if (touched || row.some((value) => value !== '')) rows.push({ cells: row, line: startLine });
    if (rows.length > limits.maxRows + 1) throw unreadable();
    row = [];
    touched = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (quoted) {
      if (character !== '"') {
        cell += character;
        // A line break inside a quoted cell is a line of the file too (a CRLF is one).
        if (character === '\n' || (character === '\r' && text.charAt(index + 1) !== '\n')) line += 1;
      } else if (text.charAt(index + 1) === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"' && cell === '') {
      quoted = true;
      touched = true;
    } else if (character === delimiter) {
      endCell();
      touched = true;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text.charAt(index + 1) === '\n') index += 1;
      endRow();
      line += 1;
      startLine = line;
    } else cell += character;
  }
  if (quoted) throw unreadable();
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function csvTable(bytes: Uint8Array, limits: TabularLimits): SourceRow[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unreadable();
  }
  return csvRows(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, limits);
}

// ---- XLSX (a zip of XML parts) --------------------------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The entries of the central directory of a zip file. Encrypted or zip64 archives are not read. */
function zipEntries(bytes: Buffer, limits: TabularLimits): Map<string, ZipEntry> {
  let end = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 22 - 65_535); position -= 1) {
    if (bytes.readUInt32LE(position) === EOCD) {
      end = position;
      break;
    }
  }
  if (end < 0) throw unreadable();
  const count = bytes.readUInt16LE(end + 10);
  let position = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, ZipEntry>();
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > bytes.length || bytes.readUInt32LE(position) !== CENTRAL) throw unreadable();
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const compressedSize = bytes.readUInt32LE(position + 20);
    const size = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const offset = bytes.readUInt32LE(position + 42);
    const name = bytes.toString('utf8', position + 46, position + 46 + nameLength);
    // Encrypted (bit 0), a size that does not fit in 32 bits, and a total that no spreadsheet needs are all refused.
    if ((flags & 1) !== 0 || compressedSize === 0xffffffff || size === 0xffffffff) throw unreadable();
    total += size;
    if (total > limits.maxInflatedBytes) throw unreadable();
    entries.set(name, { name, method, compressedSize, size, offset });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipText(bytes: Buffer, entry: ZipEntry, limits: TabularLimits): string {
  if (entry.offset + 30 > bytes.length || bytes.readUInt32LE(entry.offset) !== LOCAL) throw unreadable();
  const start = entry.offset + 30 + bytes.readUInt16LE(entry.offset + 26) + bytes.readUInt16LE(entry.offset + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw unreadable();
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method !== 8) throw unreadable();
  try {
    // The inflated size is capped while it is produced, not after: a bomb never gets to be large.
    return inflateRawSync(data, { maxOutputLength: Math.min(limits.maxInflatedBytes, Math.max(entry.size, 1) + 1024) }).toString('utf8');
  } catch {
    throw unreadable();
  }
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (value: string): string =>
  value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (match, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? match;
  });

/** The text of every <t> element inside a fragment (a shared string or an inline string may be made of several runs). */
const textOf = (fragment: string): string => [...fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((found) => decodeXml(found[1] ?? '')).join('');

function sharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((found) => textOf(found[1] ?? ''));
}

/** `A` is 0, `Z` is 25, `AA` is 26. */
function columnIndex(reference: string): number {
  let index = 0;
  for (const character of reference.replace(/[^A-Z]/gi, '').toUpperCase()) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

// ---- dates: a date in a worksheet is a number, and only its style says that it is a date ------------------------------------

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
}

/** The formats of the standard that show a date or a time (ECMA-376 18.8.30): 14 to 22, 27 to 36, 45 to 47 and 50 to 58. */
const BUILT_IN_DATE_FORMATS: ReadonlySet<number> = new Set([...range(14, 22), ...range(27, 36), ...range(45, 47), ...range(50, 58)]);

/** A custom format shows a date when a day, month, year, hour or second token is left once the escapes, the quoted text and the [bracket] parts are removed. */
function isDateFormat(code: string): boolean {
  return /[dmyhs]/i.test(code.replace(/\\./g, '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/[_*]./g, ''));
}

interface WorkbookDates {
  /** The indexes of the cell formats (the `s` of a cell) that show a date or a time. */
  styles: ReadonlySet<number>;
  /** The workbook counts its days from 1904-01-01 instead of 1899-12-30. */
  date1904: boolean;
}

function workbookDates(styles: string | undefined, workbook: string): WorkbookDates {
  const date1904 = /<workbookPr\b[^>]*\sdate1904="(?:1|true)"/i.test(workbook);
  if (styles === undefined) return { styles: new Set(), date1904 };
  const custom = new Map<number, string>();
  for (const tag of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = /\snumFmtId="(\d+)"/.exec(tag[0])?.[1];
    const code = /\sformatCode="([^"]*)"/.exec(tag[0])?.[1];
    if (id !== undefined && code !== undefined) custom.set(Number(id), decodeXml(code));
  }
  const formats = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const dates = new Set<number>();
  [...formats.matchAll(/<xf\b[^>]*>/g)].forEach((tag, index) => {
    const id = Number(/\snumFmtId="(\d+)"/.exec(tag[0])?.[1] ?? 0);
    const code = custom.get(id);
    if (code === undefined ? BUILT_IN_DATE_FORMATS.has(id) : isDateFormat(code)) dates.add(index);
  });
  return { styles: dates, date1904 };
}

const DAY_MS = 86_400_000;
const SECONDS_PER_DAY = 86_400;
const LAST_DAY_MS = Date.UTC(9999, 11, 31);
const two = (value: number): string => String(value).padStart(2, '0');

/**
 * The text of a serial number that a date style marks: yyyy-mm-dd, yyyy-mm-ddThh:mm:ss when the serial has a time of day, hh:mm:ss when it
 * has nothing but a time. The 1900 system counts a 29 February 1900 that never was (serial 60), so from serial 61 on the day zero is
 * 1899-12-30; the serial 60, the serial 0 and what is not a day of the calendar stay as they are, for the module that reads the file to refuse.
 */
function serialDate(raw: string, date1904: boolean): string {
  const serial = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(serial) || serial < 0) return raw;
  const total = Math.round(serial * SECONDS_PER_DAY);
  const day = Math.floor(total / SECONDS_PER_DAY);
  const rest = total - day * SECONDS_PER_DAY;
  const time = `${two(Math.floor(rest / 3600))}:${two(Math.floor((rest % 3600) / 60))}:${two(rest % 60)}`;
  if (day === 0 && rest > 0) return time;
  let base: number;
  if (date1904) base = Date.UTC(1904, 0, 1);
  else if (day === 0 || day === 60) return raw;
  else base = day < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const at = base + day * DAY_MS;
  if (at > LAST_DAY_MS) return raw;
  const date = new Date(at).toISOString().slice(0, 10);
  return rest === 0 ? date : `${date}T${time}`;
}

function sheetRows(xml: string, strings: readonly string[], dates: WorkbookDates, limits: TabularLimits): SourceRow[] {
  const rows: SourceRow[] = [];
  let previous = 0;
  for (const found of xml.matchAll(/<row((?:\s[^>]*)?)(?<!\/)>([\s\S]*?)<\/row>|<row((?:\s[^>]*)?)\/>/g)) {
    // The row number of the sheet; a row without one (or one that goes back) follows the row before it.
    const declared = Number(/\sr="(\d+)"/.exec(found[1] ?? found[3] ?? '')?.[1] ?? Number.NaN);
    const line = Number.isInteger(declared) && declared > previous ? declared : previous + 1;
    previous = line;
    const cells: string[] = [];
    for (const cell of (found[2] ?? '').matchAll(/<c((?:\s[^>]*)?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? '';
      const reference = /\sr="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const type = /\st="([^"]*)"/.exec(attributes)?.[1];
      const body = cell[2] ?? '';
      let value = '';
      if (type === 's') value = strings[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? Number.NaN)] ?? '';
      else if (type === 'inlineStr') value = textOf(/<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        const style = /\ss="(\d+)"/.exec(attributes)?.[1];
        if ((type === undefined || type === 'n') && style !== undefined && dates.styles.has(Number(style))) value = serialDate(value, dates.date1904);
      }
      const index = reference === undefined ? cells.length : columnIndex(reference);
      if (index < 0 || index >= limits.maxColumns) throw unreadable();
      if (value.length > limits.maxCellLength) throw unreadable();
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    if (cells.some((value) => value !== '')) rows.push({ cells, line });
    if (rows.length > limits.maxRows + 1) throw unreadable();
  }
  return rows;
}

function xlsxTable(bytes: Uint8Array, limits: TabularLimits): SourceRow[] {
  const buffer = Buffer.from(bytes);
  const entries = zipEntries(buffer, limits);
  const read = (name: string): string | undefined => {
    const entry = entries.get(name);
    return entry === undefined ? undefined : zipText(buffer, entry, limits);
  };
  const workbook = read('xl/workbook.xml');
  const relationships = read('xl/_rels/workbook.xml.rels');
  if (workbook === undefined || relationships === undefined) throw unreadable();
  // The first sheet of the workbook, through its relationship.
  const sheetId = /<sheet\s[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
  const target = [...relationships.matchAll(/<Relationship\s[^>]*>/g)].map((found) => found[0]).find((tag) => /\sId="([^"]+)"/.exec(tag)?.[1] === sheetId);
  const path = target === undefined ? undefined : /\sTarget="([^"]+)"/.exec(target)?.[1];
  if (path === undefined) throw unreadable();
  const sheet = read(path.startsWith('/') ? path.slice(1) : `xl/${path}`);
  if (sheet === undefined) throw unreadable();
  return sheetRows(sheet, sharedStrings(read('xl/sharedStrings.xml')), workbookDates(read('xl/styles.xml'), workbook), limits);
}

/**
 * Reads a CSV file (UTF-8, comma, semicolon or tab) or the first sheet of an XLSX file into a header and rows of text. The format is
 * told by the bytes (a zip is a workbook), never by the name. Anything unreadable, too big, or too wide is 422 VALIDATION_FAILED on
 * `file`; every cell stays text, so the module that maps it decides what a number or a date is.
 */
export function readTabularFile(bytes: Uint8Array, limits: TabularLimits = DEFAULT_TABULAR_LIMITS): TabularFile {
  if (bytes.length === 0 || bytes.length > limits.maxBytes) throw unreadable();
  const format: TabularFormat = isZip(bytes) ? 'XLSX' : 'CSV';
  const table = format === 'XLSX' ? xlsxTable(bytes, limits) : csvTable(bytes, limits);
  const [head, ...body] = table;
  if (head === undefined) throw unreadable();
  const headers = head.cells.map((name) => name.trim());
  if (headers.every((name) => name === '') || new Set(headers.filter((name) => name !== '')).size !== headers.filter((name) => name !== '').length) throw unreadable();
  return { format, headers, rows: body.map((row) => headers.map((_name, index) => row.cells[index] ?? '')), lines: body.map((row) => row.line) };
}
