import ExcelJS from 'exceljs';
import type { ReportLayout } from '@machvon/kernel';
import { normalizeZip } from './zip-normalize';

const FIXED_DATE = new Date(Date.UTC(2026, 10, 8, 0, 0, 0));
const FONT = 'Times New Roman';

/**
 * The Excel template of a generic form of the system (RPT-1 part 2): one sheet named as the layout says, the widths of its columns, A4 portrait fitted to one page wide. The layout writes the header itself
 * (`headerMode: WRITE`), so the template holds no words; a customer's own form is a template file made by the customer and read as it is. Deterministic: fixed dates and a normalised zip, so the same layout always gives
 * the same bytes (and the same sha256 in the register of template files).
 */
export async function buildBlankTemplate(layout: ReportLayout): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MACHVON';
  workbook.lastModifiedBy = 'MACHVON';
  workbook.created = FIXED_DATE;
  workbook.modified = FIXED_DATE;
  workbook.title = layout.name;
  const sheet = workbook.addWorksheet(layout.sheetName, { views: [{ showGridLines: false }] });
  for (const column of layout.columns) {
    const target = sheet.getColumn(column.col);
    target.width = column.width ?? 14;
    target.font = { name: FONT, size: 12 };
  }
  sheet.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  const written = await workbook.xlsx.writeBuffer();
  return normalizeZip(new Uint8Array(written as ArrayBuffer));
}
