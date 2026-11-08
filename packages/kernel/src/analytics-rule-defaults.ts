import { message } from './messages.ts';
/**
 * The built-in default params that lane C (analytics, G0-4 and G3-2) adds under the rule types `KPI_DEFINITION` and `RAG_THRESHOLDS` of `governance-rules.ts`. Plain data with no imports, so that the rules module can
 * spread them into its defaults without a cycle. Every number here is a starting value of the research (roadmap, "not verified") to be confirmed with the customer and the auditors; a tenant approves its own
 * version of a code and that version wins (maker is not checker).
 */

export interface AnalyticsDefault {
  params: Record<string, unknown>;
  unverified: boolean;
}

const KPI_OWNER = 'CAPITAL_PLANNER';
const KPI_SOURCE = message('analytics.rule.kpi_source');

const kpi = (params: Record<string, unknown>, unverified = true): AnalyticsDefault => ({ params, unverified });

/** The figures of the command center HOME-01/HOME-03, one definition each. `formula` is the sentence a reader sees; the numerator, the denominator and the exclusions say what is in it. */

/** The figures of the command center HOME-01/HOME-03, one definition each. `formula` is the sentence a reader sees; the numerator, the denominator and the exclusions say what is in it. */
export const KPI_HOME_DEFAULTS: Readonly<Record<string, AnalyticsDefault>> = {
  DISBURSEMENT_RATE_PM: kpi({
    name: message('analytics.rule.kpi_home_defaults.disbursement_rate_pm.name'),
    formula: message('analytics.rule.kpi_home_defaults.disbursement_rate_pm.formula'),
    numerator: message('analytics.rule.kpi_home_defaults.disbursement_rate_pm.numerator'),
    denominator: message('analytics.rule.kpi_home_defaults.disbursement_rate_pm.denominator'),
    exclusions: [message('analytics.rule.kpi_home_defaults.disbursement_rate_pm.exclusions'), message('analytics.rule.kpi_home_defaults.disbursement_rate_pm.exclusions_2')],
    source: KPI_SOURCE,
    unit: 'PERCENT',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 2,
    refresh_hours: 24,
    allowed_lag_days: 8,
    rag_code: 'DISBURSEMENT_RATIO',
  }),
  DISBURSEMENT_RATE_TOTAL: kpi({
    name: message('analytics.rule.kpi_home_defaults.disbursement_rate_total.name'),
    formula: message('analytics.rule.kpi_home_defaults.disbursement_rate_total.formula'),
    numerator: message('analytics.rule.kpi_home_defaults.disbursement_rate_pm.numerator'),
    denominator: message('analytics.rule.kpi_home_defaults.disbursement_rate_total.denominator'),
    exclusions: [message('analytics.rule.kpi_home_defaults.disbursement_rate_pm.exclusions'), message('analytics.rule.kpi_home_defaults.disbursement_rate_pm.exclusions_2')],
    source: KPI_SOURCE,
    unit: 'PERCENT',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 2,
    refresh_hours: 24,
    allowed_lag_days: 8,
    rag_code: 'DISBURSEMENT_RATIO',
  }),
  DISBURSED_TREASURY: kpi({
    name: message('analytics.rule.kpi_home_defaults.disbursed_treasury.name'),
    formula: message('analytics.rule.kpi_home_defaults.disbursed_treasury.formula'),
    numerator: message('analytics.rule.kpi_home_defaults.disbursed_treasury.numerator'),
    exclusions: [message('analytics.rule.kpi_home_defaults.disbursed_treasury.exclusions')],
    source: KPI_SOURCE,
    unit: 'VND',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 0,
    refresh_hours: 24,
    allowed_lag_days: 8,
  }),
  PLAN_PM_ASSIGNED: kpi({
    name: message('analytics.rule.kpi_home_defaults.plan_pm_assigned.name'),
    formula: message('analytics.rule.kpi_home_defaults.plan_pm_assigned.formula'),
    denominator: message('analytics.rule.kpi_home_defaults.plan_pm_assigned.denominator'),
    exclusions: [message('analytics.rule.kpi_home_defaults.plan_pm_assigned.exclusions')],
    source: KPI_SOURCE,
    unit: 'VND',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 0,
    refresh_hours: 24,
    allowed_lag_days: 8,
  }),
  PLAN_TOTAL: kpi({
    name: message('analytics.rule.kpi_home_defaults.plan_total.name'),
    formula: message('analytics.rule.kpi_home_defaults.plan_total.formula'),
    denominator: message('analytics.rule.kpi_home_defaults.plan_total.denominator'),
    exclusions: [message('analytics.rule.kpi_home_defaults.plan_pm_assigned.exclusions')],
    source: KPI_SOURCE,
    unit: 'VND',
    period: 'YEAR_TO_DATE',
    owner: KPI_OWNER,
    decimals: 0,
    refresh_hours: 24,
    allowed_lag_days: 8,
  }),
  OPEN_WARNINGS: kpi({
    name: message('analytics.rule.kpi_home_defaults.open_warnings.name'),
    formula: message('analytics.rule.kpi_home_defaults.open_warnings.formula'),
    numerator: message('analytics.rule.kpi_home_defaults.open_warnings.numerator'),
    exclusions: [message('analytics.rule.kpi_home_defaults.open_warnings.exclusions')],
    source: message('analytics.rule.kpi_home_defaults.open_warnings.source'),
    unit: 'COUNT',
    period: 'AS_OF_NOW',
    owner: 'WARNING_OWNER',
    decimals: 0,
    refresh_hours: 1,
    allowed_lag_days: 0,
  }),
  OVERDUE_EXPLANATIONS: kpi({
    name: message('analytics.rule.kpi_home_defaults.overdue_explanations.name'),
    formula: message('analytics.rule.kpi_home_defaults.overdue_explanations.formula'),
    numerator: message('analytics.rule.kpi_home_defaults.overdue_explanations.numerator'),
    exclusions: [message('analytics.rule.kpi_home_defaults.overdue_explanations.exclusions')],
    source: message('analytics.rule.kpi_home_defaults.overdue_explanations.source'),
    unit: 'COUNT',
    period: 'AS_OF_NOW',
    owner: 'WARNING_OWNER',
    decimals: 0,
    refresh_hours: 1,
    allowed_lag_days: 0,
  }),
  PENDING_REALLOCATIONS: kpi({
    name: message('analytics.rule.kpi_home_defaults.pending_reallocations.name'),
    formula: message('analytics.rule.kpi_home_defaults.pending_reallocations.formula'),
    numerator: message('analytics.rule.kpi_home_defaults.pending_reallocations.numerator'),
    exclusions: [message('analytics.rule.kpi_home_defaults.pending_reallocations.exclusions')],
    source: message('analytics.rule.kpi_home_defaults.pending_reallocations.source'),
    unit: 'COUNT',
    period: 'AS_OF_NOW',
    owner: KPI_OWNER,
    decimals: 0,
    refresh_hours: 1,
    allowed_lag_days: 0,
  }),
};

/**
 * The factors of the early-warning score of a unit (G3-2) and its bands, as `RAG_THRESHOLDS` codes. A factor is read against its own line (`green`, `amber`, the better side by `direction`) and carries a `weight`;
 * the score runs 0 (nothing wrong) to 100 (everything wrong), so `EWS_SCORE` reads LOWER_IS_BETTER. `min_coverage_pct` of a factor is not used; that of `EWS_SCORE` is the share of the weight that must have data
 * before a band is given at all (below it the unit is "not enough data", never green).
 */
export const EWS_RATE_CODE = 'EWS_RATE_VS_PACE';
export const EWS_CRITICAL_CODE = 'EWS_CRITICAL_WARNINGS';
export const EWS_OVERDUE_CODE = 'EWS_OVERDUE_EXPLANATIONS';
export const EWS_NO_DATA_CODE = 'EWS_NO_DATA_SHARE';
export const EWS_SCORE_CODE = 'EWS_SCORE';
export const EWS_FACTOR_CODES = [EWS_RATE_CODE, EWS_CRITICAL_CODE, EWS_OVERDUE_CODE, EWS_NO_DATA_CODE] as const;

export const RAG_EWS_DEFAULTS: Readonly<Record<string, AnalyticsDefault>> = {
  // Disbursement rate over the pace of the year (day of the year / days of the year): 0,95 and 0,85 of the pace are the starting lines of the research.
  [EWS_RATE_CODE]: { params: { direction: 'HIGHER_IS_BETTER', green: 0.95, amber: 0.85, min_coverage_pct: 0, weight: 40 }, unverified: true },
  // Open warnings of the severity "Critical" in the unit: none is green, one or two is amber.
  [EWS_CRITICAL_CODE]: { params: { direction: 'LOWER_IS_BETTER', green: 0, amber: 2, min_coverage_pct: 0, weight: 30 }, unverified: true },
  [EWS_OVERDUE_CODE]: { params: { direction: 'LOWER_IS_BETTER', green: 0, amber: 2, min_coverage_pct: 0, weight: 20 }, unverified: true },
  // The share of the projects of the unit that have no Treasury figure, in percent.
  [EWS_NO_DATA_CODE]: { params: { direction: 'LOWER_IS_BETTER', green: 10, amber: 30, min_coverage_pct: 0, weight: 10 }, unverified: true },
  [EWS_SCORE_CODE]: { params: { direction: 'LOWER_IS_BETTER', green: 25, amber: 45, min_coverage_pct: 60 }, unverified: true },
};
