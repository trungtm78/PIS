import { unzipSync } from 'fflate';
import ExcelJS from 'exceljs';
import { EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { MAX_UNITS_PER_VERSION } from '@machvon/kernel';
import type { ExtractedUnit, UnitBox } from '@machvon/kernel';
import type { DocumentTextExtractionPort, TextExtraction, TextExtractionInput } from './text-extraction';

/**
 * The local reader (the file adapter of the text port, DOC-2): it reads a Word file and a workbook by their structure and the text layer of a PDF, inside the process of the API, with no network and no external tool.
 *   - Word: the paragraphs of the body in reading order, the cells of the tables; a Word file has no fixed pages, so a paragraph is cited by its number, not by a page.
 *   - Workbook: every non-empty cell of every sheet, cited by sheet and address (`Budget!B7`).
 *   - PDF: the text of each page, grouped into lines and paragraphs, with the box of each paragraph as fractions of the page. A page with no text layer (a scan) gives no unit: the file reads as "no text", and an OCR
 *     reader bound behind the same port reads it later. The boxes are approximate (the width of a glyph is estimated, a page rotation is not applied); the text and the page are exact.
 * The container of a Word file or a workbook is a zip, and a zip can lie about its size: the declared sizes are checked before anything is inflated.
 */

export const LOCAL_ENGINE = { name: 'machvon-local-reader', version: '1' } as const;

const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_PAGE_STREAM_BYTES = 50 * 1024 * 1024;
const MAX_PDF_PAGES = 2000;

type Failure = NonNullable<TextExtraction['failure']>;

const failed = (failure: Failure, pageCount: number | null = null): TextExtraction => ({ status: 'FAILED', units: [], omitted: 0, pageCount, engine: LOCAL_ENGINE, failure });

class UnitSink {
  readonly units: ExtractedUnit[] = [];
  omitted = 0;

  add(unit: ExtractedUnit): void {
    if (this.units.length >= MAX_UNITS_PER_VERSION) this.omitted += 1;
    else this.units.push(unit);
  }
}

/** The declared size of a zip, summed without inflating a byte; a zip that declares too much, or holds too many entries, is refused. */
function assertZipIsSane(bytes: Uint8Array): void {
  let total = 0;
  let entries = 0;
  unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      entries += 1;
      if (total > MAX_UNZIPPED_BYTES || entries > MAX_ZIP_ENTRIES) throw new Error('zip too large');
      return false;
    },
  });
}

// ---- Word -----------------------------------------------------------------------------------------------------------------------------------------

const XML_ENTITY = /&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g;
const decodeXml = (text: string): string =>
  text.replace(XML_ENTITY, (_whole, entity: string) => {
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'amp') return '&';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });

const WORD_TOKEN =
  /<w:tbl(?:\s[^>]*)?>|<\/w:tbl>|<w:tr(?:\s[^>]*)?>|<\/w:tr>|<w:tc(?:\s[^>]*)?>|<\/w:tc>|<w:p(?:\s[^>]*)?>|<\/w:p>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:br\s[^>]*\/>|<w:pStyle\s+w:val="([^"]*)"\s*\/>|<w:numPr>|<w:gridSpan\s+w:val="(\d+)"\s*\/>/g;

export function readWordBody(xml: string): { units: ExtractedUnit[]; omitted: number } {
  const sink = new UnitSink();
  let depth = 0;
  let table = 0;
  let row = 0;
  let column = 0;
  let span = 1;
  let paragraph = 0;
  let buffer = '';
  let style = '';
  let listed = false;
  let cell: string[] = [];
  for (const match of xml.matchAll(WORD_TOKEN)) {
    const token = match[0];
    if (token.startsWith('<w:tbl')) {
      depth += 1;
      if (depth === 1) {
        table += 1;
        row = 0;
      }
    } else if (token === '</w:tbl>') {
      depth = Math.max(0, depth - 1);
    } else if (token.startsWith('<w:tr')) {
      if (depth === 1) {
        row += 1;
        column = 1;
      }
    } else if (token.startsWith('<w:tc')) {
      if (depth === 1) {
        cell = [];
        span = 1;
      }
    } else if (token === '</w:tc>') {
      if (depth === 1) {
        const text = cell.join(' ').trim();
        if (text !== '') sink.add({ kind: 'TABLE_CELL', locator: { table, row, column }, text });
        column += span;
      }
    } else if (token.startsWith('<w:gridSpan')) {
      span = Math.max(1, Number(match[3] ?? 1));
    } else if (token === '<w:p>' || token.startsWith('<w:p ')) {
      buffer = '';
      style = '';
      listed = false;
    } else if (token === '</w:p>') {
      const text = buffer.replace(/\s+/g, ' ').trim();
      if (depth > 0) {
        if (text !== '') cell.push(text);
      } else if (text !== '') {
        paragraph += 1;
        const kind = /^(Heading|Title|Subtitle)/i.test(style) ? 'HEADING' : listed || /List/i.test(style) ? 'LIST_ITEM' : 'PARAGRAPH';
        sink.add({ kind, locator: { paragraph }, text });
      }
      buffer = '';
    } else if (token.startsWith('<w:pStyle')) {
      style = decodeXml(match[2] ?? '');
    } else if (token === '<w:numPr>') {
      listed = true;
    } else if (token === '<w:tab/>' || token.startsWith('<w:br')) {
      buffer += ' ';
    } else if (token.startsWith('<w:t')) {
      buffer += decodeXml(match[1] ?? '');
    }
  }
  return { units: sink.units, omitted: sink.omitted };
}

function extractWord(bytes: Uint8Array): TextExtraction {
  assertZipIsSane(bytes);
  const files = unzipSync(bytes, { filter: (file) => file.name === 'word/document.xml' });
  const document = files['word/document.xml'];
  if (document === undefined) return failed('UNREADABLE');
  const { units, omitted } = readWordBody(new TextDecoder('utf-8').decode(document));
  return { status: 'OK', units, omitted, pageCount: null, engine: LOCAL_ENGINE };
}

// ---- workbook ----------------------------------------------------------------------------------------------------------------------------------------

async function extractWorkbook(bytes: Uint8Array): Promise<TextExtraction> {
  assertZipIsSane(bytes);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  const sink = new UnitSink();
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        // The cells a merge covers repeat the value of the first one: only the first is a place of its own.
        if (cell.type === ExcelJS.ValueType.Merge) return;
        const text = cell.text.trim();
        if (text === '') return;
        sink.add({ kind: 'SHEET_CELL', locator: { sheet: sheet.name, cell: cell.address }, text });
      });
    });
  });
  return { status: 'OK', units: sink.units, omitted: sink.omitted, pageCount: null, engine: LOCAL_ENGINE };
}

// ---- PDF ------------------------------------------------------------------------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a` applied first, then `b` (the order of the PDF operators: Tm, then the current transformation matrix). */
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

/** The characters of the codes 0x80 to 0x9F in Windows-1252, by code point. */
const CP1252_HIGH: readonly number[] = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

interface PdfFont {
  /** Bytes per character code: 2 for a composite font, 1 for a simple one. */
  width: 1 | 2;
  map: Map<number, string> | null;
  /** A composite font with no map has codes nobody can turn into text. */
  unreadable: boolean;
}

const hexBytes = (hex: string): number[] => {
  const clean = hex.replace(/\s+/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const bytes: number[] = [];
  for (let at = 0; at < padded.length; at += 2) bytes.push(Number.parseInt(padded.slice(at, at + 2), 16));
  return bytes;
};

const utf16 = (hex: string): string => {
  const bytes = hexBytes(hex);
  let out = '';
  for (let at = 0; at + 1 < bytes.length; at += 2) out += String.fromCharCode(((bytes[at] as number) << 8) | (bytes[at + 1] as number));
  return out;
};

/** The map of a `ToUnicode` CMap: the codes of its `bfchar` and `bfrange` entries, and the width of its codes. */
export function readToUnicode(cmap: string): { map: Map<number, string>; width: 1 | 2 } {
  const map = new Map<number, string>();
  let width: 1 | 2 = 1;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmap);
  if (space !== null) {
    const first = /<([0-9a-fA-F]+)>/.exec(space[1] ?? '');
    if (first !== null && (first[1] as string).length >= 4) width = 2;
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of (block[1] as string).matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(Number.parseInt(entry[1] as string, 16), utf16(entry[2] as string));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const entry of (block[1] as string).matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const low = Number.parseInt(entry[1] as string, 16);
      const high = Math.min(Number.parseInt(entry[2] as string, 16), low + 65535);
      const target = entry[3] as string;
      if (target.startsWith('[')) {
        let code = low;
        for (const item of target.matchAll(/<([0-9a-fA-F]*)>/g)) {
          if (code > high) break;
          map.set(code, utf16(item[1] as string));
          code += 1;
        }
      } else {
        const start = utf16(target.slice(1, -1));
        const last = start.length === 0 ? 0 : start.charCodeAt(start.length - 1);
        for (let code = low; code <= high; code += 1) map.set(code, start.slice(0, -1) + String.fromCharCode(last + (code - low)));
      }
    }
  }
  return { map, width };
}

function streamText(context: PDFContext, object: PDFObject | undefined): string | undefined {
  const stream = object === undefined ? undefined : context.lookup(object);
  if (!(stream instanceof PDFRawStream)) return undefined;
  return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
}

function fontOf(context: PDFContext, dict: PDFDict): PdfFont {
  const subtype = dict.lookup(PDFName.of('Subtype'));
  const composite = subtype instanceof PDFName && subtype.asString() === '/Type0';
  const cmap = streamText(context, dict.get(PDFName.of('ToUnicode')));
  if (cmap !== undefined) {
    const { map, width } = readToUnicode(cmap);
    return { width: composite ? 2 : width, map, unreadable: false };
  }
  return composite ? { width: 2, map: null, unreadable: true } : { width: 1, map: null, unreadable: false };
}

function decodeText(font: PdfFont, bytes: readonly number[]): string {
  if (font.unreadable) return '';
  let out = '';
  const step = font.width;
  for (let at = 0; at + step <= bytes.length; at += step) {
    const code = step === 2 ? ((bytes[at] as number) << 8) | (bytes[at + 1] as number) : (bytes[at] as number);
    const mapped = font.map?.get(code);
    if (mapped !== undefined) out += mapped;
    else if (step === 1) out += code >= 0x80 && code <= 0x9f ? String.fromCodePoint(CP1252_HIGH[code - 0x80] ?? 0x20) : code >= 0x20 ? String.fromCharCode(code) : '';
  }
  return out;
}

type Token = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'str'; v: number[] } | { t: 'arr'; v: Token[] } | { t: 'op'; v: string };

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** The tokens of a content stream: numbers, names, strings, arrays and operators; dictionaries and inline images are skipped. */
export function tokenize(data: string): Token[] {
  const out: Token[] = [];
  const stack: Token[][] = [out];
  let at = 0;
  const push = (token: Token): void => {
    (stack[stack.length - 1] as Token[]).push(token);
  };
  while (at < data.length) {
    const code = data.charCodeAt(at);
    if (WHITE.has(code)) {
      at += 1;
    } else if (code === 0x25) {
      while (at < data.length && data.charCodeAt(at) !== 10 && data.charCodeAt(at) !== 13) at += 1;
    } else if (code === 0x28) {
      const bytes: number[] = [];
      let depth = 1;
      at += 1;
      while (at < data.length && depth > 0) {
        const c = data.charCodeAt(at);
        if (c === 0x5c) {
          const next = data.charCodeAt(at + 1);
          at += 2;
          if (next === 0x6e) bytes.push(10);
          else if (next === 0x72) bytes.push(13);
          else if (next === 0x74) bytes.push(9);
          else if (next === 0x62) bytes.push(8);
          else if (next === 0x66) bytes.push(12);
          else if (next >= 0x30 && next <= 0x37) {
            let value = next - 0x30;
            for (let digits = 0; digits < 2; digits += 1) {
              const d = data.charCodeAt(at);
              if (d >= 0x30 && d <= 0x37) {
                value = value * 8 + (d - 0x30);
                at += 1;
              } else break;
            }
            bytes.push(value & 0xff);
          } else if (next === 10 || next === 13) {
            if (next === 13 && data.charCodeAt(at) === 10) at += 1;
          } else bytes.push(next);
          continue;
        }
        if (c === 0x28) depth += 1;
        else if (c === 0x29) depth -= 1;
        if (depth > 0) bytes.push(c & 0xff);
        at += 1;
      }
      push({ t: 'str', v: bytes });
    } else if (code === 0x3c && data.charCodeAt(at + 1) === 0x3c) {
      let depth = 1;
      at += 2;
      while (at < data.length && depth > 0) {
        if (data.startsWith('<<', at)) {
          depth += 1;
          at += 2;
        } else if (data.startsWith('>>', at)) {
          depth -= 1;
          at += 2;
        } else at += 1;
      }
    } else if (code === 0x3c) {
      const end = data.indexOf('>', at);
      const stop = end < 0 ? data.length : end;
      push({ t: 'str', v: hexBytes(data.slice(at + 1, stop)) });
      at = stop + 1;
    } else if (code === 0x5b) {
      const array: Token[] = [];
      push({ t: 'arr', v: array });
      stack.push(array);
      at += 1;
    } else if (code === 0x5d) {
      if (stack.length > 1) stack.pop();
      at += 1;
    } else if (code === 0x2f) {
      let end = at + 1;
      while (end < data.length && !WHITE.has(data.charCodeAt(end)) && !DELIMITER.has(data.charCodeAt(end))) end += 1;
      push({ t: 'name', v: data.slice(at + 1, end) });
      at = end;
    } else if (DELIMITER.has(code)) {
      at += 1;
    } else {
      let end = at;
      while (end < data.length && !WHITE.has(data.charCodeAt(end)) && !DELIMITER.has(data.charCodeAt(end))) end += 1;
      const word = data.slice(at, end);
      at = end;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push({ t: 'num', v: Number(word) });
      else if (word === 'BI') {
        // An inline image: its data is binary, so skip to the end of it.
        const stop = data.indexOf('EI', at);
        at = stop < 0 ? data.length : stop + 2;
      } else push({ t: 'op', v: word });
    }
  }
  return out;
}

interface Run {
  x: number;
  y: number;
  size: number;
  x1: number;
  text: string;
}

const num = (token: Token | undefined): number => (token?.t === 'num' ? token.v : 0);

/** The text runs of a page, with where each starts and how big it is, in the order the page draws them. */
/** A Form XObject a page draws with `Do`: its own content, the fonts it sees and the matrix that places it. */
interface PdfForm {
  content: string;
  fonts: Map<string, PdfFont>;
  matrix: Matrix;
  forms: FormResolver;
}

type FormResolver = (name: string) => PdfForm | undefined;

/** How deep forms may draw forms, and how many forms one page may open: a form that draws itself, or a bomb of forms, ends the reading of the page. */
const MAX_FORM_DEPTH = 4;
const MAX_FORMS_PER_PAGE = 500;

function runsOf(content: string, fonts: Map<string, PdfFont>, forms: FormResolver, start: Matrix = IDENTITY, depth = 0, budget = { forms: 0 }): Run[] {
  const runs: Run[] = [];
  const operands: Token[] = [];
  let ctm = start;
  const saved: Matrix[] = [];
  let tm = IDENTITY;
  let tlm = IDENTITY;
  let leading = 0;
  let font: PdfFont = { width: 1, map: null, unreadable: false };
  let size = 12;
  const scale = (): number => size * Math.hypot(tm[2], tm[3]) * Math.hypot(ctm[2], ctm[3]);
  const show = (pieces: Array<{ text: string } | { gap: number }>): void => {
    const origin = multiply(tm, ctm);
    const effective = scale();
    let text = '';
    let advance = 0;
    for (const piece of pieces) {
      if ('text' in piece) {
        text += piece.text;
        advance += piece.text.length * 0.5 * size;
      } else {
        if (piece.gap < -200) text += ' ';
        advance -= (piece.gap / 1000) * size;
      }
    }
    const move = advance * Math.hypot(tm[0], tm[1]) * Math.hypot(ctm[0], ctm[1]);
    if (text.trim() !== '') runs.push({ x: origin[4], y: origin[5], size: effective, x1: origin[4] + move, text });
    tm = multiply([1, 0, 0, 1, advance, 0], tm);
  };
  const next = (): void => {
    tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
    tm = tlm;
  };
  for (const token of tokenize(content)) {
    if (token.t !== 'op') {
      operands.push(token);
      if (operands.length > 64) operands.shift();
      continue;
    }
    const at = (n: number): Token | undefined => operands[operands.length - n];
    switch (token.v) {
      case 'q':
        saved.push(ctm);
        break;
      case 'Q':
        ctm = saved.pop() ?? ctm;
        break;
      case 'Do': {
        // A form is drawn where it is asked for, with its own matrix on top of the current one; the text it holds is part of the page.
        const name = at(1);
        if (name?.t === 'name' && depth < MAX_FORM_DEPTH && budget.forms < MAX_FORMS_PER_PAGE) {
          const form = forms(name.v);
          if (form !== undefined) {
            budget.forms += 1;
            runs.push(...runsOf(form.content, form.fonts, form.forms, multiply(form.matrix, ctm), depth + 1, budget));
          }
        }
        break;
      }
      case 'cm':
        ctm = multiply([num(at(6)), num(at(5)), num(at(4)), num(at(3)), num(at(2)), num(at(1))], ctm);
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'Tf': {
        const name = at(2);
        font = (name?.t === 'name' ? fonts.get(name.v) : undefined) ?? { width: 1, map: null, unreadable: false };
        size = num(at(1)) || size;
        break;
      }
      case 'TL':
        leading = num(at(1));
        break;
      case 'Td':
        tlm = multiply([1, 0, 0, 1, num(at(2)), num(at(1))], tlm);
        tm = tlm;
        break;
      case 'TD':
        leading = -num(at(1));
        tlm = multiply([1, 0, 0, 1, num(at(2)), num(at(1))], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tm = [num(at(6)), num(at(5)), num(at(4)), num(at(3)), num(at(2)), num(at(1))];
        tlm = tm;
        break;
      case 'T*':
        next();
        break;
      case 'Tj': {
        const text = at(1);
        if (text?.t === 'str') show([{ text: decodeText(font, text.v) }]);
        break;
      }
      case "'": {
        next();
        const text = at(1);
        if (text?.t === 'str') show([{ text: decodeText(font, text.v) }]);
        break;
      }
      case '"': {
        next();
        const text = at(1);
        if (text?.t === 'str') show([{ text: decodeText(font, text.v) }]);
        break;
      }
      case 'TJ': {
        const list = at(1);
        if (list?.t === 'arr') show(list.v.flatMap((item): Array<{ text: string } | { gap: number }> => (item.t === 'str' ? [{ text: decodeText(font, item.v) }] : item.t === 'num' ? [{ gap: item.v }] : [])));
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
  return runs;
}

interface Line {
  y: number;
  size: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  text: string;
}

function linesOf(runs: readonly Run[]): Line[] {
  const lines: Line[] = [];
  for (const run of runs) {
    const last = lines[lines.length - 1];
    const same = last !== undefined && Math.abs(run.y - last.y) <= 0.4 * Math.max(run.size, last.size);
    if (same) {
      const gap = run.x - last.x1;
      last.text += (gap > 0.15 * run.size && !last.text.endsWith(' ') && !run.text.startsWith(' ') ? ' ' : '') + run.text;
      last.x0 = Math.min(last.x0, run.x);
      last.x1 = Math.max(last.x1, run.x1);
      last.top = Math.max(last.top, run.y + 0.8 * run.size);
      last.bottom = Math.min(last.bottom, run.y - 0.2 * run.size);
      last.size = Math.max(last.size, run.size);
    } else {
      lines.push({ y: run.y, size: run.size, x0: run.x, x1: run.x1, top: run.y + 0.8 * run.size, bottom: run.y - 0.2 * run.size, text: run.text });
    }
  }
  return lines;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The paragraphs of a page: the lines are cut where the next line is not just below the last (a gap above 1.7 lines, or a move up), with the box each fills. */
export function paragraphsOf(lines: readonly Line[], width: number, height: number): Array<{ kind: 'HEADING' | 'PARAGRAPH'; text: string; box: UnitBox | undefined }> {
  const typical = median(lines.map((line) => line.size));
  const groups: Line[][] = [];
  for (const line of lines) {
    const group = groups[groups.length - 1];
    const last = group?.[group.length - 1];
    const below = last !== undefined && last.y - line.y > 0 && last.y - line.y <= 1.7 * Math.max(last.size, line.size);
    const bothHeading = last !== undefined && last.size >= typical * 1.25 === line.size >= typical * 1.25;
    if (group !== undefined && below && bothHeading) group.push(line);
    else groups.push([line]);
  }
  return groups.map((group) => {
    const text = group.map((line) => line.text.trim()).join(' ');
    const size = Math.max(...group.map((line) => line.size));
    const x0 = Math.min(...group.map((line) => line.x0));
    const x1 = Math.max(...group.map((line) => line.x1));
    const top = Math.max(...group.map((line) => line.top));
    const bottom = Math.min(...group.map((line) => line.bottom));
    const box: UnitBox | undefined = width > 0 && height > 0 ? { x0: clamp01(x0 / width), y0: clamp01(1 - top / height), x1: clamp01(x1 / width), y1: clamp01(1 - bottom / height) } : undefined;
    return { kind: size >= typical * 1.25 && text.length <= 160 ? 'HEADING' : 'PARAGRAPH', text, box: box !== undefined && box.x1 >= box.x0 && box.y1 >= box.y0 ? box : undefined };
  });
}

function fontsOf(context: PDFContext, resources: PDFDict | undefined): Map<string, PdfFont> {
  const fonts = new Map<string, PdfFont>();
  const fontDict = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  for (const [name, value] of fontDict?.entries() ?? []) {
    const dict = context.lookupMaybe(value, PDFDict);
    if (dict !== undefined) fonts.set(name.asString().slice(1), fontOf(context, dict));
  }
  return fonts;
}

/** The forms of a resource dictionary, opened on demand: a form without resources of its own sees the ones of the page or form that draws it. */
function formsOf(context: PDFContext, resources: PDFDict | undefined, inherited: Map<string, PdfFont>): FormResolver {
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return (name) => {
    const entry = xobjects?.get(PDFName.of(name));
    const stream = entry === undefined ? undefined : context.lookup(entry);
    if (!(stream instanceof PDFRawStream)) return undefined;
    const subtype = stream.dict.lookup(PDFName.of('Subtype'));
    if (!(subtype instanceof PDFName) || subtype.asString() !== '/Form') return undefined;
    const decoded = decodePDFRawStream(stream).decode();
    if (decoded.length > MAX_PAGE_STREAM_BYTES) throw new Error('form too large');
    const own = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
    const fonts = own === undefined ? inherited : new Map([...inherited, ...fontsOf(context, own)]);
    const numbers = stream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray)?.asArray().map((item) => (item instanceof PDFNumber ? item.asNumber() : Number.NaN));
    const matrix: Matrix = numbers !== undefined && numbers.length === 6 && numbers.every(Number.isFinite) ? (numbers as Matrix) : IDENTITY;
    return { content: Buffer.from(decoded).toString('latin1'), fonts, matrix, forms: formsOf(context, own ?? resources, fonts) };
  };
}

function contentOf(context: PDFContext, contents: PDFObject | undefined): string {
  const resolved = contents === undefined ? undefined : context.lookup(contents);
  const parts: PDFObject[] = resolved instanceof PDFArray ? resolved.asArray() : resolved === undefined ? [] : [resolved];
  let total = 0;
  const texts: string[] = [];
  for (const part of parts) {
    const stream = context.lookup(part);
    if (stream instanceof PDFRawStream) {
      const decoded = decodePDFRawStream(stream).decode();
      total += decoded.length;
      if (total > MAX_PAGE_STREAM_BYTES) throw new Error('page too large');
      texts.push(Buffer.from(decoded).toString('latin1'));
    } else if (stream instanceof PDFStream) {
      texts.push(Buffer.from(stream.getContents()).toString('latin1'));
    }
  }
  return texts.join('\n');
}

async function extractPdf(bytes: Uint8Array): Promise<TextExtraction> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (error) {
    return failed(error instanceof EncryptedPDFError ? 'ENCRYPTED' : 'UNREADABLE');
  }
  const pageCount = document.getPageCount();
  if (pageCount > MAX_PDF_PAGES) return failed('TOO_LARGE', pageCount);
  const sink = new UnitSink();
  const context = document.context;
  try {
    for (let index = 0; index < pageCount; index += 1) {
      const page = document.getPage(index);
      const resources = page.node.Resources();
      const fonts = fontsOf(context, resources);
      const { width, height } = page.getSize();
      const runs = runsOf(contentOf(context, page.node.Contents()), fonts, formsOf(context, resources, fonts));
      paragraphsOf(linesOf(runs), width, height).forEach((paragraph, at) => {
        sink.add({ kind: paragraph.kind, locator: { page: index + 1, paragraph: at + 1 }, text: paragraph.text, box: paragraph.box });
      });
    }
  } catch {
    return failed('UNREADABLE', pageCount);
  }
  return { status: 'OK', units: sink.units, omitted: sink.omitted, pageCount, engine: LOCAL_ENGINE };
}

/** The adapter the module binds by default: no network, no tool outside the process. */
export class LocalTextExtractor implements DocumentTextExtractionPort {
  async extract(input: TextExtractionInput): Promise<TextExtraction> {
    try {
      if (input.format === 'PDF') return await extractPdf(input.bytes);
      if (input.format === 'DOCX') return extractWord(input.bytes);
      return await extractWorkbook(input.bytes);
    } catch {
      return failed('UNREADABLE');
    }
  }
}
