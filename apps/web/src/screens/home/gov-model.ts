import { ApiError } from '@machvon/api-client';
import { DRILL_PATH, MY_WORK_PATH, WARNINGS_PATH } from './model';

/**
 * The analytics governance of HOME (lane C): "what changed since last week" (G3-4), the explainable colours (G3-2) and the file of the figures (G0-4). Every reader here is tolerant of what the server sends
 * and strict about what it must not invent: a line with no sentence, a colour with no name or a unit with no id is not shown, and a missing number is never turned into 0.
 */

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);
/** A number as the server sent it (a JSON number, or a decimal text); anything else is no number. */
const numberOf = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
};

export const RANKING_PATH = '/home/home-04';
export const RAG_PATH = '/home/home-11';
export const OVERRIDE_PERMISSION = 'home.rag.override';
export const SCORE_PERMISSION = 'home.rag.score';

// ---- what changed since last week ------------------------------------------------------------------------------------------------------------------

export const CHANGE_KINDS = ['UNITS_TO_RED', 'RATE_CHANGE', 'WARNINGS_DELTA', 'DISBURSED_WEEK', 'OVERDUE_DELTA', 'NO_DATA_DELTA', 'UNITS_RECOVERED'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
/** The numbers each kind of line needs for its sentence. */
export const CHANGE_PARAMS: Record<ChangeKind, readonly string[]> = {
  UNITS_TO_RED: ['count'],
  UNITS_RECOVERED: ['count'],
  RATE_CHANGE: ['from', 'to', 'delta'],
  WARNINGS_DELTA: ['from', 'to', 'delta'],
  OVERDUE_DELTA: ['from', 'to', 'delta'],
  NO_DATA_DELTA: ['from', 'to', 'delta'],
  DISBURSED_WEEK: ['amount_vnd'],
};
export const CHANGE_LINKS = ['DRILL', 'RAG', 'WARNINGS', 'MY_WORK', 'RANKING'] as const;
export type ChangeLink = (typeof CHANGE_LINKS)[number];
/** The most lines the block says: a leader reads five, not fifty. */
export const MAX_CHANGE_LINES = 5;

export interface ChangeLine {
  kind: ChangeKind;
  direction: 'UP' | 'DOWN';
  /** The numbers of the sentence, as the server wrote them (text), keyed by name. */
  params: Record<string, string>;
  link: ChangeLink;
  metricCode: string | null;
  contextToken: string | null;
}

export interface Changes {
  snapshotId: string;
  asOfDate: string;
  weekStart: string;
  previousWeekStart: string;
  previousAsOfDate: string | null;
  /** NO_PREVIOUS_WEEK: there is no week before to compare with (it is not "nothing changed"). */
  reason: 'NO_PREVIOUS_WEEK' | null;
  lines: ChangeLine[];
}

function toChangeLine(raw: unknown): ChangeLine | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = oneOf(raw.kind, CHANGE_KINDS);
  const link = oneOf(raw.link, CHANGE_LINKS);
  const direction = raw.direction === 'UP' || raw.direction === 'DOWN' ? raw.direction : undefined;
  // A line the screen has no sentence for is not said: no number is shown that nobody can read.
  if (kind === undefined || link === undefined || direction === undefined) return undefined;
  const params: Record<string, string> = {};
  if (isRecord(raw.params)) for (const [key, value] of Object.entries(raw.params)) if (typeof value === 'string' || typeof value === 'number') params[key] = String(value);
  // A sentence whose numbers are not all there is not said (never a placeholder, never a number made up).
  if (CHANGE_PARAMS[kind].some((key) => params[key] === undefined || params[key] === '')) return undefined;
  return { kind, direction, params, link, metricCode: nullableText(raw.metric_code), contextToken: nullableText(raw.context_token) };
}

/** The changes since last week as the block reads them, or undefined when the answer is not one (no snapshot named). */
export function toChanges(raw: unknown): Changes | undefined {
  if (!isRecord(raw) || text(raw.snapshot_id) === '' || !Array.isArray(raw.lines)) return undefined;
  return {
    snapshotId: text(raw.snapshot_id),
    asOfDate: text(raw.as_of_date),
    weekStart: text(raw.week_start),
    previousWeekStart: text(raw.previous_week_start),
    previousAsOfDate: nullableText(raw.previous_as_of_date),
    reason: raw.reason === 'NO_PREVIOUS_WEEK' ? 'NO_PREVIOUS_WEEK' : null,
    lines: raw.lines.flatMap((line) => toChangeLine(line) ?? []).slice(0, MAX_CHANGE_LINES),
  };
}

/** The magnitude of a change as text: the direction says up or down, so the sign of a delta is not said twice. */
export const magnitudeOf = (value: string | undefined): string => (value ?? '').replace(/^[+-]/, '');

/** The path a line links to, with the token of its figure for a drill. A drill line without its token has no link (a link that opens nothing is worse than none). */
export function changePathOf(line: Pick<ChangeLine, 'link' | 'contextToken'>): string | undefined {
  switch (line.link) {
    case 'DRILL':
      return line.contextToken === null || line.contextToken === '' ? undefined : `${DRILL_PATH}?${new URLSearchParams({ token: line.contextToken }).toString()}`;
    case 'RAG':
      return RAG_PATH;
    case 'WARNINGS':
      return WARNINGS_PATH;
    case 'MY_WORK':
      return MY_WORK_PATH;
    case 'RANKING':
      return RANKING_PATH;
  }
}

export type ChangesProblem = 'noSnapshot' | 'denied' | 'error';

/** What a failure of the changes block is: nothing frozen yet (404) and a refusal (403) are their own words; any other failure is a failure, never "no change". */
export function describeChanges(error: unknown): ChangesProblem {
  if (error instanceof ApiError && error.code === 'RESOURCE_NOT_FOUND') return 'noSnapshot';
  if (error instanceof ApiError && (error.status === 403 || error.code === 'SCOPE_DENIED')) return 'denied';
  return 'error';
}

// ---- the explainable colours -----------------------------------------------------------------------------------------------------------------------

export const RAG_BANDS = ['RED', 'AMBER', 'GREEN', 'NO_DATA'] as const;
export type RagBand = (typeof RAG_BANDS)[number];
export const OVERRIDE_BANDS = ['RED', 'AMBER', 'GREEN'] as const;
export type OverrideBand = (typeof OVERRIDE_BANDS)[number];
export const FACTOR_CODES = ['EWS_RATE_VS_PACE', 'EWS_CRITICAL_WARNINGS', 'EWS_OVERDUE_EXPLANATIONS', 'EWS_NO_DATA_SHARE'] as const;
/** How many weeks the trend keeps. */
export const TREND_WEEKS = 8;

export interface RagFactor {
  code: string;
  value: number | null;
  band: RagBand;
  /** What the factor adds to the score of 100: the higher the score, the worse the unit. */
  points: number;
  weight: number;
  direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  green: number;
  amber: number;
}

export interface RagOverride {
  band: OverrideBand;
  ruleBand: RagBand | null;
  reason: string;
  until: string;
  by: string;
  at: string | null;
}

export interface RagWeek {
  weekStart: string;
  score: number | null;
  band: RagBand;
}

export interface RagUnit {
  unitId: string;
  code: string;
  name: string;
  /** The colour that is shown: the override while it lasts, else the colour of the rules. */
  band: RagBand;
  ruleBand: RagBand;
  overridden: boolean;
  override: RagOverride | null;
  /** 0 to 100 (the higher the worse), or null: too little data for a score (never shown as 0). */
  score: number | null;
  coveragePct: number | null;
  noDataReason: string | null;
  factors: RagFactor[];
  reasons: RagFactor[];
  projects: number;
  previous: RagWeek | null;
  trend: RagWeek[];
}

export interface RagModelView {
  unverified: boolean;
  minCoveragePct: number | null;
  scoreGreen: number | null;
  scoreAmber: number | null;
}

export interface RagReading {
  snapshotId: string;
  asOfDate: string;
  weekStart: string;
  model: RagModelView;
  summary: Record<RagBand, number>;
  units: RagUnit[];
}

const band = (value: unknown): RagBand | undefined => oneOf(value, RAG_BANDS);

function toFactor(raw: unknown): RagFactor | undefined {
  if (!isRecord(raw) || text(raw.code) === '') return undefined;
  const direction = raw.direction === 'LOWER_IS_BETTER' ? 'LOWER_IS_BETTER' : 'HIGHER_IS_BETTER';
  const green = numberOf(raw.green);
  const amber = numberOf(raw.amber);
  if (green === null || amber === null) return undefined;
  return { code: text(raw.code), value: numberOf(raw.value), band: band(raw.band) ?? 'NO_DATA', points: numberOf(raw.points) ?? 0, weight: numberOf(raw.weight) ?? 0, direction, green, amber };
}

function toWeek(raw: unknown): RagWeek | undefined {
  if (!isRecord(raw) || text(raw.week_start) === '') return undefined;
  return { weekStart: text(raw.week_start), score: numberOf(raw.score), band: band(raw.band) ?? 'NO_DATA' };
}

function toOverride(raw: unknown): RagOverride | null {
  if (!isRecord(raw)) return null;
  const chosen = oneOf(raw.band, OVERRIDE_BANDS);
  if (chosen === undefined) return null;
  return { band: chosen, ruleBand: band(raw.rule_band) ?? null, reason: text(raw.reason), until: text(raw.until), by: text(raw.by), at: nullableText(raw.at) };
}

function toRagUnit(raw: unknown): RagUnit | undefined {
  if (!isRecord(raw) || text(raw.unit_id) === '') return undefined;
  const shown = band(raw.band);
  // A unit with no colour named is not a unit of this screen: it is neither green nor anything else.
  if (shown === undefined) return undefined;
  const score = numberOf(raw.score);
  return {
    unitId: text(raw.unit_id),
    code: text(raw.code),
    name: text(raw.name),
    band: shown,
    ruleBand: band(raw.rule_band) ?? shown,
    overridden: raw.overridden === true,
    override: toOverride(raw.override),
    // No data means no score: a score that arrives with it is not believed (never a 0 beside "chưa đủ dữ liệu").
    score: shown === 'NO_DATA' ? null : score,
    coveragePct: numberOf(raw.coverage_pct),
    noDataReason: nullableText(raw.no_data_reason),
    factors: (Array.isArray(raw.factors) ? raw.factors : []).flatMap((factor) => toFactor(factor) ?? []),
    reasons: (Array.isArray(raw.reasons) ? raw.reasons : []).flatMap((factor) => toFactor(factor) ?? []).slice(0, 3),
    projects: numberOf(raw.projects) ?? 0,
    previous: toWeek(raw.previous) ?? null,
    trend: (Array.isArray(raw.trend) ? raw.trend : []).flatMap((week) => toWeek(week) ?? []).slice(-TREND_WEEKS),
  };
}

const RANK: Record<RagBand, number> = { RED: 0, AMBER: 1, NO_DATA: 2, GREEN: 3 };

/** Red first, then amber, then the units that cannot be judged yet, then green; the order the server gave is kept inside each colour. */
export const redFirst = (units: readonly RagUnit[]): RagUnit[] => units.map((unit, index) => ({ unit, index })).sort((left, right) => RANK[left.unit.band] - RANK[right.unit.band] || left.index - right.index).map((entry) => entry.unit);

export function toRagReading(raw: unknown): RagReading | undefined {
  if (!isRecord(raw) || text(raw.snapshot_id) === '' || !Array.isArray(raw.units)) return undefined;
  const model = isRecord(raw.model) ? raw.model : {};
  const units = redFirst(raw.units.flatMap((unit) => toRagUnit(unit) ?? []));
  const given = isRecord(raw.summary) ? raw.summary : {};
  // The summary is counted from the units that are shown when the server did not give one (a count that is not there is not 0 of anything).
  const summary = Object.fromEntries(RAG_BANDS.map((each) => [each, numberOf(given[each]) ?? units.filter((unit) => unit.band === each).length])) as Record<RagBand, number>;
  return {
    snapshotId: text(raw.snapshot_id),
    asOfDate: text(raw.as_of_date),
    weekStart: text(raw.week_start),
    model: { unverified: model.unverified === true, minCoveragePct: numberOf(model.min_coverage_pct), scoreGreen: numberOf(model.score_green), scoreAmber: numberOf(model.score_amber) },
    summary,
    units,
  };
}

/** The factor code as an i18n key suffix, or undefined for a factor the screen has no name for (it is then shown by its code, not hidden). */
export const factorKnown = (code: string): boolean => (FACTOR_CODES as readonly string[]).includes(code);

/** The change of the score against the week before, in points: positive is worse (a higher score is a higher risk). Null when either week has no score. */
export function scoreDelta(unit: Pick<RagUnit, 'score' | 'previous'>): number | null {
  if (unit.score === null || unit.previous === null || unit.previous.score === null) return null;
  return Math.round((unit.score - unit.previous.score) * 100) / 100;
}

export type RagProblem = 'noSnapshot' | 'denied' | 'error';

/** What a failure of the colours screen is: no frozen snapshot (404) and a refusal (403) are words of their own; anything else is an error to retry. */
export function describeRag(error: unknown): RagProblem {
  if (error instanceof ApiError && error.code === 'RESOURCE_NOT_FOUND') return 'noSnapshot';
  if (error instanceof ApiError && (error.status === 403 || error.code === 'SCOPE_DENIED')) return 'denied';
  return 'error';
}

/** A refusal of the right (403, scope or permission): shown as "denied", never as a failure to try again. */
export const isRefused = (error: unknown): boolean => error instanceof ApiError && (error.status === 403 || error.code === 'SCOPE_DENIED' || error.code === 'PERMISSION_DENIED');

export const OVERRIDE_REASON_MIN = 10;
export const OVERRIDE_REASON_MAX = 500;
export const OVERRIDE_MAX_DAYS = 90;

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The days an override may last until: after today, at most 90 days ahead (the server judges it again). */
export const overrideWindow = (today: string): { min: string; max: string } => ({ min: addDays(today, 1), max: addDays(today, OVERRIDE_MAX_DAYS) });

export type OverrideField = 'band' | 'reason' | 'until';

/** Whether a reason is the length the server asks (10 to 500 characters). */
export const reasonOk = (reason: string): boolean => reason.trim().length >= OVERRIDE_REASON_MIN && reason.trim().length <= OVERRIDE_REASON_MAX;

/** What is wrong with the colour and the last day of an override before it is asked for: the colour must be one of the three and differ from the rules' own, the last day is after today and at most 90 days ahead. */
export function checkOverrideTarget(input: { band: string; until: string }, ruleBand: RagBand, today: string): Array<'band' | 'until'> {
  const problems: Array<'band' | 'until'> = [];
  if (oneOf(input.band, OVERRIDE_BANDS) === undefined || input.band === ruleBand) problems.push('band');
  const window = overrideWindow(today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until) || input.until < window.min || input.until > window.max) problems.push('until');
  return problems;
}

/** What is wrong with an override before it is sent, by field: the target as above, and the reason (10 to 500 characters). */
export function checkOverride(input: { band: string; reason: string; until: string }, ruleBand: RagBand, today: string): OverrideField[] {
  const problems: OverrideField[] = checkOverrideTarget(input, ruleBand, today);
  if (!reasonOk(input.reason)) problems.push('reason');
  return problems;
}

export const withdrawReasonOk = reasonOk;

// ---- the file of the figures -----------------------------------------------------------------------------------------------------------------------

export interface FiguresFile {
  fileName: string;
  mediaType: string;
  format: 'CSV' | 'XLSX';
  rows: number;
  sizeBytes: number;
  sha256: string;
  contentBase64: string;
}

export function toFiguresFile(raw: unknown): FiguresFile | undefined {
  if (!isRecord(raw)) return undefined;
  const format = oneOf(raw.format, ['CSV', 'XLSX'] as const);
  if (format === undefined || text(raw.file_name) === '' || text(raw.content_base64) === '') return undefined;
  return { fileName: text(raw.file_name), mediaType: text(raw.media_type) === '' ? 'application/octet-stream' : text(raw.media_type), format, rows: numberOf(raw.rows) ?? 0, sizeBytes: numberOf(raw.size_bytes) ?? 0, sha256: text(raw.sha256), contentBase64: text(raw.content_base64) };
}

/** The bytes of a base64 text. */
export function bytesOfBase64(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Hands the file to the browser as a download (a Blob and an address that lives for the click; no server is asked again). False when the browser cannot make the address. */
export function downloadFile(file: FiguresFile): boolean {
  if (typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(new Blob([bytesOfBase64(file.contentBase64) as BlobPart], { type: file.mediaType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}
