import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import type { Tone } from '../../../ui';
import { dayText } from '../model';
import type { FormProblem } from '../model';

type Schemas = components['schemas'];

// ---- the shapes of the contract (generated; the screens never describe a shape a second time) -----------------------------------------------------------------------------

export type ScorePeriod = Schemas['StaffScorePeriod'];
export type PeriodPreview = Schemas['StaffScorePeriodPreview'];
export type PeriodPage = Schemas['StaffScorePeriodPage'];
export type ScoreLine = Schemas['StaffScoreLine'];
export type ScoreLinePage = Schemas['StaffScoreLinePage'];
export type ScoreLineRow = ScoreLinePage['items'][number];
export type MyScorePage = Schemas['MyStaffScorePage'];
export type MyScore = MyScorePage['items'][number];
export type Comparison = Schemas['StaffScoreComparison'];
export type ComparisonPoint = Comparison['points'][number];
export type SignalPage = Schemas['StaffScoreSignalPage'];
export type SignalRow = SignalPage['items'][number];
export type SignalFlag = SignalRow['flags'][number];
export type Contribution = ScoreLine['contributions'][number];
export type Excluded = ScoreLine['excluded'][number];
export type Adjustment = ScoreLine['adjustments'][number];
export type ScoreResponse = ScoreLine['responses'][number];
export type PeriodExport = Schemas['StaffScorePeriodExport'];
export type KpiResultPage = Schemas['PwfKpiResultPage'];
export type KpiResultItem = KpiResultPage['items'][number];
export type KpiOperationList = Schemas['PwfKpiOperationList'];
export type KpiOperationEntry = KpiOperationList['items'][number];
export type PeriodStatus = ScorePeriod['status'];
export type LineState = ScoreLine['state'];
export type FlagCode = SignalFlag['code'];
export type PeriodRequest = Schemas['StaffScorePeriodRequest'];
export type AdjustmentRequest = Schemas['StaffScoreAdjustmentRequest'];
export type ResponseHandle = Schemas['StaffScoreResponseHandle'];
export type DecisionBody = Schemas['PwfDecisionInput'];

// ---- permissions (the same names as the contract) -----------------------------------------------------------------------------------------------------------------------

export const SCORE_PERMISSIONS = {
  readOwn: 'staff_score.read_own',
  readUnit: 'staff_score.read_unit',
  readHr: 'staff_score.read_hr',
  manage: 'staff_score.manage',
  adjust: 'staff_score.adjust',
  approve: 'staff_score.approve',
  review: 'staff_score.review',
  export: 'staff_score.export',
} as const;
export type ScorePermission = (typeof SCORE_PERMISSIONS)[keyof typeof SCORE_PERMISSIONS];

/** Holds a permission, or the session does not say what is held (the server decides then). */
export const mayDo = (permissions: readonly string[] | undefined, permission: ScorePermission): boolean => permissions === undefined || permissions.includes(permission);

/** A frozen (read-only) session holds no right that writes. */
export const mayWrite = (permissions: readonly string[] | undefined, permission: ScorePermission, readOnly: boolean): boolean => !readOnly && mayDo(permissions, permission);

// ---- routes ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const SCORE_PATHS = {
  kpiSet: '/pwf/pwf-09',
  policy: '/pwf/pwf-10',
  mine: '/pwf/pwf-11',
  unit: '/pwf/pwf-12',
  detail: '/pwf/pwf-13',
  period: '/pwf/pwf-14',
  task: '/pwf/pwf-04',
} as const;

const query = (params: Record<string, string | undefined>): string => {
  const pairs = Object.entries(params).flatMap(([name, value]) => (value === undefined || value === '' ? [] : [`${name}=${encodeURIComponent(value)}`]));
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
};

export const lineLink = (lineId: string): string => `${SCORE_PATHS.detail}${query({ id: lineId })}`;
export const periodLink = (periodId: string): string => `${SCORE_PATHS.period}${query({ id: periodId })}`;
export const unitLink = (periodId: string): string => `${SCORE_PATHS.unit}${query({ period: periodId })}`;
export const scoreTaskLink = (taskId: string): string => `${SCORE_PATHS.task}${query({ id: taskId })}`;

// ---- limits the contract states ----------------------------------------------------------------------------------------------------------------------------------------

export const RESPONSE_MIN = 20;
export const RESPONSE_MAX = 2000;
export const ADJUSTMENT_REASON_MIN = 20;
export const ADJUSTMENT_REASON_MAX = 1000;
export const EVIDENCE_REF_MAX = 300;
export const DECISION_NOTE_MIN = 5;
export const DECISION_NOTE_MAX = 500;
export const CONCLUSION_MIN = 5;
export const CONCLUSION_MAX = 2000;
/** The widest swing the contract allows; the policy of the period narrows it (`max_adjustment_points`). */
export const POINTS_CEILING = 30;
export const PAGE_SIZE = 50;

// ---- what a figure says ------------------------------------------------------------------------------------------------------------------------------------------------

/** A score is shown with its rating only when the person was rated; a small sample and a person with nothing to rate show "not enough data" (BR-PWF-36). */
export const isRated = (line: { state: LineState }): boolean => line.state === 'RATED';

/** The score a person is judged by: the adjusted one when an approved adjustment moved it, else the computed one. Both are always shown. */
export const effectiveScore = (line: { score_computed: number | null; score_adjusted: number | null }): number | null => line.score_adjusted ?? line.score_computed;

export const hasAdjustedScore = (line: { score_computed: number | null; score_adjusted: number | null }): boolean => line.score_adjusted !== null && line.score_adjusted !== line.score_computed;

export function scoreText(value: number | null): string {
  if (value === null) return '–';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

export function periodTone(status: PeriodStatus): Tone {
  switch (status) {
    case 'DRAFT':
      return 'neutral';
    case 'LOCKED':
      return 'warning';
    case 'OFFICIAL':
      return 'success';
  }
}

export function periodIcon(status: PeriodStatus): string {
  switch (status) {
    case 'DRAFT':
      return '○';
    case 'LOCKED':
      return '◐';
    case 'OFFICIAL':
      return '✓';
  }
}

export function lineTone(state: LineState): Tone {
  switch (state) {
    case 'RATED':
      return 'success';
    case 'SMALL_SAMPLE':
      return 'warning';
    case 'NOT_RATED':
      return 'neutral';
  }
}

export function lineIcon(state: LineState): string {
  switch (state) {
    case 'RATED':
      return '✓';
    case 'SMALL_SAMPLE':
      return '⚠';
    case 'NOT_RATED':
      return '○';
  }
}

/** A contribution of a task the viewer may not read arrives with no task id (the server masks it): the screen says it is restricted and links nowhere. */
export const isRestricted = (contribution: Pick<Contribution, 'task_id'>): boolean => contribution.task_id === null;

/** The period of a line as the words of two days ("01/10/2026 - 31/12/2026"). */
export const rangeText = (from: string, to: string): string => `${dayText(from)} – ${dayText(to)}`;

// ---- the rows of a scoreboard ---------------------------------------------------------------------------------------------------------------------------------------------

/** Whether the rated people of the rows were judged on different numbers of tasks: such people are never ranked against each other (BR-PWF-36). */
export function ratedSamplesDiffer(rows: readonly Pick<ScoreLineRow, 'rated_task_count' | 'state'>[]): boolean {
  return new Set(rows.filter(isRated).map((row) => row.rated_task_count)).size > 1;
}

/** Why a board shows no places, if it does not: `partial` when the pages loaded are not the whole population (an ordinal place among some of the people would be wrong), `incomparable` when the rated samples differ. */
export type RankingBlock = 'partial' | 'incomparable' | null;

export function rankingBlock(rows: readonly Pick<ScoreLineRow, 'rated_task_count' | 'state'>[], complete: boolean): RankingBlock {
  if (!complete) return 'partial';
  return ratedSamplesDiffer(rows) ? 'incomparable' : null;
}

/**
 * The order of a scoreboard. Places are given only to a COMPLETE population of rated people who were judged on the same sample (BR-PWF-36): then the rated are numbered by score, highest first, and a small sample or
 * an unrated person is listed after them with no place. Otherwise nobody is numbered and the rows stay as the server gave them: a place among the pages loaded so far, or across different samples, would be a ranking
 * nobody may draw.
 */
export function boardOrder(rows: readonly ScoreLineRow[], complete: boolean): Array<{ row: ScoreLineRow; place: number | null }> {
  if (rankingBlock(rows, complete) !== null) return rows.map((row) => ({ row, place: null }));
  const rated = rows.filter(isRated).sort((a, b) => (effectiveScore(b) ?? 0) - (effectiveScore(a) ?? 0) || a.display_name.localeCompare(b.display_name));
  const rest = rows.filter((row) => !isRated(row));
  return [...rated.map((row, at) => ({ row, place: at + 1 })), ...rest.map((row) => ({ row, place: null }))];
}

// ---- who may do what on a line ---------------------------------------------------------------------------------------------------------------------------------------------

export interface LineActions {
  /** The server's `can_request_adjustment`; a frozen session may not. */
  requestAdjustment: boolean;
  /** The server's `can_respond`: only the person scored, inside the window. */
  respond: boolean;
  /** An adjustment that is still requested can be decided by a person who holds the right and is neither who asked nor the person scored. */
  decideAdjustment: (adjustment: Adjustment) => boolean;
  /** An open response is handled by a person who holds the right and is not the person scored. */
  handleResponse: (response: ScoreResponse) => boolean;
  /** Flags are for the reviewers: the person scored never sees them, and neither does anybody without `staff_score.review`. */
  seeFlags: boolean;
}

export function actionsOf(line: ScoreLine, me: string | undefined, permissions: readonly string[] | undefined, readOnly: boolean): LineActions {
  const subject = me !== undefined && line.membership_id === me;
  const approver = mayWrite(permissions, SCORE_PERMISSIONS.approve, readOnly) && !subject;
  return {
    requestAdjustment: line.can_request_adjustment && !readOnly,
    respond: line.can_respond && !readOnly,
    decideAdjustment: (adjustment) => approver && adjustment.status === 'REQUESTED' && adjustment.requested_by !== me,
    handleResponse: (response) => approver && response.status === 'OPEN',
    seeFlags: !subject && mayDo(permissions, SCORE_PERMISSIONS.review),
  };
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------------------------------------------------------

export type ScoreProblemKind =
  | 'versionConflict'
  | 'selfApproval'
  | 'periodOverlap'
  | 'shareInvalid'
  | 'calendarNotEffective'
  | 'periodLocked'
  | 'adjustmentInvalid'
  | 'windowClosed'
  | 'inWorkflow'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

export interface ScoreProblem {
  kind: ScoreProblemKind;
  /** The field the server named. */
  field: string | undefined;
}

const KIND_BY_CODE: Readonly<Record<string, ScoreProblemKind>> = {
  VERSION_CONFLICT: 'versionConflict',
  SELF_APPROVAL_DENIED: 'selfApproval',
  STAFF_SCORE_PERIOD_OVERLAP: 'periodOverlap',
  STAFF_SCORE_SHARE_INVALID: 'shareInvalid',
  CALENDAR_NOT_EFFECTIVE: 'calendarNotEffective',
  STAFF_SCORE_PERIOD_LOCKED: 'periodLocked',
  STAFF_SCORE_ADJUSTMENT_INVALID: 'adjustmentInvalid',
  STAFF_SCORE_RESPONSE_WINDOW_CLOSED: 'windowClosed',
  WORKFLOW_ALREADY_RUNNING: 'inWorkflow',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** What a refused command was refused for; anything the screens have no word for is `general`. */
export function describeScoreProblem(error: unknown): ScoreProblem {
  if (!(error instanceof ApiError)) return { kind: 'general', field: undefined };
  return { kind: KIND_BY_CODE[error.code] ?? (error.status === 404 ? 'notFound' : 'general'), field: error.detail };
}

/** The refusals that say "somebody changed it first": the screen offers to read the newer version. */
export const isScoreConflict = (problem: ScoreProblem): boolean => problem.kind === 'versionConflict';

/** A read that came back 404 (the line is not there, or not for this person: the answer never says which). */
export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

// ---- forms -------------------------------------------------------------------------------------------------------------------------------------------------------------------

const size = (value: string): number => value.trim().length;

export function boundedText(value: string, min: number, max: number): FormProblem | undefined {
  const length = size(value);
  if (length === 0) return 'required';
  if (length < min) return 'tooShort';
  return length > max ? 'tooLong' : undefined;
}

export const responseProblem = (value: string): FormProblem | undefined => boundedText(value, RESPONSE_MIN, RESPONSE_MAX);

export interface AdjustmentForm {
  points: string;
  reason: string;
  evidenceRef: string;
}

export const EMPTY_ADJUSTMENT: AdjustmentForm = { points: '', reason: '', evidenceRef: '' };
export type AdjustmentField = 'points' | 'reason' | 'evidenceRef';
export type AdjustmentProblems = Partial<Record<AdjustmentField, FormProblem>>;

const POINTS = /^[+-]?\d{1,2}(\.\d{1,2})?$/;

/** Points are a signed number with at most two decimals inside the swing the policy allows; zero changes nothing and is refused. */
export function pointsProblem(value: string, ceiling: number): FormProblem | undefined {
  const text = value.trim().replace(',', '.');
  if (text === '') return 'required';
  if (!POINTS.test(text)) return 'invalidNumber';
  const points = Number(text);
  return points === 0 || Math.abs(points) > ceiling ? 'invalidNumber' : undefined;
}

export function validateAdjustment(form: AdjustmentForm, limits: { ceiling: number; reasonMin: number }): AdjustmentProblems {
  const problems: AdjustmentProblems = {};
  const points = pointsProblem(form.points, limits.ceiling);
  if (points !== undefined) problems.points = points;
  const reason = boundedText(form.reason, limits.reasonMin, ADJUSTMENT_REASON_MAX);
  if (reason !== undefined) problems.reason = reason;
  if (form.evidenceRef.trim().length > EVIDENCE_REF_MAX) problems.evidenceRef = 'tooLong';
  return problems;
}

export function adjustmentBody(form: AdjustmentForm): AdjustmentRequest {
  const ref = form.evidenceRef.trim();
  return { points: Number(form.points.trim().replace(',', '.')), reason: form.reason.trim(), ...(ref === '' ? {} : { evidence_ref: ref }) };
}

export type DecisionKind = DecisionBody['decision'];

export function decisionBody(decision: DecisionKind, note: string): DecisionBody | FormProblem {
  const trimmed = note.trim();
  if (decision === 'REJECT' && trimmed === '') return 'required';
  if (trimmed !== '') {
    const problem = boundedText(trimmed, DECISION_NOTE_MIN, DECISION_NOTE_MAX);
    if (problem !== undefined) return problem;
  }
  return { decision, ...(trimmed === '' ? {} : { note: trimmed }) };
}

export interface HandleForm {
  outcome: ResponseHandle['outcome'];
  conclusion: string;
  points: string;
  reason: string;
}

export const EMPTY_HANDLE: HandleForm = { outcome: 'KEEP', conclusion: '', points: '', reason: '' };
export type HandleField = 'conclusion' | 'points' | 'reason';
export type HandleProblems = Partial<Record<HandleField, FormProblem>>;

/** The points and the reason are asked for only when the outcome is ADJUST. */
export function validateHandle(form: HandleForm, limits: { ceiling: number; reasonMin: number }): HandleProblems {
  const problems: HandleProblems = {};
  const conclusion = boundedText(form.conclusion, CONCLUSION_MIN, CONCLUSION_MAX);
  if (conclusion !== undefined) problems.conclusion = conclusion;
  if (form.outcome === 'ADJUST') {
    const points = pointsProblem(form.points, limits.ceiling);
    if (points !== undefined) problems.points = points;
    const reason = boundedText(form.reason, limits.reasonMin, ADJUSTMENT_REASON_MAX);
    if (reason !== undefined) problems.reason = reason;
  }
  return problems;
}

export function handleBody(form: HandleForm): ResponseHandle {
  if (form.outcome === 'KEEP') return { outcome: 'KEEP', conclusion: form.conclusion.trim() };
  return { outcome: 'ADJUST', conclusion: form.conclusion.trim(), adjustment_points: Number(form.points.trim().replace(',', '.')), adjustment_reason: form.reason.trim() };
}

/** The period a new draft is asked for: both days and the code of the policy and the unit. */
export interface PeriodForm {
  unitId: string;
  from: string;
  to: string;
  policy: string;
}

export const EMPTY_PERIOD: PeriodForm = { unitId: '', from: '', to: '', policy: 'DEFAULT' };
export type PeriodField = 'unitId' | 'from' | 'to' | 'policy';
export type PeriodProblems = Partial<Record<PeriodField, FormProblem>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day that exists: the shape alone passes 2026-13-01, and `toISOString` of such a date throws, so the date must be a real one before it is formatted. */
const validDay = (value: string): boolean => {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export function validatePeriod(form: PeriodForm): PeriodProblems {
  const problems: PeriodProblems = {};
  if (!UUID.test(form.unitId.trim())) problems.unitId = 'pickOne';
  const from = form.from.trim();
  const to = form.to.trim();
  if (from === '') problems.from = 'required';
  else if (!validDay(from)) problems.from = 'invalidDay';
  if (to === '') problems.to = 'required';
  else if (!validDay(to) || (problems.from === undefined && to < from)) problems.to = 'invalidDay';
  if (!CODE.test(form.policy.trim())) problems.policy = 'required';
  return problems;
}

export const periodBody = (form: PeriodForm): PeriodRequest => ({ scope_unit_id: form.unitId.trim().toLowerCase(), period_from: form.from.trim(), period_to: form.to.trim(), policy_code: form.policy.trim() });

// ---- export ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The file of an export, from the base64 the server answers with; null when the browser cannot make one. */
export function exportBlob(file: Pick<PeriodExport, 'content_base64' | 'content_type'>): Blob | null {
  if (typeof Blob === 'undefined') return null;
  const bytes = Uint8Array.from(atob(file.content_base64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: file.content_type });
}

// ---- compare -----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The change of the score between two periods that were both rated; a period with a small sample or no rating is never compared with another. */
export function changeBetween(previous: ComparisonPoint | undefined, next: ComparisonPoint): number | null {
  if (previous === undefined || previous.state !== 'RATED' || next.state !== 'RATED') return null;
  const before = effectiveScore(previous);
  const after = effectiveScore(next);
  if (before === null || after === null) return null;
  return Math.round((after - before) * 100) / 100;
}
