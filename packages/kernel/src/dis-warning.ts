import { DomainError } from './errors.ts';

/**
 * The early-warning rules of DIS (ST-DIS-012, DIS 3 F7, BR-DIS-13): a rule is data (a metric, a comparator, a threshold, a severity, the legal basis it stands on), versioned and published by someone
 * other than its author; after each frozen snapshot the published rules are evaluated and a violation opens one warning, found again by its dedupe key. Thresholds are assumptions until the finance
 * office signs them. R1 evaluates the four metrics below, on a project each.
 */
export const WARNING_METRICS = ['YTD_RATE_GAP', 'REPORT_OVERDUE', 'NATIONAL_CODE_MISSING', 'PERIOD_DELTA_NEGATIVE'] as const;
export type WarningMetric = (typeof WARNING_METRICS)[number];
export const WARNING_COMPARATORS = ['LT', 'LTE', 'GT', 'GTE', 'EQ', 'MISSING', 'CONSECUTIVE_ZERO', 'DAYS_TO_DEADLINE_LTE'] as const;
export type WarningComparator = (typeof WARNING_COMPARATORS)[number];
export const WARNING_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number];
export const WARNING_SCOPES = ['PROJECT', 'UNIT', 'TENANT'] as const;
export type WarningScope = (typeof WARNING_SCOPES)[number];

/** The comparator each metric is read with: a rule that compares a metric another way is not a rule of this release. */
const COMPARATOR_OF: Readonly<Record<WarningMetric, WarningComparator>> = {
  YTD_RATE_GAP: 'GTE',
  REPORT_OVERDUE: 'MISSING',
  NATIONAL_CODE_MISSING: 'MISSING',
  PERIOD_DELTA_NEGATIVE: 'LT',
};

export interface RuleInput {
  rule_code?: unknown;
  name?: unknown;
  metric_code?: unknown;
  comparator?: unknown;
  threshold_json?: unknown;
  severity?: unknown;
  scope_kind?: unknown;
  auto_explanation?: unknown;
  legal_basis?: unknown;
  effective_from?: unknown;
  effective_until?: unknown;
}

export interface RuleDraft {
  ruleCode: string;
  name: string;
  metricCode: WarningMetric;
  comparator: WarningComparator;
  threshold: Record<string, unknown>;
  severity: WarningSeverity;
  scopeKind: WarningScope;
  autoExplanation: boolean;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
}

const RULE_CODE = /^[A-Z][A-Z0-9-]{0,29}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const bad = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function textOf(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw bad(field);
  const text = value.trim();
  if (text.length < min || text.length > max) throw bad(field);
  return text;
}

function dayOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DAY.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw bad(field);
  return value;
}

/** A positive number of points or days, whole or with up to four decimals, kept as text so that no rate is read through a float. */
function pointsOf(value: unknown, field: string): string {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,4})?$/.test(text) || Number(text) <= 0 || Number(text) > 100) throw bad(field);
  return text;
}

function wholeDays(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw bad(field);
  return value;
}

function thresholdOf(metric: WarningMetric, raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('threshold_json');
  const given = raw as Record<string, unknown>;
  const allowed = (keys: readonly string[]): void => {
    for (const key of Object.keys(given)) if (!keys.includes(key)) throw bad(`threshold_json.${key}`);
  };
  switch (metric) {
    case 'YTD_RATE_GAP': {
      allowed(['points', 'critical_points']);
      const points = pointsOf(given.points, 'threshold_json.points');
      if (given.critical_points === undefined) return { points };
      const critical = pointsOf(given.critical_points, 'threshold_json.critical_points');
      if (Number(critical) <= Number(points)) throw bad('threshold_json.critical_points');
      return { points, critical_points: critical };
    }
    case 'REPORT_OVERDUE': {
      allowed(['grace_days', 'explanation_due_days']);
      return {
        grace_days: given.grace_days === undefined ? 0 : wholeDays(given.grace_days, 'threshold_json.grace_days', 60),
        explanation_due_days: given.explanation_due_days === undefined ? 3 : wholeDays(given.explanation_due_days, 'threshold_json.explanation_due_days', 60),
      };
    }
    case 'NATIONAL_CODE_MISSING':
      allowed([]);
      return {};
    case 'PERIOD_DELTA_NEGATIVE':
      allowed([]);
      return {};
  }
}

/**
 * Judges a rule that someone proposes: a metric the product does not know is 422 METRIC_UNKNOWN (so that a rule never waits for a figure nobody computes), every other fault is 422 VALIDATION_FAILED on its field.
 * R1 evaluates rules of the scope PROJECT only; a rule of a unit or of the tenant is refused until a release evaluates it.
 */
export function checkRule(input: RuleInput): RuleDraft {
  const metric = typeof input.metric_code === 'string' ? input.metric_code.trim() : undefined;
  if (metric === undefined || metric === '') throw bad('metric_code');
  if (!(WARNING_METRICS as readonly string[]).includes(metric)) throw new DomainError('METRIC_UNKNOWN', 422, 'metric_code');
  const metricCode = metric as WarningMetric;
  const ruleCode = typeof input.rule_code === 'string' ? input.rule_code.trim() : '';
  if (!RULE_CODE.test(ruleCode)) throw bad('rule_code');
  if (input.comparator !== COMPARATOR_OF[metricCode]) throw bad('comparator');
  const severity = (WARNING_SEVERITIES as readonly unknown[]).includes(input.severity) ? (input.severity as WarningSeverity) : undefined;
  if (severity === undefined) throw bad('severity');
  if (input.scope_kind !== 'PROJECT') throw bad('scope_kind');
  if (input.auto_explanation !== undefined && typeof input.auto_explanation !== 'boolean') throw bad('auto_explanation');
  const effectiveFrom = dayOf(input.effective_from, 'effective_from');
  const effectiveUntil = input.effective_until === undefined ? null : dayOf(input.effective_until, 'effective_until');
  if (effectiveUntil !== null && effectiveUntil < effectiveFrom) throw bad('effective_until');
  return {
    ruleCode,
    name: textOf(input.name, 'name', 3, 300),
    metricCode,
    comparator: COMPARATOR_OF[metricCode],
    threshold: thresholdOf(metricCode, input.threshold_json),
    severity,
    scopeKind: 'PROJECT',
    autoExplanation: input.auto_explanation === true,
    legalBasis: textOf(input.legal_basis, 'legal_basis', 3, 2000),
    effectiveFrom,
    effectiveUntil,
  };
}

/** Whether a published rule is in force on a day: from its first day to its last, both included. */
export const inForce = (rule: { effectiveFrom: string; effectiveUntil: string | null }, day: string): boolean => rule.effectiveFrom <= day && (rule.effectiveUntil === null || day <= rule.effectiveUntil);

const SCALE = 10_000n;
const scaled = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0').slice(0, 4));
};
const plain = (value: bigint): string => `${value / SCALE}.${(value % SCALE).toString().padStart(4, '0')}`;

/**
 * The share of the year that the day has gone through, in percent: the expected curve that the disbursement of a project is held against (BR-DIS-13, assumption: a straight line over the days of the
 * year; the design also allows the line of what the project registered, which comes with the forecast).
 */
export function expectedRatePct(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const dayOfYear = Math.round((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const daysInYear = Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000);
  return plain((BigInt(dayOfYear) * 100n * SCALE * 2n + BigInt(daysInYear)) / (2n * BigInt(daysInYear)));
}

/** What the evaluation knows of one project in one snapshot. */
export interface ProjectFacts {
  /** The rate of the year plan of the project (the whole plan), or null when it has none (a rate that cannot be given is not a rate that is low). */
  ratePct: string | null;
  expectedPct: string;
  reportHandedIn: boolean;
  /** Whole days past the deadline of the period at the time of the evaluation (negative before it). */
  daysPastDeadline: number;
  hasCapital: boolean;
  hasNationalCode: boolean;
  /** What the project's cells changed in the period, in all (null when no cell had a period before it). */
  periodDeltaVnd: string | null;
}

export interface Violation {
  severity: WarningSeverity;
  observed: Record<string, unknown>;
  autoExplanation: boolean;
  explanationDueDays: number | null;
}

type RuleForEvaluation = Pick<RuleDraft, 'metricCode' | 'severity' | 'threshold' | 'autoExplanation'>;

/** Whether a project violates a rule in a snapshot, and with what severity and observation; null when it does not (or when the figure the rule needs is not there). */
export function evaluateRule(rule: RuleForEvaluation, facts: ProjectFacts): Violation | null {
  switch (rule.metricCode) {
    case 'YTD_RATE_GAP': {
      if (facts.ratePct === null) return null;
      const gap = scaled(facts.expectedPct) - scaled(facts.ratePct);
      if (gap < scaled(String(rule.threshold.points))) return null;
      const critical = rule.threshold.critical_points === undefined ? undefined : scaled(String(rule.threshold.critical_points));
      return {
        severity: critical !== undefined && gap >= critical ? 'CRITICAL' : rule.severity,
        observed: { metric: 'YTD_RATE_GAP', observed_pct: facts.ratePct, expected_pct: facts.expectedPct, gap_points: plain(gap) },
        autoExplanation: rule.autoExplanation,
        explanationDueDays: null,
      };
    }
    case 'REPORT_OVERDUE': {
      const grace = typeof rule.threshold.grace_days === 'number' ? rule.threshold.grace_days : 0;
      if (facts.reportHandedIn || facts.daysPastDeadline <= grace) return null;
      return {
        severity: rule.severity,
        observed: { metric: 'REPORT_OVERDUE', days_past_deadline: facts.daysPastDeadline },
        autoExplanation: rule.autoExplanation,
        explanationDueDays: rule.autoExplanation && typeof rule.threshold.explanation_due_days === 'number' ? rule.threshold.explanation_due_days : null,
      };
    }
    case 'NATIONAL_CODE_MISSING':
      if (!facts.hasCapital || facts.hasNationalCode) return null;
      return { severity: rule.severity, observed: { metric: 'NATIONAL_CODE_MISSING' }, autoExplanation: rule.autoExplanation, explanationDueDays: null };
    case 'PERIOD_DELTA_NEGATIVE':
      if (facts.periodDeltaVnd === null || BigInt(facts.periodDeltaVnd) >= 0n) return null;
      return { severity: rule.severity, observed: { metric: 'PERIOD_DELTA_NEGATIVE', delta_vnd: facts.periodDeltaVnd }, autoExplanation: rule.autoExplanation, explanationDueDays: null };
  }
}

/** Per project and year, or per project, year and period: the key under which one warning is open at most (`rule_code|subject|plan_year[|period]`). */
export function dedupeKeyOf(rule: { ruleCode: string; metricCode: WarningMetric }, projectId: string, planYear: number, periodId: string): string {
  const perPeriod = rule.metricCode === 'REPORT_OVERDUE' || rule.metricCode === 'PERIOD_DELTA_NEGATIVE';
  return perPeriod ? `${rule.ruleCode}|${projectId}|${planYear}|${periodId}` : `${rule.ruleCode}|${projectId}|${planYear}`;
}

export const WARNING_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED', 'RESOLVED', 'DISMISSED'] as const;
export type WarningStatus = (typeof WARNING_STATUSES)[number];
export const WARNING_ACTIONS = ['acknowledge', 'dismiss'] as const;
export type WarningAction = (typeof WARNING_ACTIONS)[number];

/** The statuses of a warning that is still to be handled: the one the dedupe key holds. */
export const OPEN_WARNING_STATUSES: readonly WarningStatus[] = ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED'];

const NEXT: Readonly<Record<WarningAction, Readonly<Partial<Record<WarningStatus, WarningStatus>>>>> = {
  acknowledge: { OPEN: 'ACKNOWLEDGED' },
  dismiss: { OPEN: 'DISMISSED', ACKNOWLEDGED: 'DISMISSED' },
};

/** The status after an action, or 409 WARNING_STATE_INVALID naming the status the warning is in (a warning that was handled or closed is not handled twice). */
export function nextWarningStatus(status: WarningStatus, action: WarningAction): WarningStatus {
  const next = NEXT[action][status];
  if (next === undefined) throw new DomainError('WARNING_STATE_INVALID', 409, 'status', { extensions: { warning_status: status } });
  return next;
}

/** The words an action must give: a reason of at least five characters (DisWarningAction), kept on the warning and on the audit trail. */
export function reasonOf(value: unknown): string {
  return textOf(value, 'reason', 5, 2000);
}
