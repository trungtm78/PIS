import { fillGrid, fillNarrative, periodRange, previewOf } from '@machvon/kernel';
import type { FilledGrid, FilledNarrative, NarrativeBlock, ReportFillData, ReportLayout, ReportPreview } from '@machvon/kernel';
import { renderDocx } from './docx-render';
import { fillXlsxTemplate } from './xlsx-template';

/**
 * Fills a form for one period (RPT-1 part 2): the grid from the layout and the data, the workbook from the template and the grid, and, for a form with a narrative part, the Word document from the narrative blocks
 * with their tokens resolved by the same figures as the grid. The document dates are the last day of the period (not the clock), so the same layout, template and data always give the same bytes and the same
 * sha256: that is what lets a repeat of the same report be recognised (a DUPLICATE, not a new revision) and what lets an auditor regenerate a copy and compare.
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
  grid: FilledGrid;
  narrative: FilledNarrative | null;
  preview: ReportPreview;
  /** What the grid and the narrative could not give, for the copy to carry: cell or token, the code of the reason, the detail. */
  issues: Array<{ ref: string; code: string; detail: string | null }>;
}

export async function renderReport(input: RenderInput): Promise<RenderedReport> {
  const grid = fillGrid(input.layout, input.data);
  const issuedAt = new Date(`${periodRange(input.data.period).to}T00:00:00Z`);
  const xlsx = await fillXlsxTemplate(input.xlsxTemplate, grid, { issuedAt, creator: input.creator });
  let narrative: FilledNarrative | null = null;
  let docx: Uint8Array | null = null;
  if (input.narrative !== null) {
    narrative = fillNarrative(input.narrative, input.data, input.layout.moneyScale);
    docx = await renderDocx(narrative.blocks, { title: input.layout.name, creator: input.creator, issuedAt, stamp: grid.stamp, headerText: input.layout.name });
  }
  const issues = [...grid.issues.map((one) => ({ ref: one.ref, code: one.code, detail: one.detail })), ...(narrative?.issues ?? []).map((one) => ({ ref: one.token, code: one.code, detail: null }))];
  return { xlsx, docx, grid, narrative, preview: previewOf(grid, narrative), issues };
}
