import { periodRange, previewOf, formDocumentOf } from '@machvon/kernel';
import type { FilledGrid, FilledNarrative, NarrativeBlock, ReportDocument, ReportFillData, ReportLayout, ReportPreview } from '@machvon/kernel';
import { renderDocx } from './docx-render';
import { reportPdfOf } from './report-pdf';
import { fillXlsxTemplate } from './xlsx-template';

/**
 * Fills a form for one period (RPT-1 part 2, ENT-4b): the form is filled ONCE into a `ReportDocument` (the grid and the narrative, R26) and the three writers read that one document: the workbook from the template and the grid,
 * the Word file from the narrative (tokens resolved by the same figures as the grid), the PDF from the sheet of the document and the narrative. The document dates are the last day of the period (not the clock), so the same
 * layout, template and data always give the same bytes and the same sha256: that is what lets a repeat of the same report be recognised (a DUPLICATE, not a new revision) and what lets an auditor regenerate a copy and compare.
 */
export interface RenderInput {
  layout: ReportLayout;
  narrative: readonly NarrativeBlock[] | null;
  xlsxTemplate: Uint8Array;
  data: ReportFillData;
  creator: string;
}

export interface RenderedReport {
  xlsx: Uint8Array;
  docx: Uint8Array | null;
  pdf: Uint8Array;
  document: ReportDocument;
  grid: FilledGrid;
  narrative: FilledNarrative | null;
  /** The hash of the layout (and narrative skeleton) the files were made from. */
  layoutSha256: string;
  preview: ReportPreview;
  /** What the grid and the narrative could not give, for the copy to carry: cell or token, the code of the reason, the detail. */
  issues: Array<{ ref: string; code: string; detail: string | null }>;
}

export async function renderReport(input: RenderInput): Promise<RenderedReport> {
  const document = formDocumentOf(input.layout, input.narrative, input.data);
  const { grid, narrative } = document;
  const issuedAt = new Date(`${periodRange(input.data.period).to}T00:00:00Z`);
  const xlsx = await fillXlsxTemplate(input.xlsxTemplate, grid, { issuedAt, creator: input.creator });
  const docx = narrative === null ? null : await renderDocx(narrative.blocks, { title: input.layout.name, creator: input.creator, issuedAt, stamp: grid.stamp, headerText: input.layout.name });
  const { bytes: pdf } = await reportPdfOf(document, { issuedAt, creator: input.creator });
  const issues = [...grid.issues.map((one) => ({ ref: one.ref, code: one.code, detail: one.detail })), ...(narrative?.issues ?? []).map((one) => ({ ref: one.token, code: one.code, detail: null }))];
  return { xlsx, docx, pdf, document, grid, narrative, layoutSha256: document.layoutSha256, preview: previewOf(grid, narrative), issues };
}
