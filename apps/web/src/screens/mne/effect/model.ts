import { ApiError } from '@machvon/api-client';

/*
 * MNE-11 (MR-1, MR.03): the effectiveness of a project after the investment. Every parser keeps only the fields it lists (an allowlist), keeps a figure the server could not know as null (never zero), and keeps the decimals
 * as the strings that came: the variance, the achievement and the band are computed by the server, the browser never recomputes them. Nothing here does arithmetic on a measured value.
 */

export const DIRECTIONS = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const BANDS = ['MET', 'PARTIAL', 'MISSED', 'NOT_MEASURED'] as const;
export type Band = (typeof BANDS)[number];
export const CONCLUSIONS = ['SATISFACTORY', 'PARTIALLY_SATISFACTORY', 'UNSATISFACTORY'] as const;
export type Conclusion = (typeof CONCLUSIONS)[number];
export const EVALUATION_KINDS = ['INITIAL', 'MIDTERM', 'FINAL', 'IMPACT'] as const;
export type EvaluationKind = (typeof EVALUATION_KINDS)[number];
export const ASSESSMENT_KINDS = [...EVALUATION_KINDS, 'AD_HOC'] as const;
export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number];
export const ANCHORS = ['IMPLEMENTATION_START', 'COMPLETION', 'HANDOVER'] as const;
export type Anchor = (typeof ANCHORS)[number];
export const CALENDAR_STATES = ['DONE', 'OVERDUE', 'DUE_SOON', 'UPCOMING'] as const;
export type CalendarState = (typeof CALENDAR_STATES)[number];
export type BasisKind = 'BASELINE_TO_TARGET' | 'RATIO' | 'DIRECTION_ONLY' | 'NONE';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const num = (value: unknown): number => numOrNull(value) ?? 0;
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const rec = (value: unknown): Raw => (isRecord(value) ? value : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const pick = <T extends string>(options: readonly T[], value: unknown): T | undefined => options.find((option) => option === value);

export interface Person {
  membershipId: string;
  displayName: string | null;
}

const toPerson = (raw: unknown): Person | null => (isRecord(raw) && str(raw.membership_id) !== '' ? { membershipId: str(raw.membership_id), displayName: strOrNull(raw.display_name) } : null);

/** The name a person is shown by: the display name, or the first eight characters of the id when the directory has none. */
export const personName = (person: Person | null): string => (person === null ? '' : (person.displayName ?? person.membershipId.slice(0, 8)));

// ---- the rule ("i") -------------------------------------------------------------------------------------------------------------

export interface Policy {
  name: string;
  code: string;
  formula: string | null;
  source: string | null;
  asOf: string | null;
  legalStatus: string;
  unverified: boolean;
  version: string;
  owner: string;
  metAtPct: number | null;
  partlyAtPct: number | null;
  draftStatuses: string[];
  fixStatuses: string[];
  measureStatuses: string[];
}

function toPolicy(raw: unknown): Policy {
  const policy = rec(raw);
  const params = rec(policy.params);
  return {
    name: str(policy.name),
    code: str(policy.code),
    formula: strOrNull(policy.formula),
    source: strOrNull(policy.source),
    asOf: strOrNull(policy.as_of),
    legalStatus: str(policy.legal_status),
    // A rule that does not say it is verified is treated as not verified.
    unverified: policy.unverified !== false,
    version: str(policy.version),
    owner: str(policy.owner),
    metAtPct: numOrNull(params.met_at_pct),
    partlyAtPct: numOrNull(params.partly_at_pct),
    draftStatuses: strings(params.draft_statuses),
    fixStatuses: strings(params.fix_statuses),
    measureStatuses: strings(params.measure_statuses),
  };
}

// ---- the target sets ------------------------------------------------------------------------------------------------------------

export interface Actual {
  measurementId: string;
  value: string;
  measuredOn: string;
  methodNote: string;
  evidenceDocumentId: string | null;
  recordedAt: string;
}

export interface Variance {
  varianceValue: string | null;
  variancePct: string | null;
  achievementPct: string | null;
  basis: BasisKind;
  band: Band;
}

export interface Indicator {
  id: string;
  code: string;
  name: string;
  unit: string;
  direction: Direction;
  baselineValue: string | null;
  baselineOn: string | null;
  targetValue: string;
  measureAfterMonths: number | null;
  dataSource: string;
  formula: string;
  actual: Actual | null;
  variance: Variance;
}

export interface TargetSet {
  id: string;
  versionNo: number;
  status: 'DRAFT' | 'FIXED' | 'SUPERSEDED';
  basis: string;
  basisDocumentId: string | null;
  supersedesId: string | null;
  supersedeReason: string | null;
  draftedBy: Person | null;
  draftedAt: string;
  fixedBy: Person | null;
  fixedAt: string | null;
  fixedOn: string | null;
  version: number;
  indicators: Indicator[];
}

const BASES: readonly BasisKind[] = ['BASELINE_TO_TARGET', 'RATIO', 'DIRECTION_ONLY', 'NONE'];

function toIndicator(raw: Raw): Indicator {
  const variance = rec(raw.variance);
  const actual = isRecord(raw.actual) ? raw.actual : undefined;
  return {
    id: str(raw.id),
    code: str(raw.code),
    name: str(raw.name),
    unit: str(raw.unit),
    direction: pick(DIRECTIONS, raw.direction) ?? 'HIGHER_IS_BETTER',
    baselineValue: strOrNull(raw.baseline_value),
    baselineOn: strOrNull(raw.baseline_on),
    targetValue: str(raw.target_value),
    measureAfterMonths: numOrNull(raw.measure_after_months),
    dataSource: str(raw.data_source),
    formula: str(raw.formula),
    actual:
      actual === undefined
        ? null
        : { measurementId: str(actual.measurement_id), value: str(actual.value), measuredOn: str(actual.measured_on), methodNote: str(actual.method_note), evidenceDocumentId: strOrNull(actual.evidence_document_id), recordedAt: str(actual.recorded_at) },
    variance: {
      varianceValue: strOrNull(variance.variance_value),
      variancePct: strOrNull(variance.variance_pct),
      achievementPct: strOrNull(variance.achievement_pct),
      basis: pick(BASES, variance.basis) ?? 'NONE',
      band: pick(BANDS, variance.band) ?? 'NOT_MEASURED',
    },
  };
}

function toSet(raw: unknown): TargetSet | null {
  if (!isRecord(raw) || str(raw.id) === '') return null;
  return {
    id: str(raw.id),
    versionNo: num(raw.version_no),
    status: raw.status === 'FIXED' ? 'FIXED' : raw.status === 'SUPERSEDED' ? 'SUPERSEDED' : 'DRAFT',
    basis: str(raw.basis),
    basisDocumentId: strOrNull(raw.basis_document_id),
    supersedesId: strOrNull(raw.supersedes_id),
    supersedeReason: strOrNull(raw.supersede_reason),
    draftedBy: toPerson(raw.drafted_by),
    draftedAt: str(raw.drafted_at),
    fixedBy: toPerson(raw.fixed_by),
    fixedAt: strOrNull(raw.fixed_at),
    fixedOn: strOrNull(raw.fixed_on),
    version: num(raw.version),
    indicators: list(raw.indicators).map(toIndicator),
  };
}

// ---- the history, the calendar, the assessments ---------------------------------------------------------------------------------

export interface Measurement {
  id: string;
  indicatorCode: string;
  measuredOn: string;
  value: string;
  methodNote: string;
  evidenceDocumentId: string | null;
  correctsId: string | null;
  correctionReason: string | null;
  /** A later row corrects this one. */
  corrected: boolean;
  recordedBy: Person | null;
  recordedAt: string;
}

export interface CalendarEntry {
  id: string;
  kind: EvaluationKind;
  anchor: Anchor;
  anchorOn: string;
  months: number;
  dueOn: string;
  required: boolean;
  status: 'PLANNED' | 'DONE';
  state: CalendarState;
  daysLate: number;
  assessmentId: string | null;
  ruleCode: string;
  ruleVersion: string;
  ruleUnverified: boolean;
}

export interface FrozenLine {
  code: string;
  name: string;
  unit: string;
  direction: Direction;
  baselineValue: string | null;
  targetValue: string;
  actualValue: string | null;
  measuredOn: string | null;
  varianceValue: string | null;
  variancePct: string | null;
  achievementPct: string | null;
  band: Band;
}

export interface Assessment {
  id: string;
  kind: AssessmentKind;
  status: 'SUBMITTED' | 'APPROVED' | 'RETURNED';
  asOf: string;
  conclusion: Conclusion;
  summary: string;
  lines: FrozenLine[];
  policyVersion: string;
  policyUnverified: boolean;
  calendarEntryId: string | null;
  submittedBy: Person | null;
  submittedAt: string;
  decidedBy: Person | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export interface Can {
  draft: boolean;
  fix: boolean;
  measure: boolean;
  generateCalendar: boolean;
  assess: boolean;
  decide: boolean;
}

export interface EffectView {
  project: { id: string; code: string; name: string; status: string; projectGroup: string | null };
  policy: Policy;
  fixed: TargetSet | null;
  draft: TargetSet | null;
  superseded: Array<{ id: string; versionNo: number; fixedOn: string | null }>;
  measurements: Measurement[];
  calendar: CalendarEntry[];
  assessments: Assessment[];
  suggestedConclusion: Conclusion | null;
  can: Can;
  asOf: string;
}

export function toEffectView(raw: unknown): EffectView | undefined {
  if (!isRecord(raw) || !isRecord(raw.project) || str(raw.project.id) === '') return undefined;
  const can = rec(raw.can);
  return {
    project: { id: str(raw.project.id), code: str(raw.project.code), name: str(raw.project.name), status: str(raw.project.status), projectGroup: strOrNull(raw.project.project_group) },
    policy: toPolicy(raw.policy),
    fixed: toSet(raw.fixed),
    draft: toSet(raw.draft),
    superseded: list(raw.superseded).map((item) => ({ id: str(item.id), versionNo: num(item.version_no), fixedOn: strOrNull(item.fixed_on) })),
    measurements: list(raw.measurements).map((item) => ({
      id: str(item.id),
      indicatorCode: str(item.indicator_code),
      measuredOn: str(item.measured_on),
      value: str(item.value),
      methodNote: str(item.method_note),
      evidenceDocumentId: strOrNull(item.evidence_document_id),
      correctsId: strOrNull(item.corrects_id),
      correctionReason: strOrNull(item.correction_reason),
      corrected: item.corrected === true,
      recordedBy: toPerson(item.recorded_by),
      recordedAt: str(item.recorded_at),
    })),
    calendar: list(raw.calendar).flatMap((item): CalendarEntry[] => {
      const kind = pick(EVALUATION_KINDS, item.kind);
      if (kind === undefined || str(item.id) === '') return [];
      return [
        {
          id: str(item.id),
          kind,
          anchor: pick(ANCHORS, item.anchor) ?? 'IMPLEMENTATION_START',
          anchorOn: str(item.anchor_on),
          months: num(item.months),
          dueOn: str(item.due_on),
          required: item.required === true,
          status: item.status === 'DONE' ? 'DONE' : 'PLANNED',
          state: pick(CALENDAR_STATES, item.state) ?? 'UPCOMING',
          daysLate: num(item.days_late),
          assessmentId: strOrNull(item.assessment_id),
          ruleCode: str(item.rule_code),
          ruleVersion: str(item.rule_version),
          ruleUnverified: item.rule_unverified !== false,
        },
      ];
    }),
    assessments: list(raw.assessments).flatMap((item): Assessment[] => {
      const kind = pick(ASSESSMENT_KINDS, item.kind);
      if (kind === undefined || str(item.id) === '') return [];
      return [
        {
          id: str(item.id),
          kind,
          status: item.status === 'APPROVED' ? 'APPROVED' : item.status === 'RETURNED' ? 'RETURNED' : 'SUBMITTED',
          asOf: str(item.as_of),
          conclusion: pick(CONCLUSIONS, item.conclusion) ?? 'PARTIALLY_SATISFACTORY',
          summary: str(item.summary),
          lines: list(item.lines).map(toFrozenLine),
          policyVersion: str(item.policy_version),
          policyUnverified: item.policy_unverified !== false,
          calendarEntryId: strOrNull(item.calendar_entry_id),
          submittedBy: toPerson(item.submitted_by),
          submittedAt: str(item.submitted_at),
          decidedBy: toPerson(item.decided_by),
          decidedAt: strOrNull(item.decided_at),
          decisionReason: strOrNull(item.decision_reason),
          version: num(item.version),
        },
      ];
    }),
    suggestedConclusion: pick(CONCLUSIONS, raw.suggested_conclusion) ?? null,
    can: { draft: can.draft === true, fix: can.fix === true, measure: can.measure === true, generateCalendar: can.generate_calendar === true, assess: can.assess === true, decide: can.decide === true },
    asOf: str(raw.as_of),
  };
}

function toFrozenLine(raw: Raw): FrozenLine {
  return {
    code: str(raw.code),
    name: str(raw.name),
    unit: str(raw.unit),
    direction: pick(DIRECTIONS, raw.direction) ?? 'HIGHER_IS_BETTER',
    baselineValue: strOrNull(raw.baseline_value),
    targetValue: str(raw.target_value),
    actualValue: strOrNull(raw.actual_value),
    measuredOn: strOrNull(raw.measured_on),
    varianceValue: strOrNull(raw.variance_value),
    variancePct: strOrNull(raw.variance_pct),
    achievementPct: strOrNull(raw.achievement_pct),
    band: pick(BANDS, raw.band) ?? 'NOT_MEASURED',
  };
}

/** The measurements of one indicator, newest first (by the day measured, then by the moment written). */
export const measurementsNewestFirst = (rows: readonly Measurement[]): Measurement[] =>
  [...rows].sort((a, b) => (a.measuredOn === b.measuredOn ? b.recordedAt.localeCompare(a.recordedAt) : b.measuredOn.localeCompare(a.measuredOn)));

/** The entries of the calendar in the order they fall due. */
export const calendarByDue = (rows: readonly CalendarEntry[]): CalendarEntry[] => [...rows].sort((a, b) => a.dueOn.localeCompare(b.dueOn));

/** Why a computed figure is empty, as a code the screen has a word for: no measurement yet, a target of zero, or a baseline equal to the target. */
export type NaReason = 'NO_MEASUREMENT' | 'TARGET_ZERO' | 'BASELINE_EQUALS_TARGET' | 'NOT_COMPUTABLE';

export function naReason(variance: Variance, which: 'variance' | 'achievement'): NaReason {
  if (variance.basis === 'NONE' || variance.band === 'NOT_MEASURED') return 'NO_MEASUREMENT';
  if (which === 'variance') return 'TARGET_ZERO';
  return variance.basis === 'DIRECTION_ONLY' ? 'BASELINE_EQUALS_TARGET' : 'NOT_COMPUTABLE';
}

// ---- the calendar answer --------------------------------------------------------------------------------------------------------

export interface CalendarResult {
  created: Array<{ kind: EvaluationKind; dueOn: string; anchor: Anchor; anchorOn: string }>;
  waiting: Array<{ kind: EvaluationKind; anchor: Anchor }>;
  ruleUnverified: boolean;
}

export function toCalendarResult(raw: unknown): CalendarResult {
  const answer = rec(raw);
  return {
    created: list(answer.created).flatMap((item) => {
      const kind = pick(EVALUATION_KINDS, item.kind);
      return kind === undefined ? [] : [{ kind, dueOn: str(item.due_on), anchor: pick(ANCHORS, item.anchor) ?? 'IMPLEMENTATION_START', anchorOn: str(item.anchor_on) }];
    }),
    waiting: list(answer.waiting).flatMap((item) => {
      const kind = pick(EVALUATION_KINDS, item.kind);
      return kind === undefined ? [] : [{ kind, anchor: pick(ANCHORS, item.anchor) ?? 'IMPLEMENTATION_START' }];
    }),
    ruleUnverified: rec(answer.rule).unverified !== false,
  };
}

// ---- the forms ------------------------------------------------------------------------------------------------------------------

export const DECIMAL = /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string): boolean => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** A decimal as typed: spaces trimmed and the comma of the Vietnamese keyboard read as the point. It is the same text, never a number. */
export const decimalText = (value: string): string => value.trim().replace(',', '.');

export type FormProblem = 'required' | 'invalid' | 'short';

export interface IndicatorForm {
  code: string;
  name: string;
  unit: string;
  direction: Direction;
  baselineValue: string;
  baselineOn: string;
  targetValue: string;
  measureAfterMonths: string;
  dataSource: string;
  formula: string;
}

export const EMPTY_INDICATOR: IndicatorForm = { code: '', name: '', unit: '', direction: 'HIGHER_IS_BETTER', baselineValue: '', baselineOn: '', targetValue: '', measureAfterMonths: '', dataSource: '', formula: '' };

export interface DraftForm {
  basis: string;
  basisDocumentId: string;
  supersedeReason: string;
  indicators: IndicatorForm[];
}

export const MAX_INDICATORS = 40;

/** A new draft starts from the set that stands (its indicators are copied, so a revision changes what must change) or from one empty row. */
export function draftFormOf(from: TargetSet | null): DraftForm {
  return {
    basis: from?.basis ?? '',
    basisDocumentId: from?.basisDocumentId ?? '',
    supersedeReason: '',
    indicators:
      from === null || from.indicators.length === 0
        ? [{ ...EMPTY_INDICATOR }]
        : from.indicators.map((line) => ({
            code: line.code,
            name: line.name,
            unit: line.unit,
            direction: line.direction,
            baselineValue: line.baselineValue ?? '',
            baselineOn: line.baselineOn ?? '',
            targetValue: line.targetValue,
            measureAfterMonths: line.measureAfterMonths === null ? '' : String(line.measureAfterMonths),
            dataSource: line.dataSource,
            formula: line.formula,
          })),
  };
}

export type IndicatorField = keyof IndicatorForm;
export interface DraftProblems {
  basis?: FormProblem;
  basisDocumentId?: FormProblem;
  supersedeReason?: FormProblem;
  indicators?: FormProblem;
  rows: Array<Partial<Record<IndicatorField, FormProblem>>>;
}

const lengthProblem = (value: string, min: number, max: number): FormProblem | undefined => (value.trim() === '' ? 'required' : value.trim().length < min ? 'short' : value.trim().length > max ? 'invalid' : undefined);

/** The checks the server makes again; a form that fails any of them is not sent. `needsReason` is true when a fixed set stands (a revision says why). */
export function validateDraft(form: DraftForm, needsReason: boolean): DraftProblems {
  const problems: DraftProblems = { rows: [] };
  const basis = lengthProblem(form.basis, 3, 500);
  if (basis !== undefined) problems.basis = basis;
  if (form.basisDocumentId.trim() !== '' && !UUID.test(form.basisDocumentId.trim())) problems.basisDocumentId = 'invalid';
  if (needsReason) {
    const reason = lengthProblem(form.supersedeReason, 10, 2000);
    if (reason !== undefined) problems.supersedeReason = reason;
  }
  if (form.indicators.length < 1 || form.indicators.length > MAX_INDICATORS) problems.indicators = 'invalid';
  const seen = new Set<string>();
  problems.rows = form.indicators.map((row) => {
    const found: Partial<Record<IndicatorField, FormProblem>> = {};
    const code = row.code.trim();
    if (code === '') found.code = 'required';
    else if (!CODE.test(code) || seen.has(code)) found.code = 'invalid';
    seen.add(code);
    const name = lengthProblem(row.name, 3, 200);
    if (name !== undefined) found.name = name;
    if (row.unit.trim() === '') found.unit = 'required';
    else if (row.unit.trim().length > 40) found.unit = 'invalid';
    if (row.baselineValue.trim() !== '' && !DECIMAL.test(decimalText(row.baselineValue))) found.baselineValue = 'invalid';
    if (row.baselineOn !== '' && !isDay(row.baselineOn)) found.baselineOn = 'invalid';
    if (row.targetValue.trim() === '') found.targetValue = 'required';
    else if (!DECIMAL.test(decimalText(row.targetValue))) found.targetValue = 'invalid';
    if (row.measureAfterMonths.trim() !== '' && !(/^\d{1,3}$/.test(row.measureAfterMonths.trim()) && Number(row.measureAfterMonths) <= 240)) found.measureAfterMonths = 'invalid';
    const source = lengthProblem(row.dataSource, 3, 500);
    if (source !== undefined) found.dataSource = source;
    const formula = lengthProblem(row.formula, 3, 500);
    if (formula !== undefined) found.formula = formula;
    return found;
  });
  return problems;
}

export const hasProblems = (problems: DraftProblems): boolean =>
  problems.basis !== undefined || problems.basisDocumentId !== undefined || problems.supersedeReason !== undefined || problems.indicators !== undefined || problems.rows.some((row) => Object.keys(row).length > 0);

/** The body of a draft: only what was written is sent (an empty optional field is left out, never sent as an empty text). */
export function draftBody(form: DraftForm, needsReason: boolean): Record<string, unknown> {
  return {
    basis: form.basis.trim(),
    ...(form.basisDocumentId.trim() === '' ? {} : { basis_document_id: form.basisDocumentId.trim() }),
    ...(needsReason ? { supersede_reason: form.supersedeReason.trim() } : {}),
    indicators: form.indicators.map((row) => ({
      code: row.code.trim(),
      name: row.name.trim(),
      unit: row.unit.trim(),
      direction: row.direction,
      ...(row.baselineValue.trim() === '' ? {} : { baseline_value: decimalText(row.baselineValue) }),
      ...(row.baselineOn === '' ? {} : { baseline_on: row.baselineOn }),
      target_value: decimalText(row.targetValue),
      ...(row.measureAfterMonths.trim() === '' ? {} : { measure_after_months: Number(row.measureAfterMonths) }),
      data_source: row.dataSource.trim(),
      formula: row.formula.trim(),
    })),
  };
}

export interface MeasureForm {
  indicatorCode: string;
  measuredOn: string;
  value: string;
  methodNote: string;
  evidenceDocumentId: string;
  correctsId: string;
  correctionReason: string;
}

export const EMPTY_MEASURE: MeasureForm = { indicatorCode: '', measuredOn: '', value: '', methodNote: '', evidenceDocumentId: '', correctsId: '', correctionReason: '' };
export type MeasureField = keyof MeasureForm;

export function validateMeasure(form: MeasureForm, today: string): Partial<Record<MeasureField, FormProblem>> {
  const found: Partial<Record<MeasureField, FormProblem>> = {};
  if (form.indicatorCode === '') found.indicatorCode = 'required';
  if (form.measuredOn === '') found.measuredOn = 'required';
  else if (!isDay(form.measuredOn) || form.measuredOn > today) found.measuredOn = 'invalid';
  if (form.value.trim() === '') found.value = 'required';
  else if (!DECIMAL.test(decimalText(form.value))) found.value = 'invalid';
  const note = lengthProblem(form.methodNote, 3, 1000);
  if (note !== undefined) found.methodNote = note;
  if (form.evidenceDocumentId.trim() !== '' && !UUID.test(form.evidenceDocumentId.trim())) found.evidenceDocumentId = 'invalid';
  if (form.correctsId !== '') {
    const reason = lengthProblem(form.correctionReason, 10, 2000);
    if (reason !== undefined) found.correctionReason = reason;
  }
  return found;
}

export function measureBody(form: MeasureForm): Record<string, unknown> {
  return {
    indicator_code: form.indicatorCode,
    measured_on: form.measuredOn,
    value: decimalText(form.value),
    method_note: form.methodNote.trim(),
    ...(form.evidenceDocumentId.trim() === '' ? {} : { evidence_document_id: form.evidenceDocumentId.trim() }),
    ...(form.correctsId === '' ? {} : { corrects_id: form.correctsId, correction_reason: form.correctionReason.trim() }),
  };
}

export interface AssessForm {
  kind: AssessmentKind;
  conclusion: Conclusion;
  summary: string;
}
export type AssessField = keyof AssessForm;

export const validateAssess = (form: AssessForm): Partial<Record<AssessField, FormProblem>> => {
  const summary = lengthProblem(form.summary, 10, 4000);
  return summary === undefined ? {} : { summary };
};
export const assessBody = (form: AssessForm): Record<string, unknown> => ({ kind: form.kind, conclusion: form.conclusion, summary: form.summary.trim() });

/** The shortest reason a return must give. */
export const MIN_RETURN_REASON = 10;

export const decisionBody = (decision: 'APPROVE' | 'RETURN', reason: string): Record<string, unknown> => ({ decision, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) });

// ---- refusals -------------------------------------------------------------------------------------------------------------------

export type Refusal =
  | 'targetState'
  | 'notFixed'
  | 'measurementDuplicate'
  | 'assessmentState'
  | 'assessmentAlready'
  | 'stageInvalid'
  | 'selfApproval'
  | 'versionConflict'
  | 'validation'
  | 'noMeasurement'
  | 'notTheAuthor'
  | 'denied'
  | 'notFound'
  | 'session'
  | 'general';

export interface Refused {
  refusal: Refusal;
  /** The field the server named (VALIDATION_FAILED and the duplicates), as it came. */
  field: string | undefined;
}

/** The refusal of the server as the screen words it (the words are in `labels.ts`). */
export function describeRefusal(error: unknown): Refused {
  if (!(error instanceof ApiError)) return { refusal: 'general', field: undefined };
  const field = error.detail === undefined || error.detail === '' ? undefined : error.detail;
  const reason = error.extensions.reason;
  switch (error.code) {
    case 'EFFECT_TARGET_STATE_INVALID':
      return { refusal: reason === 'NOT_THE_AUTHOR' ? 'notTheAuthor' : 'targetState', field };
    case 'EFFECT_TARGETS_NOT_FIXED':
      return { refusal: 'notFixed', field };
    case 'EFFECT_MEASUREMENT_DUPLICATE':
      return { refusal: 'measurementDuplicate', field };
    case 'EFFECT_ASSESSMENT_STATE_INVALID':
      return { refusal: reason === 'ALREADY_APPROVED' ? 'assessmentAlready' : 'assessmentState', field };
    case 'PROJECT_STAGE_INVALID':
      return { refusal: 'stageInvalid', field };
    case 'SELF_APPROVAL_DENIED':
      return { refusal: 'selfApproval', field };
    case 'VERSION_CONFLICT':
      return { refusal: 'versionConflict', field };
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return { refusal: reason === 'NO_MEASUREMENT' ? 'noMeasurement' : 'validation', field };
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return { refusal: 'denied', field };
    case 'RESOURCE_NOT_FOUND':
      return { refusal: 'notFound', field };
    case 'SESSION_EXPIRED':
      return { refusal: 'session', field };
    default:
      return { refusal: 'general', field };
  }
}
