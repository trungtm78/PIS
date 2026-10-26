import { wholeDong } from './aud-conclusion.ts';
import { DomainError } from './errors.ts';
import type { AttachmentRef, NarrativeInput, ProgressInput } from './dis-progress.ts';
import { payloadSha256 } from './pdf-render.ts';

/** The sources a report counts disbursement in (DIS 3 F1 step 4, BR-DIS-01): the year plan, the carried-over plan and every other source, each by central or local budget. */
export const FUNDING_BUCKETS = ['CURRENT_YEAR', 'CARRYOVER', 'OTHER'] as const;
export type FundingBucket = (typeof FUNDING_BUCKETS)[number];
export const BUDGET_LEVELS = ['CENTRAL', 'LOCAL'] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

export interface FundingCellKey {
  bucket: FundingBucket;
  budgetLevel: BudgetLevel;
}

/** The six cells in the order of the paper form. */
export const FUNDING_CELLS: readonly FundingCellKey[] = FUNDING_BUCKETS.flatMap((bucket) => BUDGET_LEVELS.map((budgetLevel) => ({ bucket, budgetLevel })));

export const REPORT_TYPES = ['WEEKLY', 'MONTHLY'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** D03 proposal (CXN-03, BR-DIS-12): a cumulative cell is read year to date unless the report says otherwise. */
export const MEASUREMENT_BASES = ['PERIOD', 'YTD', 'PROJECT_TO_DATE'] as const;
export type MeasurementBasis = (typeof MEASUREMENT_BASES)[number];
export const DEFAULT_MEASUREMENT_BASIS: MeasurementBasis = 'YTD';

export const REVISION_STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

/** DIS 3 F1: a project reports from the year its money is allocated until it is completed; before that, and after settlement, it has nothing to report. */
export const REPORTABLE_PROJECT_STATUSES: readonly string[] = ['BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED'];

/** 422 `PROJECT_STAGE_INVALID` for a project in a stage that does not report. */
export function assertReportableStage(status: string): void {
  if (!REPORTABLE_PROJECT_STATUSES.includes(status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id', { extensions: { project_status: status } });
}

/** CTMTQG is a part of the year plan and of the carried-over plan; the other sources have none (CHECK `funding_snapshot_line_other_chk`). */
export const takesCtmtqg = (bucket: FundingBucket): boolean => bucket !== 'OTHER';

/** What a person entered for a cell: whole dong as text, with the national target programmes as a subset that is shown apart and never added. */
export interface FundingInput {
  bucket: FundingBucket;
  budgetLevel: BudgetLevel;
  cumulativeVnd: string;
  ctmtqgVnd: string | null;
  nextMonthVnd: string;
  nextMonthCtmtqgVnd: string | null;
  sourceYear: number | null;
}

/** The members of a funding line of the request, as the contract names them. */
export interface RawFundingLine {
  bucket: FundingBucket;
  budget_level: BudgetLevel;
  cumulative_vnd: string;
  ctmtqg_subset_vnd?: string | undefined;
  next_month_vnd?: string | undefined;
  next_month_ctmtqg_subset_vnd?: string | undefined;
  source_year?: number | undefined;
}

const cellKey = (bucket: string, level: string): string => `${bucket}/${level}`;

/**
 * BR-DIS-01 and BR-DIS-07: the six cells of a report. A cell may be left out and then reads zero; a cell named twice, a money that is not whole dong, a subset in a source that has none
 * (422 `VALIDATION_FAILED`, naming `funding_lines[i].<member>`) and a subset above the cell it is a part of (422 `SUBSET_EXCEEDS_PARENT`, naming the subset) are refused. The result always has six
 * cells, in the order of the form, so that a saved report reads the same whatever order it was entered in.
 */
export function fundingCells(lines: readonly RawFundingLine[]): FundingInput[] {
  const entered = new Map<string, FundingInput>();
  lines.forEach((line, index) => {
    const at = (member: string): string => `funding_lines[${index}].${member}`;
    if (!(FUNDING_BUCKETS as readonly string[]).includes(line.bucket)) throw new DomainError('VALIDATION_FAILED', 422, at('bucket'));
    if (!(BUDGET_LEVELS as readonly string[]).includes(line.budget_level)) throw new DomainError('VALIDATION_FAILED', 422, at('budget_level'));
    const key = cellKey(line.bucket, line.budget_level);
    if (entered.has(key)) throw new DomainError('VALIDATION_FAILED', 422, at('bucket'));
    const cumulative = wholeDong(line.cumulative_vnd, at('cumulative_vnd'));
    const ctmtqg = line.ctmtqg_subset_vnd === undefined ? null : wholeDong(line.ctmtqg_subset_vnd, at('ctmtqg_subset_vnd'));
    const nextMonth = line.next_month_vnd === undefined ? '0' : wholeDong(line.next_month_vnd, at('next_month_vnd'));
    const nextMonthCtmtqg = line.next_month_ctmtqg_subset_vnd === undefined ? null : wholeDong(line.next_month_ctmtqg_subset_vnd, at('next_month_ctmtqg_subset_vnd'));
    if (!takesCtmtqg(line.bucket)) {
      if (ctmtqg !== null) throw new DomainError('VALIDATION_FAILED', 422, at('ctmtqg_subset_vnd'));
      if (nextMonthCtmtqg !== null) throw new DomainError('VALIDATION_FAILED', 422, at('next_month_ctmtqg_subset_vnd'));
    }
    if (ctmtqg !== null && BigInt(ctmtqg) > BigInt(cumulative)) {
      throw new DomainError('SUBSET_EXCEEDS_PARENT', 422, at('ctmtqg_subset_vnd'), { extensions: { parent_vnd: cumulative, subset_vnd: ctmtqg } });
    }
    if (nextMonthCtmtqg !== null && BigInt(nextMonthCtmtqg) > BigInt(nextMonth)) {
      throw new DomainError('SUBSET_EXCEEDS_PARENT', 422, at('next_month_ctmtqg_subset_vnd'), { extensions: { parent_vnd: nextMonth, subset_vnd: nextMonthCtmtqg } });
    }
    if (line.source_year !== undefined && (!Number.isInteger(line.source_year) || line.source_year < 1990 || line.source_year > 2100)) throw new DomainError('VALIDATION_FAILED', 422, at('source_year'));
    entered.set(key, {
      bucket: line.bucket,
      budgetLevel: line.budget_level,
      cumulativeVnd: cumulative,
      ctmtqgVnd: ctmtqg,
      nextMonthVnd: nextMonth,
      nextMonthCtmtqgVnd: nextMonthCtmtqg,
      sourceYear: line.source_year ?? null,
    });
  });
  return FUNDING_CELLS.map((cell) => entered.get(cellKey(cell.bucket, cell.budgetLevel)) ?? { ...cell, cumulativeVnd: '0', ctmtqgVnd: null, nextMonthVnd: '0', nextMonthCtmtqgVnd: null, sourceYear: null });
}

export interface FundingTotals {
  /** BR-DIS-01: the sum of the six cumulative cells. The national target programmes are inside them and are not added again. */
  cumulativeVnd: string;
  ctmtqgVnd: string;
  nextMonthVnd: string;
  nextMonthCtmtqgVnd: string;
}

export function fundingTotals(cells: ReadonlyArray<Pick<FundingInput, 'cumulativeVnd' | 'ctmtqgVnd' | 'nextMonthVnd' | 'nextMonthCtmtqgVnd'>>): FundingTotals {
  let cumulative = 0n;
  let ctmtqg = 0n;
  let nextMonth = 0n;
  let nextMonthCtmtqg = 0n;
  for (const cell of cells) {
    cumulative += BigInt(cell.cumulativeVnd);
    ctmtqg += cell.ctmtqgVnd === null ? 0n : BigInt(cell.ctmtqgVnd);
    nextMonth += BigInt(cell.nextMonthVnd);
    nextMonthCtmtqg += cell.nextMonthCtmtqgVnd === null ? 0n : BigInt(cell.nextMonthCtmtqgVnd);
  }
  return { cumulativeVnd: cumulative.toString(), ctmtqgVnd: ctmtqg.toString(), nextMonthVnd: nextMonth.toString(), nextMonthCtmtqgVnd: nextMonthCtmtqg.toString() };
}

/**
 * BR-DIS-03: what a period added to the cumulative of the period before it, per cell. A cell with nothing before it has no delta (null); a negative one is a fact to be explained, not forced to
 * zero (the submit story asks for the explanation).
 */
export function deltaOf(previousVnd: string | null, currentVnd: string): string | null {
  return previousVnd === null ? null : (BigInt(currentVnd) - BigInt(previousVnd)).toString();
}

/** The draft as it is hashed: the identity of the report, the basis, the cells in the order of the form, the explanation of a fall, the volumes, the narrative and the files attached. */
export interface DraftContent {
  projectId: string;
  periodId: string;
  planVersionId: string;
  reportType: ReportType;
  measurementBasis: MeasurementBasis;
  cells: readonly FundingInput[];
  negativeDeltaExplanation: string | null;
  progress: ProgressInput | null;
  narrative: NarrativeInput | null;
  attachments: readonly AttachmentRef[];
}

/** SHA-256 of the canonical content of a draft: the same entries in any order give the same hash, so that a replay is recognised and a change is not missed. */
export function draftHash(content: DraftContent): string {
  return payloadSha256({
    project_id: content.projectId.toLowerCase(),
    period_id: content.periodId.toLowerCase(),
    plan_version_id: content.planVersionId.toLowerCase(),
    report_type: content.reportType,
    measurement_basis: content.measurementBasis,
    negative_delta_explanation: content.negativeDeltaExplanation,
    progress: content.progress === null ? null : { construction_vnd: content.progress.constructionVnd, acceptance_vnd: content.progress.acceptanceVnd, treasury_submitted_vnd: content.progress.treasurySubmittedVnd, preparing_dossier_vnd: content.progress.preparingDossierVnd, physical_progress_pct: content.progress.physicalProgressPct },
    narrative: content.narrative === null ? null : { results: content.narrative.resultsText, causes: content.narrative.causesText, solutions: content.narrative.solutionsText, proposals: content.narrative.proposalsText, linked_issue_ids: content.narrative.linkedIssueIds },
    attachments: content.attachments.map((ref) => ({ file_object_id: ref.fileObjectId, file_sha256: ref.fileSha256, file_name: ref.fileName })),
    funding_lines: content.cells.map((cell) => ({
      bucket: cell.bucket,
      budget_level: cell.budgetLevel,
      cumulative_vnd: cell.cumulativeVnd,
      ctmtqg_subset_vnd: cell.ctmtqgVnd,
      next_month_vnd: cell.nextMonthVnd,
      next_month_ctmtqg_subset_vnd: cell.nextMonthCtmtqgVnd,
      source_year: cell.sourceYear,
    })),
  });
}

/** The explanation of a fall: words of 10 to 2000 characters, or none (422 `VALIDATION_FAILED`). */
export function negativeDeltaExplanation(text: string | undefined): string | null {
  if (text === undefined) return null;
  const words = text.normalize('NFC').trim();
  if (words.length < 10 || words.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'negative_delta_explanation');
  return words;
}
