import { AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, LevelFormat, PageBreak, PageNumber, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType } from 'docx';
import type { ParagraphChild } from 'docx';
import { unzipSync } from 'fflate';
import { DomainError } from '@machvon/kernel';
import type { NarrativeBlock } from '@machvon/kernel';
import { normalizeZip } from './zip-normalize';

/**
 * Writes the narrative part of a report (thuyết minh) as a Word document (RPT-1). The blocks come from the kernel (`fillNarrative` has already put the figures of the register into the text, so a sentence and a table
 * cannot disagree). The library is `docx` (MIT, pure JavaScript, maintained). The default page is the one of a Vietnamese administrative document: A4 portrait, Times New Roman 13 pt, margins 20 mm above and below, 30 mm
 * left and 15 mm right; a customer who wants another page says so in the options. The output is deterministic (fixed zip order and times, document dates set to the time of the issue), so the same blocks give the same
 * bytes and the same sha256.
 */
export interface DocxPageSetup {
  orientation?: 'PORTRAIT' | 'LANDSCAPE' | undefined;
  /** Margins in millimetres. */
  marginMm?: { top: number; bottom: number; left: number; right: number } | undefined;
}

export interface DocxOptions {
  title: string;
  creator: string;
  subject?: string | undefined;
  /** The time written into the document properties; the epoch when not given. */
  issuedAt?: Date | undefined;
  /** Text of the header of every page (the name of the organisation or the form). */
  headerText?: string | undefined;
  /** Text of the footer, before the page number. */
  footerText?: string | undefined;
  /** The mark every page carries when the form is not an official one (the demo mark, `grid.stamp` of the kernel): printed in red in the header and at the start of the footer, and written into the document properties. */
  stamp?: string | null | undefined;
  font?: string | undefined;
  /** Size of the body text in points. */
  fontSizePt?: number | undefined;
  page?: DocxPageSetup | undefined;
}

const A4_WIDTH = 11906;
const A4_HEIGHT = 16838;
const TWIPS_PER_MM = 1440 / 25.4;
const DEFAULT_MARGIN_MM = { top: 20, bottom: 20, left: 30, right: 15 };
const twips = (mm: number): number => Math.round(mm * TWIPS_PER_MM);
const NUMBERED = 'machvon-numbered';
const BULLETED = 'machvon-bulleted';

const ALIGN = { LEFT: AlignmentType.LEFT, CENTER: AlignmentType.CENTER, RIGHT: AlignmentType.RIGHT, JUSTIFY: AlignmentType.JUSTIFIED } as const;
const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
const THIN = { style: BorderStyle.SINGLE, size: 4, color: '000000' } as const;

const invalid = (detail: string): never => {
  throw new DomainError('VALIDATION_FAILED', 422, detail);
};

function assertOptions(options: DocxOptions): void {
  if (options.title.trim() === '' || options.creator.trim() === '') invalid('docx_options');
  if (options.fontSizePt !== undefined && !(options.fontSizePt >= 6 && options.fontSizePt <= 24)) invalid('docx_options');
  const margin = options.page?.marginMm;
  if (margin !== undefined && ![margin.top, margin.bottom, margin.left, margin.right].every((value) => Number.isFinite(value) && value >= 5 && value <= 60)) invalid('docx_options');
}

const cellOf = (text: string, options: { bold?: boolean; width?: number; align?: keyof typeof ALIGN; shade?: boolean; border?: boolean }): TableCell =>
  new TableCell({
    width: options.width === undefined ? undefined : { size: options.width, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    shading: options.shade === true ? { type: ShadingType.CLEAR, fill: 'E7E6E6', color: 'auto' } : undefined,
    borders: options.border === false ? { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER } : { top: THIN, bottom: THIN, left: THIN, right: THIN },
    children: text.split('\n').map((line) => new Paragraph({ alignment: ALIGN[options.align ?? 'LEFT'], children: [new TextRun({ text: line, bold: options.bold === true })] })),
  });

function tableOf(block: Extract<NarrativeBlock, { type: 'TABLE' }>): Table {
  const columns = block.header.length;
  if (columns === 0 || block.rows.some((row) => row.length !== columns)) invalid('table');
  const widths = block.widths ?? block.header.map(() => 100 / columns);
  if (widths.length !== columns || widths.some((width) => !(width > 0))) invalid('table');
  const total = widths.reduce((sum, width) => sum + width, 0);
  const percent = widths.map((width) => (width / total) * 100);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: block.header.map((text, index) => cellOf(text, { bold: true, align: 'CENTER', shade: true, width: percent[index] as number })) }),
      ...block.rows.map((row) => new TableRow({ cantSplit: true, children: row.map((text, index) => cellOf(text, { width: percent[index] as number })) })),
    ],
  });
}

/** The signature block: one column per slot, the role in bold, a line for the signature and the name, with no borders. */
function signaturesOf(block: Extract<NarrativeBlock, { type: 'SIGNATURES' }>): Table {
  if (block.slots.length === 0) invalid('signatures');
  const width = 100 / block.slots.length;
  const column = (slot: { role: string; name: string | null }): TableCell =>
    new TableCell({
      width: { size: width, type: WidthType.PERCENTAGE },
      borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: slot.role, bold: true })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '(Ký, ghi rõ họ tên)', italics: true, size: 22 })] }),
        new Paragraph({ children: [new TextRun({ text: '' })], spacing: { before: 900 } }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: slot.name ?? '', bold: true })] }),
      ],
    });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER }, rows: [new TableRow({ cantSplit: true, children: block.slots.map(column) })] });
}

type Child = Paragraph | Table;

function childrenOf(blocks: readonly NarrativeBlock[]): Child[] {
  const out: Child[] = [];
  let numberedInstance = 0;
  for (const block of blocks) {
    switch (block.type) {
      case 'HEADING':
        out.push(new Paragraph({ heading: HEADINGS[block.level], children: [new TextRun({ text: block.text, bold: true })], spacing: { before: 240, after: 120 } }));
        break;
      case 'PARAGRAPH':
        out.push(new Paragraph({ alignment: ALIGN[block.align ?? 'JUSTIFY'], spacing: { after: 120 }, children: [new TextRun({ text: block.text, bold: block.bold === true, italics: block.italic === true })] }));
        break;
      case 'LIST': {
        if (block.ordered) numberedInstance += 1;
        for (const item of block.items) {
          out.push(new Paragraph({ numbering: block.ordered ? { reference: NUMBERED, level: 0, instance: numberedInstance } : { reference: BULLETED, level: 0 }, alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: item })] }));
        }
        break;
      }
      case 'TABLE':
        out.push(tableOf(block), new Paragraph({ children: [] }));
        break;
      case 'PAGE_BREAK':
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case 'SIGNATURES':
        out.push(signaturesOf(block), new Paragraph({ children: [] }));
        break;
    }
  }
  return out;
}

function headerOf(headerText: string | undefined, stamp: string | null): { default?: Header } {
  const children: Paragraph[] = [];
  if (stamp !== null) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: stamp, size: 20, bold: true, color: 'C00000' })] }));
  if (headerText !== undefined && headerText !== '') children.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: headerText, size: 20, italics: true })] }));
  return children.length === 0 ? {} : { default: new Header({ children }) };
}

const W3CDTF = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Returns the bytes of the Word document for the blocks. Throws VALIDATION_FAILED for a table whose rows do not match its header, a signature block with no slots, or options that are out of range. */
export async function renderDocx(blocks: readonly NarrativeBlock[], options: DocxOptions): Promise<Uint8Array> {
  assertOptions(options);
  const margin = options.page?.marginMm ?? DEFAULT_MARGIN_MM;
  const landscape = options.page?.orientation === 'LANDSCAPE';
  const font = options.font ?? 'Times New Roman';
  const size = Math.round((options.fontSizePt ?? 13) * 2);
  const issuedAt = options.issuedAt ?? new Date(0);
  const footerChildren: ParagraphChild[] = [];
  const mark = options.stamp ?? null;
  if (mark !== null) footerChildren.push(new TextRun({ text: `${mark} — `, size: 20, color: 'C00000' }));
  if (options.footerText !== undefined && options.footerText !== '') footerChildren.push(new TextRun({ text: `${options.footerText} — `, size: 20 }));
  footerChildren.push(new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 20 }));

  const document = new Document({
    creator: options.creator,
    lastModifiedBy: options.creator,
    title: options.title,
    ...(options.subject === undefined && mark === null ? {} : { subject: options.subject ?? (mark as string) }),
    ...(mark === null ? {} : { description: mark }),
    styles: {
      default: { document: { run: { font, size }, paragraph: { spacing: { line: 312 } } } },
      paragraphStyles: [1, 2, 3].map((level) => ({ id: `Heading${level}`, name: `heading ${level}`, basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font, size: size + (level === 1 ? 4 : level === 2 ? 2 : 0), bold: true } })),
    },
    numbering: {
      config: [
        { reference: NUMBERED, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
        { reference: BULLETED, levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: A4_WIDTH, height: A4_HEIGHT, orientation: landscape ? 'landscape' : 'portrait' }, margin: { top: twips(margin.top), bottom: twips(margin.bottom), left: twips(margin.left), right: twips(margin.right) } } },
        headers: headerOf(options.headerText, mark),
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: footerChildren })] }) },
        children: childrenOf(blocks),
      },
    ],
  });
  const written = await Packer.toBuffer(document);
  const stamp = W3CDTF(issuedAt);
  return normalizeZip(new Uint8Array(written), {
    replace: {
      'docProps/core.xml': (text) => text.replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/, `$1${stamp}$2`).replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${stamp}$2`),
    },
  });
}

// ---- reading back (golden tests, and the check of an issued copy) ----------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] as string);

/** The text of the paragraphs of the body of a Word document, in order (table cells included, one paragraph per entry), with page breaks as the entry `\f`. */
export function readDocxParagraphs(bytes: Uint8Array): string[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (file) => file.name === 'word/document.xml' });
  } catch {
    throw new DomainError('TEMPLATE_INVALID', 422, 'docx');
  }
  const xml = entries['word/document.xml'];
  if (xml === undefined) throw new DomainError('TEMPLATE_INVALID', 422, 'docx');
  const paragraphs: string[] = [];
  for (const match of new TextDecoder().decode(xml).matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const body = match[0];
    const text = [...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:br w:type="page"\/>|<w:tab\/>/g)].map((part) => (part[0].startsWith('<w:br') ? '\f' : part[0] === '<w:tab/>' ? '\t' : decode(part[1] ?? ''))).join('');
    paragraphs.push(text);
  }
  return paragraphs;
}

/** The text of the header and footer parts of a Word document (one entry per paragraph, headers first), for the check that a demo copy carries its mark on every page. */
export function readDocxHeaderFooter(bytes: Uint8Array): { headers: string[]; footers: string[] } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (file) => /^word\/(header|footer)\d*\.xml$/.test(file.name) });
  } catch {
    throw new DomainError('TEMPLATE_INVALID', 422, 'docx');
  }
  const out: { headers: string[]; footers: string[] } = { headers: [], footers: [] };
  for (const name of Object.keys(entries).sort()) {
    const xml = new TextDecoder().decode(entries[name] as Uint8Array);
    const target = name.includes('header') ? out.headers : out.footers;
    for (const match of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) target.push([...match[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((part) => decode(part[1] as string)).join(''));
  }
  return out;
}
