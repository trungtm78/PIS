import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import { toAttachment, toNarrative, toProgress, toReview } from './detail-parts';
import type { Attachment, Narrative, Progress, Review } from './detail-parts';
import { digitsOf } from './money';

/** DIS-01 the list of the weekly reports, DIS-02 the choice of the period and the project, DIS-04 the entry of the six cells, DIS-18 the draft that was saved (ST-DIS-003, DIS 3 F1). */
export const REPORTS_PATH = '/dis/dis-01';
export const CREATE_PATH = '/dis/dis-02';
export const EDIT_PATH = '/dis/dis-04';
export const SAVED_PATH = '/dis/dis-18';
/** The steps of the draft that follow the choice of the period and the project (ST-DIS-004): the volumes, the cumulative cells, the registration for next month and the review. */
export const PROGRESS_PATH = '/dis/dis-03';
export const REGISTRATION_PATH = '/dis/dis-05';
export const REVIEW_PATH = '/dis/dis-06';

/** The permissions that gate the buttons; the server decides again on every request. */
export const CREATE_PERMISSION = 'report.create';
export const EDIT_PERMISSION = 'report.edit';

export const BUCKETS = ['CURRENT_YEAR', 'CARRYOVER', 'OTHER'] as const;
export type Bucket = (typeof BUCKETS)[number];
export const LEVELS = ['CENTRAL', 'LOCAL'] as const;
export type Level = (typeof LEVELS)[number];
export const BASES = ['PERIOD', 'YTD', 'PROJECT_TO_DATE'] as const;
export type Basis = (typeof BASES)[number];
export const REPORT_STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'RETURNED', 'AMENDMENT_REQUESTED', 'WITHDRAWN', 'SUPERSEDED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface CellKey {
  bucket: Bucket;
  level: Level;
}

/** The six cells in the order of the paper form. */
export const CELLS: readonly CellKey[] = BUCKETS.flatMap((bucket) => LEVELS.map((level) => ({ bucket, level })));
export const cellId = (cell: CellKey): string => `${cell.bucket}:${cell.level}`;
/** The national target programmes are a part of the year plan and of the carried-over plan; the other sources have none. */
export const takesCtmtqg = (bucket: Bucket): boolean => bucket !== 'OTHER';

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);
const dong = (value: unknown): string | undefined => (typeof value === 'string' && /^[0-9]{1,24}$/.test(value) ? value : undefined);
const signedDong = (value: unknown): string | undefined => (typeof value === 'string' && /^-?[0-9]{1,24}$/.test(value) ? value : undefined);

/** A report as DIS-01 lists it. */
export interface ReportLine {
  id: string;
  project: { id: string; code: string; name: string };
  period: { id: string; code: string; endDate: string; fiscalYear: number };
  revision: number;
  status: ReportStatus;
  reportType: 'WEEKLY' | 'MONTHLY';
  isLate: boolean;
  version: number;
  cumulativeVnd: string;
  ctmtqgVnd: string;
  updatedAt: string;
}

export function toReportLine(raw: unknown): ReportLine | undefined {
  const row = asRecord(raw);
  const project = asRecord(row?.project);
  const period = asRecord(row?.period);
  const id = text(row?.id);
  const projectId = text(project?.id);
  const projectCode = text(project?.code);
  const periodId = text(period?.id);
  const periodCode = text(period?.code);
  const endDate = text(period?.end_date);
  const fiscalYear = whole(period?.fiscal_year);
  const revision = whole(row?.revision);
  const status = oneOf(REPORT_STATUSES, row?.status);
  const reportType = oneOf(['WEEKLY', 'MONTHLY'] as const, row?.report_type);
  const version = whole(row?.version);
  const cumulative = dong(row?.cumulative_vnd);
  const ctmtqg = dong(row?.ctmtqg_vnd);
  const updatedAt = text(row?.updated_at);
  if (row === undefined || id === undefined || projectId === undefined || projectCode === undefined || periodId === undefined || periodCode === undefined || endDate === undefined || fiscalYear === undefined) return undefined;
  if (revision === undefined || status === undefined || reportType === undefined || version === undefined || cumulative === undefined || ctmtqg === undefined || updatedAt === undefined) return undefined;
  return {
    id,
    project: { id: projectId, code: projectCode, name: text(project?.name) ?? '' },
    period: { id: periodId, code: periodCode, endDate, fiscalYear },
    revision,
    status,
    reportType,
    isLate: row.is_late === true,
    version,
    cumulativeVnd: cumulative,
    ctmtqgVnd: ctmtqg,
    updatedAt,
  };
}

/** The figures of a set of reports. */
export interface Kpi {
  reports: number;
  projects: number;
  cumulativeVnd: string;
  ctmtqgVnd: string;
}

function toKpi(raw: unknown): Kpi | undefined {
  const row = asRecord(raw);
  const reports = whole(row?.reports);
  const projects = whole(row?.projects);
  const cumulative = dong(row?.cumulative_vnd);
  const ctmtqg = dong(row?.ctmtqg_vnd);
  return reports === undefined || projects === undefined || cumulative === undefined || ctmtqg === undefined ? undefined : { reports, projects, cumulativeVnd: cumulative, ctmtqgVnd: ctmtqg };
}

/** The figures above the list: the ones of the filter and the ones of everything the caller can see, each with the words of what it is the total of (SRC-01/02). */
export interface ReportSummary {
  filtered: Kpi;
  scope: Kpi;
  isFiltered: boolean;
}

export interface ReportPage {
  items: ReportLine[];
  nextCursor: string | null;
  summary: ReportSummary | undefined;
}

export function toReportPage(raw: unknown): ReportPage {
  const row = asRecord(raw);
  const summary = asRecord(row?.summary);
  const filtered = toKpi(summary?.filtered);
  const scope = toKpi(summary?.scope);
  return {
    items: (Array.isArray(row?.items) ? row.items : []).flatMap((item) => toReportLine(item) ?? []),
    nextCursor: nullableText(row?.next_cursor),
    summary: filtered === undefined || scope === undefined ? undefined : { filtered, scope, isFiltered: summary?.is_filtered === true },
  };
}

/** A cell of a report with what the plan allocated to it and what the period before had reached. */
export interface FundingCell extends CellKey {
  allocatedVnd: string;
  cumulativeVnd: string;
  ctmtqgVnd: string | null;
  nextMonthVnd: string;
  nextMonthCtmtqgVnd: string | null;
  sourceYear: number | null;
  previousCumulativeVnd: string | null;
  deltaVnd: string | null;
}

export interface ReportDetail {
  id: string;
  revision: number;
  status: ReportStatus;
  version: number;
  reportType: 'WEEKLY' | 'MONTHLY';
  measurementBasis: Basis;
  negativeDeltaExplanation: string | null;
  project: { id: string; code: string; name: string; status: string };
  period: { id: string; code: string; periodType: string; fiscalYear: number; startDate: string; endDate: string; status: string };
  planVersion: { id: string; fiscalYear: number; revision: number };
  cells: FundingCell[];
  totals: { allocatedVnd: string; cumulativeVnd: string; ctmtqgVnd: string; nextMonthVnd: string; nextMonthCtmtqgVnd: string };
  progress: Progress | null;
  narrative: Narrative | null;
  attachments: Attachment[];
  /** The review of a draft; none for a report that was handed in. */
  review: Review | null;
}

export function toReportDetail(raw: unknown): ReportDetail | undefined {
  const row = asRecord(raw);
  const project = asRecord(row?.project);
  const period = asRecord(row?.period);
  const plan = asRecord(row?.plan_version);
  const totals = asRecord(row?.totals);
  const id = text(row?.id);
  const revision = whole(row?.revision);
  const status = oneOf(REPORT_STATUSES, row?.status);
  const reportType = oneOf(['WEEKLY', 'MONTHLY'] as const, row?.report_type);
  const basis = oneOf(BASES, row?.measurement_basis);
  const version = whole(row?.version);
  const projectId = text(project?.id);
  const projectCode = text(project?.code);
  const periodId = text(period?.id);
  const periodCode = text(period?.code);
  const planId = text(plan?.id);
  const allocated = dong(totals?.allocated_vnd);
  const cumulative = dong(totals?.cumulative_vnd);
  const ctmtqg = dong(totals?.ctmtqg_vnd);
  if (row === undefined || id === undefined || revision === undefined || status === undefined || reportType === undefined || basis === undefined || version === undefined) return undefined;
  if (projectId === undefined || projectCode === undefined || periodId === undefined || periodCode === undefined || planId === undefined || allocated === undefined || cumulative === undefined || ctmtqg === undefined) return undefined;
  const cells = (Array.isArray(row.funding_lines) ? row.funding_lines : []).flatMap((item): FundingCell[] => {
    const entry = asRecord(item);
    const bucket = oneOf(BUCKETS, entry?.bucket);
    const level = oneOf(LEVELS, entry?.budget_level);
    const cell = dong(entry?.cumulative_vnd);
    const alloc = dong(entry?.allocated_vnd);
    const nextMonth = dong(entry?.next_month_vnd);
    if (entry === undefined || bucket === undefined || level === undefined || cell === undefined || alloc === undefined || nextMonth === undefined) return [];
    return [
      {
        bucket,
        level,
        allocatedVnd: alloc,
        cumulativeVnd: cell,
        ctmtqgVnd: dong(entry.ctmtqg_subset_vnd) ?? null,
        nextMonthVnd: nextMonth,
        nextMonthCtmtqgVnd: dong(entry.next_month_ctmtqg_subset_vnd) ?? null,
        sourceYear: whole(entry.source_year) ?? null,
        previousCumulativeVnd: dong(entry.previous_cumulative_vnd) ?? null,
        deltaVnd: signedDong(entry.delta_vnd) ?? null,
      },
    ];
  });
  return {
    id,
    revision,
    status,
    version,
    reportType,
    measurementBasis: basis,
    negativeDeltaExplanation: nullableText(row.negative_delta_explanation),
    project: { id: projectId, code: projectCode, name: text(project?.name) ?? '', status: text(project?.status) ?? '' },
    period: {
      id: periodId,
      code: periodCode,
      periodType: text(period?.period_type) ?? '',
      fiscalYear: whole(period?.fiscal_year) ?? 0,
      startDate: text(period?.start_date) ?? '',
      endDate: text(period?.end_date) ?? '',
      status: text(period?.status) ?? '',
    },
    planVersion: { id: planId, fiscalYear: whole(plan?.fiscal_year) ?? 0, revision: whole(plan?.revision) ?? 0 },
    cells,
    totals: { allocatedVnd: allocated, cumulativeVnd: cumulative, ctmtqgVnd: ctmtqg, nextMonthVnd: dong(totals?.next_month_vnd) ?? '0', nextMonthCtmtqgVnd: dong(totals?.next_month_ctmtqg_vnd) ?? '0' },
    progress: toProgress(row.progress),
    narrative: toNarrative(row.narrative),
    attachments: (Array.isArray(row.attachments) ? row.attachments : []).flatMap((item) => toAttachment(item) ?? []),
    review: toReview(row.review),
  };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;

/** The button that starts a draft: the permission to create, in a tenant that is not read only. */
export const canCreate = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(CREATE_PERMISSION)) && mode !== 'READ_ONLY';

/** The entries of a report are edited by a holder of the permission to edit, in a tenant that is not read only, while the report is a draft. */
export const canEdit = (permissions: readonly string[] | undefined, mode: Mode, status: ReportStatus): boolean => status === 'DRAFT' && (permissions === undefined || permissions.includes(EDIT_PERMISSION)) && mode !== 'READ_ONLY';

/** What a person writes in a cell, as the form holds it. */
export interface CellForm {
  cumulative: string;
  ctmtqg: string;
}

export interface FundingForm {
  basis: Basis;
  explanation: string;
  cells: Record<string, CellForm>;
}

/** The form as the report stands: a cell with nothing entered reads zero, and the subset of a source that has none is empty. */
export function formOf(detail: ReportDetail): FundingForm {
  const cells: Record<string, CellForm> = {};
  for (const key of CELLS) {
    const found = detail.cells.find((cell) => cell.bucket === key.bucket && cell.level === key.level);
    cells[cellId(key)] = { cumulative: found?.cumulativeVnd ?? '0', ctmtqg: found?.ctmtqgVnd ?? '' };
  }
  return { basis: detail.measurementBasis, explanation: detail.negativeDeltaExplanation ?? '', cells };
}

export type CellProblem = 'required' | 'invalid' | 'exceeds' | 'notAllowed';
export type FormProblem = 'tooShort' | 'tooLong' | 'invalid';

export interface FundingProblems {
  /** By cell and field: `CURRENT_YEAR:CENTRAL.cumulative`. */
  cells: Record<string, CellProblem>;
  explanation?: FormProblem;
}

const EXPLANATION_MIN = 10;
const EXPLANATION_MAX = 2000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export const fieldId = (cell: CellKey, field: 'cumulative' | 'ctmtqg'): string => `${cellId(cell)}.${field}`;

/**
 * BR-DIS-01 and BR-DIS-07 as the form can tell them before the server does: a cell is a whole amount of dong, the CTMTQG is a whole amount inside its cell and is absent from the other
 * sources, and the explanation of a fall, when given, is words. The server judges the same again on every save.
 */
export function validateFunding(form: FundingForm): FundingProblems {
  const problems: FundingProblems = { cells: {} };
  for (const key of CELLS) {
    const entry = form.cells[cellId(key)] ?? { cumulative: '', ctmtqg: '' };
    const cumulative = entry.cumulative.trim() === '' ? undefined : digitsOf(entry.cumulative);
    if (entry.cumulative.trim() === '') problems.cells[fieldId(key, 'cumulative')] = 'required';
    else if (cumulative === undefined) problems.cells[fieldId(key, 'cumulative')] = 'invalid';
    if (entry.ctmtqg.trim() === '') continue;
    const subset = digitsOf(entry.ctmtqg);
    if (!takesCtmtqg(key.bucket)) problems.cells[fieldId(key, 'ctmtqg')] = 'notAllowed';
    else if (subset === undefined) problems.cells[fieldId(key, 'ctmtqg')] = 'invalid';
    else if (cumulative !== undefined && BigInt(subset) > BigInt(cumulative)) problems.cells[fieldId(key, 'ctmtqg')] = 'exceeds';
  }
  const words = form.explanation.trim();
  if (words !== '') {
    if (words.length < EXPLANATION_MIN) problems.explanation = 'tooShort';
    else if (words.length > EXPLANATION_MAX) problems.explanation = 'tooLong';
    else if (CONTROL.test(words)) problems.explanation = 'invalid';
  }
  return problems;
}

export const hasProblems = (problems: FundingProblems): boolean => Object.keys(problems.cells).length > 0 || problems.explanation !== undefined;

/** What the form adds up to as it is typed: the total is the sum of the six cells, the CTMTQG inside them is given apart and never added (BR-DIS-01). A cell that is not an amount reads zero. */
export function totalsOf(form: FundingForm): { cumulativeVnd: string; ctmtqgVnd: string } {
  let cumulative = 0n;
  let ctmtqg = 0n;
  for (const key of CELLS) {
    const entry = form.cells[cellId(key)];
    cumulative += BigInt(digitsOf(entry?.cumulative ?? '') ?? '0');
    ctmtqg += BigInt(digitsOf(entry?.ctmtqg ?? '') ?? '0');
  }
  return { cumulativeVnd: cumulative.toString(), ctmtqgVnd: ctmtqg.toString() };
}

/** What a cell added since the period before, as it is typed: nothing to compare with gives none. */
export function deltaOf(previous: string | null, typed: string): string | null {
  const now = digitsOf(typed);
  return previous === null || now === undefined ? null : (BigInt(now) - BigInt(previous)).toString();
}

/** A fall in any cell has to be explained when the report is handed in (BR-DIS-03). */
export function hasFall(detail: ReportDetail, form: FundingForm): boolean {
  return detail.cells.some((cell) => {
    const delta = deltaOf(cell.previousCumulativeVnd, form.cells[cellId(cell)]?.cumulative ?? '');
    return delta !== null && delta.startsWith('-');
  });
}

export type ReportDraftBody = components['schemas']['ReportDraft'];

/** The entries to save: all six cells, with the next-month registration as the report holds it (it is entered on its own screen). */
export function saveBody(detail: ReportDetail, form: FundingForm): ReportDraftBody {
  const explanation = form.explanation.trim();
  return {
    project_id: detail.project.id,
    period_id: detail.period.id,
    plan_version_id: detail.planVersion.id,
    report_type: detail.reportType,
    measurement_basis: form.basis,
    funding_lines: CELLS.map((key) => {
      const entry = form.cells[cellId(key)] ?? { cumulative: '0', ctmtqg: '' };
      const kept = detail.cells.find((cell) => cell.bucket === key.bucket && cell.level === key.level);
      const subset = entry.ctmtqg.trim() === '' ? undefined : digitsOf(entry.ctmtqg);
      return {
        bucket: key.bucket,
        budget_level: key.level,
        cumulative_vnd: digitsOf(entry.cumulative) ?? '0',
        ...(subset === undefined ? {} : { ctmtqg_subset_vnd: subset }),
        next_month_vnd: kept?.nextMonthVnd ?? '0',
        ...(kept?.nextMonthCtmtqgVnd == null ? {} : { next_month_ctmtqg_subset_vnd: kept.nextMonthCtmtqgVnd }),
      };
    }),
    ...(explanation === '' ? {} : { negative_delta_explanation: explanation }),
  };
}

/** The start of a draft: the project and the period, the basis the cumulative cells are read on; the cells start at zero and are entered on DIS-04. */
export function createBody(input: { projectId: string; periodId: string; basis: Basis }): ReportDraftBody {
  return { project_id: input.projectId, period_id: input.periodId, measurement_basis: input.basis, report_type: 'WEEKLY', funding_lines: [] };
}

/** The id of the resource a command answered with: the report that was made. */
export function resourceIdOf(done: unknown): string | undefined {
  const id = asRecord(done)?.resource_id;
  return typeof id === 'string' ? id : undefined;
}

export interface FilterState {
  year: string;
  periodId: string;
  planId: string;
  projectId: string;
}

export const NO_FILTER: FilterState = { year: '', periodId: '', planId: '', projectId: '' };

export type ReportProblem =
  | 'draftExists'
  | 'reportExists'
  | 'periodLocked'
  | 'planNotEffective'
  | 'stageInvalid'
  | 'subsetExceeds'
  | 'immutable'
  | 'versionConflict'
  | 'scopeDenied'
  | 'validation'
  | 'notFound'
  | 'fileInfected'
  | 'fileType'
  | 'fileTooLarge'
  | 'scanPending'
  | 'hashMismatch'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ReportProblem>> = {
  DRAFT_EXISTS: 'draftExists',
  REPORT_STATE_INVALID: 'reportExists',
  PERIOD_LOCKED: 'periodLocked',
  PLAN_VERSION_NOT_EFFECTIVE: 'planNotEffective',
  PROJECT_STAGE_INVALID: 'stageInvalid',
  SUBSET_EXCEEDS_PARENT: 'subsetExceeds',
  REVISION_IMMUTABLE: 'immutable',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  FILE_NOT_CLEAN: 'fileInfected',
  FILE_TYPE_NOT_ALLOWED: 'fileType',
  PAYLOAD_TOO_LARGE: 'fileTooLarge',
  SCAN_PENDING: 'scanPending',
  HASH_MISMATCH: 'hashMismatch',
};

export interface DescribedReport {
  problem: ReportProblem;
  /** The report that is in the way (a draft that exists already), so the screen can lead to it. */
  existingId: string | undefined;
  /** The cell the server named, `CURRENT_YEAR:CENTRAL.ctmtqg`, so the screen can mark it. */
  field: string | undefined;
}

const DETAIL_FIELD = /^funding_lines\[(\d)\]\.(cumulative_vnd|ctmtqg_subset_vnd|next_month_vnd|next_month_ctmtqg_subset_vnd)$/;
/** The suffix of the field id of a cell for each member the server can name. */
const FIELD_SUFFIX: Readonly<Record<string, string>> = { cumulative_vnd: 'cumulative', ctmtqg_subset_vnd: 'ctmtqg', next_month_vnd: 'nextMonth', next_month_ctmtqg_subset_vnd: 'nextCtmtqg' };

/** Maps the error of a command to what the screen shows; an unknown failure is the general message. */
export function describeReport(error: unknown): DescribedReport {
  if (!(error instanceof ApiError)) return { problem: 'general', existingId: undefined, field: undefined };
  const existing = error.extensions.report_id;
  const matched = error.detail === undefined ? null : DETAIL_FIELD.exec(error.detail);
  const key = matched === null ? undefined : CELLS[Number(matched[1])];
  return {
    problem: PROBLEM_BY_CODE[error.code] ?? 'general',
    existingId: typeof existing === 'string' ? existing : undefined,
    field: key === undefined || matched === null ? undefined : `${cellId(key)}.${FIELD_SUFFIX[matched[2] ?? ''] ?? 'cumulative'}`,
  };
}

/** The reports are listed with filters the server understands; an empty filter lets everything through. */
export function queryOf(filter: FilterState, cursor: string | undefined): Record<string, string> {
  return {
    ...(filter.year === '' ? {} : { fiscal_year: filter.year }),
    ...(filter.periodId === '' ? {} : { period_id: filter.periodId }),
    ...(filter.planId === '' ? {} : { plan_id: filter.planId }),
    ...(filter.projectId === '' ? {} : { project_id: filter.projectId }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export const isFiltered = (filter: FilterState): boolean => filter.year !== '' || filter.periodId !== '' || filter.planId !== '' || filter.projectId !== '';
