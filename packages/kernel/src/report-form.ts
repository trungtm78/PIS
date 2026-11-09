import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import type { Edition } from './edition.ts';
import { assertReportPeriod, groupDigits } from './report-layout.ts';
import type { FilledGrid, FilledNarrative, FormPeriod, FormPeriodKind, GridCellKind, LayoutRowKind, NarrativeBlock, ReportFillData, ReportLayout } from './report-layout.ts';

/**
 * What the report engine needs to know about a form that is not in the layout itself (RPT-1 part 2): which edition offers it, who receives it, which period kind it is for, where its figures come from and where its
 * template files are. A bundle is registered by the process (the public forms by the API, the enterprise forms by the server entry of the enterprise package, through the enterprise seam), registered for a tenant when
 * someone first generates it (the layout and the template are copied into the tenant's own rows and never change), and read from there afterwards.
 *
 * The figures come from one of two sources: LIVE (the indicators of the KPI register, read by a provider of the API: for the public weekly report the command center, for the enterprise forms the funding model of FND-1 when
 * it lands) or ILLUSTRATIVE (invented data of a DEMO form, labelled so: the form shows what it will look like and its copy is never accepted, R18).
 */
export type ReportDataSourceKind = 'LIVE' | 'ILLUSTRATIVE';
export const REPORT_FILE_FORMATS = ['XLSX', 'DOCX'] as const;
export type ReportFileFormat = (typeof REPORT_FILE_FORMATS)[number];

export interface ReportTemplateBytes {
  xlsx: Uint8Array;
  /** The Word skeleton of a form with a narrative part, or null. */
  docx: Uint8Array | null;
}

export interface ReportFormBundle {
  edition: Edition;
  layout: ReportLayout;
  /** The narrative blocks (the Word part), or null for a table-only form. */
  narrative: readonly NarrativeBlock[] | null;
  /** Who receives the form (a code of the receiver: `PVN`, `HPM`...), or `INTERNAL`. */
  receiver: string;
  periodKind: FormPeriodKind;
  dataSource: ReportDataSourceKind;
  /** For a LIVE form, the id of the provider of its figures (the API knows the providers); null for an illustrative one. */
  provider: string | null;
  /** The bytes of the template files, read when the form is registered for a tenant. */
  templates(): Promise<ReportTemplateBytes>;
  /** For an ILLUSTRATIVE form: the invented data of one period. */
  illustrative?: ((period: FormPeriod) => ReportFillData) | undefined;
  /**
   * For an ILLUSTRATIVE form only (ENT-3a): the id of a provider whose figures come from a frozen snapshot of the period. When the provider finds one, the copy is filled from it (its data source is then LIVE and it
   * names the snapshot and its revision) and the form is still a DEMO form with its stamp; when it finds none, the invented data is used exactly as before.
   */
  snapshotProvider?: string | null | undefined;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The digest of what a copy is made of: the hashes of its files, in the order of their format. A copy of one file has the digest of that one line; a copy with a Word narrative has both. It is the `sha256` of the
 * issued copy (R17): the same files give the same digest, so a repeat of the same bytes is recognised (`nextIssueOf`) and a changed word in either file is a new revision.
 */
export function packageDigestOf(files: ReadonlyArray<{ format: ReportFileFormat; sha256: string }>): string {
  if (files.length === 0 || files.some((file) => !SHA256.test(file.sha256) || !(REPORT_FILE_FORMATS as readonly string[]).includes(file.format))) throw new DomainError('VALIDATION_FAILED', 422, 'files');
  const formats = files.map((file) => file.format);
  if (new Set(formats).size !== formats.length) throw new DomainError('VALIDATION_FAILED', 422, 'files');
  const lines = [...files].sort((a, b) => REPORT_FILE_FORMATS.indexOf(a.format) - REPORT_FILE_FORMATS.indexOf(b.format)).map((file) => `${file.format}:${file.sha256}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** A period must be well formed and of the kind the form is for (VALIDATION_FAILED, `period`/`period_kind`). */
export function assertPeriodFitsForm(periodKind: FormPeriodKind, period: FormPeriod): void {
  assertReportPeriod(period);
  if (period.kind !== periodKind) throw new DomainError('VALIDATION_FAILED', 422, 'period_kind');
}

export const REPORT_CHANNELS = ['MANUAL', 'DOWNLOAD', 'EMAIL', 'PORTAL', 'HPM_PUSH'] as const;
export type ReportChannel = (typeof REPORT_CHANNELS)[number];
export const RECEIVER_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

/** A receiver code and a channel the delivery log accepts. */
export function assertDeliveryTarget(receiver: string, channel: string): void {
  if (!RECEIVER_CODE.test(receiver)) throw new DomainError('VALIDATION_FAILED', 422, 'receiver');
  if (!(REPORT_CHANNELS as readonly string[]).includes(channel)) throw new DomainError('VALIDATION_FAILED', 422, 'channel');
}

export interface PreviewCell {
  col: number;
  kind: GridCellKind;
  text: string;
}

export interface PreviewRow {
  row: number;
  kind: LayoutRowKind;
  cells: PreviewCell[];
}

/** What the screen shows of a filled grid before anything is issued: the cells as text (numbers grouped the way the form is read, formulas as written), capped so a huge dataset cannot make a huge answer. */
export interface ReportPreview {
  columns: number;
  rows: PreviewRow[];
  rowCount: number;
  truncated: boolean;
  narrative: string[];
  stamp: string | null;
}

export const PREVIEW_ROW_CAP = 300;
const NARRATIVE_LINE_CAP = 120;

function narrativeLines(blocks: readonly NarrativeBlock[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === 'HEADING' || block.type === 'PARAGRAPH') lines.push(block.text);
    else if (block.type === 'LIST') lines.push(...block.items);
    else if (block.type === 'TABLE') lines.push(...block.rows.map((row) => row.join(' | ')));
    else if (block.type === 'SIGNATURES') lines.push(block.slots.map((slot) => slot.role).join(' | '));
  }
  return lines.filter((line) => line.trim() !== '').slice(0, NARRATIVE_LINE_CAP);
}

export function previewOf(grid: FilledGrid, narrative: FilledNarrative | null = null): ReportPreview {
  const byRow = new Map<number, PreviewCell[]>();
  let columns = 0;
  for (const cell of grid.cells) {
    columns = Math.max(columns, cell.col);
    const text = cell.kind === 'TEXT' ? (cell.text ?? '') : cell.kind === 'NUMBER' ? groupDigits(cell.number ?? '', 'vi') : cell.kind === 'FORMULA' ? `=${cell.formula ?? ''}` : '';
    const row = byRow.get(cell.row) ?? [];
    row.push({ col: cell.col, kind: cell.kind, text });
    byRow.set(cell.row, row);
  }
  const rows: PreviewRow[] = grid.rows.slice(0, PREVIEW_ROW_CAP).map((gridRow) => ({ row: gridRow.row, kind: gridRow.kind, cells: (byRow.get(gridRow.row) ?? []).sort((a, b) => a.col - b.col) }));
  return { columns, rows, rowCount: grid.rows.length, truncated: grid.rows.length > PREVIEW_ROW_CAP, narrative: narrative === null ? [] : narrativeLines(narrative.blocks), stamp: grid.stamp };
}
