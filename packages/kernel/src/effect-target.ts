import { addMonthsClamped } from './billing-period.ts';
import { DomainError } from './errors.ts';

/**
 * The post-investment effectiveness of a project (MR-1, MR.03 merged with G4-7): the target indicators fixed when the investment was approved, the actual values measured after the commissioning, the variance
 * between them, the evaluations the calendar of Articles 76 and 77 asks for, and the assessment record. Pure functions of their input: the thresholds and the months come from the governance rules
 * `EFFECT_POLICY` and `EFFECT_EVALUATION_CALENDAR` (flagged not verified), the figures are exact decimals computed on whole numbers (no float), and a figure that cannot be known is `null`, never zero.
 */

export const EFFECT_POLICY_RULE_TYPE = 'EFFECT_POLICY';
export const EFFECT_POLICY_RULE_CODE = 'DEFAULT';
export const EFFECT_CALENDAR_RULE_TYPE = 'EFFECT_EVALUATION_CALENDAR';

export const EFFECT_DIRECTIONS = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'] as const;
export type EffectDirection = (typeof EFFECT_DIRECTIONS)[number];
export const EFFECT_BANDS = ['MET', 'PARTIAL', 'MISSED', 'NOT_MEASURED'] as const;
export type EffectBand = (typeof EFFECT_BANDS)[number];
export const EFFECT_CONCLUSIONS = ['SATISFACTORY', 'PARTIALLY_SATISFACTORY', 'UNSATISFACTORY'] as const;
export type EffectConclusion = (typeof EFFECT_CONCLUSIONS)[number];
export const EFFECT_EVALUATION_KINDS = ['INITIAL', 'MIDTERM', 'FINAL', 'IMPACT'] as const;
export type EffectEvaluationKind = (typeof EFFECT_EVALUATION_KINDS)[number];
/** The kinds an assessment may carry: the four of the calendar and one asked for outside it. */
export const EFFECT_ASSESSMENT_KINDS = [...EFFECT_EVALUATION_KINDS, 'AD_HOC'] as const;
export type EffectAssessmentKind = (typeof EFFECT_ASSESSMENT_KINDS)[number];
export const EFFECT_ANCHORS = ['IMPLEMENTATION_START', 'COMPLETION', 'HANDOVER'] as const;
export type EffectAnchor = (typeof EFFECT_ANCHORS)[number];
export const EFFECT_PROJECT_GROUPS = ['QTQG', 'A', 'B', 'C'] as const;
export type EffectProjectGroup = (typeof EFFECT_PROJECT_GROUPS)[number];

const invalid = (field: string, extensions?: Record<string, unknown>): DomainError => (extensions === undefined ? new DomainError('VALIDATION_FAILED', 422, field) : new DomainError('VALIDATION_FAILED', 422, field, { extensions }));
const ruleInvalid = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- the policy -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface EffectPolicy {
  /** An indicator whose achievement reaches this percent is met. */
  metAtPct: number;
  /** From this percent (and below the met line) an indicator is partly met. */
  partlyAtPct: number;
  /** The statuses of a project in which target indicators are drafted. */
  draftStatuses: readonly string[];
  /** The statuses in which a draft is fixed: the investment is approved. */
  fixStatuses: readonly string[];
  /** The statuses in which an actual value is recorded: the work is commissioned. */
  measureStatuses: readonly string[];
}

export const EFFECT_POLICY_DEFAULTS: EffectPolicy = {
  metAtPct: 100,
  partlyAtPct: 70,
  draftStatuses: ['APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED'],
  fixStatuses: ['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED'],
  measureStatuses: ['COMPLETED', 'SETTLED', 'CLOSED'],
};

const statusList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(item))) throw ruleInvalid(field);
  return value as string[];
};

export function parseEffectPolicy(raw: unknown): EffectPolicy {
  if (!isRecord(raw)) throw ruleInvalid('params');
  const met = raw.met_at_pct;
  const partly = raw.partly_at_pct;
  if (typeof met !== 'number' || !Number.isFinite(met) || met <= 0 || met > 200) throw ruleInvalid('met_at_pct');
  if (typeof partly !== 'number' || !Number.isFinite(partly) || partly < 0 || partly >= met) throw ruleInvalid('partly_at_pct');
  return { metAtPct: met, partlyAtPct: partly, draftStatuses: statusList(raw.draft_statuses, 'draft_statuses'), fixStatuses: statusList(raw.fix_statuses, 'fix_statuses'), measureStatuses: statusList(raw.measure_statuses, 'measure_statuses') };
}

export const effectPolicyParams = (policy: EffectPolicy): Record<string, unknown> => ({
  met_at_pct: policy.metAtPct,
  partly_at_pct: policy.partlyAtPct,
  draft_statuses: [...policy.draftStatuses],
  fix_statuses: [...policy.fixStatuses],
  measure_statuses: [...policy.measureStatuses],
});

// ---- exact decimals ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const SCALE = 6;
const UNIT = 1_000_000n;
const DECIMAL = /^-?(0|[1-9]\d{0,17})(\.\d{1,6})?$/;

/** A decimal text as whole millionths (no float): `1.5` is 1500000. A value that is not a decimal of at most 18 whole and 6 fractional digits is 422 on `field`. */
export function toMicro(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw invalid(field);
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const micro = BigInt(whole) * UNIT + BigInt(fraction.padEnd(SCALE, '0'));
  return negative ? -micro : micro;
}

/** Whole millionths as the shortest decimal text (`1500000` is `1.5`, `2000000` is `2`). */
export function microText(micro: bigint): string {
  const negative = micro < 0n;
  const absolute = negative ? -micro : micro;
  const whole = absolute / UNIT;
  const fraction = (absolute % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const body = fraction === '' ? whole.toString() : `${whole}.${fraction}`;
  return negative && absolute !== 0n ? `-${body}` : body;
}

/** `numerator / denominator x 100` in hundredths of a percent (a whole number), rounded half away from zero; null when the denominator is zero. No limit of size applies: the ratio of two valid values may be far above 100 percent. */
function percentHundredths(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator === 0n) return null;
  const negative = numerator < 0n !== denominator < 0n && numerator !== 0n;
  const top = (numerator < 0n ? -numerator : numerator) * 10_000n;
  const bottom = denominator < 0n ? -denominator : denominator;
  const quotient = top / bottom;
  const rounded = (top % bottom) * 2n >= bottom ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Hundredths of a percent as a decimal text with two places (`8000` is `80.00`). */
function hundredthsText(hundredths: bigint): string {
  const negative = hundredths < 0n;
  const absolute = negative ? -hundredths : hundredths;
  return `${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

const percentOf = (numerator: bigint, denominator: bigint): string | null => {
  const found = percentHundredths(numerator, denominator);
  return found === null ? null : hundredthsText(found);
};

// ---- the variance of an indicator -------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface VarianceInput {
  direction: EffectDirection;
  /** Decimal texts; the baseline may be absent, the actual absent when nothing was measured yet. */
  baselineValue: string | null;
  targetValue: string;
  actualValue: string | null;
}

export interface Variance {
  /** The actual minus the target, as a decimal text (null when not measured). */
  varianceValue: string | null;
  /** The variance as a percent of the absolute target, two places (null when not measured or the target is zero). */
  variancePct: string | null;
  /** How far the actual went from the baseline to the target, in percent, two places; may be negative or above 100. */
  achievementPct: string | null;
  /** How the achievement was read: from the baseline, from the ratio to the target, or not at all. */
  basis: 'BASELINE_TO_TARGET' | 'RATIO' | 'DIRECTION_ONLY' | 'NONE';
  band: EffectBand;
}

/**
 * The variance of an indicator against its target. The achievement runs from the baseline (0 percent) to the target (100 percent) when there is a baseline; without one it is the ratio of the actual to the target
 * (the target to the actual when lower is better). When the baseline equals the target no progress can be measured and the direction alone decides. The band follows the policy: met from `metAtPct`, partly from `partlyAtPct`.
 */
export function computeVariance(input: VarianceInput, policy: Pick<EffectPolicy, 'metAtPct' | 'partlyAtPct'>): Variance {
  if (input.actualValue === null) return { varianceValue: null, variancePct: null, achievementPct: null, basis: 'NONE', band: 'NOT_MEASURED' };
  const target = toMicro(input.targetValue, 'target_value');
  const actual = toMicro(input.actualValue, 'value');
  const baseline = input.baselineValue === null ? null : toMicro(input.baselineValue, 'baseline_value');
  const higher = input.direction === 'HIGHER_IS_BETTER';
  const varianceValue = microText(actual - target);
  const variancePct = percentOf(actual - target, target < 0n ? -target : target);
  let achievementH: bigint | null = null;
  let basis: Variance['basis'] = 'DIRECTION_ONLY';
  if (baseline !== null && baseline !== target) {
    achievementH = percentHundredths(actual - baseline, target - baseline);
    basis = 'BASELINE_TO_TARGET';
  } else if (baseline === null) {
    if (higher) achievementH = percentHundredths(actual, target);
    else achievementH = actual <= 0n ? (target >= 0n ? 10_000n : null) : percentHundredths(target, actual);
    basis = achievementH === null ? 'DIRECTION_ONLY' : 'RATIO';
  }
  const achievement = achievementH === null ? null : hundredthsText(achievementH);
  const reaches = higher ? actual >= target : actual <= target;
  let band: EffectBand;
  if (achievementH === null) {
    band = reaches ? 'MET' : 'MISSED';
  } else {
    band = achievementH >= BigInt(Math.round(policy.metAtPct * 100)) ? 'MET' : achievementH >= BigInt(Math.round(policy.partlyAtPct * 100)) ? 'PARTIAL' : 'MISSED';
  }
  return { varianceValue, variancePct, achievementPct: achievement, basis, band };
}

/** The conclusion the lines suggest (the person who submits may choose another, and says why in the summary): all met is satisfactory, none met unsatisfactory, otherwise partly. */
export function suggestConclusion(bands: readonly EffectBand[]): EffectConclusion | null {
  const measured = bands.filter((band) => band !== 'NOT_MEASURED');
  if (measured.length === 0) return null;
  if (measured.every((band) => band === 'MET')) return 'SATISFACTORY';
  if (measured.every((band) => band === 'MISSED')) return 'UNSATISFACTORY';
  return 'PARTIALLY_SATISFACTORY';
}

// ---- the target indicators --------------------------------------------------------------------------------------------------------------------------------------------------------------------

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MAX_INDICATORS = 40;

/** A calendar day as typed; a day that does not exist (the 30th of February) is 422 on `field`. */
export function dayOf(value: unknown, field: string): string {
  const matched = typeof value === 'string' ? DAY.exec(value) : null;
  if (matched === null || typeof value !== 'string') throw invalid(field);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

function words(raw: unknown, field: string, min: number, max: number): string {
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (value.length < min || value.length > max) throw invalid(field);
  return value;
}

export interface EffectIndicatorInput {
  code: string;
  name: string;
  unit: string;
  direction: EffectDirection;
  baselineValue: string | null;
  baselineOn: string | null;
  targetValue: string;
  measureAfterMonths: number | null;
  dataSource: string;
  formula: string;
}

/** One target indicator as it is written: the baseline and its day go together, the numbers are exact decimals, and the way of measuring is said (where the actual comes from, how it is computed). */
export function assertIndicator(raw: unknown, at: string): EffectIndicatorInput {
  if (!isRecord(raw)) throw invalid(at);
  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  if (!CODE.test(code)) throw invalid(`${at}.code`);
  const direction = EFFECT_DIRECTIONS.find((candidate) => candidate === raw.direction);
  if (direction === undefined) throw invalid(`${at}.direction`);
  const hasBaseline = raw.baseline_value !== undefined && raw.baseline_value !== null;
  const hasBaselineDay = raw.baseline_on !== undefined && raw.baseline_on !== null;
  if (hasBaseline !== hasBaselineDay) throw invalid(hasBaseline ? `${at}.baseline_on` : `${at}.baseline_value`);
  if (hasBaseline) toMicro(raw.baseline_value, `${at}.baseline_value`);
  toMicro(raw.target_value, `${at}.target_value`);
  const months = raw.measure_after_months;
  if (months !== undefined && months !== null && (typeof months !== 'number' || !Number.isInteger(months) || months < 0 || months > 240)) throw invalid(`${at}.measure_after_months`);
  return {
    code,
    name: words(raw.name, `${at}.name`, 3, 200),
    unit: words(raw.unit, `${at}.unit`, 1, 40),
    direction,
    baselineValue: hasBaseline ? (raw.baseline_value as string) : null,
    baselineOn: hasBaselineDay ? dayOf(raw.baseline_on, `${at}.baseline_on`) : null,
    targetValue: raw.target_value as string,
    measureAfterMonths: typeof months === 'number' ? months : null,
    dataSource: words(raw.data_source, `${at}.data_source`, 3, 500),
    formula: words(raw.formula, `${at}.formula`, 3, 500),
  };
}

/** The whole list of a draft: 1 to 40 indicators with codes that are all different (422 `VALIDATION_FAILED` on the one that repeats). */
export function assertIndicators(raw: unknown): EffectIndicatorInput[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_INDICATORS) throw invalid('indicators');
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const one = assertIndicator(item, `indicators[${index}]`);
    if (seen.has(one.code)) throw invalid(`indicators[${index}].code`, { reason: 'DUPLICATE_CODE' });
    seen.add(one.code);
    return one;
  });
}

/** The basis of the targets: the number and date of the decision that approved the investment, 3 to 500 characters. */
export const assertBasis = (raw: unknown): string => words(raw, 'basis', 3, 500);

/** A reason of 10 to 2000 characters (the replacement of a fixed set, the correction of a measurement, the return of an assessment). */
export const assertReason = (raw: unknown, field = 'reason'): string => words(raw, field, 10, 2000);

/** Whether a project in this status takes the step (a draft, a fix, a measurement) by the policy: 422 `PROJECT_STAGE_INVALID` otherwise. */
export function assertProjectStatus(status: string, allowed: readonly string[]): void {
  if (!allowed.includes(status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id', { extensions: { status } });
}

/** The person who fixes a set of targets is not the one who drafted it (403 `SELF_APPROVAL_DENIED`). */
export function assertFixer(actor: string, drafter: string): void {
  if (actor.toLowerCase() === drafter.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

/** The person who decides an assessment is not the one who submitted it (403 `SELF_APPROVAL_DENIED`). */
export function assertAssessmentDecider(actor: string, submitter: string): void {
  if (actor.toLowerCase() === submitter.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

// ---- the measurement --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface MeasurementInput {
  indicatorCode: string;
  measuredOn: string;
  value: string;
  methodNote: string;
  evidenceDocumentId: string | null;
  correctsId: string | null;
  correctionReason: string | null;
}

/** An actual value: the day is a real day not after today, the value an exact decimal, the way it was taken is said; a correction names the row it replaces and why. */
export function assertMeasurement(raw: Record<string, unknown>, today: string, asUuid: (value: unknown) => string | undefined): MeasurementInput {
  const code = typeof raw.indicator_code === 'string' ? raw.indicator_code.trim() : '';
  if (!CODE.test(code)) throw invalid('indicator_code');
  const measuredOn = dayOf(raw.measured_on, 'measured_on');
  if (measuredOn > today) throw invalid('measured_on', { reason: 'IN_THE_FUTURE' });
  toMicro(raw.value, 'value');
  const evidence = raw.evidence_document_id === undefined || raw.evidence_document_id === null ? null : (asUuid(raw.evidence_document_id) ?? null);
  if (raw.evidence_document_id !== undefined && raw.evidence_document_id !== null && evidence === null) throw invalid('evidence_document_id');
  const corrects = raw.corrects_id === undefined || raw.corrects_id === null ? null : (asUuid(raw.corrects_id) ?? null);
  if (raw.corrects_id !== undefined && raw.corrects_id !== null && corrects === null) throw invalid('corrects_id');
  if (corrects !== null && (raw.correction_reason === undefined || raw.correction_reason === null)) throw invalid('correction_reason');
  if (corrects === null && raw.correction_reason !== undefined && raw.correction_reason !== null) throw invalid('correction_reason');
  return {
    indicatorCode: code,
    measuredOn,
    value: raw.value as string,
    methodNote: words(raw.method_note, 'method_note', 3, 1000),
    evidenceDocumentId: evidence,
    correctsId: corrects,
    correctionReason: corrects === null ? null : assertReason(raw.correction_reason, 'correction_reason'),
  };
}

// ---- the assessment ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface AssessmentInput {
  kind: EffectAssessmentKind;
  conclusion: EffectConclusion;
  summary: string;
}

export function assertAssessment(raw: Record<string, unknown>): AssessmentInput {
  const kind = EFFECT_ASSESSMENT_KINDS.find((candidate) => candidate === raw.kind);
  if (kind === undefined) throw invalid('kind');
  const conclusion = EFFECT_CONCLUSIONS.find((candidate) => candidate === raw.conclusion);
  if (conclusion === undefined) throw invalid('conclusion');
  return { kind, conclusion, summary: words(raw.summary, 'summary', 10, 4000) };
}

export type AssessmentDecision = 'APPROVE' | 'RETURN';

/** A decision: approve (a note is optional) or return (a reason of at least 10 characters). */
export function assertAssessmentDecision(raw: Record<string, unknown>): { decision: AssessmentDecision; reason: string | null } {
  const decision = raw.decision === 'APPROVE' || raw.decision === 'RETURN' ? raw.decision : undefined;
  if (decision === undefined) throw invalid('decision');
  if (decision === 'RETURN') return { decision, reason: assertReason(raw.reason) };
  return { decision, reason: raw.reason === undefined || raw.reason === null ? null : words(raw.reason, 'reason', 1, 2000) };
}

// ---- the calendar of evaluations (Articles 76 and 77) -----------------------------------------------------------------------------------------------------------------------------------------

export interface CalendarRuleEntry {
  kind: EffectEvaluationKind;
  anchor: EffectAnchor;
  months: number;
  required: boolean;
}

export interface CalendarRule {
  projectGroup: EffectProjectGroup;
  entries: readonly CalendarRuleEntry[];
}

export function parseCalendarRule(raw: unknown): CalendarRule {
  if (!isRecord(raw)) throw ruleInvalid('params');
  const group = EFFECT_PROJECT_GROUPS.find((candidate) => candidate === raw.project_group);
  if (group === undefined) throw ruleInvalid('project_group');
  if (!Array.isArray(raw.entries) || raw.entries.length < 1 || raw.entries.length > EFFECT_EVALUATION_KINDS.length) throw ruleInvalid('entries');
  const seen = new Set<string>();
  const entries = raw.entries.map((item: unknown, index) => {
    if (!isRecord(item)) throw ruleInvalid(`entries[${index}]`);
    const kind = EFFECT_EVALUATION_KINDS.find((candidate) => candidate === item.kind);
    const anchor = EFFECT_ANCHORS.find((candidate) => candidate === item.anchor);
    if (kind === undefined || seen.has(kind)) throw ruleInvalid(`entries[${index}].kind`);
    if (anchor === undefined) throw ruleInvalid(`entries[${index}].anchor`);
    if (typeof item.months !== 'number' || !Number.isInteger(item.months) || item.months < 0 || item.months > 240) throw ruleInvalid(`entries[${index}].months`);
    if (typeof item.required !== 'boolean') throw ruleInvalid(`entries[${index}].required`);
    seen.add(kind);
    return { kind, anchor, months: item.months, required: item.required };
  });
  return { projectGroup: group, entries };
}

/** The days the anchors fell on for a project (a day the system does not know yet is absent). */
export type AnchorDays = Partial<Record<EffectAnchor, { on: string; source: 'STAGE_HISTORY' | 'HANDOVER_ACCEPTANCE' }>>;

export interface CalendarDraftEntry {
  kind: EffectEvaluationKind;
  anchor: EffectAnchor;
  anchorOn: string;
  anchorSource: 'STAGE_HISTORY' | 'HANDOVER_ACCEPTANCE';
  months: number;
  dueOn: string;
  required: boolean;
}

/**
 * The entries a rule gives for a project from the anchor days it has: an entry whose anchor day is not known yet is not made (it is returned in `waiting` with the anchor it waits for), and the entries already made
 * for the project (`existing` kinds) are left alone, so generating the calendar twice makes it once.
 */
export function deriveCalendar(rule: CalendarRule, anchors: AnchorDays, existing: ReadonlySet<string>): { entries: CalendarDraftEntry[]; waiting: Array<{ kind: EffectEvaluationKind; anchor: EffectAnchor }> } {
  const entries: CalendarDraftEntry[] = [];
  const waiting: Array<{ kind: EffectEvaluationKind; anchor: EffectAnchor }> = [];
  for (const line of rule.entries) {
    if (existing.has(line.kind)) continue;
    const day = anchors[line.anchor];
    if (day === undefined) {
      waiting.push({ kind: line.kind, anchor: line.anchor });
      continue;
    }
    entries.push({ kind: line.kind, anchor: line.anchor, anchorOn: day.on, anchorSource: day.source, months: line.months, dueOn: addMonthsClamped(day.on, line.months), required: line.required });
  }
  return { entries, waiting };
}

export const CALENDAR_STATES = ['DONE', 'OVERDUE', 'DUE_SOON', 'UPCOMING'] as const;
export type CalendarState = (typeof CALENDAR_STATES)[number];
/** An evaluation that falls due within this many days is "due soon". */
export const DUE_SOON_DAYS = 30;

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** The state of a calendar entry on a day: done when its assessment was approved, overdue the day after its day, due soon within a month of it, otherwise upcoming. */
export function calendarState(entry: { status: 'PLANNED' | 'DONE'; dueOn: string }, today: string): CalendarState {
  if (entry.status === 'DONE') return 'DONE';
  const left = dayNumber(entry.dueOn) - dayNumber(today);
  return left < 0 ? 'OVERDUE' : left <= DUE_SOON_DAYS ? 'DUE_SOON' : 'UPCOMING';
}

/** The days an overdue entry is late (0 when it is not). */
export const daysLate = (dueOn: string, today: string): number => Math.max(0, dayNumber(today) - dayNumber(dueOn));

const ANCHOR_BY_KIND_A: ReadonlyArray<CalendarRuleEntry> = [
  { kind: 'INITIAL', anchor: 'IMPLEMENTATION_START', months: 12, required: true },
  { kind: 'MIDTERM', anchor: 'IMPLEMENTATION_START', months: 24, required: true },
  { kind: 'FINAL', anchor: 'COMPLETION', months: 3, required: true },
  { kind: 'IMPACT', anchor: 'HANDOVER', months: 24, required: true },
];
const ANCHOR_BY_KIND_BC: ReadonlyArray<CalendarRuleEntry> = [
  { kind: 'FINAL', anchor: 'COMPLETION', months: 3, required: true },
  { kind: 'IMPACT', anchor: 'HANDOVER', months: 24, required: true },
];

/** The starting calendar of each group (Articles 76 and 77, to be confirmed against the law before it is relied on): national important and group A have four evaluations, groups B and C have two. */
export const CALENDAR_DEFAULTS: Readonly<Record<EffectProjectGroup, CalendarRule>> = {
  QTQG: { projectGroup: 'QTQG', entries: ANCHOR_BY_KIND_A },
  A: { projectGroup: 'A', entries: ANCHOR_BY_KIND_A },
  B: { projectGroup: 'B', entries: ANCHOR_BY_KIND_BC },
  C: { projectGroup: 'C', entries: ANCHOR_BY_KIND_BC },
};

/** The code of the rule of a group of project: a rule code has at least two characters, so the group `A` is `GROUP_A`. */
export const calendarRuleCode = (group: EffectProjectGroup): string => `GROUP_${group}`;

export const calendarRuleParams = (rule: CalendarRule): Record<string, unknown> => ({ project_group: rule.projectGroup, entries: rule.entries.map((entry) => ({ kind: entry.kind, anchor: entry.anchor, months: entry.months, required: entry.required })) });
