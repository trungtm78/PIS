import type { ExportColumn, ExportDocument } from './dis-export.ts';
import { message } from './messages.ts';

/**
 * The file of the figures of the command center (G0-4: "cross-check of web, mobile and Excel"): one row for each indicator of the register, with the text of the value exactly as the screen and the phone write it
 * (`display_value` of the API), the numerator and denominator, why there is no figure when there is none, the flags that sit on the number, the certification, and the definition (version, formula, source, owner, day it
 * is as of). The cells are the same strings the API gives: nothing here rounds or reformats a figure, so the three channels cannot differ by a last digit. A figure that is not there is an empty cell and a reason, never 0.
 */
export interface HomeFigureRow {
  code: string;
  name: string;
  /** `display_value` of the API: the text of the figure as every channel writes it, null when there is none. */
  displayValue: string | null;
  unit: string;
  numerator: string | null;
  denominator: string | null;
  nullReason: string | null;
  flags: readonly string[];
  certification: string;
  definitionVersion: number;
  asOfDate: string;
  formula: string;
  source: string;
  owner: string;
}

export interface HomeExportInput {
  snapshotId: string;
  asOfDate: string;
  treasuryCutoffDate: string;
  definitionStatus: string;
  scopeText: string;
  createdAt: Date;
  rows: readonly HomeFigureRow[];
}

export const HOME_EXPORT_COLUMNS: readonly ExportColumn[] = [
  { key: 'metric_code', label: message('home.export.home_export_columns.label.metric_code'), numeric: false },
  { key: 'name', label: message('home.export.home_export_columns.label.name'), numeric: false },
  { key: 'display_value', label: message('home.export.home_export_columns.label.display_value'), numeric: true },
  { key: 'unit', label: message('home.export.home_export_columns.label.unit'), numeric: false },
  { key: 'numerator', label: message('home.export.home_export_columns.label.numerator'), numeric: true },
  { key: 'denominator', label: message('home.export.home_export_columns.label.denominator'), numeric: true },
  { key: 'null_reason', label: message('home.export.home_export_columns.label.null_reason'), numeric: false },
  { key: 'flags', label: message('home.export.home_export_columns.label.flags'), numeric: false },
  { key: 'certification', label: message('home.export.home_export_columns.label.certification'), numeric: false },
  { key: 'definition_version', label: message('home.export.home_export_columns.label.definition_version'), numeric: true },
  { key: 'as_of_date', label: message('home.export.home_export_columns.label.as_of_date'), numeric: false },
  { key: 'formula', label: message('home.export.home_export_columns.label.formula'), numeric: false },
  { key: 'source', label: message('home.export.home_export_columns.label.source'), numeric: false },
  { key: 'owner', label: message('home.export.home_export_columns.label.owner'), numeric: false },
];

const orEmpty = (value: string | null): string => value ?? '';

export function buildHomeExportDocument(input: HomeExportInput): ExportDocument {
  const entry = (key: string, label: string, value: string): { key: string; label: string; value: string } => ({ key, label, value });
  return {
    title: message('home.export.build_home_export_document.title'),
    header: [
      entry('scope', message('home.export.build_home_export_document.header'), input.scopeText),
      entry('snapshot_id', message('home.export.build_home_export_document.header_2'), input.snapshotId),
      entry('as_of_date', message('home.export.home_export_columns.label.as_of_date'), input.asOfDate),
      entry('treasury_cutoff_date', message('home.export.build_home_export_document.header_3'), input.treasuryCutoffDate),
      entry('definition_status', message('home.export.build_home_export_document.header_4'), input.definitionStatus),
      entry('created_at', message('home.export.build_home_export_document.header_5'), input.createdAt.toISOString()),
      entry('row_count', message('home.export.build_home_export_document.header_6'), String(input.rows.length)),
    ],
    columns: HOME_EXPORT_COLUMNS,
    rows: input.rows.map((row) => [
      row.code,
      row.name,
      orEmpty(row.displayValue),
      row.unit,
      orEmpty(row.numerator),
      orEmpty(row.denominator),
      orEmpty(row.nullReason),
      row.flags.join(';'),
      row.certification,
      String(row.definitionVersion),
      row.asOfDate,
      row.formula,
      row.source,
      row.owner,
    ]),
    notice: input.definitionStatus === 'SIGNED' ? null : message('home.export.build_home_export_document.notice'),
  };
}
