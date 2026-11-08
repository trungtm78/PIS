import { message } from '@machvon/kernel';
import type { ExportDocument, NarrativeBlock } from '@machvon/kernel';
import { renderDocx } from './docx-render';

/** The media type of a Word document (what the object store and the download say). */
export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** More columns than this and the page is turned on its side and the type is made smaller: a wide table is read across, not folded. */
const PORTRAIT_COLUMNS = 6;
const WIDE_FONT_PT = 9;
const NARROW_FONT_PT = 11;
/** What a column needs, by the width of its words, as the PDF of the same document weighs them; a column that is not named takes the default. */
const WEIGHTS: Readonly<Record<string, number>> = { label: 2.4, value: 3.2, unit: 1, source: 1.8, project_code: 1.1, project_name: 2.2, unit_code: 1, unit_name: 1.6, bucket: 1.1, budget_level: 0.9, rate_null_reason: 1.4, treasury_coverage: 0.9 };
const DEFAULT_WEIGHT = 1.2;
const CREATOR = 'MACHVON';

export interface ExportDocxOptions {
  /** The mark a document that is not an official one carries on every page; none for an official one. */
  stamp?: string | null | undefined;
  /** The text of the header of every page; the title of the document when not given. */
  headerText?: string | undefined;
}

/**
 * The Word rendering of an export document (IAM-2): the same document that the CSV, the workbook and the PDF are made from, so that a figure of the Word file cannot differ from one of the other files. The title is the heading, the
 * header entries (the scope, the period, the cut-off day, the hash of the snapshot) are a two-column table, the notice that says the definitions are not signed is an italic line, and the table of the rows follows; with more
 * than six columns the page is landscape and the type smaller. The bytes depend on the document alone (no time of the moment is written into the file), so the same document gives the same bytes and the same sha256.
 */
export async function docxOf(document: ExportDocument, options: ExportDocxOptions = {}): Promise<Uint8Array> {
  const wide = document.columns.length > PORTRAIT_COLUMNS;
  const blocks: NarrativeBlock[] = [{ type: 'HEADING', level: 1, text: document.title }];
  if (document.header.length > 0) blocks.push({ type: 'TABLE', header: [message('export.docx.header.name'), message('export.docx.header.value')], rows: document.header.map((entry) => [entry.label, entry.value]), widths: [1, 2] });
  if (document.notice !== null) blocks.push({ type: 'PARAGRAPH', text: document.notice, italic: true, align: 'LEFT' });
  if (document.columns.length > 0) {
    blocks.push({ type: 'TABLE', header: document.columns.map((column) => column.label), rows: document.rows, widths: document.columns.map((column) => WEIGHTS[column.key] ?? DEFAULT_WEIGHT) });
    if (document.rows.length === 0) blocks.push({ type: 'PARAGRAPH', text: message('export.docx.no_rows'), italic: true, align: 'LEFT' });
  }
  return renderDocx(blocks, {
    title: document.title,
    creator: CREATOR,
    headerText: options.headerText ?? document.title,
    footerText: message('export.docx.footer'),
    stamp: options.stamp ?? null,
    fontSizePt: wide ? WIDE_FONT_PT : NARROW_FONT_PT,
    page: { orientation: wide ? 'LANDSCAPE' : 'PORTRAIT', marginMm: wide ? { top: 15, bottom: 15, left: 15, right: 15 } : { top: 20, bottom: 20, left: 25, right: 15 } },
  });
}
