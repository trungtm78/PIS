import type { ExportColumn, ExportDocument } from './dis-export.ts';

/**
 * The file of the figures of the command center (G0-4: "kiểm đối chiếu web, di động, Excel"): one row for each indicator of the register, with the text of the value exactly as the screen and the phone write it
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
  { key: 'metric_code', label: 'Mã chỉ tiêu', numeric: false },
  { key: 'name', label: 'Tên chỉ tiêu', numeric: false },
  { key: 'display_value', label: 'Giá trị', numeric: true },
  { key: 'unit', label: 'Đơn vị', numeric: false },
  { key: 'numerator', label: 'Tử số', numeric: true },
  { key: 'denominator', label: 'Mẫu số', numeric: true },
  { key: 'null_reason', label: 'Lý do chưa có số', numeric: false },
  { key: 'flags', label: 'Cờ chất lượng', numeric: false },
  { key: 'certification', label: 'Chứng nhận', numeric: false },
  { key: 'definition_version', label: 'Phiên bản định nghĩa', numeric: true },
  { key: 'as_of_date', label: 'Số liệu đến ngày', numeric: false },
  { key: 'formula', label: 'Công thức', numeric: false },
  { key: 'source', label: 'Nguồn', numeric: false },
  { key: 'owner', label: 'Đơn vị chịu trách nhiệm', numeric: false },
];

const orEmpty = (value: string | null): string => value ?? '';

export function buildHomeExportDocument(input: HomeExportInput): ExportDocument {
  const entry = (key: string, label: string, value: string): { key: string; label: string; value: string } => ({ key, label, value });
  return {
    title: 'Chỉ tiêu trung tâm điều hành',
    header: [
      entry('scope', 'Phạm vi', input.scopeText),
      entry('snapshot_id', 'Ảnh chụp số liệu', input.snapshotId),
      entry('as_of_date', 'Số liệu đến ngày', input.asOfDate),
      entry('treasury_cutoff_date', 'Ngày chốt số Kho bạc', input.treasuryCutoffDate),
      entry('definition_status', 'Tình trạng định nghĩa', input.definitionStatus),
      entry('created_at', 'Giờ lập tệp', input.createdAt.toISOString()),
      entry('row_count', 'Số dòng', String(input.rows.length)),
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
    notice: input.definitionStatus === 'SIGNED' ? null : 'Các công thức là đề xuất, đang chờ chủ nghiệp vụ ký xác nhận: số trong tệp chưa phải số điều hành.',
  };
}
