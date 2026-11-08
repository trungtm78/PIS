import { DomainError } from './errors.ts';
import { message } from './messages.ts';

/**
 * The thresholds of the committee workspace (lane BAN-1, docs/committee-workspace.md): the expected curve of the disbursement of the year, the lines a sector or a unit is judged against, what makes a project need the
 * attention of the head of the committee and how much each reason weighs, and the lines of the four alerts of the committee. All of it is the governance rule `COMMITTEE_POLICY` (code DEFAULT): a tenant approves its own
 * version, the built-in values below are the starting values of the research and are flagged UNVERIFIED on every screen that shows a figure judged against them. Pure: no clock and no database.
 */

export const COMMITTEE_POLICY_RULE_TYPE = 'COMMITTEE_POLICY';
export const COMMITTEE_POLICY_CODE = 'DEFAULT';

export interface CurvePoint {
  /** The month whose last day the point is for (1 to 12). */
  month: number;
  /** The share of the plan of the year that should be disbursed by that day, in percent. */
  cumulativePct: number;
}

export interface CommitteeWeights {
  delayed: number;
  stalled: number;
  overBudget: number;
  farBelow: number;
  notReporting: number;
}

export interface CommitteePolicy {
  curve: readonly CurvePoint[];
  /** The province is behind when its rate is more than this many points below the curve on the day. */
  provinceGapPoints: number;
  /** Colour lines for the gap (rate minus curve, in points): green at or above `ragGapGreen`, amber at or above `ragGapAmber`, red below. */
  ragGapGreen: number;
  ragGapAmber: number;
  /** A sector is far behind when its rate is more than this many points below the rate of the province. */
  sectorGapPoints: number;
  /** A sector whose plan is smaller than this share of the plan of the province is not raised (a tiny plan swings). */
  sectorMinPlanSharePct: number;
  unitNotReportingDays: number;
  unitMinReportingRatePct: number;
  delayDays: number;
  stalledDays: number;
  overBudgetPct: number;
  /** A project is far below plan when its rate is more than this many points below the curve on the day. */
  farBelowPoints: number;
  weights: CommitteeWeights;
  /** The money (whole dong) at which the exposure of a project weighs fully in the impact score. */
  exposureReferenceVnd: number;
  attentionTopN: number;
  /** A unit with at least this many overdue directives raises the alert of directives overdue. */
  directiveOverdueAlertCount: number;
}

/**
 * The starting values. The curve is the expected cumulative disbursement over the year: the research of the roadmap names no law for it, so it is a configuration the committee fixes with the Finance Department;
 * 25 percent by the end of March, 50 by the end of June, 80 by the end of September and 100 by the end of the year are the orders of magnitude of the yearly directives of the Prime Minister on public investment.
 */
export const COMMITTEE_POLICY_DEFAULTS: CommitteePolicy = {
  curve: [
    { month: 1, cumulativePct: 4 },
    { month: 2, cumulativePct: 8 },
    { month: 3, cumulativePct: 15 },
    { month: 4, cumulativePct: 25 },
    { month: 5, cumulativePct: 35 },
    { month: 6, cumulativePct: 50 },
    { month: 7, cumulativePct: 60 },
    { month: 8, cumulativePct: 70 },
    { month: 9, cumulativePct: 80 },
    { month: 10, cumulativePct: 90 },
    { month: 11, cumulativePct: 95 },
    { month: 12, cumulativePct: 100 },
  ],
  provinceGapPoints: 5,
  ragGapGreen: -5,
  ragGapAmber: -15,
  sectorGapPoints: 10,
  sectorMinPlanSharePct: 1,
  unitNotReportingDays: 14,
  unitMinReportingRatePct: 50,
  delayDays: 30,
  stalledDays: 45,
  overBudgetPct: 5,
  farBelowPoints: 20,
  weights: { delayed: 3, stalled: 2, overBudget: 3, farBelow: 2, notReporting: 1 },
  exposureReferenceVnd: 100_000_000_000,
  attentionTopN: 25,
  directiveOverdueAlertCount: 1,
};

export interface CommitteePolicyReading {
  code: string;
  /** The version of the rule in force; null for the built-in default. */
  version: number | null;
  source: 'DEFAULT' | 'RULE';
  unverified: boolean;
  params: CommitteePolicy;
}

export const defaultCommitteePolicy = (): CommitteePolicyReading => ({ code: COMMITTEE_POLICY_CODE, version: null, source: 'DEFAULT', unverified: true, params: structuredClone(COMMITTEE_POLICY_DEFAULTS) });

const badParams = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const isNum = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const record = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badParams(field);
  return value as Record<string, unknown>;
};
const closed = (input: Record<string, unknown>, allowed: readonly string[], prefix = ''): void => {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw badParams(`${prefix}${key}`);
};

const KEYS = [
  'curve',
  'province_gap_points',
  'rag_gap_green',
  'rag_gap_amber',
  'sector_gap_points',
  'sector_min_plan_share_pct',
  'unit_not_reporting_days',
  'unit_min_reporting_rate_pct',
  'delay_days',
  'stalled_days',
  'over_budget_pct',
  'far_below_points',
  'weights',
  'exposure_reference_vnd',
  'attention_top_n',
  'directive_overdue_alert_count',
] as const;
const WEIGHT_KEYS = ['delayed', 'stalled', 'over_budget', 'far_below', 'not_reporting'] as const;

/** The params of an approved rule, judged again as they are read: one that cannot be understood is never half applied. */
export function parseCommitteePolicy(raw: unknown): CommitteePolicy {
  const input = record(raw, 'params');
  closed(input, KEYS);
  const points = input.curve;
  if (!Array.isArray(points) || points.length !== 12) throw badParams('curve');
  const curve = points.map((point, index): CurvePoint => {
    const item = record(point, `curve[${index}]`);
    closed(item, ['month', 'cumulative_pct'], `curve[${index}].`);
    if (item.month !== index + 1) throw badParams(`curve[${index}].month`);
    if (!isNum(item.cumulative_pct, 0, 100)) throw badParams(`curve[${index}].cumulative_pct`);
    return { month: item.month as number, cumulativePct: item.cumulative_pct };
  });
  for (let index = 1; index < curve.length; index += 1) if ((curve[index] as CurvePoint).cumulativePct < (curve[index - 1] as CurvePoint).cumulativePct) throw badParams(`curve[${index}].cumulative_pct`);
  if ((curve[11] as CurvePoint).cumulativePct !== 100) throw badParams('curve[11].cumulative_pct');
  if (!isNum(input.province_gap_points, 0, 100)) throw badParams('province_gap_points');
  if (!isNum(input.rag_gap_green, -100, 0)) throw badParams('rag_gap_green');
  if (!isNum(input.rag_gap_amber, -100, 0) || input.rag_gap_amber > input.rag_gap_green) throw badParams('rag_gap_amber');
  if (!isNum(input.sector_gap_points, 0, 100)) throw badParams('sector_gap_points');
  if (!isNum(input.sector_min_plan_share_pct, 0, 100)) throw badParams('sector_min_plan_share_pct');
  if (!isInt(input.unit_not_reporting_days, 1, 365)) throw badParams('unit_not_reporting_days');
  if (!isNum(input.unit_min_reporting_rate_pct, 0, 100)) throw badParams('unit_min_reporting_rate_pct');
  if (!isInt(input.delay_days, 1, 3650)) throw badParams('delay_days');
  if (!isInt(input.stalled_days, 1, 3650)) throw badParams('stalled_days');
  if (!isNum(input.over_budget_pct, 0, 500)) throw badParams('over_budget_pct');
  if (!isNum(input.far_below_points, 0, 100)) throw badParams('far_below_points');
  const weights = record(input.weights, 'weights');
  closed(weights, WEIGHT_KEYS, 'weights.');
  for (const key of WEIGHT_KEYS) if (!isNum(weights[key], 0, 10)) throw badParams(`weights.${key}`);
  if (WEIGHT_KEYS.every((key) => weights[key] === 0)) throw badParams('weights');
  if (!isInt(input.exposure_reference_vnd, 1, 1_000_000_000_000_000)) throw badParams('exposure_reference_vnd');
  if (!isInt(input.attention_top_n, 1, 200)) throw badParams('attention_top_n');
  if (!isInt(input.directive_overdue_alert_count, 1, 1000)) throw badParams('directive_overdue_alert_count');
  return {
    curve,
    provinceGapPoints: input.province_gap_points,
    ragGapGreen: input.rag_gap_green,
    ragGapAmber: input.rag_gap_amber,
    sectorGapPoints: input.sector_gap_points,
    sectorMinPlanSharePct: input.sector_min_plan_share_pct,
    unitNotReportingDays: input.unit_not_reporting_days,
    unitMinReportingRatePct: input.unit_min_reporting_rate_pct,
    delayDays: input.delay_days,
    stalledDays: input.stalled_days,
    overBudgetPct: input.over_budget_pct,
    farBelowPoints: input.far_below_points,
    weights: { delayed: weights.delayed as number, stalled: weights.stalled as number, overBudget: weights.over_budget as number, farBelow: weights.far_below as number, notReporting: weights.not_reporting as number },
    exposureReferenceVnd: input.exposure_reference_vnd,
    attentionTopN: input.attention_top_n,
    directiveOverdueAlertCount: input.directive_overdue_alert_count,
  };
}

/** The policy as the params of a rule (the shape the registry stores). */
export function committeePolicyParams(policy: CommitteePolicy): Record<string, unknown> {
  return {
    curve: policy.curve.map((point) => ({ month: point.month, cumulative_pct: point.cumulativePct })),
    province_gap_points: policy.provinceGapPoints,
    rag_gap_green: policy.ragGapGreen,
    rag_gap_amber: policy.ragGapAmber,
    sector_gap_points: policy.sectorGapPoints,
    sector_min_plan_share_pct: policy.sectorMinPlanSharePct,
    unit_not_reporting_days: policy.unitNotReportingDays,
    unit_min_reporting_rate_pct: policy.unitMinReportingRatePct,
    delay_days: policy.delayDays,
    stalled_days: policy.stalledDays,
    over_budget_pct: policy.overBudgetPct,
    far_below_points: policy.farBelowPoints,
    weights: { delayed: policy.weights.delayed, stalled: policy.weights.stalled, over_budget: policy.weights.overBudget, far_below: policy.weights.farBelow, not_reporting: policy.weights.notReporting },
    exposure_reference_vnd: policy.exposureReferenceVnd,
    attention_top_n: policy.attentionTopN,
    directive_overdue_alert_count: policy.directiveOverdueAlertCount,
  };
}

/** The reading of a resolved rule (or of nothing: the built-in default). */
export function committeePolicyOf(resolved: { version: number; source: 'RULE' | 'DEFAULT'; unverified: boolean; params: Record<string, unknown> } | undefined): CommitteePolicyReading {
  if (resolved === undefined) return defaultCommitteePolicy();
  return { code: COMMITTEE_POLICY_CODE, version: resolved.source === 'DEFAULT' ? null : resolved.version, source: resolved.source, unverified: resolved.unverified, params: parseCommitteePolicy(resolved.params) };
}

// -- The indicators of the workspace in the KPI register (rule type KPI_DEFINITION) -------------------------------------------------------------------------------------------------------

export interface CommitteeKpiDefault {
  params: Record<string, unknown>;
  unverified: boolean;
}

const OWNER = 'COMMITTEE_SECRETARIAT';
const SOURCE = message('committee.kpi.source');
const kpiOf = (code: string, unit: 'PERCENT' | 'VND' | 'COUNT', numerator: boolean, denominator: boolean, extra: Record<string, unknown> = {}): CommitteeKpiDefault => {
  const key = code.toLowerCase();
  return {
    unverified: true,
    params: {
      name: message(`committee.kpi.${key}.name`),
      formula: message(`committee.kpi.${key}.formula`),
      ...(numerator ? { numerator: message(`committee.kpi.${key}.numerator`) } : {}),
      ...(denominator ? { denominator: message(`committee.kpi.${key}.denominator`) } : {}),
      exclusions: [message('committee.kpi.exclusion.unknown')],
      source: SOURCE,
      unit,
      period: 'YEAR_TO_DATE',
      owner: OWNER,
      decimals: unit === 'PERCENT' ? 2 : 0,
      refresh_hours: 24,
      allowed_lag_days: 8,
      ...extra,
    },
  };
};

/** The figures of the committee workspace, one definition each (the "i" of every number reads from here). */
export const COMMITTEE_KPI_DEFAULTS: Readonly<Record<string, CommitteeKpiDefault>> = {
  COMMITTEE_PLAN_TOTAL: kpiOf('COMMITTEE_PLAN_TOTAL', 'VND', true, false),
  COMMITTEE_DISBURSED: kpiOf('COMMITTEE_DISBURSED', 'VND', true, false),
  COMMITTEE_DISBURSEMENT_RATE: kpiOf('COMMITTEE_DISBURSEMENT_RATE', 'PERCENT', true, true),
  COMMITTEE_DISBURSED_LAST_YEAR: kpiOf('COMMITTEE_DISBURSED_LAST_YEAR', 'VND', true, false),
  COMMITTEE_GAP_VS_CURVE: kpiOf('COMMITTEE_GAP_VS_CURVE', 'PERCENT', true, false),
  COMMITTEE_OUTLOOK_LOW: kpiOf('COMMITTEE_OUTLOOK_LOW', 'VND', true, false),
  COMMITTEE_OUTLOOK_HIGH: kpiOf('COMMITTEE_OUTLOOK_HIGH', 'VND', true, false),
  COMMITTEE_ATTENTION_PROJECTS: kpiOf('COMMITTEE_ATTENTION_PROJECTS', 'COUNT', true, false, { period: 'AS_OF_NOW' }),
  COMMITTEE_UNITS_NOT_REPORTING: kpiOf('COMMITTEE_UNITS_NOT_REPORTING', 'COUNT', true, false, { period: 'AS_OF_NOW' }),
  COMMITTEE_DIRECTIVES_OVERDUE: kpiOf('COMMITTEE_DIRECTIVES_OVERDUE', 'COUNT', true, false, { period: 'AS_OF_NOW' }),
};
