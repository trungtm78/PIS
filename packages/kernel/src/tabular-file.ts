import { inflateRawSync } from 'node:zlib';
import { DomainError } from './errors.ts';

export type TabularFormat = 'CSV' | 'XLSX';

export interface TabularFile {
  format: TabularFormat;
  /** The first row: the names of the columns, trimmed. */
  headers: string[];
  /** The rows after the header, as text; a short row is padded with empty cells to the width of the header. */
  rows: string[][];
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

/** RFC 4180 rows: quoted cells may hold the delimiter, line breaks and doubled quotes. Blank lines are skipped. */
function csvRows(text: string, limits: TabularLimits): string[][] {
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
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
    if (touched || row.some((value) => value !== '')) rows.push(row);
    if (rows.length > limits.maxRows + 1) throw unreadable();
    row = [];
    touched = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (quoted) {
      if (character !== '"') cell += character;
      else if (text.charAt(index + 1) === '"') {
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
    } else cell += character;
  }
  if (quoted) throw unreadable();
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function csvTable(bytes: Uint8Array, limits: TabularLimits): string[][] {
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

function sheetRows(xml: string, strings: readonly string[], limits: TabularLimits): string[][] {
  const rows: string[][] = [];
  for (const found of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>|<row(?:\s[^>]*)?\/>/g)) {
    const cells: string[] = [];
    for (const cell of (found[1] ?? '').matchAll(/<c((?:\s[^>]*)?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? '';
      const reference = /\sr="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const type = /\st="([^"]*)"/.exec(attributes)?.[1];
      const body = cell[2] ?? '';
      let value = '';
      if (type === 's') value = strings[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? Number.NaN)] ?? '';
      else if (type === 'inlineStr') value = textOf(/<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      const index = reference === undefined ? cells.length : columnIndex(reference);
      if (index < 0 || index >= limits.maxColumns) throw unreadable();
      if (value.length > limits.maxCellLength) throw unreadable();
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    if (cells.some((value) => value !== '')) rows.push(cells);
    if (rows.length > limits.maxRows + 1) throw unreadable();
  }
  return rows;
}

function xlsxTable(bytes: Uint8Array, limits: TabularLimits): string[][] {
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
  return sheetRows(sheet, sharedStrings(read('xl/sharedStrings.xml')), limits);
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
  const headers = head.map((name) => name.trim());
  if (headers.every((name) => name === '') || new Set(headers.filter((name) => name !== '')).size !== headers.filter((name) => name !== '').length) throw unreadable();
  return { format, headers, rows: body.map((row) => headers.map((_name, index) => row[index] ?? '')) };
}
