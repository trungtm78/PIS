import { scaledMoney } from './dis-export.ts';
import type { ExportDocument } from './dis-export.ts';
import { DomainError } from './errors.ts';
import { message } from './messages.ts';
import type { MneFieldKind, MneReportStatus } from './mne-report.ts';

/**
 * The export package of an issued monitoring report (ST-MNE-004, MNE 3.1 F3, BR-MNE-05): the files a person files by hand with the recipient, with the receipt written down afterwards. No call goes to the national
 * system from here: the adapter is only the label of how far the way to it is (CXN-05). The rules of the files and of the receipt are here, with no store or clock of their own.
 */
export const MNE_EXPORT_TARGETS = ['NATIONAL_PIM_SYSTEM', 'RECIPIENT_AGENCY', 'LGSP'] as const;
export type MneExportTarget = (typeof MNE_EXPORT_TARGETS)[number];

export const MNE_EXPORT_FORMATS = ['XLSX', 'PDF', 'XML', 'CSV'] as const;
export type MneExportFormat = (typeof MNE_EXPORT_FORMATS)[number];

/** The formats this release makes: the XML of the national system has no specification yet (CXN-05), so it is refused, not guessed. */
export const MNE_GENERATED_FORMATS: readonly MneExportFormat[] = ['XLSX', 'PDF', 'CSV'];

export const MNE_PACKAGE_STATUSES = ['GENERATED', 'DOWNLOADED', 'SUBMISSION_CONFIRMED', 'REJECTED', 'EXPIRED'] as const;
export type MnePackageStatus = (typeof MNE_PACKAGE_STATUSES)[number];

/** The connector of the integration settings that stands for the way to each target: its adapter status is what the package says about the way (VERIFIED, PROPOSED, MOCK or MISSING). */
export const MNE_EXPORT_CONNECTORS: Readonly<Record<MneExportTarget, string>> = {
  NATIONAL_PIM_SYSTEM: 'NATIONAL_PIM_FILE',
  RECIPIENT_AGENCY: 'RECIPIENT_AGENCY_FILE',
  LGSP: 'LGSP_FILE',
};

/** How long a file that nobody filed stays offered. */
export const MNE_PACKAGE_EXPIRY_DAYS = 90;

/** What a file says while the legal basis of its form is not confirmed and the form names no text of its own (BR-MNE-01): it is never a file that looks final. */
export const UNCONFIRMED_WATERMARK = message('mne.export.watermark.unconfirmed');

/** The notice of a file: the watermark of the form while it waits for its confirmation (or the plain words when it names none), nothing once it is confirmed. */
export function exportWatermark(form: { legalConfirmationRef: string | null; watermarkText: string | null }): string | null {
  if (form.legalConfirmationRef !== null) return null;
  return form.watermarkText === null || form.watermarkText.trim() === '' ? UNCONFIRMED_WATERMARK : form.watermarkText;
}

/** A report is exported only once DOC has issued it (409 REPORT_NOT_ISSUED naming the state), and not after DOC recalled what it issued. */
export function assertExportable(report: { status: MneReportStatus; recalledAt: string | null }): void {
  if (!(['ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL'] as const).includes(report.status as 'ISSUED') || report.recalledAt !== null) {
    throw new DomainError('REPORT_NOT_ISSUED', 409, 'status', { extensions: { report_status: report.status, recalled: report.recalledAt !== null } });
  }
}

/** The formats asked for: each one of the four, none twice, and each one this release makes (422 EXPORT_FORMAT_UNSUPPORTED naming it) and that the form allows. */
export function checkedFormats(asked: readonly string[], allowed: readonly string[]): MneExportFormat[] {
  const seen = new Set<string>();
  for (const [index, format] of asked.entries()) {
    if (!(MNE_EXPORT_FORMATS as readonly string[]).includes(format) || seen.has(format)) throw new DomainError('VALIDATION_FAILED', 422, `formats[${index}]`);
    if (!MNE_GENERATED_FORMATS.includes(format as MneExportFormat) || !allowed.includes(format)) throw new DomainError('EXPORT_FORMAT_UNSUPPORTED', 422, `formats[${index}]`, { extensions: { format } });
    seen.add(format);
  }
  return [...seen] as MneExportFormat[];
}

export interface MneExportCell {
  label: string;
  kind: MneFieldKind;
  value: string | number | null;
  /** Where a locked cell comes from, as a short text; empty for a cell written by hand. */
  source: string;
}

export interface MneExportInput {
  formCode: string;
  formRevision: number;
  formTitle: string;
  periodLabel: string;
  unitCode: string;
  unitName: string;
  dueDate: string;
  asOfDate: string | null;
  payloadSha256: string | null;
  documentId: string | null;
  /** The watermark of a form that waits for the confirmation of its legal basis (BR-MNE-01); null once it is confirmed. */
  watermark: string | null;
  cells: readonly MneExportCell[];
}

const COLUMNS = [
  { key: 'label', label: message('mne.export.column.label'), numeric: false },
  { key: 'value', label: message('mne.export.column.value'), numeric: false },
  { key: 'unit', label: message('mne.export.column.unit'), numeric: false },
  { key: 'source', label: message('mne.export.column.source'), numeric: false },
] as const;

/** A cell the way the file writes it: money in million dong (the national forms count in millions) with the unit named, a rate with its percent sign, a count and a text as they are, an empty cell as nothing. */
export function exportedCell(cell: MneExportCell): { value: string; unit: string } {
  if (cell.value === null) return { value: '', unit: '' };
  const text = String(cell.value);
  switch (cell.kind) {
    case 'MONEY':
      return { value: scaledMoney(text, 'MILLION_VND'), unit: message('mne.export.unit.million_dong') };
    case 'PERCENT':
      return { value: text, unit: '%' };
    case 'INTEGER':
      return { value: text, unit: '' };
    case 'TEXT':
      return { value: text, unit: '' };
  }
}

/** The document the three formats are made from: the head of the report, one row per cell of its form, and the watermark as the notice while the legal basis is not confirmed. */
export function mneExportDocument(input: MneExportInput): ExportDocument {
  const header = [
    { key: 'form', label: message('mne.export.header.form'), value: message('mne.export.header.form_value', { code: input.formCode, revision: input.formRevision }) },
    { key: 'period', label: message('mne.export.header.period'), value: input.periodLabel },
    { key: 'unit', label: message('mne.export.header.unit'), value: `${input.unitName} (${input.unitCode})` },
    { key: 'due_date', label: message('mne.export.header.due_date'), value: input.dueDate },
    ...(input.asOfDate === null ? [] : [{ key: 'as_of_date', label: message('mne.export.header.as_of_date'), value: input.asOfDate }]),
    ...(input.payloadSha256 === null ? [] : [{ key: 'payload_sha256', label: message('mne.export.header.payload_sha256'), value: input.payloadSha256 }]),
    ...(input.documentId === null ? [] : [{ key: 'document_id', label: message('mne.export.header.document_id'), value: input.documentId }]),
  ];
  return {
    title: input.formTitle,
    header,
    columns: COLUMNS,
    rows: input.cells.map((cell) => {
      const written = exportedCell(cell);
      return [cell.label, written.value, written.unit, cell.source];
    }),
    notice: input.watermark,
  };
}

/** The filing is late when the day it was made (Vietnam time, as the person says it) is after the due date of the report. */
export function filedLate(dueDate: string, submittedAt: string): boolean {
  const filed = new Date(Date.parse(submittedAt) + 7 * 3_600_000).toISOString().slice(0, 10);
  return filed > dueDate;
}
