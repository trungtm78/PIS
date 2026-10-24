import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import type { FreshnessUnit, QualityBadge } from './model';

export const QUALITY_MANAGE_PERMISSION = 'data.quality.manage';
export const QUALITY_APPROVE_PERMISSION = 'data.quality.approve';
export const QUALITY_RUN_PERMISSION = 'data.quality.run';
export const QUALITY_READ_PERMISSION = 'data.quality.read';
export const RULE_READ_PERMISSION = 'quality_rule_version.read';

export const DIMENSIONS = ['COMPLETENESS', 'UNIQUENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS', 'ACCURACY', 'INTEGRITY'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** Accuracy is measured from a confirmed source or an expert sample, which no rule can express yet: the form offers the other six. */
export const WRITABLE_DIMENSIONS = DIMENSIONS.filter((dimension): dimension is Exclude<Dimension, 'ACCURACY'> => dimension !== 'ACCURACY');
export type WritableDimension = (typeof WRITABLE_DIMENSIONS)[number];
export const ACTIONS = ['QUARANTINE', 'HARD_BLOCK', 'WARN'] as const;
export type ActionOnFail = (typeof ACTIONS)[number];
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
const RULE_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
const RESULTS = ['PASS', 'WARN', 'FAIL', 'ERROR'] as const;
export type RuleResult = (typeof RESULTS)[number];
const RUN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
const OVERALL = ['PASSED', 'WARNING', 'FAILED'] as const;
export type Overall = (typeof OVERALL)[number];
const TRIGGERS = ['SNAPSHOT_FROZEN', 'IMPORT_BATCH', 'SCHEDULE', 'MANUAL'] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const COMPARATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;
export type Comparator = (typeof COMPARATORS)[number];

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const nullableWhole = (value: unknown): number | null => whole(value) ?? null;
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((item) => item === value);

// ---- what the server answers ------------------------------------------------------------------------------------------

/** The picture of the datasets that the filter matches (DGV-01). The average leaves out the datasets that were never assessed. */
export interface QualitySummary {
  total: number;
  notAssessed: number;
  passed: number;
  warning: number;
  failed: number;
  stale: number;
  hardFail: number;
  openIncidents: number;
  overdueIncidents: number;
  /** A decimal string in hundredths, null when no dataset has a score: never 0 for "nothing measured". */
  averageScore: string | null;
}

export function toSummary(raw: unknown): QualitySummary | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const numbers = ['total', 'not_assessed', 'passed', 'warning', 'failed', 'stale', 'hard_fail', 'open_incidents', 'overdue_incidents'].map((key) => whole(row[key]));
  if (numbers.some((value) => value === undefined)) return undefined;
  const [total, notAssessed, passed, warning, failed, stale, hardFail, openIncidents, overdueIncidents] = numbers as number[];
  return {
    total: total as number,
    notAssessed: notAssessed as number,
    passed: passed as number,
    warning: warning as number,
    failed: failed as number,
    stale: stale as number,
    hardFail: hardFail as number,
    openIncidents: openIncidents as number,
    overdueIncidents: overdueIncidents as number,
    averageScore: nullableText(row.average_score),
  };
}

export interface RuleView {
  id: string;
  contractId: string;
  datasetId: string;
  datasetCode: string;
  code: string;
  revision: number;
  dimension: Dimension;
  fieldPath: string | null;
  expression: Record<string, unknown>;
  severity: Severity;
  minPassRate: string;
  warnPassRate: string | null;
  action: ActionOnFail;
  weight: number;
  status: RuleStatus;
  createdBy: string;
  createdByName: string | null;
  approvedByName: string | null;
  version: number;
}

export function toRule(raw: unknown): RuleView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const threshold = asRecord(row.threshold_json);
  const expression = asRecord(row.expression_ast);
  const id = text(row.id);
  const contractId = text(row.contract_id);
  const datasetId = text(row.dataset_id);
  const datasetCode = text(row.dataset_code);
  const code = text(row.code);
  const revision = whole(row.revision);
  const dimension = oneOf(DIMENSIONS, row.dimension);
  const severity = oneOf(SEVERITIES, row.severity);
  const action = oneOf(ACTIONS, row.action_on_fail);
  const weight = whole(row.criticality_weight);
  const status = oneOf(RULE_STATUSES, row.status);
  const createdBy = text(row.created_by);
  const version = whole(row.version);
  const minPassRate = text(threshold?.min_pass_rate_pct);
  if (
    id === undefined || contractId === undefined || datasetId === undefined || datasetCode === undefined || code === undefined || revision === undefined || dimension === undefined || severity === undefined ||
    action === undefined || weight === undefined || status === undefined || createdBy === undefined || version === undefined || minPassRate === undefined || expression === undefined
  ) {
    return undefined;
  }
  return {
    id,
    contractId,
    datasetId,
    datasetCode,
    code,
    revision,
    dimension,
    fieldPath: nullableText(row.field_path),
    expression,
    severity,
    minPassRate,
    warnPassRate: nullableText(threshold?.warn_pass_rate_pct),
    action,
    weight,
    status,
    createdBy,
    createdByName: nullableText(row.created_by_name),
    approvedByName: nullableText(row.approved_by_name),
    version,
  };
}

export interface DimensionView {
  dimension: Dimension;
  assessed: boolean;
  score: string | null;
  rulesTotal: number;
  rulesFailed: number;
}

export interface ScoredRuleView {
  ruleVersionId: string;
  code: string;
  revision: number;
  dimension: Dimension;
  severity: Severity;
  action: ActionOnFail;
  weight: number;
  fieldPath: string | null;
  evaluated: number;
  passed: number;
  failed: number;
  quarantined: number;
  measuredValue: string | null;
  minPassRate: string | null;
  result: RuleResult;
  errorCode: string | null;
  incidentId: string | null;
}

export interface RunView {
  id: string;
  snapshotId: string;
  trigger: Trigger;
  status: RunStatus;
  overall: Overall | null;
  score: string | null;
  hardFail: boolean;
  certifiedBlocked: boolean;
  failureCode: string | null;
  ruleCount: number;
  quarantined: number;
  startedAt: string;
  finishedAt: string | null;
  snapshotAsOf: string | null;
  definitionStatus: string | null;
}

export interface ScorecardView {
  datasetId: string;
  datasetCode: string;
  title: string;
  domain: string;
  badge: QualityBadge;
  assessed: boolean;
  score: string | null;
  hardFail: boolean | null;
  certifiedBlocked: boolean | null;
  sloSeconds: number;
  ageSeconds: number | null;
  snapshotId: string | null;
  snapshotAsOf: string | null;
  definitionStatus: string | null;
  asOf: string;
  latestRun: RunView | null;
  pendingAttempt: RunView | null;
  dimensions: DimensionView[];
  rules: ScoredRuleView[];
  openIncidents: number;
  overdueIncidents: number;
}

const BADGES = ['NOT_ASSESSED', 'PASSED', 'WARNING', 'FAILED', 'STALE'] as const;

function toRun(raw: unknown): RunView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const snapshotId = text(row.snapshot_id);
  const trigger = oneOf(TRIGGERS, row.trigger);
  const status = oneOf(RUN_STATUSES, row.status);
  const startedAt = text(row.started_at);
  const ruleCount = whole(row.rule_count);
  if (id === undefined || snapshotId === undefined || trigger === undefined || status === undefined || startedAt === undefined || ruleCount === undefined || typeof row.hard_fail !== 'boolean' || typeof row.certified_blocked !== 'boolean') {
    return undefined;
  }
  return {
    id,
    snapshotId,
    trigger,
    status,
    overall: oneOf(OVERALL, row.overall_result) ?? null,
    score: nullableText(row.score),
    hardFail: row.hard_fail,
    certifiedBlocked: row.certified_blocked,
    failureCode: nullableText(row.failure_code),
    ruleCount,
    quarantined: whole(row.quarantined_count) ?? 0,
    startedAt,
    finishedAt: nullableText(row.finished_at),
    snapshotAsOf: nullableText(row.snapshot_as_of),
    definitionStatus: nullableText(row.definition_status),
  };
}

function toDimension(raw: unknown): DimensionView | undefined {
  const row = asRecord(raw);
  const dimension = oneOf(DIMENSIONS, row?.dimension);
  const rulesTotal = whole(row?.rules_total);
  const rulesFailed = whole(row?.rules_failed);
  if (row === undefined || dimension === undefined || typeof row.assessed !== 'boolean' || rulesTotal === undefined || rulesFailed === undefined) return undefined;
  return { dimension, assessed: row.assessed, score: nullableText(row.score), rulesTotal, rulesFailed };
}

function toScoredRule(raw: unknown): ScoredRuleView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const ruleVersionId = text(row.rule_version_id);
  const code = text(row.code);
  const revision = whole(row.revision);
  const dimension = oneOf(DIMENSIONS, row.dimension);
  const severity = oneOf(SEVERITIES, row.severity);
  const action = oneOf(ACTIONS, row.action_on_fail);
  const weight = whole(row.criticality_weight);
  const result = oneOf(RESULTS, row.result);
  const evaluated = whole(row.evaluated_count);
  const passed = whole(row.passed_count);
  const failed = whole(row.failed_count);
  const quarantined = whole(row.quarantined_count);
  if (
    ruleVersionId === undefined || code === undefined || revision === undefined || dimension === undefined || severity === undefined || action === undefined || weight === undefined || result === undefined ||
    evaluated === undefined || passed === undefined || failed === undefined || quarantined === undefined
  ) {
    return undefined;
  }
  return {
    ruleVersionId,
    code,
    revision,
    dimension,
    severity,
    action,
    weight,
    fieldPath: nullableText(row.field_path),
    evaluated,
    passed,
    failed,
    quarantined,
    measuredValue: nullableText(row.measured_value),
    minPassRate: nullableText(asRecord(row.threshold)?.min_pass_rate_pct),
    result,
    errorCode: nullableText(row.error_code),
    incidentId: nullableText(row.incident_id),
  };
}

/** The scorecard of a dataset as the server answers it; an answer that does not have the shape is refused rather than shown half-filled. */
export function toScorecard(raw: unknown): ScorecardView | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const freshness = asRecord(row.freshness);
  const datasetId = text(row.dataset_id);
  const datasetCode = text(row.dataset_code);
  const title = text(row.title);
  const domain = text(row.domain);
  const badge = oneOf(BADGES, row.badge);
  const sloSeconds = whole(freshness?.slo_seconds);
  const asOf = text(row.as_of);
  const openIncidents = whole(row.open_incidents);
  const overdueIncidents = whole(row.overdue_incidents);
  if (
    datasetId === undefined || datasetCode === undefined || title === undefined || domain === undefined || badge === undefined || sloSeconds === undefined || asOf === undefined || typeof row.assessed !== 'boolean' ||
    openIncidents === undefined || overdueIncidents === undefined || !Array.isArray(row.dimensions) || !Array.isArray(row.rules)
  ) {
    return undefined;
  }
  return {
    datasetId,
    datasetCode,
    title,
    domain,
    badge,
    assessed: row.assessed,
    score: nullableText(row.score),
    hardFail: typeof row.hard_fail === 'boolean' ? row.hard_fail : null,
    certifiedBlocked: typeof row.certified_blocked === 'boolean' ? row.certified_blocked : null,
    sloSeconds,
    ageSeconds: nullableWhole(freshness?.age_seconds),
    snapshotId: nullableText(row.snapshot_id),
    snapshotAsOf: nullableText(row.snapshot_as_of),
    definitionStatus: nullableText(row.definition_status),
    asOf,
    latestRun: toRun(row.latest_run) ?? null,
    pendingAttempt: toRun(row.pending_attempt) ?? null,
    dimensions: row.dimensions.flatMap((item) => toDimension(item) ?? []),
    rules: row.rules.flatMap((item) => toScoredRule(item) ?? []),
    openIncidents,
    overdueIncidents,
  };
}

// ---- time -------------------------------------------------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** A length of time in the largest unit it fills, cut down ("2 days" for 49 hours): a run is never said to be younger than it is. */
export function durationOf(seconds: number): { unit: FreshnessUnit; count: number } {
  if (seconds >= DAY) return { unit: 'days', count: Math.floor(seconds / DAY) };
  if (seconds >= HOUR) return { unit: 'hours', count: Math.floor(seconds / HOUR) };
  if (seconds >= MINUTE) return { unit: 'minutes', count: Math.floor(seconds / MINUTE) };
  return { unit: 'seconds', count: Math.max(0, Math.floor(seconds)) };
}

/** Seconds from an instant (ISO text) to `nowMs`, never negative; null when there is no instant or it is not a date. */
export function ageSecondsOf(instant: string | null, nowMs: number): number | null {
  if (instant === null) return null;
  const at = Date.parse(instant);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((nowMs - at) / 1000));
}

/** An instant as "2026-10-24 08:30" in UTC (the screens say it is UTC); text that is not a date is shown as it came. */
export function instantText(instant: string): string {
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? instant : at.toISOString().slice(0, 16).replace('T', ' ');
}

// ---- the form of a rule -----------------------------------------------------------------------------------------------

export const OPERATORS = ['not_null', 'not_blank', 'is_null', 'compare', 'between', 'in', 'compare_fields', 'unique', 'reference_exists', 'snapshot_age_within'] as const;
export type Operator = (typeof OPERATORS)[number];

/** The operators a dimension allows (the server judges the rule again, and the list here only keeps the form from offering what it will refuse). */
export const OPERATORS_BY_DIMENSION: Readonly<Record<WritableDimension, readonly Operator[]>> = {
  COMPLETENESS: ['not_null', 'not_blank'],
  VALIDITY: ['compare', 'between', 'in', 'is_null', 'not_null', 'not_blank'],
  UNIQUENESS: ['unique'],
  CONSISTENCY: ['compare_fields'],
  TIMELINESS: ['snapshot_age_within'],
  INTEGRITY: ['reference_exists'],
};

export interface RuleForm {
  code: string;
  dimension: WritableDimension;
  operator: Operator;
  field: string;
  otherField: string;
  comparator: Comparator;
  value: string;
  min: string;
  max: string;
  values: string;
  seconds: string;
  minRate: string;
  warnRate: string;
  severity: Severity;
  action: ActionOnFail;
  weight: string;
}

export type RuleField = keyof RuleForm;
/** The fields of the form that hold text typed by a person. */
export type RuleTextField = 'code' | 'field' | 'otherField' | 'value' | 'min' | 'max' | 'values' | 'seconds' | 'minRate' | 'warnRate' | 'weight';
export type RuleProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidNumber' | 'invalidRate' | 'invalidList' | 'warnNotBelowMin';
export type RuleErrors = Partial<Record<RuleField, RuleProblem>>;

export const EMPTY_RULE_FORM: RuleForm = {
  code: '',
  dimension: 'COMPLETENESS',
  operator: 'not_null',
  field: '',
  otherField: '',
  comparator: 'eq',
  value: '',
  min: '',
  max: '',
  values: '',
  seconds: '',
  minRate: '100',
  warnRate: '',
  severity: 'MEDIUM',
  action: 'QUARANTINE',
  weight: '1',
};

/** The form after the dimension changed: the operator stays when the new dimension allows it, otherwise it is the first one it allows. */
export function withDimension(form: RuleForm, dimension: WritableDimension): RuleForm {
  const allowed = OPERATORS_BY_DIMENSION[dimension];
  const operator = allowed.includes(form.operator) ? form.operator : (allowed[0] as Operator);
  // An integrity failure is a hard failure: it can only block or quarantine, never merely warn.
  const action = dimension === 'INTEGRITY' && form.action === 'WARN' ? 'QUARANTINE' : form.action;
  return { ...form, dimension, operator, action, minRate: dimension === 'INTEGRITY' ? '100' : form.minRate };
}

const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const RATE = /^\d{1,3}(\.\d{1,6})?$/;
const SIGNED_NUMBER = /^-?\d{1,18}(\.\d{1,6})?$/;
const WHOLE = /^[1-9][0-9]{0,8}$/;
const MAX_CODE = 80;
const MIN_CODE = 2;
const MAX_LITERAL = 200;
const MAX_VALUES = 50;
const MAX_UNIQUE_FIELDS = 4;
const FULL_RATE = 100;

/** The fields named in a comma separated list: the ones that are plain names, once each; null when one is not or the list is empty or too long. */
function fieldList(value: string, max: number): string[] | null {
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => !FIELD_NAME.test(item)) || items.length > max) return null;
  return [...new Set(items)];
}

function rateOf(value: string): number | undefined {
  const trimmed = value.trim();
  if (!RATE.test(trimmed)) return undefined;
  const rate = Number(trimmed);
  return rate > FULL_RATE ? undefined : rate;
}

export function validateRule(form: RuleForm): RuleErrors {
  const errors: RuleErrors = {};
  const code = form.code.trim();
  if (code === '') errors.code = 'required';
  else if (code.length < MIN_CODE) errors.code = 'tooShort';
  else if (code.length > MAX_CODE) errors.code = 'tooLong';
  const needsField = ['not_null', 'not_blank', 'is_null', 'compare', 'between', 'in', 'reference_exists'].includes(form.operator);
  if (needsField && !FIELD_NAME.test(form.field.trim())) errors.field = form.field.trim() === '' ? 'required' : 'invalidList';
  if (form.operator === 'compare_fields') {
    if (!FIELD_NAME.test(form.field.trim())) errors.field = form.field.trim() === '' ? 'required' : 'invalidList';
    if (!FIELD_NAME.test(form.otherField.trim())) errors.otherField = form.otherField.trim() === '' ? 'required' : 'invalidList';
  }
  if (form.operator === 'compare' && (form.value.trim() === '' || form.value.length > MAX_LITERAL)) errors.value = form.value.trim() === '' ? 'required' : 'tooLong';
  if (form.operator === 'between') {
    if (!SIGNED_NUMBER.test(form.min.trim())) errors.min = form.min.trim() === '' ? 'required' : 'invalidNumber';
    if (!SIGNED_NUMBER.test(form.max.trim())) errors.max = form.max.trim() === '' ? 'required' : 'invalidNumber';
  }
  if (form.operator === 'in') {
    const items = form.values.split(',').map((item) => item.trim());
    if (form.values.trim() === '') errors.values = 'required';
    else if (items.some((item) => item === '' || item.length > MAX_LITERAL) || items.length > MAX_VALUES) errors.values = 'invalidList';
  }
  if (form.operator === 'unique') {
    if (form.field.trim() === '') errors.field = 'required';
    else if (fieldList(form.field, MAX_UNIQUE_FIELDS) === null) errors.field = 'invalidList';
  }
  if (form.operator === 'snapshot_age_within' && !WHOLE.test(form.seconds.trim())) errors.seconds = form.seconds.trim() === '' ? 'required' : 'invalidNumber';
  const min = rateOf(form.minRate);
  if (min === undefined || min === 0) errors.minRate = 'invalidRate';
  else if (form.dimension === 'INTEGRITY' && min !== FULL_RATE) errors.minRate = 'invalidRate';
  if (form.warnRate.trim() !== '') {
    const warn = rateOf(form.warnRate);
    if (warn === undefined) errors.warnRate = 'invalidRate';
    else if (min !== undefined && warn >= min) errors.warnRate = 'warnNotBelowMin';
  }
  if (!WHOLE.test(form.weight.trim()) || Number(form.weight) > 10) errors.weight = 'invalidNumber';
  return errors;
}

/** The expression of a form that passed `validateRule`, as the allowlisted node the server stores. */
export function buildExpression(form: RuleForm): Record<string, unknown> {
  const field = form.field.trim();
  switch (form.operator) {
    case 'not_null':
    case 'not_blank':
    case 'is_null':
    case 'reference_exists':
      return { op: form.operator, field };
    case 'compare':
      return { op: 'compare', field, cmp: form.comparator, value: form.value.trim() };
    case 'between':
      return { op: 'between', field, min: form.min.trim(), max: form.max.trim() };
    case 'in':
      return { op: 'in', field, values: form.values.split(',').map((item) => item.trim()) };
    case 'compare_fields':
      return { op: 'compare_fields', left: field, cmp: form.comparator, right: form.otherField.trim() };
    case 'unique':
      return { op: 'unique', fields: fieldList(form.field, MAX_UNIQUE_FIELDS) ?? [] };
    case 'snapshot_age_within':
      return { op: 'snapshot_age_within', seconds: Number(form.seconds.trim()) };
  }
}

/** The body of a draft: the contract types the expression and the threshold as plain objects; here they are told apart. */
export type RuleDraftBody = Omit<components['schemas']['DgvRuleDraft'], 'expression_ast' | 'threshold_json'> & { expression_ast: Record<string, unknown>; threshold_json: Record<string, string> };

export function buildRuleBody(contractId: string, form: RuleForm): RuleDraftBody {
  const threshold: Record<string, string> = { min_pass_rate_pct: form.minRate.trim() };
  if (form.warnRate.trim() !== '') threshold.warn_pass_rate_pct = form.warnRate.trim();
  return {
    contract_id: contractId,
    code: form.code.trim(),
    dimension: form.dimension,
    expression_ast: buildExpression(form),
    severity: form.severity,
    threshold_json: threshold,
    action_on_fail: form.action,
    criticality_weight: Number(form.weight.trim()),
  };
}

/** A short text of what a stored expression says, for the list of rules: the operator and the fields, never a value of the data. */
export function expressionSummary(expression: Record<string, unknown>): string {
  const op = typeof expression.op === 'string' ? expression.op : '';
  const part = (node: unknown): string => (typeof node === 'object' && node !== null ? expressionSummary(node as Record<string, unknown>) : '');
  if (Array.isArray(expression.args)) return `(${expression.args.map(part).join(`) ${op} (`)})`;
  if (typeof expression.arg === 'object' && expression.arg !== null) return `${op} (${part(expression.arg)})`;
  const parts: string[] = [];
  for (const key of ['field', 'left', 'cmp', 'right', 'seconds']) {
    const value = expression[key];
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
  }
  if (Array.isArray(expression.fields)) parts.push(expression.fields.filter((item): item is string => typeof item === 'string').join(', '));
  return `${op} ${parts.join(' ')}`.trim();
}

// ---- the form of a run ------------------------------------------------------------------------------------------------

export type RunProblem = 'required' | 'invalidId';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateRunSnapshot(snapshotId: string): RunProblem | undefined {
  const trimmed = snapshotId.trim();
  if (trimmed === '') return 'required';
  return UUID.test(trimmed) ? undefined : 'invalidId';
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type QualityProblemReason =
  | 'expressionNotAllowed'
  | 'thresholdInvalid'
  | 'selfApproval'
  | 'snapshotNotFound'
  | 'snapshotNotFrozen'
  | 'alreadyRunning'
  | 'versionConflict'
  | 'notDraft'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

export interface QualityProblem {
  reason: QualityProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, QualityProblemReason>> = {
  EXPRESSION_NOT_ALLOWED: 'expressionNotAllowed',
  THRESHOLD_INVALID: 'thresholdInvalid',
  SELF_APPROVAL_DENIED: 'selfApproval',
  SNAPSHOT_NOT_FOUND: 'snapshotNotFound',
  RUN_ALREADY_RUNNING: 'alreadyRunning',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
};

/** Maps the error of a command of the quality screens to what they show; a conflict of state is told apart by the field it names. */
export function describeQualityProblem(error: unknown): QualityProblem {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  if (error.code === 'STAGE_TRANSITION_DENIED') return { reason: error.detail === 'snapshot_id' ? 'snapshotNotFrozen' : 'notDraft', field: error.detail };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
