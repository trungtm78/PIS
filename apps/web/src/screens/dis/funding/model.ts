import { ApiError } from '@machvon/api-client';
import { formatVnd } from '../report/money';

/**
 * DIS-27 to DIS-29 (FND-1, docs/fnd-funding-model.md): the figures of the funding model as the API gives them. The shapes are read defensively (a wrong shape is an error of the read, never an empty screen); money is whole
 * dong as text and is never turned into a number; a figure nobody has is `null` and is written as a dash, never as zero.
 */
export interface FundingTaxonomy {
  pack_code: string;
  pack_label: string;
  version: number;
  unverified: boolean;
  entry_mode: string;
  phasing_must_sum: boolean;
  measures: string[];
  period_grains: string[];
  classes: Array<{ code: string; label: string; additive: boolean }>;
  tiers: Array<{ code: string; label: string }>;
  ratios: Array<{ code: string; numerator: string; denominator: string; basis: string }>;
  provenance: { formula: string | null; source: string | null; as_of: string | null; legal_status: string | null };
  actions: { prepare: boolean; accept: boolean };
  as_of: string;
}

export interface FundingBoard {
  pack_code: string;
  version: number;
  unverified: boolean;
  plan_year: number;
  period: { grain: string; plan_year: number; ordinal: number; start: string; end: string };
  as_of: string;
  measure: string;
  view: string;
  totals: { money: Money[]; rates: Rate[] };
  projects: BoardProject[];
  truncated: boolean;
  actions: { prepare: boolean; accept: boolean };
}

export interface BatchEntry {
  id: string;
  period_ordinal: number;
  amount_vnd: string;
  revision: number;
  status: string;
}

export interface FundingBatch {
  batch_id: string;
  project_id: string;
  project_code: string;
  class_code: string;
  tier_code: string;
  measure: string;
  figure_kind: string;
  period_grain: string;
  plan_year: number;
  basis: string;
  status: string;
  as_of_date: string;
  explanation: string | null;
  prepared_by_me: boolean;
  approved_at: string | null;
  created_at: string;
  version: number;
  entries: BatchEntry[];
  actions: { submit: boolean; withdraw: boolean; accept: boolean; return: boolean };
}

export interface HistoryEntry {
  id: string;
  figure_kind: string;
  basis: string;
  revision: number;
  as_of_date: string;
  status: string;
  amount_vnd: string;
  change_vnd: string | null;
  converted_from_id: string | null;
  estimate_amount_vnd: string | null;
  conversion_reason: string | null;
  conversion_delta_vnd: string | null;
}

export interface PendingEntry {
  batch_id: string;
  figure_kind: string;
  period_ordinal: number;
  amount_vnd: string;
  status: string;
  as_of_date: string;
}

export interface FundingHistory {
  project_id: string;
  project_code: string;
  class_code: string;
  tier_code: string;
  measure: string;
  period_grain: string;
  plan_year: number;
  period_ordinal: number;
  history: HistoryEntry[];
  pending: PendingEntry[];
  as_of: string;
}

export const READ_PERMISSION = 'funding.read';
export const PREPARE_PERMISSION = 'funding.figure.prepare';
export const ACCEPT_PERMISSION = 'funding.figure.accept';
export const BOARD_PATH = '/dis/dis-27';
export const BATCH_PATH = '/dis/dis-28';
export const HISTORY_PATH = '/dis/dis-29';
export const NONE = '–';
/** A reason of a withdrawal or a return is at least this long (the contract: minLength 10). */
export const MIN_REASON = 10;
/** An explanation (a reversal, a late adjustment) is 20 to 2000 characters. */
export const MIN_EXPLANATION = 20;

export const FIGURE_KINDS = ['PLAN_QUARTER', 'PLAN_MONTH', 'ESTIMATE', 'ACTUAL', 'PLAN_YEAR', 'PLAN_ADJUSTED'] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];
export const BATCH_STATUSES = ['DRAFT', 'SUBMITTED', 'ACCEPTED', 'SUPERSEDED', 'WITHDRAWN'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const GRAINS = ['MONTH', 'QUARTER', 'YEAR'] as const;
export type Grain = (typeof GRAINS)[number];
export const VIEWS = ['AS_REPORTED', 'RESTATED'] as const;
export type View = (typeof VIEWS)[number];
export const NULL_REASONS = ['ZERO_DENOMINATOR', 'NO_DATA'] as const;

/** The figure columns of the board in the order of the form: what the plan said, what is expected, what happened. */
export const BOARD_COLUMNS = [
  { key: 'plan_year_vnd', code: 'PLAN_YEAR' },
  { key: 'plan_adjusted_vnd', code: 'PLAN_ADJUSTED' },
  { key: 'plan_in_force_vnd', code: 'PLAN_IN_FORCE' },
  { key: 'plan_period_vnd', code: 'PLAN_PERIOD' },
  { key: 'estimate_vnd', code: 'ESTIMATE' },
  { key: 'actual_vnd', code: 'ACTUAL' },
  { key: 'cumulative_ytd_vnd', code: 'CUMULATIVE_YTD' },
  { key: 'cumulative_since_start_vnd', code: 'CUMULATIVE_SINCE_START' },
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export interface Cell {
  class_code: string;
  tier_code: string;
  plan_year_vnd: string | null;
  plan_adjusted_vnd: string | null;
  plan_in_force_vnd: string | null;
  plan_period_vnd: string | null;
  estimate_vnd: string | null;
  actual_vnd: string | null;
  cumulative_ytd_vnd: string | null;
  cumulative_since_start_vnd: string | null;
  estimate_year_vnd: string | null;
  gap_months: number[];
  actual_flash: boolean;
}

export interface Rate {
  code: string;
  class_code: string | null;
  numerator_vnd: string | null;
  denominator_vnd: string;
  rate_pct: string | null;
  null_reason: (typeof NULL_REASONS)[number] | null;
  basis: string;
  numerator_term: string;
  denominator_term: string;
  as_of: string;
  pack_code: string;
}

export interface Money {
  code: string;
  class_code: string | null;
  value_vnd: string | null;
}

export interface BoardProject {
  project_id: string;
  project_code: string;
  project_name: string;
  cells: Cell[];
  money: Money[];
  rates: Rate[];
}

/** The segment of a translation key for a code of the API: `PLAN_IN_FORCE` is `planInForce` (the keys are written module.screen.action.state in lower camel case). */
export function camel(code: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return code
    .toLowerCase()
    .split('_')
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

export function toBoard(raw: unknown): FundingBoard {
  const body = asRecord(raw);
  const totals = asRecord(body?.totals);
  if (body === undefined || !Array.isArray(body.projects) || totals === undefined || !Array.isArray(totals.rates) || !Array.isArray(totals.money) || asRecord(body.period) === undefined) throw new Error('unexpected board');
  return body as unknown as FundingBoard;
}

export function toTaxonomy(raw: unknown): FundingTaxonomy {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.classes) || !Array.isArray(body.tiers) || !Array.isArray(body.measures) || !Array.isArray(body.ratios) || asRecord(body.provenance) === undefined) throw new Error('unexpected taxonomy');
  return body as unknown as FundingTaxonomy;
}

export function toBatch(raw: unknown): FundingBatch {
  const body = asRecord(raw);
  if (body === undefined || typeof body.batch_id !== 'string' || !Array.isArray(body.entries) || asRecord(body.actions) === undefined) throw new Error('unexpected batch');
  return body as unknown as FundingBatch;
}

export function toBatches(raw: unknown): FundingBatch[] {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.items)) throw new Error('unexpected batches');
  return body.items.map(toBatch);
}

export function toHistory(raw: unknown): FundingHistory {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.history) || !Array.isArray(body.pending)) throw new Error('unexpected history');
  return body as unknown as FundingHistory;
}

// ---- writing numbers ------------------------------------------------------------------------------------------------------------------------------------------------------

/** Whole dong with a dot every three digits; a figure nobody has is a dash, never zero. */
export const money = (value: string | null | undefined): string => (value === null || value === undefined ? NONE : formatVnd(value));

/** A percent as the API wrote it (four decimals) shown with two; null is a dash. The text is cut, never turned into a float. */
export function percent(value: string | null | undefined): string {
  if (value === null || value === undefined) return NONE;
  const [whole = '0', fraction = ''] = value.split('.');
  const hundredths = Math.round(Number(fraction.padEnd(4, '0').slice(0, 4)) / 100);
  return hundredths >= 100 ? `${(BigInt(whole) + 1n).toString()},00%` : `${whole},${String(hundredths).padStart(2, '0')}%`;
}

/** The rates of the board of a project or of the total, those that are over the whole scope first, then one for each class. */
export const ratesOverall = (rates: readonly Rate[]): Rate[] => rates.filter((one) => one.class_code === null);
export const sharesOf = (rates: readonly Rate[]): Rate[] => rates.filter((one) => one.class_code !== null);

/** The value of a money figure of the total by its code, null when nobody has it. */
export const moneyOf = (figures: readonly Money[], code: string, classCode: string | null = null): string | null => figures.find((one) => one.code === code && one.class_code === classCode)?.value_vnd ?? null;

// ---- the query of the board ----------------------------------------------------------------------------------------------------------------------------------------

export interface BoardQuery {
  planYear: number;
  grain: Grain;
  ordinal: number;
  measure: string;
  view: View;
  asOf: string;
  projectId?: string;
}

export function boardQueryOf(query: BoardQuery): Record<string, string> {
  const out: Record<string, string> = { plan_year: String(query.planYear), period_grain: query.grain, period_ordinal: String(query.ordinal), measure: query.measure, view: query.view, as_of: query.asOf };
  if (query.projectId !== undefined) out.project_id = query.projectId;
  return out;
}

export const ordinalsOf = (grain: Grain): number[] => (grain === 'YEAR' ? [0] : grain === 'QUARTER' ? [1, 2, 3, 4] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

// ---- the form of a batch -------------------------------------------------------------------------------------------------------------------------------------------------

export interface BatchForm {
  projectId: string;
  classCode: string;
  tierCode: string;
  measure: string;
  kind: FigureKind;
  grain: Grain;
  planYear: number;
  asOfDate: string;
  /** One typed amount for each ordinal of the batch. */
  amounts: Record<number, string>;
  explanation: string;
  basis: 'REPORTED' | 'ADJUSTMENT' | 'OPENING_BALANCE';
  adjustsPlanYear: string;
  adjustsOrdinal: string;
  decisionDocumentId: string;
}

export type BatchField = 'project' | 'class' | 'amounts' | 'asOf' | 'explanation' | 'adjusts' | 'decision';

/** The grain a kind is entered in: the quarter plan by quarter, the month plan by month, the year plan by year; an estimate and an actual in the grain the person chooses. */
export const grainOfKind = (kind: FigureKind, chosen: Grain): Grain => (kind === 'PLAN_QUARTER' ? 'QUARTER' : kind === 'PLAN_MONTH' ? 'MONTH' : kind === 'PLAN_YEAR' || kind === 'PLAN_ADJUSTED' ? 'YEAR' : chosen);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED_DONG = /^-?(0|[1-9][0-9]{0,22})$/;

/** What is wrong with the form before it is sent, as the field that is wrong (the server judges again); an empty list is a form that may be sent. */
export function formProblems(form: BatchForm, mustSum: boolean): BatchField[] {
  const problems: BatchField[] = [];
  if (form.projectId === '') problems.push('project');
  if (form.classCode === '') problems.push('class');
  if (!DAY.test(form.asOfDate)) problems.push('asOf');
  const typed = Object.entries(form.amounts).filter(([, value]) => value.trim() !== '');
  const full = form.kind === 'PLAN_QUARTER' ? 4 : form.kind === 'PLAN_MONTH' ? 12 : 1;
  const wantsAll = mustSum && (form.kind === 'PLAN_QUARTER' || form.kind === 'PLAN_MONTH');
  const digits = typed.every(([, value]) => SIGNED_DONG.test(value.replace(/\./g, '').trim()));
  if (typed.length === 0 || !digits || (wantsAll && typed.length !== full)) problems.push('amounts');
  const negative = typed.some(([, value]) => value.trim().startsWith('-'));
  const needsWords = form.basis === 'ADJUSTMENT' || (form.kind === 'ACTUAL' && negative);
  if (needsWords && (form.explanation.trim().length < MIN_EXPLANATION || form.explanation.trim().length > 2000)) problems.push('explanation');
  if (form.basis === 'ADJUSTMENT' && (form.adjustsPlanYear === '' || form.adjustsOrdinal === '')) problems.push('adjusts');
  if (form.kind === 'PLAN_ADJUSTED' && form.decisionDocumentId.trim() === '') problems.push('decision');
  return problems;
}

/** The body of the command for a form that passed `formProblems`: the amounts as whole dong text, the dots of the thousands taken out, the ordinals in order. */
export function proposalBody(form: BatchForm): Record<string, unknown> {
  const entries = Object.entries(form.amounts)
    .filter(([, value]) => value.trim() !== '')
    .map(([ordinal, value]) => ({ period_ordinal: Number(ordinal), amount_vnd: value.replace(/\./g, '').trim() }))
    .sort((left, right) => left.period_ordinal - right.period_ordinal);
  const body: Record<string, unknown> = {
    project_id: form.projectId,
    class_code: form.classCode,
    tier_code: form.tierCode,
    measure: form.measure,
    figure_kind: form.kind,
    period_grain: form.grain,
    plan_year: form.planYear,
    as_of_date: form.asOfDate,
    entries,
  };
  if (form.kind === 'ACTUAL') body.basis = form.basis;
  if (form.explanation.trim() !== '') body.explanation = form.explanation.trim();
  if (form.basis === 'ADJUSTMENT') {
    body.adjusts_plan_year = Number(form.adjustsPlanYear);
    body.adjusts_period_ordinal = Number(form.adjustsOrdinal);
  }
  if (form.kind === 'PLAN_ADJUSTED') body.decision_document_id = form.decisionDocumentId.trim();
  return body;
}

// ---- refusals ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type ProblemKind = 'locked' | 'afterActual' | 'phasing' | 'grain' | 'class' | 'conflict' | 'state' | 'self' | 'explanation' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ProblemKind>> = {
  FIGURE_PERIOD_LOCKED: 'locked',
  ESTIMATE_AFTER_ACTUAL: 'afterActual',
  PHASING_SUM_MISMATCH: 'phasing',
  GRAIN_SUM_MISMATCH: 'grain',
  FUNDING_CLASS_UNKNOWN: 'class',
  VERSION_CONFLICT: 'conflict',
  FIGURE_STATE_INVALID: 'state',
  SELF_APPROVAL_DENIED: 'self',
  NEGATIVE_DELTA_EXPLANATION_REQUIRED: 'explanation',
};

export const describeProblem = (error: unknown): ProblemKind => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

/** The day of today in Vietnam time as `YYYY-MM-DD` (the board opens as of today). */
export function todayOf(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}
