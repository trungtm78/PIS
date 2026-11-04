import { DomainError } from './errors.ts';
import { fundingCells, fundingTotals, negativeDeltaExplanation } from './dis-report.ts';
import type { BudgetLevel, FundingBucket, FundingInput, RawFundingLine } from './dis-report.ts';
import { progressOf } from './dis-progress.ts';
import type { ProgressInput, RawProgress } from './dis-progress.ts';
import type { TabularFile } from './tabular-file.ts';

/**
 * The layout of the weekly report workbook (ST-DIS-008, DIS 3 F1 "bulk entry"): one row per project, the six cells of cumulative disbursement with the CTMTQG inside the four sources that have
 * it, the volumes, and the explanation of a fall. Only the synthetic template is known until the real workbook of the Treasury and the investors is sampled (D04): its name travels with every file
 * as `mapping_version`, so a later layout is a new name and an old file is still read the way it was.
 */
export const REPORT_IMPORT_MAPPINGS = ['DIS-WEEKLY-1'] as const;
export type ReportImportMapping = (typeof REPORT_IMPORT_MAPPINGS)[number];

/** The cells of a row in the order of the form, with the column of the amount and the column of its CTMTQG (none for the sources that have no CTMTQG). */
const CELL_COLUMNS: ReadonlyArray<{ bucket: FundingBucket; level: BudgetLevel; cumulative: string; ctmtqg: string | null }> = [
  { bucket: 'CURRENT_YEAR', level: 'CENTRAL', cumulative: 'cy_central', ctmtqg: 'cy_central_ctmtqg' },
  { bucket: 'CURRENT_YEAR', level: 'LOCAL', cumulative: 'cy_local', ctmtqg: 'cy_local_ctmtqg' },
  { bucket: 'CARRYOVER', level: 'CENTRAL', cumulative: 'co_central', ctmtqg: 'co_central_ctmtqg' },
  { bucket: 'CARRYOVER', level: 'LOCAL', cumulative: 'co_local', ctmtqg: 'co_local_ctmtqg' },
  { bucket: 'OTHER', level: 'CENTRAL', cumulative: 'other_central', ctmtqg: null },
  { bucket: 'OTHER', level: 'LOCAL', cumulative: 'other_local', ctmtqg: null },
];
const PROJECT_COLUMN = 'project_code';
const TOTAL_COLUMN = 'total_cumulative_vnd';
const EXPLANATION_COLUMN = 'negative_delta_explanation';
const PROGRESS_COLUMNS = ['construction_vnd', 'acceptance_vnd', 'treasury_submitted_vnd', 'preparing_dossier_vnd', 'physical_progress_pct'] as const;

/** The columns a file has to carry; the others are optional. */
export const REQUIRED_COLUMNS: readonly string[] = [PROJECT_COLUMN, ...CELL_COLUMNS.map((cell) => cell.cumulative)];

/** The codes with which a row is refused, for the screen to say in words. */
export const IMPORT_FAULTS = {
  projectRequired: 'PROJECT_CODE_REQUIRED',
  projectDuplicate: 'PROJECT_DUPLICATE_IN_FILE',
  amountInvalid: 'AMOUNT_INVALID',
  subsetExceeds: 'SUBSET_EXCEEDS_PARENT',
  totalMismatch: 'TOTAL_MISMATCH',
  volumesInvalid: 'VOLUMES_INVALID',
  explanationInvalid: 'EXPLANATION_INVALID',
  projectNotFound: 'PROJECT_NOT_FOUND',
  projectStage: 'PROJECT_STAGE_INVALID',
  planNotEffective: 'PLAN_VERSION_NOT_EFFECTIVE',
  reportExists: 'REPORT_STATE_INVALID',
  periodType: 'PERIOD_TYPE_INVALID',
} as const;

/** A row of the file as it will be applied: the project it is about, the six cells, the volumes when given and the explanation of a fall. */
export interface ImportRow {
  line: number;
  projectCode: string;
  cells: FundingInput[];
  progress: ProgressInput | undefined;
  explanation: string | null;
}

/** Why a row is refused: the line of the file, the project it names, the column and a stable code. Nothing is skipped without one. */
export interface RowFault {
  line: number;
  projectCode: string | null;
  field: string;
  code: string;
}

export interface ParsedImport {
  totalRows: number;
  /** The rows that are in order, as they will be applied. */
  rows: ImportRow[];
  /** Every fault of every row, by line; a row may have several. */
  faults: RowFault[];
}

/** How many rows have a fault: a row with two is one. */
export const faultedRowsOf = (faults: readonly RowFault[]): number => new Set(faults.map((fault) => fault.line)).size;

export function mappingOf(mappingVersion: string): ReportImportMapping {
  const known = REPORT_IMPORT_MAPPINGS.find((mapping) => mapping === mappingVersion);
  if (known === undefined) throw new DomainError('MAPPING_VERSION_UNKNOWN', 422, 'mapping_version');
  return known;
}

/** The column the server named in `funding_lines[i].member` as the file calls it. */
function columnOf(detail: string | undefined, cell: (typeof CELL_COLUMNS)[number]): string {
  return detail?.endsWith('ctmtqg_subset_vnd') === true && cell.ctmtqg !== null ? cell.ctmtqg : cell.cumulative;
}

/**
 * Reads the workbook as the mapping says and judges every row on its own: the amounts are whole dong, the CTMTQG is inside its cell, the total column (when given) is the sum of the six cells, the volumes
 * come all together, a project is named once. The rows that are in order are returned for the apply; every fault of the others is returned with its line and column (422 `IMPORT_SCHEMA_INVALID` when a
 * column the layout needs is not in the file, 422 `MAPPING_VERSION_UNKNOWN` for a layout that is not known). Whether a project exists, may be reported on and has a plan is for the store.
 */
export function parseReportImport(mappingVersion: string, table: TabularFile): ParsedImport {
  mappingOf(mappingVersion);
  const names = table.headers.map((header) => header.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !names.includes(column));
  if (missing.length > 0) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions: { missing_columns: missing } });
  const at = (cells: readonly string[], column: string): string | undefined => {
    const index = names.indexOf(column);
    const value = index < 0 ? undefined : cells[index]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };

  const occurrences = new Map<string, number>();
  for (const cells of table.rows) {
    const code = at(cells, PROJECT_COLUMN);
    if (code !== undefined) occurrences.set(code, (occurrences.get(code) ?? 0) + 1);
  }

  const rows: ImportRow[] = [];
  const faults: RowFault[] = [];
  table.rows.forEach((cells, index) => {
    const line = table.lines[index] ?? index + 2;
    const projectCode = at(cells, PROJECT_COLUMN);
    const found: RowFault[] = [];
    const fault = (field: string, code: string): void => void found.push({ line, projectCode: projectCode ?? null, field, code });
    if (projectCode === undefined) fault(PROJECT_COLUMN, IMPORT_FAULTS.projectRequired);
    else if ((occurrences.get(projectCode) ?? 0) > 1) fault(PROJECT_COLUMN, IMPORT_FAULTS.projectDuplicate);

    let cellFaulted = false;
    const entered: FundingInput[] = CELL_COLUMNS.map((cell) => {
      const raw: RawFundingLine = { bucket: cell.bucket, budget_level: cell.level, cumulative_vnd: at(cells, cell.cumulative) ?? '0' };
      const subset = cell.ctmtqg === null ? undefined : at(cells, cell.ctmtqg);
      if (subset !== undefined) raw.ctmtqg_subset_vnd = subset;
      try {
        return fundingCells([raw]).find((entry) => entry.bucket === cell.bucket && entry.budgetLevel === cell.level) as FundingInput;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        cellFaulted = true;
        fault(columnOf(error.detail, cell), error.code === 'SUBSET_EXCEEDS_PARENT' ? IMPORT_FAULTS.subsetExceeds : IMPORT_FAULTS.amountInvalid);
        return { bucket: cell.bucket, budgetLevel: cell.level, cumulativeVnd: '0', ctmtqgVnd: null, nextMonthVnd: '0', nextMonthCtmtqgVnd: null, sourceYear: null };
      }
    });

    const total = at(cells, TOTAL_COLUMN);
    // The total is compared with what was read: a cell that could not be read has no figure to add.
    if (total !== undefined && !cellFaulted) {
      if (total !== fundingTotals(entered).cumulativeVnd) fault(TOTAL_COLUMN, IMPORT_FAULTS.totalMismatch);
    }

    let progress: ProgressInput | undefined;
    const rawProgress: RawProgress = {};
    for (const column of PROGRESS_COLUMNS) {
      const value = at(cells, column);
      if (value !== undefined) rawProgress[column] = value;
    }
    try {
      progress = progressOf(rawProgress);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      fault(error.detail ?? PROGRESS_COLUMNS[0], IMPORT_FAULTS.volumesInvalid);
    }

    let explanation: string | null = null;
    try {
      explanation = negativeDeltaExplanation(at(cells, EXPLANATION_COLUMN));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      fault(EXPLANATION_COLUMN, IMPORT_FAULTS.explanationInvalid);
    }

    if (found.length > 0 || projectCode === undefined) faults.push(...found);
    else rows.push({ line, projectCode, cells: entered, progress, explanation });
  });
  return { totalRows: table.rows.length, rows, faults };
}
