import ExcelJS from 'exceljs';
import { NARRATIVE_IMPORT_COLUMNS, message } from '@machvon/kernel';

const FIXED_DATE = new Date(Date.UTC(2026, 10, 9, 0, 0, 0));
const FONT = 'Times New Roman';
const NARRATIVE_COLUMN_WIDTH = 42;

export const NARRATIVE_TEMPLATE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface NarrativeTemplateInput {
  /** The projects to prefill, by code; none gives a template with the header alone. */
  projects: ReadonlyArray<{ code: string; name: string }>;
  causes: ReadonlyArray<{ code: string; label: string }>;
}

/**
 * The Excel template for the narratives of a period (CN.02). The first sheet is what the import reads: the header row carries the names of the columns (the project code, the eight fields, the codes of the standard
 * causes) and a row per project; a column the import does not know is ignored, so the name of the project can sit beside its code. The second sheet lists the codes of the standard causes with their names and the
 * third explains the columns, in Vietnamese (the words are in the messages of the kernel). The import judges the whole file first (dry run) and applies it only without a fault.
 */
export async function buildNarrativeTemplate(input: NarrativeTemplateInput): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MACHVON';
  workbook.lastModifiedBy = 'MACHVON';
  workbook.created = FIXED_DATE;
  workbook.modified = FIXED_DATE;
  const sheet = workbook.addWorksheet(message('ent.narrative.template.sheet'), { views: [{ state: 'frozen', ySplit: 1 }] });
  const columns = [...NARRATIVE_IMPORT_COLUMNS, 'project_name'];
  sheet.addRow(columns);
  sheet.getRow(1).font = { name: FONT, bold: true, size: 12 };
  columns.forEach((name, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = name === 'project_code' || name === 'cause_codes' ? 22 : name === 'project_name' ? 36 : NARRATIVE_COLUMN_WIDTH;
    column.alignment = { vertical: 'top', wrapText: true };
  });
  input.projects.forEach((project, index) => {
    const row = sheet.getRow(index + 2);
    row.getCell(1).value = project.code;
    row.getCell(columns.length).value = project.name;
  });
  const causes = workbook.addWorksheet(message('ent.narrative.template.causes_sheet'));
  causes.addRow(['code', 'label']);
  causes.getRow(1).font = { name: FONT, bold: true, size: 12 };
  causes.getColumn(1).width = 28;
  causes.getColumn(2).width = 60;
  for (const cause of input.causes) causes.addRow([cause.code, cause.label]);
  const help = workbook.addWorksheet(message('ent.narrative.template.help_sheet'));
  help.getColumn(1).width = 120;
  for (const line of message('ent.narrative.template.help').split('\n')) help.addRow([line]);
  const written = await workbook.xlsx.writeBuffer();
  return new Uint8Array(written as ArrayBuffer);
}
