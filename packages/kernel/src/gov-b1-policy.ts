/**
 * The policies of lane B1 of the governance deepening (G1-2, G1-3, G1-4): the thresholds of the baseline, the formula of the estimate at completion and the stages that may not be paid, kept as data. The starting
 * values below are those of the research (docs/governance-roadmap-10of10.md, section 2): they are to be confirmed with the customer and the auditors and are never a rule of law. Where a number is not a legal
 * one, the screen says so.
 *
 * The thresholds are read through one function shape, `B1PolicyReader.get(tx, type, code, asOf)`, which is the shape of `GovernancePolicyPort.get` of the governance platform (lane A1). Until that port is wired the
 * database side passes the reader that answers with the built-in defaults; wiring the port is a one-line change of that reader. Every decision that used a policy stores its `version`.
 */

export const B1_RULE_TYPES = ['BASELINE_DEVIATION', 'EVM_POLICY', 'DISBURSEMENT_PRECONDITION'] as const;
export type B1RuleType = (typeof B1_RULE_TYPES)[number];
export const B1_DEFAULT_CODE = 'DEFAULT';

/** The formulas of the estimate at completion (F01): the cumulative CPI is the default, the other two are the options of PMBOK. */
export const EAC_METHODS = ['CPI_CUMULATIVE', 'AC_PLUS_REMAINING', 'AC_PLUS_REMAINING_OVER_CPI_SPI'] as const;
export type EacMethod = (typeof EAC_METHODS)[number];

export interface BaselineDeviationPolicy {
  /** The investment total may move this far from the baseline v0 (percent) before a re-appraisal is asked for. */
  costPct: number;
  /** The finish of the project may move this many calendar days from the baseline v0 before a re-appraisal is asked for. */
  slipDays: number;
  /** A date moved this many times raises an alert to AUD (the research: three). */
  rescheduleAlertCount: number;
}

export interface EvmPolicy {
  eacMethod: EacMethod;
  /** CPI and SPI at or above this are green; below it amber (the research: 0.95). */
  amberBelow: number;
  /** CPI and SPI below this are red (the research: 0.85). */
  redBelow: number;
}

export interface DisbursementPreconditionPolicy {
  /** A project in one of these stages is not on the list of the investment projects, so nothing is paid for it (NĐ 85/2025 Điều 53). */
  unlistedStatuses: readonly string[];
  /** A project with no approved amount in the capital plan on the system is refused (the number on the system wins over paper). */
  requireApprovedPlan: boolean;
}

export interface B1Params {
  BASELINE_DEVIATION: BaselineDeviationPolicy;
  EVM_POLICY: EvmPolicy;
  DISBURSEMENT_PRECONDITION: DisbursementPreconditionPolicy;
}

export const B1_DEFAULTS: { readonly [K in B1RuleType]: B1Params[K] } = {
  BASELINE_DEVIATION: { costPct: 10, slipDays: 90, rescheduleAlertCount: 3 },
  EVM_POLICY: { eacMethod: 'CPI_CUMULATIVE', amberBelow: 0.95, redBelow: 0.85 },
  DISBURSEMENT_PRECONDITION: { unlistedStatuses: ['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED', 'CLOSED'], requireApprovedPlan: true },
};

/** The version written on a decision that used the built-in default: there is no approved rule, so the number says so. */
export const B1_BUILT_IN_VERSION = 'built-in:1';

export interface B1PolicyAnswer<K extends B1RuleType> {
  type: K;
  code: string;
  params: B1Params[K];
  /** `built-in:1` for the default, else the version of the approved rule in force on the day. Stored on every alert, request and result that used it. */
  version: string;
}

/** The raw answer of a policy source: the params as the governance rule keeps them (or none) and the version of the rule in force. */
export interface B1RawRule {
  params: Record<string, unknown> | undefined;
  version: string;
}

/** The shape of `GovernancePolicyPort.get`: the database side of the lane gives one of these, over its transaction. */
export interface B1PolicyReader<Tx> {
  get(tx: Tx, type: B1RuleType, code: string, asOf: string): Promise<B1RawRule | undefined>;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const wholeIn = (value: unknown, min: number, max: number, fallback: number): number => (finite(value) && Number.isInteger(value) && value >= min && value <= max ? value : fallback);
const numberIn = (value: unknown, min: number, max: number, fallback: number): number => (finite(value) && value >= min && value <= max ? value : fallback);

/** Reads the params of a rule defensively: a field that is missing or out of its range falls back to the default of the research, so one wrong field never turns a guard off. */
export function readB1Params<K extends B1RuleType>(type: K, raw: Record<string, unknown> | undefined): B1Params[K] {
  const given = raw ?? {};
  switch (type) {
    case 'BASELINE_DEVIATION': {
      const base = B1_DEFAULTS.BASELINE_DEVIATION;
      return { costPct: numberIn(given.cost_pct, 0, 1000, base.costPct), slipDays: wholeIn(given.slip_days, 0, 3650, base.slipDays), rescheduleAlertCount: wholeIn(given.reschedule_alert_count, 1, 50, base.rescheduleAlertCount) } as B1Params[K];
    }
    case 'EVM_POLICY': {
      const base = B1_DEFAULTS.EVM_POLICY;
      const method = EAC_METHODS.find((candidate) => candidate === given.eac_method) ?? base.eacMethod;
      const amber = numberIn(given.amber_below, 0, 2, base.amberBelow);
      const red = numberIn(given.red_below, 0, 2, base.redBelow);
      return { eacMethod: method, amberBelow: amber, redBelow: Math.min(red, amber) } as B1Params[K];
    }
    case 'DISBURSEMENT_PRECONDITION': {
      const base = B1_DEFAULTS.DISBURSEMENT_PRECONDITION;
      const statuses = Array.isArray(given.unlisted_statuses) && given.unlisted_statuses.every((entry) => typeof entry === 'string') ? (given.unlisted_statuses as string[]) : base.unlistedStatuses;
      return { unlistedStatuses: statuses, requireApprovedPlan: typeof given.require_approved_plan === 'boolean' ? given.require_approved_plan : base.requireApprovedPlan } as B1Params[K];
    }
    default:
      throw new Error('unknown B1 rule type');
  }
}

/** The built-in default as the answer of a reader. */
export function builtInB1(type: B1RuleType, code: string = B1_DEFAULT_CODE): B1PolicyAnswer<B1RuleType> {
  return { type, code, params: B1_DEFAULTS[type], version: B1_BUILT_IN_VERSION };
}

/** The reader that answers with the built-in default for every rule: used until the governance port is wired. */
export const BUILT_IN_B1_READER: B1PolicyReader<unknown> = {
  get: () => Promise.resolve(undefined),
};

/** The policy in force on a day: the approved rule when the reader has one, else the built-in default, with the version that was used. */
export async function resolveB1Policy<K extends B1RuleType, Tx>(reader: B1PolicyReader<Tx>, tx: Tx, type: K, asOf: string, code: string = B1_DEFAULT_CODE): Promise<B1PolicyAnswer<K>> {
  const raw = await reader.get(tx, type, code, asOf);
  if (raw === undefined) return { type, code, params: B1_DEFAULTS[type] as B1Params[K], version: B1_BUILT_IN_VERSION };
  return { type, code, params: readB1Params(type, raw.params), version: raw.version };
}
