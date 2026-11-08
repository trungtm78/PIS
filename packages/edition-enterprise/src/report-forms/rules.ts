import { REPORT_FORM_MODE_RULE_TYPE, demoFormsOn } from '@machvon/kernel/src/report-layout.ts';
import { registerRuleDefaults, registerRuleType, resolveGovernanceRule } from '@machvon/kernel/src/governance-rules.ts';
import type { DefaultInput, FieldSpec, GovernanceRuleVersion, LegalStatus } from '@machvon/kernel/src/governance-rules.ts';
import { textsOf } from './texts.ts';

/**
 * The governance rules that belong to the enterprise edition's report forms (RPT-1, owner decision of 2026-11-08: for the demo stage the six forms are designed by the system itself):
 *   - the enterprise indicator pack: the KPI definitions the six forms are bound to, added as built-in defaults of `KPI_DEFINITION` (formula, numerator, denominator, source, as-of; every one flagged unverified
 *     because the FND-1 semantics spec, docs/fnd-funding-model.md, is still a proposal and the customer has not confirmed the figures);
 *   - the rule type `REPORT_FORM_MODE`: whether demo forms may be issued (`demo_forms`); the environment variable `DEMO_FORMS` overrides it (`demoFormsOn` of the kernel reads both).
 * The registration is called from the edition manifest when the package loads, once (a second call is a no-op), so the public edition never carries these codes.
 */

/** The texts of the indicator pack and of the rule type, from `messages/kpi-pack.vi.json`: the names, formulas, numerators and denominators by code, and the sources. */
interface KpiPackTexts {
  /** The provenance source of the built-in default of each indicator. */
  source: string;
  /** The `source` parameter of each indicator definition. */
  parameterSource: string;
  /** The source written on the definition of an indicator in the illustrative fill data. */
  definitionSource: string;
  reportFormMode: { formula: string; source: string; defaultFormula: string };
  kpis: Readonly<Record<string, { name: string; formula: string; numerator?: string; denominator?: string }>>;
}

export const kpiPackTexts = (): KpiPackTexts => textsOf<KpiPackTexts>('kpi-pack');

const packTexts = kpiPackTexts();

export const ENTERPRISE_KPI_SOURCE = packTexts.source;
export const ENTERPRISE_KPI_AS_OF = '2026-11-08';

type KpiUnit = 'PERCENT' | 'VND' | 'COUNT';
type KpiPeriod = 'YEAR_TO_DATE' | 'AS_OF_NOW' | 'MONTH';

interface KpiSeed {
  code: string;
  name: string;
  formula: string;
  numerator?: string;
  denominator?: string;
  unit: KpiUnit;
  period: KpiPeriod;
  decimals: number;
}

const textOf = (code: string): KpiPackTexts['kpis'][string] => {
  const found = packTexts.kpis[code];
  if (found === undefined) throw new Error(`enterprise indicator pack: no text for ${code}`);
  return found;
};

const money = (code: string, period: KpiPeriod): KpiSeed => ({ code, name: textOf(code).name, formula: textOf(code).formula, unit: 'VND', period, decimals: 0 });
const percent = (code: string, period: KpiPeriod): KpiSeed => ({ code, name: textOf(code).name, formula: textOf(code).formula, numerator: textOf(code).numerator as string, denominator: textOf(code).denominator as string, unit: 'PERCENT', period, decimals: 1 });
const count = (code: string): KpiSeed => ({ code, name: textOf(code).name, formula: textOf(code).formula, unit: 'COUNT', period: 'AS_OF_NOW', decimals: 0 });

/** The indicators of the six report forms, in the order the forms print them. Money is whole dong, percent has one place, counts are whole. The words of each are in `messages/kpi-pack.vi.json`. */
export const ENTERPRISE_KPI_SEEDS: readonly KpiSeed[] = Object.freeze([
  money('ENT_TOTAL_INVESTMENT', 'AS_OF_NOW'),
  money('ENT_PLAN_YEAR', 'YEAR_TO_DATE'),
  money('ENT_PLAN_IN_FORCE', 'YEAR_TO_DATE'),
  money('ENT_EXECUTED_PERIOD', 'MONTH'),
  money('ENT_DISBURSED_PERIOD', 'MONTH'),
  money('ENT_ESTIMATE_PERIOD', 'MONTH'),
  money('ENT_EXECUTED_YTD', 'YEAR_TO_DATE'),
  money('ENT_DISBURSED_YTD', 'YEAR_TO_DATE'),
  money('ENT_EXECUTED_SINCE_START', 'AS_OF_NOW'),
  money('ENT_DISBURSED_SINCE_START', 'AS_OF_NOW'),
  money('ENT_OUTLOOK_YEAR', 'YEAR_TO_DATE'),
  money('ENT_CAPITAL_EQUITY', 'YEAR_TO_DATE'),
  money('ENT_CAPITAL_DEBT', 'YEAR_TO_DATE'),
  money('ENT_CAPITAL_OTHER', 'YEAR_TO_DATE'),
  percent('ENT_RATE_EXECUTED_YTD', 'YEAR_TO_DATE'),
  percent('ENT_RATE_DISBURSED_YTD', 'YEAR_TO_DATE'),
  percent('ENT_RATE_SINCE_START', 'AS_OF_NOW'),
  percent('ENT_RATE_OUTLOOK_YEAR', 'YEAR_TO_DATE'),
  percent('ENT_SHARE_EQUITY', 'YEAR_TO_DATE'),
  percent('ENT_SHARE_DEBT', 'YEAR_TO_DATE'),
  percent('ENT_SHARE_OTHER', 'YEAR_TO_DATE'),
  count('ENT_PROJECTS_TOTAL'),
  count('ENT_PROJECTS_ON_TRACK'),
  count('ENT_PROJECTS_DELAYED'),
]);

/** The codes of the pack. */
export const ENTERPRISE_KPI_CODES: readonly string[] = Object.freeze(ENTERPRISE_KPI_SEEDS.map((seed) => seed.code));

const UNVERIFIED: LegalStatus = 'UNVERIFIED';

const defaultOf = (seed: KpiSeed): DefaultInput => ({
  params: {
    name: seed.name,
    formula: seed.formula,
    ...(seed.numerator === undefined ? {} : { numerator: seed.numerator }),
    ...(seed.denominator === undefined ? {} : { denominator: seed.denominator }),
    source: packTexts.parameterSource,
    unit: seed.unit,
    period: seed.period,
    owner: 'CAPITAL_PLANNER',
    decimals: seed.decimals,
    refresh_hours: 24,
    allowed_lag_days: 8,
  },
  formula: seed.formula,
  source: ENTERPRISE_KPI_SOURCE,
  asOf: ENTERPRISE_KPI_AS_OF,
  legalStatus: UNVERIFIED,
});

const REPORT_FORM_MODE_SCHEMA: Readonly<Record<string, FieldSpec>> = { demo_forms: { kind: 'boolean' } };

let registered = false;

/**
 * Registers the enterprise indicator pack under `KPI_DEFINITION` and the rule type `REPORT_FORM_MODE`. Idempotent: the package manifest calls it when it loads and a test may call it again. Needs the kernel's own
 * rules to be there first, which importing `governance-rules` guarantees.
 */
export function registerEnterpriseReportRules(): void {
  if (registered) return;
  registered = true;
  registerRuleDefaults('KPI_DEFINITION', Object.fromEntries(ENTERPRISE_KPI_SEEDS.map((seed) => [seed.code, defaultOf(seed)])));
  registerRuleType({
    type: REPORT_FORM_MODE_RULE_TYPE,
    ownerModule: 'RPT',
    modules: ['RPT', 'ENT'],
    formula: packTexts.reportFormMode.formula,
    source: packTexts.reportFormMode.source,
    asOf: ENTERPRISE_KPI_AS_OF,
    legalStatus: 'VERIFIED',
    schema: REPORT_FORM_MODE_SCHEMA,
    defaults: {
      DEFAULT: { params: { demo_forms: false }, formula: packTexts.reportFormMode.defaultFormula },
    },
  });
}

/**
 * Whether demo forms may be issued for a tenant on `asOf`: the approved `REPORT_FORM_MODE` rule of the tenant (or the built-in default, off), overridden by the environment variable `DEMO_FORMS`. The caller passes the
 * rules it read through `GovernancePolicyPort` and `process.env`; nothing here reads a global.
 */
export function demoFormsEnabled(rules: readonly GovernanceRuleVersion[], asOf: string, env: Readonly<Record<string, string | undefined>> = {}): boolean {
  registerEnterpriseReportRules();
  const resolved = resolveGovernanceRule(rules, REPORT_FORM_MODE_RULE_TYPE, 'DEFAULT', asOf);
  return demoFormsOn({ env, ruleParams: resolved?.params });
}
