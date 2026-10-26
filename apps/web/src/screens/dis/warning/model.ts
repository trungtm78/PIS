import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';

/** DIS-20: the early-warning rules and the warnings they open (ST-DIS-012, DIS 3 F7). */
export const WARNING_PATH = '/dis/dis-20';
export const MANAGE_PERMISSION = 'warning.rule.manage';
export const APPROVE_PERMISSION = 'warning.rule.approve';
export const HANDLE_PERMISSION = 'warning.handle';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

export const METRICS = ['YTD_RATE_GAP', 'REPORT_OVERDUE', 'NATIONAL_CODE_MISSING', 'PERIOD_DELTA_NEGATIVE'] as const;
export type Metric = (typeof METRICS)[number];
export const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const RULE_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export const WARNING_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'RESOLVED', 'DISMISSED'] as const;
export type WarningStatus = (typeof WARNING_STATUSES)[number];

/** The comparator each metric is read with (the server judges it too). */
export const COMPARATOR_OF: Readonly<Record<Metric, string>> = { YTD_RATE_GAP: 'GTE', REPORT_OVERDUE: 'MISSING', NATIONAL_CODE_MISSING: 'MISSING', PERIOD_DELTA_NEGATIVE: 'LT' };

export interface RuleView {
  id: string;
  ruleCode: string;
  name: string;
  metric: Metric;
  threshold: Record<string, unknown>;
  severity: Severity;
  autoExplanation: boolean;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  revision: number;
  status: RuleStatus;
  approvedBy: string | null;
  createdBy: string;
  version: number;
  /** For a draft: how many warnings it would open on the latest frozen close snapshot. */
  wouldOpen: number | null;
}

export function toRule(raw: unknown): RuleView | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.rule_code);
  const name = text(row?.name);
  const metric = METRICS.find((candidate) => candidate === row?.metric_code);
  const severity = SEVERITIES.find((candidate) => candidate === row?.severity);
  const status = RULE_STATUSES.find((candidate) => candidate === row?.status);
  const legal = text(row?.legal_basis);
  const from = text(row?.effective_from);
  const revision = whole(row?.revision);
  const version = whole(row?.version);
  const createdBy = text(row?.created_by);
  if (row === undefined || id === undefined || code === undefined || name === undefined || metric === undefined || severity === undefined || status === undefined || legal === undefined || from === undefined || revision === undefined || version === undefined || createdBy === undefined) return undefined;
  const preview = asRecord(row.preview);
  return {
    id,
    ruleCode: code,
    name,
    metric,
    threshold: asRecord(row.threshold_json) ?? {},
    severity,
    autoExplanation: row.auto_explanation === true,
    legalBasis: legal,
    effectiveFrom: from,
    effectiveUntil: nullableText(row.effective_until),
    revision,
    status,
    approvedBy: nullableText(row.approved_by),
    createdBy,
    version,
    wouldOpen: whole(preview?.would_open) ?? null,
  };
}

export interface WarningView {
  id: string;
  ruleCode: string;
  ruleName: string;
  projectCode: string | null;
  projectName: string | null;
  severity: Severity;
  observed: Record<string, unknown>;
  status: WarningStatus;
  resolutionReason: string | null;
  acknowledgementNote: string | null;
  openedAt: string;
  closedAt: string | null;
  version: number;
}

export function toWarning(raw: unknown): WarningView | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.rule_code);
  const name = text(row?.rule_name);
  const severity = SEVERITIES.find((candidate) => candidate === row?.severity);
  const status = WARNING_STATUSES.find((candidate) => candidate === row?.status);
  const opened = text(row?.opened_at);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || code === undefined || name === undefined || severity === undefined || status === undefined || opened === undefined || version === undefined) return undefined;
  const project = asRecord(row.project);
  return {
    id,
    ruleCode: code,
    ruleName: name,
    projectCode: nullableText(project?.code),
    projectName: nullableText(project?.name),
    severity,
    observed: asRecord(row.observed) ?? {},
    status,
    resolutionReason: nullableText(row.resolution_reason),
    acknowledgementNote: nullableText(row.acknowledgement_note),
    openedAt: opened,
    closedAt: nullableText(row.closed_at),
    version,
  };
}

export interface WarningPage {
  items: WarningView[];
  nextCursor: string | undefined;
}

export const toWarningPage = (raw: unknown): WarningPage => {
  const row = asRecord(raw);
  return { items: (Array.isArray(row?.items) ? row.items : []).flatMap((item) => toWarning(item) ?? []), nextCursor: text(row?.next_cursor) };
};

export const toRules = (raw: unknown): RuleView[] => (Array.isArray(asRecord(raw)?.items) ? (asRecord(raw)?.items as unknown[]) : []).flatMap((item) => toRule(item) ?? []);

/** A warning still to be handled: the ones a person can acknowledge or dismiss are narrower still. */
export const isOpenWarning = (warning: Pick<WarningView, 'status'>): boolean => warning.status === 'OPEN' || warning.status === 'ACKNOWLEDGED' || warning.status === 'EXPLANATION_REQUESTED';
export const canAcknowledge = (warning: Pick<WarningView, 'status'>): boolean => warning.status === 'OPEN';
export const canDismiss = (warning: Pick<WarningView, 'status'>): boolean => warning.status === 'OPEN' || warning.status === 'ACKNOWLEDGED';

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** The form of a rule: what the person types, as text. */
export interface RuleForm {
  ruleCode: string;
  name: string;
  metric: Metric;
  points: string;
  criticalPoints: string;
  graceDays: string;
  explanationDueDays: string;
  severity: Severity;
  autoExplanation: boolean;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string;
}

export const EMPTY_RULE_FORM: RuleForm = {
  ruleCode: '',
  name: '',
  metric: 'YTD_RATE_GAP',
  points: '10',
  criticalPoints: '',
  graceDays: '0',
  explanationDueDays: '3',
  severity: 'WARNING',
  autoExplanation: false,
  legalBasis: '',
  effectiveFrom: '',
  effectiveUntil: '',
};

/** The form of the next revision of a rule: its words as they stand, to be changed; the code stays. */
export function reviseForm(rule: RuleView): RuleForm {
  const threshold = rule.threshold;
  const str = (value: unknown, fallback: string): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : fallback);
  return {
    ruleCode: rule.ruleCode,
    name: rule.name,
    metric: rule.metric,
    points: str(threshold.points, '10'),
    criticalPoints: str(threshold.critical_points, ''),
    graceDays: str(threshold.grace_days, '0'),
    explanationDueDays: str(threshold.explanation_due_days, '3'),
    severity: rule.severity,
    autoExplanation: rule.autoExplanation,
    legalBasis: rule.legalBasis,
    effectiveFrom: rule.effectiveFrom,
    effectiveUntil: rule.effectiveUntil ?? '',
  };
}

export type RuleField = 'ruleCode' | 'name' | 'points' | 'criticalPoints' | 'graceDays' | 'explanationDueDays' | 'legalBasis' | 'effectiveFrom' | 'effectiveUntil';
export type FieldProblem = 'required' | 'invalid';

const RULE_CODE = /^[A-Z][A-Z0-9-]{0,29}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const POINTS = /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,4})?$/;

/** What is wrong with the form, field by field: the server judges all of it again, this only saves the trip. */
export function validateRule(form: RuleForm): Partial<Record<RuleField, FieldProblem>> {
  const problems: Partial<Record<RuleField, FieldProblem>> = {};
  if (form.ruleCode.trim() === '') problems.ruleCode = 'required';
  else if (!RULE_CODE.test(form.ruleCode.trim())) problems.ruleCode = 'invalid';
  if (form.name.trim().length < 3) problems.name = form.name.trim() === '' ? 'required' : 'invalid';
  if (form.legalBasis.trim().length < 3) problems.legalBasis = form.legalBasis.trim() === '' ? 'required' : 'invalid';
  if (form.effectiveFrom === '') problems.effectiveFrom = 'required';
  else if (!DAY.test(form.effectiveFrom)) problems.effectiveFrom = 'invalid';
  if (form.effectiveUntil !== '' && (!DAY.test(form.effectiveUntil) || form.effectiveUntil < form.effectiveFrom)) problems.effectiveUntil = 'invalid';
  if (form.metric === 'YTD_RATE_GAP') {
    if (form.points.trim() === '') problems.points = 'required';
    else if (!POINTS.test(form.points.trim()) || Number(form.points) <= 0 || Number(form.points) > 100) problems.points = 'invalid';
    if (form.criticalPoints.trim() !== '' && (!POINTS.test(form.criticalPoints.trim()) || Number(form.criticalPoints) <= Number(form.points) || Number(form.criticalPoints) > 100)) problems.criticalPoints = 'invalid';
  }
  if (form.metric === 'REPORT_OVERDUE') {
    if (!/^\d{1,2}$/.test(form.graceDays.trim())) problems.graceDays = 'invalid';
    if (!/^\d{1,2}$/.test(form.explanationDueDays.trim())) problems.explanationDueDays = 'invalid';
  }
  return problems;
}

export type RuleBody = components['schemas']['DisWarningRule'];

/** The request of a new revision, in the words of the contract; empty optional parts are not sent. */
export function ruleBody(form: RuleForm): RuleBody {
  const threshold: Record<string, unknown> =
    form.metric === 'YTD_RATE_GAP'
      ? { points: form.points.trim(), ...(form.criticalPoints.trim() === '' ? {} : { critical_points: form.criticalPoints.trim() }) }
      : form.metric === 'REPORT_OVERDUE'
        ? { grace_days: Number(form.graceDays), explanation_due_days: Number(form.explanationDueDays) }
        : {};
  return {
    rule_code: form.ruleCode.trim(),
    name: form.name.trim(),
    metric_code: form.metric,
    comparator: COMPARATOR_OF[form.metric] as RuleBody['comparator'],
    threshold_json: threshold as RuleBody['threshold_json'],
    severity: form.severity,
    scope_kind: 'PROJECT',
    auto_explanation: form.autoExplanation,
    legal_basis: form.legalBasis.trim(),
    effective_from: form.effectiveFrom,
    ...(form.effectiveUntil === '' ? {} : { effective_until: form.effectiveUntil }),
  };
}

export type WarningProblem = 'unknownMetric' | 'selfApproval' | 'versionConflict' | 'stateInvalid' | 'stageDenied' | 'validation' | 'scopeDenied' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, WarningProblem>> = {
  METRIC_UNKNOWN: 'unknownMetric',
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'versionConflict',
  WARNING_STATE_INVALID: 'stateInvalid',
  STAGE_TRANSITION_DENIED: 'stageDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  SCOPE_DENIED: 'scopeDenied',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeWarning = (error: unknown): WarningProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

/** The field of a form that a 422 names, so that the message stands next to it. */
export function fieldOf(error: unknown): RuleField | undefined {
  if (!(error instanceof ApiError) || error.detail === undefined) return undefined;
  const detail = error.detail;
  const map: Record<string, RuleField> = { rule_code: 'ruleCode', name: 'name', legal_basis: 'legalBasis', effective_from: 'effectiveFrom', effective_until: 'effectiveUntil', 'threshold_json.points': 'points', 'threshold_json.critical_points': 'criticalPoints', 'threshold_json.grace_days': 'graceDays', 'threshold_json.explanation_due_days': 'explanationDueDays' };
  return map[detail];
}

export const resourceIdOf = (done: unknown): string | undefined => {
  const id = asRecord(done)?.resource_id;
  return typeof id === 'string' ? id : undefined;
};
