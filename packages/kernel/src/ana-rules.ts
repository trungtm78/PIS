import type { ForecastParams } from './ana-forecast.ts';
import { DomainError } from './errors.ts';
import type { FieldSpec, RuleParams } from './governance-rules.ts';
import { message } from './messages.ts';

/**
 * The governance rule types of the executive analytics (lane GOV-11b, G3-5 to G3-11) as plain data: `governance-rules.ts` registers them (one function, `registerExecAnalyticsRules`), so that no threshold of
 * the forecast, the freshness, the rankings, the bottlenecks, the heat-map or the back-test is a constant of code. Every default is a starting value of the research, flagged unverified, to be confirmed with the
 * customer and the auditors; a tenant approves its own version of a code and that version wins (maker is not checker).
 */
export interface ExecRuleType {
  type: string;
  ownerModule: string;
  modules: readonly string[];
  formula: string;
  source: string;
  schema: Readonly<Record<string, FieldSpec>>;
  refine?: (params: Record<string, unknown>) => string | undefined;
  defaults: Readonly<Record<string, RuleParams>>;
}

const int = (min: number, max: number): FieldSpec => ({ kind: 'int', min, max });
const bool: FieldSpec = { kind: 'boolean' };
const oneOf = (...values: readonly string[]): FieldSpec => ({ kind: 'enum', values });

export const FORECAST_RULE_TYPE = 'FORECAST_PARAMS';
export const FORECAST_RULE_CODE = 'DISBURSEMENT_OUTLOOK';

export const FORECAST_DEFAULTS: Readonly<Record<string, unknown>> = {
  window_min_weeks: 4,
  window_max_weeks: 8,
  central: 'MEDIAN',
  seasonality: true,
  point_tolerance_days: 3,
  attention_below_pct: 90,
};

const FORECAST: ExecRuleType = {
  type: FORECAST_RULE_TYPE,
  ownerModule: 'BI',
  modules: ['BI', 'DIS', 'HOME'],
  formula: message('ana.rules.forecast.formula'),
  source: message('ana.rules.source'),
  schema: {
    window_min_weeks: int(2, 12),
    window_max_weeks: int(2, 26),
    central: oneOf('MEDIAN', 'MEAN'),
    seasonality: bool,
    point_tolerance_days: int(0, 6),
    attention_below_pct: int(1, 100),
  },
  refine: (params) => ((params.window_min_weeks as number) <= (params.window_max_weeks as number) ? undefined : 'window_max_weeks'),
  defaults: { [FORECAST_RULE_CODE]: FORECAST_DEFAULTS as RuleParams },
};

/** The parameters of the outlook engine from the params of the approved rule or the built-in default. */
export function forecastParamsOf(params: RuleParams): ForecastParams {
  const fail = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
  const whole = (field: string): number => {
    const value = params[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) throw fail(field);
    return value;
  };
  const central = params.central;
  if (central !== 'MEDIAN' && central !== 'MEAN') throw fail('central');
  if (typeof params.seasonality !== 'boolean') throw fail('seasonality');
  const parsed: ForecastParams = {
    windowMinWeeks: whole('window_min_weeks'),
    windowMaxWeeks: whole('window_max_weeks'),
    central,
    seasonality: params.seasonality,
    pointToleranceDays: whole('point_tolerance_days'),
    attentionBelowPct: whole('attention_below_pct'),
  };
  if (parsed.windowMinWeeks > parsed.windowMaxWeeks) throw fail('window_max_weeks');
  return parsed;
}

/** Every rule type of the lane, in the order they are registered. */
export const EXEC_RULE_TYPES: readonly ExecRuleType[] = [FORECAST];
