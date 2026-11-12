import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';
import type { FieldSpec, RuleRegistry } from './governance-rules.ts';
import { PWF_KPI_TEXT as T } from './messages/pwf-kpi-texts.ts';
import { dayNumber, dayText, isWorkflowDay, workflowDaysBetween, workingDaysBetween } from './process-core.ts';
import type { WorkCalendarSource } from './working-time.ts';

/**
 * KPIs of a workflow and the score of a person (PWF-3, owner request (c); R33, R34, R37, R43 of the review). Pure.
 *
 * A KPI of a workflow is never a formula somebody types: it is one operation of the closed catalogue below (`WORKFLOW_KPI_OPERATIONS`), named by a rule `WORKFLOW_KPI_SET`
 * together with the code of the `KPI_DEFINITION` that says what it is called and how it is read (the set only REFERENCES the register, it defines no formula text of its own),
 * a scale that turns the value into a score of 0 to 100 and a weight. The score of a person in a period (`aggregateStaffPeriod`) is the weighted mean of the scores of the tasks
 * the person held, divided by the intervals of the assignment ledger and the shares of shared tasks. The score supports a decision of a person with authority; nothing here applies a consequence.
 */

export const WORKFLOW_KPI_SET_RULE_TYPE = 'WORKFLOW_KPI_SET';
export const STAFF_SCORING_POLICY_RULE_TYPE = 'STAFF_SCORING_POLICY';
export const WORKFLOW_KPI_DEFAULTS_AS_OF = '2026-11-12';
export const DEFAULT_KPI_SET_CODE = 'DEFAULT_PROJECT_WORKFLOW';
/** The template the built-in set belongs to: a reference to a `PROJECT_WORKFLOW_TEMPLATE` code, checked by `governance:check`, never a definition. */
export const DEFAULT_KPI_SET_TEMPLATE = 'PUBLIC_INVESTMENT';

export const KPI_OPERATION_CODES = ['DAYS_DEVIATION', 'ON_TIME_RATE', 'AMOUNT_VARIANCE_PCT', 'RETURN_COUNT', 'EVIDENCE_COMPLETENESS', 'RESCHEDULE_COUNT'] as const;
export type KpiOperationCode = (typeof KPI_OPERATION_CODES)[number];
export const KPI_UNITS_USED = ['PERCENT', 'VND', 'COUNT', 'DAYS', 'RATIO'] as const;
export type KpiOperationUnit = (typeof KPI_UNITS_USED)[number];
export const TASK_STATUSES = ['DONE', 'IN_PROGRESS', 'NOT_STARTED', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const ASSIGNMENT_ROLES = ['RESPONSIBLE', 'ACCOUNTABLE', 'CONSULTED', 'INFORMED'] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];
export const EXCUSAL_KINDS = ['APPROVED_PAUSE', 'APPROVED_EXTERNAL_DELAY'] as const;
export type ExcusalKind = (typeof EXCUSAL_KINDS)[number];
const TASK_KINDS = ['TASK', 'MILESTONE'] as const;
const UNITS = ['CALENDAR', 'WORKING'] as const;
const AGAINST = ['FIRST_BASELINE', 'CURRENT_BASELINE'] as const;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;
const CODE_PATTERN = '^[A-Z][A-Z0-9_]{1,39}$';

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The facts of a task and the catalogue of operations.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** An interval of days (both ends included) that does not count against the person: a pause someone with authority approved, or a delay caused from outside that was approved. */
export interface Excusal {
  kind: ExcusalKind;
  from: string;
  to: string;
}

/** What the ledger knows of one task: the facts every operation reads. Days are `YYYY-MM-DD` in Vietnam time, money is a whole number of dong. */
export interface TaskFacts {
  taskCode: string;
  /** The due day of the first approved baseline: moving the baseline later does not change what the person promised. */
  baselineDueFirst: string | null;
  baselineDueCurrent: string | null;
  actualFinish: string | null;
  actualStart: string | null;
  status: TaskStatus;
  /** A cancellation somebody other than the person approved. */
  cancelApproved: boolean;
  /** The day the figure is read on (the day of the lock for a closed period). */
  asOf: string;
  estimateVnd: number | null;
  actualVnd: number | null;
  returnCount: number;
  requiredEvidence: number;
  providedEvidence: number;
  rescheduleCount: number;
  excusals: readonly Excusal[];
  priority: TaskPriority;
  plannedWorkingDays: number;
}

/** The members of an item's `operation_params`, once read. */
export interface OperationParams {
  unit?: (typeof UNITS)[number] | undefined;
  against?: (typeof AGAINST)[number] | undefined;
  graceDays?: number | undefined;
}

export interface OperationContext {
  calendars?: WorkCalendarSource | undefined;
}

export type OperationState = 'OK' | 'NOT_APPLICABLE' | 'EXCLUDED' | 'MISSING_FACT';

export interface OperationResult {
  state: OperationState;
  value: number | null;
  detail: Readonly<Record<string, number | string | null>>;
}

export interface KpiOperation {
  code: KpiOperationCode;
  unit: KpiOperationUnit;
  direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  /** TASK: one task gives one value. TASK_SET: a rate over the tasks given. */
  level: 'TASK' | 'TASK_SET';
  /** The members of `TaskFacts` the operation reads: what `inputsHash` is made of. */
  reads: readonly (keyof TaskFacts)[];
  compute(facts: readonly TaskFacts[], params: OperationParams, context: OperationContext): OperationResult;
}

const result = (state: OperationState, value: number | null, detail: Record<string, number | string | null> = {}): OperationResult => ({ state, value, detail });
const missing = (reason: string): OperationResult => result('MISSING_FACT', null, { reason });

function assertCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw invalid(field);
  return value;
}

function assertExcusals(excusals: readonly Excusal[]): void {
  for (const one of excusals) {
    if (!isWorkflowDay(one.from) || !isWorkflowDay(one.to) || one.from > one.to) throw invalid('excusals');
  }
}

const baselineOf = (facts: TaskFacts, params: OperationParams): string | null => ((params.against ?? 'FIRST_BASELINE') === 'FIRST_BASELINE' ? facts.baselineDueFirst : facts.baselineDueCurrent);

/** The days between two days, in the unit asked: positive when `to` is later; `undefined` when a year in between has no published calendar. */
function daysBetweenIn(unit: (typeof UNITS)[number], calendars: WorkCalendarSource | undefined, from: string, to: string): number | undefined {
  if (unit === 'CALENDAR') return workflowDaysBetween(from, to);
  if (to >= from) return workingDaysBetween(calendars, from, to);
  const back = workingDaysBetween(calendars, to, from);
  return back === undefined ? undefined : -back;
}

/** The days of the window (`after`, `through`] that the excusals cover, counted once each; `undefined` when the calendar is missing. */
function excusedDays(unit: (typeof UNITS)[number], calendars: WorkCalendarSource | undefined, excusals: readonly Excusal[], after: string, through: string): number | undefined {
  const windowFrom = dayText(dayNumber(after) + 1);
  const clipped = excusals
    .map((one) => ({ from: one.from < windowFrom ? windowFrom : one.from, to: one.to > through ? through : one.to }))
    .filter((one) => one.from <= one.to)
    .sort((left, right) => (left.from < right.from ? -1 : left.from > right.from ? 1 : 0));
  const merged: Array<{ from: string; to: string }> = [];
  for (const one of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && one.from <= dayText(dayNumber(last.to) + 1)) {
      if (one.to > last.to) last.to = one.to;
    } else merged.push({ ...one });
  }
  let total = 0;
  for (const one of merged) {
    const days = unit === 'CALENDAR' ? workflowDaysBetween(one.from, one.to) + 1 : workingDaysBetween(calendars, dayText(dayNumber(one.from) - 1), one.to);
    if (days === undefined) return undefined;
    total += days;
  }
  return total;
}

type Lateness = { kind: 'FINAL'; result: OperationResult } | { kind: 'LATE'; raw: number; excused: number; end: string };

/** How late a task is against its baseline, and how much of that the excusals cover; a task that is not measurable gives its final result instead. */
function latenessOf(facts: TaskFacts, params: OperationParams, context: OperationContext): Lateness {
  assertExcusals(facts.excusals);
  if (facts.status === 'CANCELLED') return { kind: 'FINAL', result: result('EXCLUDED', null, { reason: 'CANCELLED' }) };
  const baseline = baselineOf(facts, params);
  if (baseline === null) return { kind: 'FINAL', result: missing('NO_BASELINE') };
  let end: string;
  if (facts.status === 'DONE') {
    if (facts.actualFinish === null) return { kind: 'FINAL', result: missing('NO_ACTUAL_FINISH') };
    end = facts.actualFinish;
  } else {
    if (facts.asOf <= baseline) return { kind: 'FINAL', result: result('NOT_APPLICABLE', null, { reason: 'NOT_DUE_YET' }) };
    end = facts.asOf;
  }
  const unit = params.unit ?? 'WORKING';
  const raw = daysBetweenIn(unit, context.calendars, baseline, end);
  if (raw === undefined) return { kind: 'FINAL', result: missing('CALENDAR_UNAVAILABLE') };
  if (raw <= 0) return { kind: 'LATE', raw, excused: 0, end };
  const excused = excusedDays(unit, context.calendars, facts.excusals, baseline, end);
  if (excused === undefined) return { kind: 'FINAL', result: missing('CALENDAR_UNAVAILABLE') };
  return { kind: 'LATE', raw, excused, end };
}

function single(facts: readonly TaskFacts[]): TaskFacts {
  const [one] = facts;
  if (facts.length !== 1 || one === undefined) throw invalid('facts');
  return one;
}

const daysDeviation: KpiOperation = {
  code: 'DAYS_DEVIATION',
  unit: 'DAYS',
  direction: 'LOWER_IS_BETTER',
  level: 'TASK',
  reads: ['baselineDueFirst', 'baselineDueCurrent', 'actualFinish', 'status', 'asOf', 'excusals'],
  compute(facts, params, context) {
    const late = latenessOf(single(facts), params, context);
    if (late.kind === 'FINAL') return late.result;
    return result('OK', late.raw <= 0 ? late.raw : Math.max(0, late.raw - late.excused), { raw: late.raw, excused: late.excused });
  },
};

const onTimeRate: KpiOperation = {
  code: 'ON_TIME_RATE',
  unit: 'PERCENT',
  direction: 'HIGHER_IS_BETTER',
  level: 'TASK_SET',
  reads: ['baselineDueFirst', 'baselineDueCurrent', 'actualFinish', 'status', 'asOf', 'excusals'],
  compute(facts, params, context) {
    const grace = params.graceDays ?? 0;
    let onTime = 0;
    let due = 0;
    let excused = 0;
    let missingCount = 0;
    for (const one of facts) {
      const late = latenessOf(one, params, context);
      if (late.kind === 'FINAL') {
        if (late.result.state === 'MISSING_FACT') missingCount += 1;
        continue;
      }
      if (late.raw <= grace) {
        onTime += 1;
        due += 1;
      } else if (late.raw - late.excused <= grace) excused += 1;
      else due += 1;
    }
    const detail = { onTime, due, excused, missing: missingCount };
    if (due === 0) return result(missingCount > 0 && excused === 0 ? 'MISSING_FACT' : 'NOT_APPLICABLE', null, detail);
    return result('OK', round2((onTime / due) * 100), detail);
  },
};

const amountVariance: KpiOperation = {
  code: 'AMOUNT_VARIANCE_PCT',
  unit: 'PERCENT',
  direction: 'LOWER_IS_BETTER',
  level: 'TASK',
  reads: ['estimateVnd', 'actualVnd', 'status'],
  compute(facts) {
    const one = single(facts);
    if (one.status === 'CANCELLED') return result('EXCLUDED', null, { reason: 'CANCELLED' });
    if (one.estimateVnd === null || one.actualVnd === null) return missing('NO_AMOUNT');
    for (const [field, value] of [['estimateVnd', one.estimateVnd], ['actualVnd', one.actualVnd]] as const) if (!Number.isSafeInteger(value) || value < 0) throw invalid(field);
    if (one.estimateVnd === 0) return result('NOT_APPLICABLE', null, { reason: 'ZERO_ESTIMATE' });
    return result('OK', round2(((one.actualVnd - one.estimateVnd) / one.estimateVnd) * 100));
  },
};

const returnCount: KpiOperation = {
  code: 'RETURN_COUNT',
  unit: 'COUNT',
  direction: 'LOWER_IS_BETTER',
  level: 'TASK',
  reads: ['returnCount', 'status'],
  compute(facts) {
    const one = single(facts);
    if (one.status === 'CANCELLED') return result('EXCLUDED', null, { reason: 'CANCELLED' });
    return result('OK', assertCount(one.returnCount, 'returnCount'));
  },
};

const evidenceCompleteness: KpiOperation = {
  code: 'EVIDENCE_COMPLETENESS',
  unit: 'PERCENT',
  direction: 'HIGHER_IS_BETTER',
  level: 'TASK_SET',
  reads: ['requiredEvidence', 'providedEvidence', 'status'],
  compute(facts) {
    let required = 0;
    let provided = 0;
    for (const one of facts) {
      if (one.status === 'CANCELLED') continue;
      required += assertCount(one.requiredEvidence, 'requiredEvidence');
      provided += Math.min(assertCount(one.providedEvidence, 'providedEvidence'), one.requiredEvidence);
    }
    if (required === 0) return result('NOT_APPLICABLE', null, { reason: 'NOTHING_REQUIRED' });
    return result('OK', round2((provided / required) * 100), { required, provided });
  },
};

const rescheduleCount: KpiOperation = {
  code: 'RESCHEDULE_COUNT',
  unit: 'COUNT',
  direction: 'LOWER_IS_BETTER',
  level: 'TASK',
  reads: ['rescheduleCount', 'excusals', 'status'],
  compute(facts) {
    const one = single(facts);
    if (one.status === 'CANCELLED') return result('EXCLUDED', null, { reason: 'CANCELLED' });
    // Each approved outside delay accounts for one of the reschedules: it is not the person's doing.
    const external = one.excusals.filter((excusal) => excusal.kind === 'APPROVED_EXTERNAL_DELAY').length;
    return result('OK', Math.max(0, assertCount(one.rescheduleCount, 'rescheduleCount') - external), { external });
  },
};

export const WORKFLOW_KPI_OPERATIONS: Readonly<Record<KpiOperationCode, KpiOperation>> = Object.freeze({
  DAYS_DEVIATION: daysDeviation,
  ON_TIME_RATE: onTimeRate,
  AMOUNT_VARIANCE_PCT: amountVariance,
  RETURN_COUNT: returnCount,
  EVIDENCE_COMPLETENESS: evidenceCompleteness,
  RESCHEDULE_COUNT: rescheduleCount,
});

/** The operation of a code; a code that is not in the catalogue is a mistake of the caller (the catalogue is closed). */
export function kpiOperationOf(code: KpiOperationCode): KpiOperation {
  const found = (WORKFLOW_KPI_OPERATIONS as Partial<Record<string, KpiOperation>>)[code];
  if (found === undefined) throw invalid('operation');
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Scales: value to score.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface LinearScale {
  kind: 'LINEAR';
  worst: number;
  best: number;
}
export interface SteppedScale {
  kind: 'STEPPED';
  mode: 'AT_MOST' | 'AT_LEAST';
  steps: readonly { bound: number; score: number }[];
  otherwiseScore: number;
}
export type KpiScale = LinearScale | SteppedScale;

/** The score of a value, 0 to 100 with two decimals. LINEAR runs from `worst` (0) to `best` (100), in either direction; STEPPED takes the first step the value reaches (AT_MOST: bounds ascending, value <= bound; AT_LEAST: bounds descending, value >= bound). */
export function convertScore(value: number, scale: KpiScale): number {
  if (!Number.isFinite(value)) throw invalid('value');
  if (scale.kind === 'LINEAR') {
    if (scale.worst === scale.best) throw invalid('scale');
    return round2(Math.min(1, Math.max(0, (value - scale.worst) / (scale.best - scale.worst))) * 100);
  }
  const hit = scale.steps.find((step) => (scale.mode === 'AT_MOST' ? value <= step.bound : value >= step.bound));
  return hit === undefined ? scale.otherwiseScore : hit.score;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The rule WORKFLOW_KPI_SET.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface KpiSetItem {
  kpiCode: string;
  operation: KpiOperationCode;
  operationParams: OperationParams;
  appliesTo: { taskKinds?: readonly string[]; phases?: readonly string[]; tasks?: readonly string[] };
  weight: number;
  scale: KpiScale;
  ragCode: string | null;
}

export interface KpiSet {
  templateCode: string;
  items: readonly KpiSetItem[];
}

const code = (optional = false): FieldSpec => ({ kind: 'text', max: 40, optional, pattern: CODE_PATTERN });
const int = (min: number, max: number, optional = false): FieldSpec => ({ kind: 'int', min, max, optional });
const num = (min: number, max: number, optional = false): FieldSpec => ({ kind: 'number', min, max, optional });
const oneOf = (values: readonly string[], optional = false): FieldSpec => ({ kind: 'enum', values, optional });
const list = (of: FieldSpec, max: number, min = 0, optional = false): FieldSpec => ({ kind: 'list', of, max, min, optional });
const shape = (fields: Record<string, FieldSpec>, optional = false): FieldSpec => ({ kind: 'object', fields, optional });

const SCALE_SCHEMA = shape({
  kind: oneOf(['LINEAR', 'STEPPED']),
  worst: num(-1_000_000_000, 1_000_000_000, true),
  best: num(-1_000_000_000, 1_000_000_000, true),
  mode: oneOf(['AT_MOST', 'AT_LEAST'], true),
  steps: list(shape({ bound: num(-1_000_000_000, 1_000_000_000), score: num(0, 100) }), 10, 1, true),
  otherwise_score: num(0, 100, true),
});

const ITEM_SCHEMA = shape({
  kpi_code: code(),
  operation: oneOf(KPI_OPERATION_CODES),
  operation_params: shape({ unit: oneOf(UNITS, true), against: oneOf(AGAINST, true), grace_days: int(0, 30, true) }, true),
  applies_to: shape({ task_kinds: list(oneOf(TASK_KINDS), 2, 1, true), phases: list(code(), 20, 1, true), tasks: list(code(), 50, 1, true) }, true),
  weight: int(1, 100),
  scale: SCALE_SCHEMA,
  rag_code: code(true),
});

export const WORKFLOW_KPI_SET_SCHEMA: Readonly<Record<string, FieldSpec>> = { template_code: code(), items: list(ITEM_SCHEMA, 20, 1) };

type Raw = Record<string, unknown>;
const rawOf = (value: unknown): Raw => value as Raw;
const bad = (path: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, path);

function scaleOf(raw: Raw, path: string): KpiScale {
  const keys = Object.keys(raw);
  if (raw.kind === 'LINEAR') {
    if (typeof raw.worst !== 'number' || typeof raw.best !== 'number' || raw.worst === raw.best || keys.some((key) => !['kind', 'worst', 'best'].includes(key))) throw bad(path);
    return { kind: 'LINEAR', worst: raw.worst, best: raw.best };
  }
  const steps = (raw.steps ?? []) as Array<{ bound: number; score: number }>;
  if ((raw.mode !== 'AT_MOST' && raw.mode !== 'AT_LEAST') || steps.length === 0 || typeof raw.otherwise_score !== 'number' || keys.some((key) => !['kind', 'mode', 'steps', 'otherwise_score'].includes(key))) throw bad(path);
  const mode = raw.mode;
  const ordered = steps.every((step, index) => index === 0 || (mode === 'AT_MOST' ? step.bound > (steps[index - 1] as { bound: number }).bound : step.bound < (steps[index - 1] as { bound: number }).bound));
  if (!ordered) throw bad(path);
  return { kind: 'STEPPED', mode, steps: steps.map((step) => ({ bound: step.bound, score: step.score })), otherwiseScore: raw.otherwise_score };
}

/** Reads the params of a rule `WORKFLOW_KPI_SET` that passed the schema into a set, and checks what a closed schema cannot say: one item per KPI code, a scale that can be read. Fails with 422 `GOVERNANCE_RULE_PARAMS_INVALID` naming the field. */
export function parseKpiSet(params: unknown): KpiSet {
  const raw = rawOf(params);
  const seen = new Set<string>();
  const items = (raw.items as Raw[]).map((one, index): KpiSetItem => {
    const at = `items[${index}]`;
    const kpiCode = one.kpi_code as string;
    if (seen.has(kpiCode)) throw bad(`${at}.kpi_code`);
    seen.add(kpiCode);
    const op = rawOf(one.operation_params ?? {});
    const applies = rawOf(one.applies_to ?? {});
    const appliesTo: KpiSetItem['appliesTo'] = {};
    if (applies.task_kinds !== undefined) appliesTo.taskKinds = applies.task_kinds as string[];
    if (applies.phases !== undefined) appliesTo.phases = applies.phases as string[];
    if (applies.tasks !== undefined) appliesTo.tasks = applies.tasks as string[];
    const operationParams: OperationParams = {};
    if (op.unit !== undefined) operationParams.unit = op.unit as (typeof UNITS)[number];
    if (op.against !== undefined) operationParams.against = op.against as (typeof AGAINST)[number];
    if (op.grace_days !== undefined) operationParams.graceDays = op.grace_days as number;
    return {
      kpiCode,
      operation: one.operation as KpiOperationCode,
      operationParams,
      appliesTo,
      weight: one.weight as number,
      scale: scaleOf(rawOf(one.scale), `${at}.scale`),
      ragCode: (one.rag_code as string | undefined) ?? null,
    };
  });
  return { templateCode: raw.template_code as string, items };
}

/** The codes a set points at: the checks of the repository (`governance:check`) require each KPI code to be a `KPI_DEFINITION` and each RAG code a `RAG_THRESHOLDS` (R37), and the template code a `PROJECT_WORKFLOW_TEMPLATE`. */
export function kpiSetReferences(params: unknown): { kpiCodes: string[]; ragCodes: string[]; templateCode: string } {
  const set = parseKpiSet(params);
  const ragCodes = [...new Set(set.items.flatMap((one) => (one.ragCode === null ? [] : [one.ragCode])))].sort();
  return { kpiCodes: set.items.map((one) => one.kpiCode), ragCodes, templateCode: set.templateCode };
}

/** Whether an item measures a task: an item with no `applies_to` member measures every task, and each member present must match. */
export function itemApplies(item: KpiSetItem, task: { taskCode: string; taskKind: string; phase: string }): boolean {
  const { taskKinds, phases, tasks } = item.appliesTo;
  return (taskKinds === undefined || taskKinds.includes(task.taskKind)) && (phases === undefined || phases.includes(task.phase)) && (tasks === undefined || tasks.includes(task.taskCode));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The score of a task.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface TaskKpiResult {
  kpiCode: string;
  operation: KpiOperationCode;
  state: OperationState;
  value: number | null;
  score: number | null;
  weight: number;
  /** The hash of the facts the operation read, so that a recomputation is proved to have the same input. */
  inputsHash: string;
}

/** One KPI of a set for one task (or for a set of tasks when the operation is a rate): the value, its score on the scale, and the hash of what was read. */
export function scoreTask(facts: TaskFacts | readonly TaskFacts[], item: KpiSetItem, context: OperationContext): TaskKpiResult {
  const given: readonly TaskFacts[] = 'taskCode' in facts ? [facts] : facts;
  const operation = kpiOperationOf(item.operation);
  const outcome = operation.compute(given, item.operationParams, context);
  const read = given.map((one) => Object.fromEntries(operation.reads.map((key) => [key, one[key]])));
  const inputsHash = sha256Hex(canonicalJson({ operation: item.operation, params: item.operationParams, facts: read }));
  const score = outcome.state === 'OK' && outcome.value !== null ? convertScore(outcome.value, item.scale) : null;
  return { kpiCode: item.kpiCode, operation: item.operation, state: outcome.state, value: outcome.value, score, weight: item.weight, inputsHash };
}

/** The score of a task: the mean of the KPI scores by weight, over the KPIs that have one (the weights are re-normalised); null when none has. The KPIs left out are named with the reason. */
export function taskScoreOf(results: readonly TaskKpiResult[]): { score: number | null; leftOut: { kpiCode: string; reason: string }[] } {
  const leftOut = results.filter((one) => one.score === null).map((one) => ({ kpiCode: one.kpiCode, reason: one.state }));
  const scored = results.filter((one): one is TaskKpiResult & { score: number } => one.score !== null);
  const total = scored.reduce((sum, one) => sum + one.weight, 0);
  if (total === 0) return { score: null, leftOut };
  return { score: round2(scored.reduce((sum, one) => sum + one.weight * one.score, 0) / total), leftOut };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The rule STAFF_SCORING_POLICY.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface RatingBand {
  code: string;
  minScore: number;
}

export interface StaffScoringPolicy {
  periodKind: 'MONTH' | 'QUARTER' | 'YEAR';
  roleFactors: Readonly<Record<AssignmentRole, number>>;
  priorityWeights: Readonly<Record<TaskPriority, number>>;
  weightByPlannedDays: boolean;
  cancelledUnapproved: 'COUNT_AS_MISSED' | 'IGNORE';
  minRatedTasks: number;
  minEffectiveWeight: number;
  bands: readonly RatingBand[];
  calibration: { maxAdjustmentPoints: number; minReasonLength: number; requiresSecondApprover: boolean };
  responseWindowDays: number;
  retentionMonths: number;
}

export const STAFF_SCORING_POLICY_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  period_kind: oneOf(['MONTH', 'QUARTER', 'YEAR']),
  role_factors: shape({ RESPONSIBLE: num(0, 1), ACCOUNTABLE: num(0, 1), CONSULTED: num(0, 1), INFORMED: num(0, 1) }),
  priority_weights: shape({ LOW: num(0.1, 10), NORMAL: num(0.1, 10), HIGH: num(0.1, 10), CRITICAL: num(0.1, 10) }),
  weight_by_planned_days: { kind: 'boolean' },
  cancelled_unapproved: oneOf(['COUNT_AS_MISSED', 'IGNORE']),
  min_rated_tasks: int(1, 100),
  min_effective_weight: num(0, 1000),
  bands: list(shape({ code: code(), min_score: num(0, 100) }), 8, 2),
  calibration: shape({ max_adjustment_points: int(0, 30), min_reason_length: int(20, 500), requires_second_approver: { kind: 'boolean' } }),
  response_window_days: int(1, 60),
  retention_months: int(12, 120),
};

/** Reads the params of a rule `STAFF_SCORING_POLICY` that passed the schema, and checks the bands: codes unique, minimum scores strictly descending, the last at 0 so that every score has a band. */
export function parseStaffScoringPolicy(params: unknown): StaffScoringPolicy {
  const raw = rawOf(params);
  const bands = (raw.bands as Array<{ code: string; min_score: number }>).map((band): RatingBand => ({ code: band.code, minScore: band.min_score }));
  bands.forEach((band, index) => {
    const before = bands[index - 1];
    if (before !== undefined && bands.slice(0, index).some((other) => other.code === band.code)) throw bad(`bands[${index}].code`);
    if (before !== undefined && band.minScore >= before.minScore) throw bad(`bands[${index}].min_score`);
  });
  if ((bands[bands.length - 1] as RatingBand).minScore !== 0) throw bad('bands');
  const calibration = rawOf(raw.calibration);
  return {
    periodKind: raw.period_kind as StaffScoringPolicy['periodKind'],
    roleFactors: rawOf(raw.role_factors) as unknown as StaffScoringPolicy['roleFactors'],
    priorityWeights: rawOf(raw.priority_weights) as unknown as StaffScoringPolicy['priorityWeights'],
    weightByPlannedDays: raw.weight_by_planned_days as boolean,
    cancelledUnapproved: raw.cancelled_unapproved as StaffScoringPolicy['cancelledUnapproved'],
    minRatedTasks: raw.min_rated_tasks as number,
    minEffectiveWeight: raw.min_effective_weight as number,
    bands,
    calibration: { maxAdjustmentPoints: calibration.max_adjustment_points as number, minReasonLength: calibration.min_reason_length as number, requiresSecondApprover: calibration.requires_second_approver as boolean },
    responseWindowDays: raw.response_window_days as number,
    retentionMonths: raw.retention_months as number,
  };
}

/** The rating of a score: the first band (bands run from the highest minimum down) whose minimum the score reaches. */
export function ratingOf(score: number, bands: readonly RatingBand[]): string {
  if (!Number.isFinite(score)) throw invalid('score');
  const hit = bands.find((band) => score >= band.minScore);
  return (hit ?? (bands[bands.length - 1] as RatingBand)).code;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The score of a person in a period (R34).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type StaffTaskState = 'RATED' | 'EXCLUDED' | 'CANCELLED_APPROVED' | 'CANCELLED_UNAPPROVED' | 'NOT_STARTED';

/** One line of the assignment ledger: who held the task in which interval (`to` null while the assignment is open), in which role, and which share of the task. */
export interface LedgerAssignment {
  membershipId: string;
  role: AssignmentRole;
  from: string;
  to: string | null;
  sharePct: number;
}

export interface StaffPeriodTask {
  taskCode: string;
  taskScore: number | null;
  state: StaffTaskState;
  priority: TaskPriority;
  plannedWorkingDays: number;
  /** The days of the task that lie inside the period (both ends included): the denominator of the interval split. */
  windowFrom: string;
  windowTo: string;
  assignments: readonly LedgerAssignment[];
}

export interface StaffPeriodInput {
  periodFrom: string;
  periodTo: string;
  policy: StaffScoringPolicy;
  tasks: readonly StaffPeriodTask[];
  calendars?: WorkCalendarSource | undefined;
}

export interface StaffContribution {
  taskCode: string;
  fraction: number;
  weight: number;
  score: number;
}

export interface StaffPeriodScore {
  membershipId: string;
  score: number | null;
  rating: string | null;
  state: 'RATED' | 'NOT_RATED' | 'SMALL_SAMPLE';
  ratedTaskCount: number;
  effectiveWeight: number;
  contributions: StaffContribution[];
  excluded: { taskCode: string; reason: string }[];
  flags: string[];
}

const shareInvalid = (detail: string): DomainError => new DomainError('STAFF_SCORE_SHARE_INVALID', 422, detail);
const dayBefore = (day: string): string => dayText(dayNumber(day) - 1);

function assertLedger(task: StaffPeriodTask): void {
  if (!isWorkflowDay(task.windowFrom) || !isWorkflowDay(task.windowTo) || task.windowFrom > task.windowTo) throw invalid('window');
  for (const one of task.assignments) {
    if (!Number.isInteger(one.sharePct) || one.sharePct < 1 || one.sharePct > 100) throw shareInvalid(task.taskCode);
    if (!isWorkflowDay(one.from) || (one.to !== null && (!isWorkflowDay(one.to) || one.to < one.from))) throw shareInvalid(task.taskCode);
  }
  // Concurrent holders of one role never hold more than the whole task: the sum can only grow where an assignment begins.
  for (const role of ASSIGNMENT_ROLES) {
    const ofRole = task.assignments.filter((one) => one.role === role && (one.to === null || one.to >= task.windowFrom) && one.from <= task.windowTo);
    const starts = [...new Set(ofRole.map((one) => (one.from < task.windowFrom ? task.windowFrom : one.from)))];
    for (const start of starts) {
      const total = ofRole.filter((one) => one.from <= start && (one.to === null || one.to >= start)).reduce((sum, one) => sum + one.sharePct, 0);
      if (total > 100) throw shareInvalid(task.taskCode);
    }
  }
}

/** The weight of the task before the share of a person: its priority, times its planned working days when the policy weights by them (so that cutting a task in pieces cannot raise a rate). */
const taskWeightOf = (task: StaffPeriodTask, policy: StaffScoringPolicy): number => policy.priorityWeights[task.priority] * (policy.weightByPlannedDays ? task.plannedWorkingDays : 1);

/**
 * The score of every person who holds a task in the period (R34). The part of a person in a task is the share of the task window the assignment covers (working days when calendars give some, else calendar days)
 * times the share given to the person times the factor of the role, capped at the whole task. A task whose result is excused, approved as cancelled or not started leaves the denominator; one cancelled without
 * approval counts as 0 when the policy says so. A person with no weight is NOT_RATED (never a division by zero); below the small-sample thresholds the score is shown and the rating withheld.
 */
export function aggregateStaffPeriod(input: StaffPeriodInput): StaffPeriodScore[] {
  const { policy } = input;
  const tasks = [...input.tasks].sort((left, right) => (left.taskCode < right.taskCode ? -1 : left.taskCode > right.taskCode ? 1 : 0));
  const people = new Map<string, StaffPeriodScore & { numerator: number }>();
  const personOf = (id: string): StaffPeriodScore & { numerator: number } => {
    let found = people.get(id);
    if (found === undefined) {
      found = { membershipId: id, score: null, rating: null, state: 'NOT_RATED', ratedTaskCount: 0, effectiveWeight: 0, contributions: [], excluded: [], flags: [], numerator: 0 };
      people.set(id, found);
    }
    return found;
  };
  for (const task of tasks) {
    assertLedger(task);
    const windowWorking = input.calendars === undefined ? undefined : workingDaysBetween(input.calendars, dayBefore(task.windowFrom), task.windowTo);
    const working = windowWorking !== undefined && windowWorking > 0;
    const daysIn = (from: string, to: string): number => {
      const days = working ? workingDaysBetween(input.calendars, dayBefore(from), to) : workflowDaysBetween(from, to) + 1;
      return days ?? 0;
    };
    const windowDays = working ? (windowWorking as number) : workflowDaysBetween(task.windowFrom, task.windowTo) + 1;
    const fractions = new Map<string, number>();
    for (const one of task.assignments) {
      const from = one.from < task.windowFrom ? task.windowFrom : one.from;
      const to = one.to === null || one.to > task.windowTo ? task.windowTo : one.to;
      const overlap = from > to ? 0 : daysIn(from, to);
      const part = (overlap / windowDays) * (one.sharePct / 100) * policy.roleFactors[one.role];
      fractions.set(one.membershipId, (fractions.get(one.membershipId) ?? 0) + part);
    }
    for (const [id, raw] of [...fractions.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
      const person = personOf(id);
      const fraction = round4(Math.min(1, raw));
      if (fraction <= 0) {
        person.excluded.push({ taskCode: task.taskCode, reason: 'NO_SHARE' });
        continue;
      }
      let score: number | null = null;
      if (task.state === 'RATED') {
        if (task.taskScore === null) person.excluded.push({ taskCode: task.taskCode, reason: 'NO_SCORE' });
        else score = task.taskScore;
      } else if (task.state === 'CANCELLED_UNAPPROVED') {
        if (policy.cancelledUnapproved === 'COUNT_AS_MISSED') {
          score = 0;
          if (!person.flags.includes('CANCELLED_UNAPPROVED_COUNTED')) person.flags.push('CANCELLED_UNAPPROVED_COUNTED');
        } else person.excluded.push({ taskCode: task.taskCode, reason: 'CANCELLED_IGNORED' });
      } else person.excluded.push({ taskCode: task.taskCode, reason: task.state });
      if (score === null) continue;
      const weight = round4(taskWeightOf(task, policy) * fraction);
      person.contributions.push({ taskCode: task.taskCode, fraction, weight, score });
      person.numerator += weight * score;
      person.effectiveWeight += weight;
    }
  }
  return [...people.values()]
    .sort((left, right) => (left.membershipId < right.membershipId ? -1 : left.membershipId > right.membershipId ? 1 : 0))
    .map(({ numerator, ...person }): StaffPeriodScore => {
      const effectiveWeight = round2(person.effectiveWeight);
      const ratedTaskCount = person.contributions.length;
      if (effectiveWeight <= 0) return { ...person, effectiveWeight, ratedTaskCount, score: null, rating: null, state: 'NOT_RATED' };
      const score = round2(numerator / person.effectiveWeight);
      if (ratedTaskCount < policy.minRatedTasks || effectiveWeight < policy.minEffectiveWeight) return { ...person, effectiveWeight, ratedTaskCount, score, rating: null, state: 'SMALL_SAMPLE' };
      return { ...person, effectiveWeight, ratedTaskCount, score, rating: ratingOf(score, policy.bands), state: 'RATED' };
    });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Signals of gaming. They change no score; they go to the person who reviews the period.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface SignalLimits {
  /** The share of the tasks of a person that were cancelled (approved or not) from which the signal is raised. */
  cancelledShare: number;
  /** The signal needs at least this many tasks to be said at all. */
  cancelledMinTasks: number;
  /** A task cut after the baseline lock counts as a piece when its plan is at most this many working days. */
  splitMaxPlannedDays: number;
  /** This many pieces of one parent raise the signal. */
  splitMinCount: number;
  /** A hand-over this many days (or fewer) before the baseline due of a late task raises the signal. */
  handoverDays: number;
}

export const DEFAULT_SIGNAL_LIMITS: SignalLimits = { cancelledShare: 0.3, cancelledMinTasks: 3, splitMaxPlannedDays: 2, splitMinCount: 3, handoverDays: 5 };

export interface GamingTask {
  taskCode: string;
  state: StaffTaskState;
  parentCode: string | null;
  createdOn: string;
  plannedWorkingDays: number;
  baselineDue: string | null;
  finishedOn: string | null;
  assignments: readonly { membershipId: string; role: AssignmentRole; from: string; to: string | null }[];
}

export interface GamingInput {
  periodFrom: string;
  periodTo: string;
  baselineLockedOn: string | null;
  baselineRevisions: readonly { on: string }[];
  tasks: readonly GamingTask[];
  signalLimits?: Partial<SignalLimits> | undefined;
}

export type GamingFlagCode = 'CANCELLED_SHARE_HIGH' | 'TASKS_SPLIT_AFTER_BASELINE' | 'BASELINE_REVISED_IN_PERIOD' | 'ASSIGNEE_CHANGED_NEAR_DUE';
export interface GamingFlag {
  code: GamingFlagCode;
  taskCodes: string[];
}

export function gamingSignals(input: GamingInput): { membershipId: string; flags: GamingFlag[] }[] {
  const limits = { ...DEFAULT_SIGNAL_LIMITS, ...input.signalLimits };
  const byPerson = new Map<string, GamingTask[]>();
  for (const task of [...input.tasks].sort((left, right) => (left.taskCode < right.taskCode ? -1 : left.taskCode > right.taskCode ? 1 : 0))) {
    for (const id of new Set(task.assignments.map((one) => one.membershipId))) byPerson.set(id, [...(byPerson.get(id) ?? []), task]);
  }
  const revisedInPeriod = input.baselineRevisions.some((one) => one.on >= input.periodFrom && one.on <= input.periodTo);
  return [...byPerson.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([membershipId, tasks]) => {
      const flags: GamingFlag[] = [];
      const cancelled = tasks.filter((one) => one.state === 'CANCELLED_APPROVED' || one.state === 'CANCELLED_UNAPPROVED');
      if (tasks.length >= limits.cancelledMinTasks && cancelled.length / tasks.length >= limits.cancelledShare) flags.push({ code: 'CANCELLED_SHARE_HIGH', taskCodes: cancelled.map((one) => one.taskCode) });
      const lock = input.baselineLockedOn;
      if (lock !== null) {
        const pieces = new Map<string, string[]>();
        for (const one of tasks) {
          if (one.parentCode !== null && one.createdOn > lock && one.plannedWorkingDays <= limits.splitMaxPlannedDays) pieces.set(one.parentCode, [...(pieces.get(one.parentCode) ?? []), one.taskCode]);
        }
        const split = [...pieces.values()].filter((codes) => codes.length >= limits.splitMinCount).flat();
        if (split.length > 0) flags.push({ code: 'TASKS_SPLIT_AFTER_BASELINE', taskCodes: split });
      }
      if (revisedInPeriod) flags.push({ code: 'BASELINE_REVISED_IN_PERIOD', taskCodes: [] });
      const handed = tasks.filter((one) => {
        if (one.baselineDue === null) return false;
        const late = one.finishedOn === null ? input.periodTo > one.baselineDue : one.finishedOn > one.baselineDue;
        const left = one.assignments.filter((a) => a.membershipId === membershipId && a.to !== null);
        return late && left.some((a) => (a.to as string) <= (one.baselineDue as string) && workflowDaysBetween(a.to as string, one.baselineDue as string) <= limits.handoverDays);
      });
      if (handed.length > 0) flags.push({ code: 'ASSIGNEE_CHANGED_NEAR_DUE', taskCodes: handed.map((one) => one.taskCode) });
      return { membershipId, flags };
    });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Calibration, the lock of a period and the window of response (R43).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface AdjustmentRequest {
  points: number;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  subjectMembershipId: string;
}

/** An adjustment of a score by the manager: bounded, with a reason, requested by somebody other than the person scored, and approved by a second person who is neither the maker nor the person scored. Fails with 422 `STAFF_SCORE_ADJUSTMENT_INVALID` naming the field. */
export function assertAdjustmentAllowed(policy: StaffScoringPolicy, request: AdjustmentRequest): void {
  const fail = (field: string): never => {
    throw new DomainError('STAFF_SCORE_ADJUSTMENT_INVALID', 422, field);
  };
  if (!Number.isFinite(request.points) || Math.abs(request.points) > policy.calibration.maxAdjustmentPoints) fail('points');
  if (request.reason.trim().length < policy.calibration.minReasonLength) fail('reason');
  if (request.requestedBy === request.subjectMembershipId) fail('requestedBy');
  if (request.approvedBy === null ? policy.calibration.requiresSecondApprover : request.approvedBy === request.requestedBy || request.approvedBy === request.subjectMembershipId) fail('approvedBy');
}

/** A score moved by `points`, kept inside 0 to 100. */
export const applyAdjustment = (score: number, points: number): number => round2(Math.min(100, Math.max(0, score + points)));

/** The hash that locks a period: the same figures always give the same hash, whatever the order of the keys. */
export const periodSnapshotHash = (snapshot: unknown): string => sha256Hex(canonicalJson(snapshot));

export interface OfficializeInput {
  lockedAt: string;
  responseWindowDays: number;
  responses: readonly { status: 'OPEN' | 'HANDLED' }[];
  today: string;
}

/** A locked period becomes official once the window of response has ended or every response was handled, and never while a response is still open (R43). */
export function canOfficialize(input: OfficializeInput): { official: boolean; reason: 'WINDOW_ENDED' | 'ALL_HANDLED' | 'WINDOW_OPEN' | 'RESPONSES_OPEN' } {
  if (input.responses.some((one) => one.status === 'OPEN')) return { official: false, reason: 'RESPONSES_OPEN' };
  if (workflowDaysBetween(input.lockedAt, input.today) > input.responseWindowDays) return { official: true, reason: 'WINDOW_ENDED' };
  if (input.responses.length > 0) return { official: true, reason: 'ALL_HANDLED' };
  return { official: false, reason: 'WINDOW_OPEN' };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Registration: the two rule types, the KPI definitions they point at and the RAG line of a score.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const linear = (worst: number, best: number): Raw => ({ kind: 'LINEAR', worst, best });
const stepped = (mode: 'AT_MOST' | 'AT_LEAST', steps: Array<[number, number]>, otherwise: number): Raw => ({ kind: 'STEPPED', mode, steps: steps.map(([bound, score]) => ({ bound, score })), otherwise_score: otherwise });
const setItem = (kpiCode: string, operation: KpiOperationCode, weight: number, scale: Raw, operationParams?: Raw): Raw => ({ kpi_code: kpiCode, operation, ...(operationParams === undefined ? {} : { operation_params: operationParams }), weight, scale, rag_code: 'PWF_SCORE' });

export const DEFAULT_KPI_SET_PARAMS: Readonly<Raw> = {
  template_code: DEFAULT_KPI_SET_TEMPLATE,
  items: [
    setItem('PWF_TASK_DEVIATION_DAYS', 'DAYS_DEVIATION', 40, linear(10, 0), { unit: 'WORKING', against: 'FIRST_BASELINE' }),
    setItem('PWF_ON_TIME_RATE', 'ON_TIME_RATE', 25, linear(50, 100), { grace_days: 0 }),
    setItem('PWF_AMOUNT_VARIANCE_PCT', 'AMOUNT_VARIANCE_PCT', 10, stepped('AT_MOST', [[0, 100], [5, 80], [10, 50]], 0)),
    setItem('PWF_RETURN_COUNT', 'RETURN_COUNT', 10, stepped('AT_MOST', [[0, 100], [1, 80], [2, 60]], 30)),
    setItem('PWF_EVIDENCE_COMPLETENESS', 'EVIDENCE_COMPLETENESS', 10, linear(60, 100)),
    setItem('PWF_RESCHEDULE_COUNT', 'RESCHEDULE_COUNT', 5, stepped('AT_MOST', [[0, 100], [1, 80], [2, 50]], 20)),
  ],
};

export const DEFAULT_STAFF_SCORING_PARAMS: Readonly<Raw> = {
  period_kind: 'QUARTER',
  role_factors: { RESPONSIBLE: 1, ACCOUNTABLE: 0.5, CONSULTED: 0.2, INFORMED: 0 },
  priority_weights: { LOW: 0.5, NORMAL: 1, HIGH: 1.5, CRITICAL: 2 },
  weight_by_planned_days: true,
  cancelled_unapproved: 'COUNT_AS_MISSED',
  min_rated_tasks: 5,
  min_effective_weight: 3,
  bands: [
    { code: 'EXCELLENT', min_score: 90 },
    { code: 'GOOD', min_score: 75 },
    { code: 'FAIR', min_score: 60 },
    { code: 'WEAK', min_score: 0 },
  ],
  calibration: { max_adjustment_points: 10, min_reason_length: 20, requires_second_approver: true },
  response_window_days: 10,
  retention_months: 60,
};

const kpiDefinition = (name: string, formula: string, unit: KpiOperationUnit, extra: Raw = {}): { params: Raw; formula: string; source: string } => ({
  params: { name, formula, source: T.kpi_source, unit, owner: T.kpi_owner, decimals: unit === 'COUNT' || unit === 'DAYS' ? 0 : 1, refresh_hours: 24, ...extra },
  formula,
  source: T.kpi_source,
});

/** Registers `WORKFLOW_KPI_SET` and `STAFF_SCORING_POLICY`, the six `KPI_DEFINITION` codes the default set points at and the `RAG_THRESHOLDS` code of a score. Called once by the registry (`registerProjectWorkflowModuleRules`). */
export function registerWorkflowKpiRules(registry: RuleRegistry): void {
  registry.registerRuleType({
    type: WORKFLOW_KPI_SET_RULE_TYPE,
    ownerModule: 'PWF',
    modules: ['PWF', 'BI', 'HOME'],
    formula: T.set_formula,
    source: T.set_source,
    asOf: WORKFLOW_KPI_DEFAULTS_AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: WORKFLOW_KPI_SET_SCHEMA,
    refine: (params) => {
      try {
        parseKpiSet(params);
        return undefined;
      } catch (failure) {
        return failure instanceof DomainError ? (failure.detail ?? 'params') : 'params';
      }
    },
    defaults: { [DEFAULT_KPI_SET_CODE]: { params: DEFAULT_KPI_SET_PARAMS as Record<string, unknown> } },
  });
  registry.registerRuleType({
    type: STAFF_SCORING_POLICY_RULE_TYPE,
    ownerModule: 'PWF',
    modules: ['PWF', 'HOME', 'ADM'],
    formula: T.policy_formula,
    source: T.policy_source,
    asOf: WORKFLOW_KPI_DEFAULTS_AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: STAFF_SCORING_POLICY_SCHEMA,
    refine: (params) => {
      try {
        parseStaffScoringPolicy(params);
        return undefined;
      } catch (failure) {
        return failure instanceof DomainError ? (failure.detail ?? 'params') : 'params';
      }
    },
    defaults: { DEFAULT: { params: DEFAULT_STAFF_SCORING_PARAMS as Record<string, unknown> } },
  });
  registry.registerRuleDefaults('RAG_THRESHOLDS', {
    PWF_SCORE: { params: { direction: 'HIGHER_IS_BETTER', green: 80, amber: 60, min_coverage_pct: 50 }, formula: T.rag_formula, source: T.rag_source, asOf: WORKFLOW_KPI_DEFAULTS_AS_OF, legalStatus: 'UNVERIFIED' },
  });
  registry.registerRuleDefaults('KPI_DEFINITION', {
    PWF_TASK_DEVIATION_DAYS: { ...kpiDefinition(T.deviation_name, T.deviation_formula, 'DAYS', { exclusions: [T.deviation_exclusions], period: 'MONTH' }), asOf: WORKFLOW_KPI_DEFAULTS_AS_OF, legalStatus: 'UNVERIFIED' },
    PWF_ON_TIME_RATE: { ...kpiDefinition(T.on_time_name, T.on_time_formula, 'PERCENT', { numerator: T.on_time_numerator, denominator: T.on_time_denominator, period: 'MONTH' }), asOf: WORKFLOW_KPI_DEFAULTS_AS_OF, legalStatus: 'UNVERIFIED' },
    PWF_AMOUNT_VARIANCE_PCT: { ...kpiDefinition(T.amount_name, T.amount_formula, 'PERCENT', { period: 'MONTH' }), asOf: WORKFLOW_KPI_DEFAULTS_AS_OF, legalStatus: 'UNVERIFIED' },
    PWF_RETURN_COUNT: { ...kpiDefinition(T.returns_name, T.returns_formula, 'COUNT', { period: 'MONTH' }), asOf: WORKFLOW_KPI_DEFAULTS_AS_OF, legalStatus: 'UNVERIFIED' },
    PWF_EVIDENCE_COMPLETENESS: { ...kpiDefinition(T.evidence_name, T.evidence_formula, 'PERCENT', { period: 'MONTH' }), asOf: WORKFLOW_KPI_DEFAULTS_AS_OF, legalStatus: 'UNVERIFIED' },
    PWF_RESCHEDULE_COUNT: { ...kpiDefinition(T.reschedule_name, T.reschedule_formula, 'COUNT', { period: 'MONTH' }), asOf: WORKFLOW_KPI_DEFAULTS_AS_OF, legalStatus: 'UNVERIFIED' },
  });
}
