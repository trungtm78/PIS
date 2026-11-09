import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';
import { percentOf } from './fnd-figures.ts';
import { ENT4A_TEXT, fillCrosscheckText } from './messages/ent4a-texts.ts';
import { decimalTextOf, periodCode } from './report-layout.ts';
import type { FormPeriod, MoneyScale } from './report-layout.ts';

/**
 * The comparison of the reports of one period against each other before they are released (CN.04, ENT-4a, docs/report-engine.md, section "Cross-report comparison"). Pure: it reads no table and no snapshot. What it compares is what each report was
 * FILLED with (the figures of its strip and the project rows of its datasets, which the enterprise forms read through `EnterpriseFigureReader`, review decision R21), and the frozen snapshot of the period, which the
 * caller gives as one more set of figures made with the same reader. Figures are whole dong in decimal text and are compared as exact integers; a rate is compared in percentage points.
 *
 * The rules are the closed set `XR-01` to `XR-06`; their numbers (which roles, which codes, how much tolerance, whether a finding blocks) are the params of the governance rule `REPORT_CROSSCHECK`. A rule whose
 * counterpart is missing is SKIPPED with the reason, never passed; `coverage` says how many comparisons were really made, so a gate that compared nothing can be seen to have compared nothing. Every number a finding
 * mentions has its formula, its source and its time (design rule).
 */

export const CROSSCHECK_RULE_TYPE = 'REPORT_CROSSCHECK';
export const CROSSCHECK_DEFAULT_CODE = 'DEFAULT';

/** The parts a report plays in the comparison. The layout code that plays each is a param of the rule, so a configured form can take a part. */
export const CROSSCHECK_ROLES = ['PVN_MONTHLY', 'PVN_QUARTERLY', 'COMMITTEE', 'STEERING', 'HPM_MONTHLY'] as const;
export type CrosscheckRole = (typeof CROSSCHECK_ROLES)[number];
export const isCrosscheckRole = (value: unknown): value is CrosscheckRole => (CROSSCHECK_ROLES as readonly unknown[]).includes(value);
/** The kind of period each role is made for. */
export const ROLE_PERIOD_KIND: Readonly<Record<CrosscheckRole, 'MONTH' | 'QUARTER'>> = {
  PVN_MONTHLY: 'MONTH',
  PVN_QUARTERLY: 'QUARTER',
  COMMITTEE: 'QUARTER',
  STEERING: 'MONTH',
  HPM_MONTHLY: 'MONTH',
};

export const CROSSCHECK_RULE_IDS = ['XR-01', 'XR-02', 'XR-03', 'XR-04', 'XR-05', 'XR-06'] as const;
export type CrosscheckRuleId = (typeof CROSSCHECK_RULE_IDS)[number];
export const isCrosscheckRuleId = (value: unknown): value is CrosscheckRuleId => (CROSSCHECK_RULE_IDS as readonly unknown[]).includes(value);
export const CROSSCHECK_SEVERITIES = ['BLOCKING', 'WARNING'] as const;
export type CrosscheckSeverity = (typeof CROSSCHECK_SEVERITIES)[number];

/** The role of the frozen snapshot of the period, which is not a report but is compared like one. */
export const SNAPSHOT_ROLE = 'SNAPSHOT';

/** The money scales of the report engine, listed here (and kept in step by the type) because the rule schema is built while the report layout module may still be loading. */
export const CROSSCHECK_SCALES = ['VND', 'THOUSAND_VND', 'MILLION_VND', 'BILLION_VND'] as const satisfies readonly MoneyScale[];
/** Not report-layout's isMoneyScale: this module is loaded while report-layout is still loading (kpi-register -> governance-rules registers the rule at load), so a binding of report-layout may not exist yet when the default is checked. */
const isCrosscheckScale = (value: unknown): value is MoneyScale => (CROSSCHECK_SCALES as readonly unknown[]).includes(value);
const SCALE_PLACES: Readonly<Record<MoneyScale, number>> = { VND: 0, THOUSAND_VND: 3, MILLION_VND: 6, BILLION_VND: 9 };

// -- the policy (params of the rule) ------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface RowColumn {
  column: string;
  code: string;
}

export interface RateDefinition {
  code: string;
  numerator: string;
  denominator: string;
}

export interface RolePair {
  left: CrosscheckRole;
  right: CrosscheckRole;
}

export interface RuleSetting {
  id: CrosscheckRuleId;
  enabled: boolean;
  severity: CrosscheckSeverity;
  /** The figure codes the rule covers (the flow figures for XR-01). */
  codes: string[];
  /** XR-01 only: the figures of a point in time, which the quarter must equal at its last month. */
  stockCodes: string[];
  /** The roles the rule looks at (XR-02, XR-04, XR-05, XR-06); empty means every role. */
  roles: CrosscheckRole[];
  /** XR-01: left is the quarterly role and right the monthly role; XR-03: the two roles that must agree. */
  pairs: RolePair[];
  absoluteVnd: number;
  scale: MoneyScale;
  pctTolerance: number;
}

export interface CrosscheckPolicy {
  layoutOf: Readonly<Partial<Record<CrosscheckRole, string>>>;
  includeIllustrative: boolean;
  rateCodes: string[];
  countCodes: string[];
  totalCode: string;
  rowSource: { keyColumn: string; unitColumn: string; columns: RowColumn[] };
  rateDefinitions: RateDefinition[];
  rules: RuleSetting[];
}

const FLOW = ['ENT_EXECUTED_PERIOD', 'ENT_DISBURSED_PERIOD', 'ENT_ESTIMATE_PERIOD'];
const POINT = ['ENT_EXECUTED_YTD', 'ENT_DISBURSED_YTD', 'ENT_EXECUTED_SINCE_START', 'ENT_DISBURSED_SINCE_START', 'ENT_TOTAL_INVESTMENT', 'ENT_PLAN_YEAR', 'ENT_PLAN_IN_FORCE', 'ENT_OUTLOOK_YEAR', 'ENT_CAPITAL_EQUITY', 'ENT_CAPITAL_DEBT', 'ENT_CAPITAL_OTHER'];
const COUNTS = ['ENT_PROJECTS_TOTAL'];
const RATES = ['ENT_RATE_EXECUTED_YTD', 'ENT_RATE_DISBURSED_YTD', 'ENT_RATE_SINCE_START', 'ENT_RATE_OUTLOOK_YEAR', 'ENT_SHARE_EQUITY', 'ENT_SHARE_DEBT', 'ENT_SHARE_OTHER'];

const baseRule = (id: CrosscheckRuleId, severity: CrosscheckSeverity, codes: readonly string[], extra: Partial<Record<'stock_codes' | 'roles' | 'pairs', unknown>> = {}): Record<string, unknown> => ({
  id,
  enabled: true,
  severity,
  codes: [...codes],
  absolute_vnd: 0,
  scale: 'VND',
  pct_tolerance: 0.01,
  ...extra,
});

/** The starting values of the rule (UNVERIFIED: the customer confirms the roles, the codes and the tolerances). */
export function crosscheckDefaults(): Record<string, unknown> {
  return {
    roles: [
      { role: 'PVN_MONTHLY', layout_code: 'PVN-MONTHLY' },
      { role: 'PVN_QUARTERLY', layout_code: 'PVN-QUARTERLY-F2' },
      { role: 'COMMITTEE', layout_code: 'COMMITTEE-PERIODIC' },
      { role: 'STEERING', layout_code: 'INVEST-STEERING' },
      { role: 'HPM_MONTHLY', layout_code: 'HPM-MONTHLY' },
    ],
    include_illustrative: false,
    rate_codes: [...RATES],
    count_codes: [...COUNTS],
    total_code: 'ENT_TOTAL_INVESTMENT',
    row_source: {
      key_column: 'code',
      unit_column: 'owner_unit',
      columns: [
        { column: 'tmdt', code: 'ENT_TOTAL_INVESTMENT' },
        { column: 'plan_year', code: 'ENT_PLAN_YEAR' },
        { column: 'plan_force', code: 'ENT_PLAN_IN_FORCE' },
        { column: 'est_p', code: 'ENT_ESTIMATE_PERIOD' },
        { column: 'exec_p', code: 'ENT_EXECUTED_PERIOD' },
        { column: 'disb_p', code: 'ENT_DISBURSED_PERIOD' },
        { column: 'exec_ytd', code: 'ENT_EXECUTED_YTD' },
        { column: 'disb_ytd', code: 'ENT_DISBURSED_YTD' },
        { column: 'exec_start', code: 'ENT_EXECUTED_SINCE_START' },
        { column: 'disb_start', code: 'ENT_DISBURSED_SINCE_START' },
        { column: 'outlook', code: 'ENT_OUTLOOK_YEAR' },
        { column: 'cap_equity', code: 'ENT_CAPITAL_EQUITY' },
        { column: 'cap_debt', code: 'ENT_CAPITAL_DEBT' },
        { column: 'cap_other', code: 'ENT_CAPITAL_OTHER' },
      ],
    },
    rate_defs: [
      { code: 'ENT_RATE_EXECUTED_YTD', numerator: 'ENT_EXECUTED_YTD', denominator: 'ENT_PLAN_IN_FORCE' },
      { code: 'ENT_RATE_DISBURSED_YTD', numerator: 'ENT_DISBURSED_YTD', denominator: 'ENT_PLAN_IN_FORCE' },
      { code: 'ENT_RATE_SINCE_START', numerator: 'ENT_EXECUTED_SINCE_START', denominator: 'ENT_TOTAL_INVESTMENT' },
      { code: 'ENT_RATE_OUTLOOK_YEAR', numerator: 'ENT_OUTLOOK_YEAR', denominator: 'ENT_PLAN_IN_FORCE' },
      { code: 'ENT_SHARE_EQUITY', numerator: 'ENT_CAPITAL_EQUITY', denominator: 'ENT_PLAN_IN_FORCE' },
      { code: 'ENT_SHARE_DEBT', numerator: 'ENT_CAPITAL_DEBT', denominator: 'ENT_PLAN_IN_FORCE' },
      { code: 'ENT_SHARE_OTHER', numerator: 'ENT_CAPITAL_OTHER', denominator: 'ENT_PLAN_IN_FORCE' },
    ],
    rules: [
      baseRule('XR-01', 'BLOCKING', FLOW, {
        stock_codes: [...POINT, ...COUNTS],
        pairs: [
          { left: 'PVN_QUARTERLY', right: 'PVN_MONTHLY' },
          { left: 'COMMITTEE', right: 'STEERING' },
        ],
      }),
      baseRule('XR-02', 'BLOCKING', [...FLOW, ...POINT, ...COUNTS, ...RATES]),
      baseRule('XR-03', 'BLOCKING', [...FLOW, ...POINT, ...COUNTS, ...RATES], {
        pairs: [
          { left: 'HPM_MONTHLY', right: 'PVN_MONTHLY' },
          { left: 'STEERING', right: 'PVN_MONTHLY' },
          { left: 'COMMITTEE', right: 'PVN_QUARTERLY' },
        ],
      }),
      baseRule('XR-04', 'BLOCKING', ['ENT_EXECUTED_SINCE_START', 'ENT_DISBURSED_SINCE_START']),
      baseRule('XR-05', 'BLOCKING', [...FLOW, ...POINT]),
      baseRule('XR-06', 'WARNING', RATES),
    ],
  };
}

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const recordOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const textsOf = (value: unknown): string[] => arrayOf(value).filter((one): one is string => typeof one === 'string');

/** Reads the params (already judged by the rule schema) into the policy the comparison uses. */
export function crosscheckPolicyOf(params: Record<string, unknown>): CrosscheckPolicy {
  const layoutOf: Partial<Record<CrosscheckRole, string>> = {};
  for (const one of arrayOf(params['roles'])) {
    const entry = recordOf(one);
    if (isCrosscheckRole(entry['role']) && typeof entry['layout_code'] === 'string') layoutOf[entry['role']] = entry['layout_code'];
  }
  const source = recordOf(params['row_source']);
  return {
    layoutOf,
    includeIllustrative: params['include_illustrative'] === true,
    rateCodes: textsOf(params['rate_codes']),
    countCodes: textsOf(params['count_codes']),
    totalCode: typeof params['total_code'] === 'string' ? params['total_code'] : 'ENT_TOTAL_INVESTMENT',
    rowSource: {
      keyColumn: typeof source['key_column'] === 'string' ? source['key_column'] : 'code',
      unitColumn: typeof source['unit_column'] === 'string' ? source['unit_column'] : 'owner_unit',
      columns: arrayOf(source['columns']).map((one) => ({ column: String(recordOf(one)['column']), code: String(recordOf(one)['code']) })),
    },
    rateDefinitions: arrayOf(params['rate_defs']).map((one) => ({ code: String(recordOf(one)['code']), numerator: String(recordOf(one)['numerator']), denominator: String(recordOf(one)['denominator']) })),
    rules: arrayOf(params['rules']).flatMap((one): RuleSetting[] => {
      const entry = recordOf(one);
      if (!isCrosscheckRuleId(entry['id'])) return [];
      const scale = entry['scale'];
      return [
        {
          id: entry['id'],
          enabled: entry['enabled'] !== false,
          severity: entry['severity'] === 'WARNING' ? 'WARNING' : 'BLOCKING',
          codes: textsOf(entry['codes']),
          stockCodes: textsOf(entry['stock_codes']),
          roles: textsOf(entry['roles']).filter(isCrosscheckRole),
          pairs: arrayOf(entry['pairs']).flatMap((pair): RolePair[] => {
            const both = recordOf(pair);
            return isCrosscheckRole(both['left']) && isCrosscheckRole(both['right']) ? [{ left: both['left'], right: both['right'] }] : [];
          }),
          absoluteVnd: typeof entry['absolute_vnd'] === 'number' ? entry['absolute_vnd'] : 0,
          scale: isCrosscheckScale(scale) ? scale : 'VND',
          pctTolerance: typeof entry['pct_tolerance'] === 'number' ? entry['pct_tolerance'] : 0.01,
        },
      ];
    }),
  };
}

/** What the closed schema cannot say: unique rule ids and roles, pairs and codes where a rule needs them, rate definitions that name codes, a role that is not paired with itself. Returns the offending field. */
export function crosscheckDefect(params: Record<string, unknown>): string | undefined {
  const policy = crosscheckPolicyOf(params);
  const roles = arrayOf(params['roles']).map((one) => recordOf(one)['role']);
  if (new Set(roles).size !== roles.length) return 'roles';
  const layouts = arrayOf(params['roles']).map((one) => recordOf(one)['layout_code']);
  if (new Set(layouts).size !== layouts.length) return 'roles';
  const ids = policy.rules.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) return 'rules';
  for (const [index, rule] of policy.rules.entries()) {
    if (new Set(rule.codes).size !== rule.codes.length) return `rules[${index}].codes`;
    if (rule.codes.length === 0) return `rules[${index}].codes`;
    if ((rule.id === 'XR-01' || rule.id === 'XR-03') && rule.pairs.length === 0) return `rules[${index}].pairs`;
    for (const [at, pair] of rule.pairs.entries()) {
      if (pair.left === pair.right) return `rules[${index}].pairs[${at}]`;
      if (rule.id === 'XR-01' && (ROLE_PERIOD_KIND[pair.left] !== 'QUARTER' || ROLE_PERIOD_KIND[pair.right] !== 'MONTH')) return `rules[${index}].pairs[${at}]`;
      if (rule.id === 'XR-03' && ROLE_PERIOD_KIND[pair.left] !== ROLE_PERIOD_KIND[pair.right]) return `rules[${index}].pairs[${at}]`;
    }
  }
  const known = new Set(policy.rowSource.columns.map((one) => one.code));
  if (known.size !== policy.rowSource.columns.length) return 'row_source.columns';
  const rates = policy.rateDefinitions.map((one) => one.code);
  if (new Set(rates).size !== rates.length) return 'rate_defs';
  return undefined;
}

// -- what is compared ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface FigureEntry {
  code: string;
  basis: string;
  /** Whole dong (or a count, or a rate in percent) as decimal text; null when nobody has the figure. */
  value: string | null;
  asOf: string | null;
}

export interface CrosscheckRow {
  key: string;
  unit: string | null;
  values: Readonly<Record<string, string | null>>;
}

/** What is recorded of a report when it is generated (table `report_figure_set`): the figures of the strip and the project rows. */
export interface FigureSet {
  figures: FigureEntry[];
  rows: CrosscheckRow[];
}

export interface FillSource {
  figures: ReadonlyArray<{ code: string; basis: string; value: string | number | null; asOf?: string | null | undefined }>;
  datasets: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>;
}

/** The figures and rows of a report from the fill data it was made with. The rows of every dataset are kept in dataset order; a figure that is not a plain decimal is kept as null (never zero). */
export function figureSetOf(source: FillSource, policy: Pick<CrosscheckPolicy, 'rowSource'>): FigureSet {
  const figures = source.figures.map((one): FigureEntry => ({ code: one.code, basis: one.basis, value: decimalTextOf(one.value), asOf: one.asOf ?? null }));
  const rows: CrosscheckRow[] = [];
  for (const [dataset, list] of Object.entries(source.datasets)) {
    list.forEach((row, index) => {
      const values: Record<string, string | null> = {};
      for (const { column, code } of policy.rowSource.columns) if (column in row) values[code] = decimalTextOf(row[column] as string | number | null | undefined);
      const key = row[policy.rowSource.keyColumn];
      const unit = row[policy.rowSource.unitColumn];
      rows.push({ key: typeof key === 'string' && key !== '' ? key : `${dataset}#${index + 1}`, unit: typeof unit === 'string' && unit.trim() !== '' ? unit : null, values });
    });
  }
  return { figures, rows };
}

export type ReportRefKind = 'DRAFT' | 'ISSUE' | 'SNAPSHOT';

export interface CrosscheckReport {
  ref: { kind: ReportRefKind; id: string; revision: number | null };
  role: CrosscheckRole | typeof SNAPSHOT_ROLE;
  layoutCode: string;
  period: FormPeriod;
  dataSource: 'LIVE' | 'ILLUSTRATIVE';
  /** The membership that prepared the report (the author); null for a snapshot. */
  preparedBy: string | null;
  /** The snapshot the report was made from (R17), null for a report on illustrative data. */
  snapshot: { snapshotId: string; revision: number; asOf: string | null } | null;
  /** null when the figures of the report were not recorded (a draft made before ENT-4a). */
  set: FigureSet | null;
}

export interface FindingTerm {
  role: string;
  layoutCode: string;
  ref: { kind: ReportRefKind; id: string; revision: number | null };
  periodCode: string;
  code: string;
  /** The row (project) a term is of, when the finding is about a row. */
  rowKey: string | null;
  value: string | null;
  source: string;
  asOf: string | null;
}

export type PathStep = { step: 'REGENERATE_REPORT'; layoutCode: string; ref: string } | { step: 'COMPLETE_MONTH'; layoutCode: string; periodCode: string } | { step: 'ASSIGN_UNIT'; layoutCode: string; rows: string[] } | { step: 'CHECK_SOURCE' } | { step: 'EXPLAIN' };

export interface CrosscheckFinding {
  ruleId: CrosscheckRuleId;
  ruleName: string;
  severity: CrosscheckSeverity;
  code: string;
  periodCode: string;
  formula: string;
  expected: string | null;
  actual: string | null;
  difference: string;
  tolerance: string;
  unit: 'VND' | 'COUNT' | 'PCT';
  terms: FindingTerm[];
  /** Subtotals per unit (XR-05) so the reader sees where the difference sits. */
  units: Array<{ unit: string; sum: string }> | null;
  /** The ids of the drafts and issued copies the finding is about (a snapshot is not one). */
  involves: string[];
  /** The memberships that prepared those reports: none of them may explain the finding. */
  authors: string[];
  path: PathStep[];
  /** sha256 of the rule, the figure, the period and the values of the terms: an explanation holds for this fingerprint only. */
  fingerprint: string;
}

export type SkipReason = 'NO_FIGURES' | 'ILLUSTRATIVE' | 'MISSING_REPORT' | 'NO_VALUE' | 'NO_SNAPSHOT' | 'DUPLICATE';

export interface CrosscheckSkip {
  ruleId: CrosscheckRuleId | '*';
  reason: SkipReason;
  role: string | null;
  layoutCode: string | null;
  periodCode: string | null;
  code: string | null;
  text: string;
}

export interface CrosscheckResult {
  periodCode: string;
  findings: CrosscheckFinding[];
  skipped: CrosscheckSkip[];
  coverage: { reports: number; usable: number; rulesRun: number; comparisons: number; skipped: number };
  /** sha256 of the findings and the coverage: the evidence kept with an issued copy. */
  sha256: string;
}

// -- the family of a period ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The periods whose reports can be compared with the reports of `period`: the quarter and its three months. Another kind of period has none. */
export function crosscheckFamily(period: FormPeriod): FormPeriod[] {
  if ((period.kind !== 'MONTH' && period.kind !== 'QUARTER') || period.index === undefined) return [];
  const quarter = period.kind === 'QUARTER' ? period.index : Math.ceil(period.index / 3);
  return [{ kind: 'QUARTER', year: period.year, index: quarter }, ...[1, 2, 3].map((offset): FormPeriod => ({ kind: 'MONTH', year: period.year, index: (quarter - 1) * 3 + offset }))];
}

/** The role a layout code plays in the policy, or undefined when it plays none. */
export function roleOfLayout(policy: Pick<CrosscheckPolicy, 'layoutOf'>, layoutCode: string): CrosscheckRole | undefined {
  return CROSSCHECK_ROLES.find((role) => policy.layoutOf[role] === layoutCode);
}

// -- arithmetic -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const WHOLE = /^-?\d+$/;
const wholeOf = (value: string | null): bigint | null => (value !== null && WHOLE.test(value) ? BigInt(value) : null);
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
/** Percentage points as an integer of ten-thousandths (the unit of `percentOf`). */
function pointsOf(value: string | null): bigint | null {
  if (value === null || !/^-?\d+(\.\d{1,4})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(`${whole}${fraction.padEnd(4, '0')}`);
  return negative ? -scaled : scaled;
}
const pointsText = (value: bigint): string => {
  const negative = value < 0n;
  const digits = abs(value).toString().padStart(5, '0');
  return `${negative ? '-' : ''}${digits.slice(0, digits.length - 4)}.${digits.slice(digits.length - 4)}`;
};

/** Half a unit of the scale for each term: a sum of n figures that were each rounded to the scale may differ by n half units. Whole dong need no allowance. */
const allowanceOf = (scale: MoneyScale, terms: number): bigint => (SCALE_PLACES[scale] === 0 ? 0n : (BigInt(terms) * 10n ** BigInt(SCALE_PLACES[scale])) / 2n);

type Kind = 'MONEY' | 'COUNT' | 'RATE';
const kindOf = (policy: CrosscheckPolicy, code: string): Kind => (policy.rateCodes.includes(code) ? 'RATE' : policy.countCodes.includes(code) ? 'COUNT' : 'MONEY');

interface Compared {
  kind: Kind;
  expected: string | null;
  actual: string | null;
  difference: string;
  tolerance: string;
  breach: boolean;
}

/** `actual` against `expected` with the tolerance of the rule for `terms` numbers; null when either side is not a number of the kind. */
function compare(policy: CrosscheckPolicy, rule: RuleSetting, code: string, expected: string | null, actual: string | null, terms: number): Compared | undefined {
  const kind = kindOf(policy, code);
  if (kind === 'RATE') {
    const left = pointsOf(expected);
    const right = pointsOf(actual);
    if (left === null || right === null) return undefined;
    const tolerance = BigInt(Math.round(rule.pctTolerance * 10000));
    const difference = right - left;
    return { kind, expected, actual, difference: pointsText(difference), tolerance: pointsText(tolerance), breach: abs(difference) > tolerance };
  }
  const left = wholeOf(expected);
  const right = wholeOf(actual);
  if (left === null || right === null) return undefined;
  const tolerance = kind === 'COUNT' ? 0n : BigInt(rule.absoluteVnd) + allowanceOf(rule.scale, terms);
  const difference = right - left;
  return { kind, expected, actual, difference: difference.toString(), tolerance: tolerance.toString(), breach: abs(difference) > tolerance };
}

// -- the comparison ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const RULE_NAME: Readonly<Record<CrosscheckRuleId, string>> = {
  'XR-01': ENT4A_TEXT.rule_01_name,
  'XR-02': ENT4A_TEXT.rule_02_name,
  'XR-03': ENT4A_TEXT.rule_03_name,
  'XR-04': ENT4A_TEXT.rule_04_name,
  'XR-05': ENT4A_TEXT.rule_05_name,
  'XR-06': ENT4A_TEXT.rule_06_name,
};

export const crosscheckRuleName = (id: CrosscheckRuleId): string => RULE_NAME[id];

const UNIT_OF: Record<Kind, CrosscheckFinding['unit']> = { MONEY: 'VND', COUNT: 'COUNT', RATE: 'PCT' };

interface Run {
  policy: CrosscheckPolicy;
  period: FormPeriod;
  reports: CrosscheckReport[];
  findings: CrosscheckFinding[];
  skipped: CrosscheckSkip[];
  comparisons: number;
  seen: Set<string>;
}

const codeOfPeriod = (period: FormPeriod): string => periodCode(period);

function usable(run: Run, report: CrosscheckReport): boolean {
  return report.set !== null && (report.dataSource === 'LIVE' || run.policy.includeIllustrative);
}

function sourceOf(report: CrosscheckReport, on: 'figures' | 'rows'): string {
  const period = codeOfPeriod(report.period);
  if (report.role === SNAPSHOT_ROLE && report.snapshot !== null) return fillCrosscheckText('source_snapshot', { snapshot: report.snapshot.snapshotId, revision: report.snapshot.revision });
  if (on === 'rows') return fillCrosscheckText('source_rows', { period });
  return report.snapshot === null ? fillCrosscheckText('source_figures', { period }) : fillCrosscheckText('source_report_snapshot', { snapshot: report.snapshot.snapshotId, revision: report.snapshot.revision });
}

const figureOf = (report: CrosscheckReport, code: string): FigureEntry | undefined => report.set?.figures.find((one) => one.code === code);

function termOf(report: CrosscheckReport, code: string, value: string | null, asOf: string | null, rowKey: string | null = null, on: 'figures' | 'rows' = 'figures'): FindingTerm {
  return { role: report.role, layoutCode: report.layoutCode, ref: report.ref, periodCode: codeOfPeriod(report.period), code, rowKey, value, source: sourceOf(report, on), asOf };
}

function skip(run: Run, entry: Omit<CrosscheckSkip, 'text'> & { text?: string }): void {
  const key = canonicalJson([entry.ruleId, entry.reason, entry.role, entry.layoutCode, entry.periodCode, entry.code]);
  if (run.seen.has(key)) return;
  run.seen.add(key);
  const text =
    entry.text ??
    (entry.reason === 'NO_FIGURES'
      ? ENT4A_TEXT.skip_no_figures
      : entry.reason === 'ILLUSTRATIVE'
        ? ENT4A_TEXT.skip_illustrative
        : entry.reason === 'MISSING_REPORT'
          ? fillCrosscheckText('skip_missing_report', { role: entry.role ?? '', period: entry.periodCode ?? '' })
          : entry.reason === 'NO_SNAPSHOT'
            ? fillCrosscheckText('skip_no_snapshot', { period: entry.periodCode ?? '' })
            : entry.reason === 'DUPLICATE'
              ? fillCrosscheckText('skip_duplicate', { role: entry.role ?? '', period: entry.periodCode ?? '' })
              : fillCrosscheckText('skip_no_value', { code: entry.code ?? '' }));
  run.skipped.push({ ...entry, text });
}

function pathOf(terms: readonly FindingTerm[], extra: PathStep[] = []): PathStep[] {
  const steps: PathStep[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const key = `${term.ref.kind}:${term.ref.id}`;
    if (term.ref.kind === 'SNAPSHOT' || seen.has(key)) continue;
    seen.add(key);
    steps.push({ step: 'REGENERATE_REPORT', layoutCode: term.layoutCode, ref: term.ref.id });
  }
  return [...extra, ...steps, { step: 'CHECK_SOURCE' }, { step: 'EXPLAIN' }];
}

function addFinding(run: Run, rule: RuleSetting, code: string, formula: string, result: Compared, terms: FindingTerm[], extra: { units?: Array<{ unit: string; sum: string }>; path?: PathStep[]; authors: Map<string, string | null> }): void {
  const reportsOf = terms.filter((term) => term.ref.kind !== 'SNAPSHOT');
  const involves = [...new Set(reportsOf.map((term) => term.ref.id))].sort();
  const authors = [...new Set(involves.flatMap((id) => (extra.authors.get(id) === null || extra.authors.get(id) === undefined ? [] : [extra.authors.get(id) as string])))].sort();
  const pc = codeOfPeriod(run.period);
  const fingerprint = sha256Hex(canonicalJson({ rule: rule.id, code, period: pc, terms: terms.map((term) => [term.ref.kind, term.ref.id, term.ref.revision, term.periodCode, term.code, term.rowKey, term.value]) }));
  run.findings.push({
    ruleId: rule.id,
    ruleName: RULE_NAME[rule.id],
    severity: rule.severity,
    code,
    periodCode: pc,
    formula,
    expected: result.expected,
    actual: result.actual,
    difference: result.difference,
    tolerance: result.tolerance,
    unit: UNIT_OF[result.kind],
    terms,
    units: extra.units ?? null,
    involves,
    authors,
    path: extra.path ?? pathOf(terms),
    fingerprint,
  });
}

const sumWhole = (values: ReadonlyArray<string | null>): string | null => {
  let total = 0n;
  for (const value of values) {
    const one = wholeOf(value);
    if (one === null) return null;
    total += one;
  }
  return total.toString();
};

function ruleSetting(policy: CrosscheckPolicy, id: CrosscheckRuleId): RuleSetting | undefined {
  const found = policy.rules.find((one) => one.id === id);
  return found !== undefined && found.enabled ? found : undefined;
}

function pick(run: Run, role: CrosscheckRole | typeof SNAPSHOT_ROLE, period: FormPeriod): CrosscheckReport | undefined {
  const code = codeOfPeriod(period);
  const found = run.reports.filter((one) => one.role === role && codeOfPeriod(one.period) === code);
  if (found.length === 0) return undefined;
  for (const extra of found.slice(1)) skip(run, { ruleId: '*', reason: 'DUPLICATE', role, layoutCode: extra.layoutCode, periodCode: code, code: null });
  return found[0];
}

/** A report in the run that can be read: a skip with the reason when it cannot. */
function readable(run: Run, ruleId: CrosscheckRuleId, report: CrosscheckReport | undefined, role: string, period: FormPeriod): CrosscheckReport | undefined {
  const periodText = codeOfPeriod(period);
  if (report === undefined) {
    skip(run, { ruleId, reason: role === SNAPSHOT_ROLE ? 'NO_SNAPSHOT' : 'MISSING_REPORT', role, layoutCode: run.policy.layoutOf[role as CrosscheckRole] ?? null, periodCode: periodText, code: null });
    return undefined;
  }
  if (report.set === null) {
    skip(run, { ruleId, reason: 'NO_FIGURES', role, layoutCode: report.layoutCode, periodCode: periodText, code: null });
    return undefined;
  }
  if (!usable(run, report)) {
    skip(run, { ruleId, reason: 'ILLUSTRATIVE', role, layoutCode: report.layoutCode, periodCode: periodText, code: null });
    return undefined;
  }
  return report;
}

function noValue(run: Run, ruleId: CrosscheckRuleId, report: CrosscheckReport, code: string): void {
  skip(run, { ruleId, reason: 'NO_VALUE', role: report.role, layoutCode: report.layoutCode, periodCode: codeOfPeriod(report.period), code });
}

// XR-01 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function ruleMonthsToQuarter(run: Run, rule: RuleSetting, authors: Map<string, string | null>): void {
  const quarter = crosscheckFamily(run.period)[0];
  if (quarter === undefined) return;
  const months = crosscheckFamily(run.period).slice(1);
  for (const pair of rule.pairs) {
    const whole = readable(run, rule.id, pick(run, pair.left, quarter), pair.left, quarter);
    if (whole === undefined) continue;
    const parts = months.map((month) => readable(run, rule.id, pick(run, pair.right, month), pair.right, month));
    if (parts.some((one) => one === undefined)) continue;
    const monthly = parts as CrosscheckReport[];
    const flow = new Set(rule.codes);
    for (const code of [...rule.codes, ...rule.stockCodes.filter((one) => !flow.has(one))]) {
      const isFlow = flow.has(code);
      const head = figureOf(whole, code);
      const used = isFlow ? monthly : [monthly[monthly.length - 1] as CrosscheckReport];
      const values = used.map((one) => figureOf(one, code));
      if (head === undefined || head.value === null || values.some((one) => one === undefined || one.value === null)) {
        noValue(run, rule.id, whole, code);
        continue;
      }
      const sum = isFlow ? sumWhole(values.map((one) => (one as FigureEntry).value)) : (values[0] as FigureEntry).value;
      const result = compare(run.policy, rule, code, sum, head.value, used.length + 1);
      if (result === undefined) {
        noValue(run, rule.id, whole, code);
        continue;
      }
      run.comparisons += 1;
      if (!result.breach) continue;
      const terms = [termOf(whole, code, head.value, head.asOf), ...used.map((one, index) => termOf(one, code, (values[index] as FigureEntry).value, (values[index] as FigureEntry).asOf))];
      const formula = fillCrosscheckText('rule_01_formula', { code, months: used.length });
      addFinding(run, rule, code, formula, result, terms, { authors });
    }
  }
}

// XR-02 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function ruleSnapshotMatch(run: Run, rule: RuleSetting, authors: Map<string, string | null>): void {
  for (const report of run.reports) {
    if (report.role === SNAPSHOT_ROLE) continue;
    if (rule.roles.length > 0 && !rule.roles.includes(report.role)) continue;
    const mine = readable(run, rule.id, report, report.role, report.period);
    if (mine === undefined) continue;
    const snapshot = readable(run, rule.id, pick(run, SNAPSHOT_ROLE, report.period), SNAPSHOT_ROLE, report.period);
    if (snapshot === undefined) continue;
    for (const code of rule.codes) {
      const figure = figureOf(mine, code);
      const frozen = figureOf(snapshot, code);
      if (figure === undefined || frozen === undefined || frozen.value === null || figure.value === null) {
        noValue(run, rule.id, mine, code);
        continue;
      }
      const result = compare(run.policy, rule, code, frozen.value, figure.value, 1);
      if (result === undefined) {
        noValue(run, rule.id, mine, code);
        continue;
      }
      run.comparisons += 1;
      if (!result.breach) continue;
      const terms = [termOf(mine, code, figure.value, figure.asOf), termOf(snapshot, code, frozen.value, frozen.asOf)];
      addFinding(run, rule, code, fillCrosscheckText('rule_02_formula', { code, role: mine.role }), result, terms, { authors });
    }
  }
}

// XR-03 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function ruleSameIndicator(run: Run, rule: RuleSetting, authors: Map<string, string | null>): void {
  for (const pair of rule.pairs) {
    const kind = ROLE_PERIOD_KIND[pair.left];
    for (const period of crosscheckFamily(run.period).filter((one) => one.kind === kind)) {
      const left = readable(run, rule.id, pick(run, pair.left, period), pair.left, period);
      const right = left === undefined ? undefined : readable(run, rule.id, pick(run, pair.right, period), pair.right, period);
      if (left === undefined || right === undefined) continue;
      for (const code of rule.codes) {
        const mine = figureOf(left, code);
        const reference = figureOf(right, code);
        if (mine === undefined || reference === undefined || mine.value === null || reference.value === null) {
          noValue(run, rule.id, left, code);
          continue;
        }
        const result = compare(run.policy, rule, code, reference.value, mine.value, 1);
        if (result === undefined) {
          noValue(run, rule.id, left, code);
          continue;
        }
        run.comparisons += 1;
        if (!result.breach) continue;
        const terms = [termOf(left, code, mine.value, mine.asOf), termOf(right, code, reference.value, reference.asOf)];
        addFinding(run, rule, code, fillCrosscheckText('rule_03_formula', { code, left: pair.left, right: pair.right }), result, terms, { authors });
      }
    }
  }
}

// XR-04 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function ruleCumulative(run: Run, rule: RuleSetting, authors: Map<string, string | null>): void {
  const total = run.policy.totalCode;
  for (const report of run.reports) {
    if (rule.roles.length > 0 && report.role !== SNAPSHOT_ROLE && !rule.roles.includes(report.role)) continue;
    const mine = readable(run, rule.id, report, report.role, report.period);
    if (mine === undefined || mine.set === null) continue;
    for (const code of rule.codes) {
      const headline = figureOf(mine, code);
      const cap = figureOf(mine, total);
      if (headline !== undefined && headline.value !== null && cap !== undefined && cap.value !== null) {
        const result = compare(run.policy, rule, code, cap.value, headline.value, 1);
        if (result !== undefined) {
          run.comparisons += 1;
          if (result.breach && BigInt(result.difference) > 0n) {
            const terms = [termOf(mine, code, headline.value, headline.asOf), termOf(mine, total, cap.value, cap.asOf)];
            addFinding(run, rule, code, fillCrosscheckText('rule_04_formula', { code, total }), result, terms, { authors });
          }
        } else noValue(run, rule.id, mine, code);
      } else noValue(run, rule.id, mine, code);
      for (const row of mine.set.rows) {
        const have = row.values[code] ?? null;
        const limit = row.values[total] ?? null;
        if (have === null || limit === null) continue;
        const result = compare(run.policy, rule, code, limit, have, 1);
        if (result === undefined) continue;
        run.comparisons += 1;
        if (!result.breach || BigInt(result.difference) <= 0n) continue;
        const terms = [termOf(mine, code, have, null, row.key, 'rows'), termOf(mine, total, limit, null, row.key, 'rows')];
        addFinding(run, rule, code, fillCrosscheckText('rule_04_formula', { code, total }), result, terms, { authors });
      }
    }
  }
}

// XR-05 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function ruleUnitSum(run: Run, rule: RuleSetting, authors: Map<string, string | null>): void {
  for (const report of run.reports) {
    if (report.role === SNAPSHOT_ROLE || (rule.roles.length > 0 && !rule.roles.includes(report.role))) continue;
    const mine = readable(run, rule.id, report, report.role, report.period);
    if (mine === undefined || mine.set === null) continue;
    const rows = mine.set.rows;
    if (rows.length === 0) continue;
    const withUnit = rows.filter((one) => one.unit !== null);
    const without = rows.filter((one) => one.unit === null).map((one) => one.key);
    for (const code of rule.codes) {
      const headline = figureOf(mine, code);
      if (headline === undefined || headline.value === null || !rows.some((one) => (one.values[code] ?? null) !== null)) {
        noValue(run, rule.id, mine, code);
        continue;
      }
      const perUnit = new Map<string, bigint>();
      let bad = false;
      for (const row of withUnit) {
        const value = row.values[code] ?? null;
        if (value === null) continue;
        const whole = wholeOf(value);
        if (whole === null) {
          bad = true;
          break;
        }
        perUnit.set(row.unit as string, (perUnit.get(row.unit as string) ?? 0n) + whole);
      }
      if (bad) {
        noValue(run, rule.id, mine, code);
        continue;
      }
      const sum = [...perUnit.values()].reduce((one, two) => one + two, 0n).toString();
      const result = compare(run.policy, rule, code, headline.value, sum, rows.length + 1);
      if (result === undefined) {
        noValue(run, rule.id, mine, code);
        continue;
      }
      run.comparisons += 1;
      if (!result.breach) continue;
      const units = [...perUnit.entries()].sort(([one], [two]) => one.localeCompare(two)).map(([unit, value]) => ({ unit, sum: value.toString() }));
      const terms = [termOf(mine, code, headline.value, headline.asOf), ...units.map((one): FindingTerm => ({ ...termOf(mine, code, one.sum, null, one.unit, 'rows') }))];
      const extra: PathStep[] = without.length > 0 ? [{ step: 'ASSIGN_UNIT', layoutCode: mine.layoutCode, rows: without }] : [];
      addFinding(run, rule, code, fillCrosscheckText('rule_05_formula', { code }), result, terms, { authors, units, path: pathOf(terms, extra) });
    }
  }
}

// XR-06 ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function ruleRate(run: Run, rule: RuleSetting, authors: Map<string, string | null>): void {
  for (const report of run.reports) {
    if (rule.roles.length > 0 && report.role !== SNAPSHOT_ROLE && !rule.roles.includes(report.role)) continue;
    const mine = readable(run, rule.id, report, report.role, report.period);
    if (mine === undefined) continue;
    for (const definition of run.policy.rateDefinitions.filter((one) => rule.codes.includes(one.code))) {
      const rate = figureOf(mine, definition.code);
      const numerator = figureOf(mine, definition.numerator);
      const denominator = figureOf(mine, definition.denominator);
      if (rate === undefined || rate.value === null || numerator === undefined || numerator.value === null || denominator === undefined || denominator.value === null) {
        noValue(run, rule.id, mine, definition.code);
        continue;
      }
      const top = wholeOf(numerator.value);
      const bottom = wholeOf(denominator.value);
      if (top === null || bottom === null || bottom <= 0n || top < 0n) {
        noValue(run, rule.id, mine, definition.code);
        continue;
      }
      const expected = percentOf(top, bottom);
      const result = compare(run.policy, rule, definition.code, expected, rate.value, 1);
      if (result === undefined) {
        noValue(run, rule.id, mine, definition.code);
        continue;
      }
      run.comparisons += 1;
      if (!result.breach) continue;
      const terms = [termOf(mine, definition.code, rate.value, rate.asOf), termOf(mine, definition.numerator, numerator.value, numerator.asOf), termOf(mine, definition.denominator, denominator.value, denominator.asOf)];
      const formula = fillCrosscheckText('rule_06_formula', { code: definition.code, numerator: definition.numerator, denominator: definition.denominator, tolerance: result.tolerance });
      addFinding(run, rule, definition.code, formula, result, terms, { authors });
    }
  }
}

/**
 * Compares the reports given for the family of `period` (the quarter and its months, and the frozen snapshot of each) under the policy. `period` is the period of the report that is about to be released, or any
 * period of the family. The result lists the findings in a fixed order (rule, figure, fingerprint), so the same inputs always give the same result and the same `sha256`.
 */
export function compareReports(period: FormPeriod, reports: readonly CrosscheckReport[], policy: CrosscheckPolicy): CrosscheckResult {
  const family = new Set(crosscheckFamily(period).map(codeOfPeriod));
  const inFamily = reports.filter((one) => family.has(codeOfPeriod(one.period)));
  const run: Run = { policy, period, reports: [...inFamily], findings: [], skipped: [], comparisons: 0, seen: new Set() };
  const authors = new Map<string, string | null>(inFamily.filter((one) => one.ref.kind !== 'SNAPSHOT').map((one) => [one.ref.id, one.preparedBy]));
  let rulesRun = 0;
  const runners: Array<[CrosscheckRuleId, (run: Run, rule: RuleSetting, authors: Map<string, string | null>) => void]> = [
    ['XR-01', ruleMonthsToQuarter],
    ['XR-02', ruleSnapshotMatch],
    ['XR-03', ruleSameIndicator],
    ['XR-04', ruleCumulative],
    ['XR-05', ruleUnitSum],
    ['XR-06', ruleRate],
  ];
  for (const [id, runner] of runners) {
    const rule = ruleSetting(policy, id);
    if (rule === undefined) continue;
    rulesRun += 1;
    runner(run, rule, authors);
  }
  const order = (one: CrosscheckFinding, two: CrosscheckFinding): number => one.ruleId.localeCompare(two.ruleId) || one.code.localeCompare(two.code) || one.fingerprint.localeCompare(two.fingerprint);
  run.findings.sort(order);
  const real = inFamily.filter((one) => one.role !== SNAPSHOT_ROLE);
  const coverage = { reports: real.length, usable: real.filter((one) => usable(run, one)).length, rulesRun, comparisons: run.comparisons, skipped: run.skipped.length };
  return { periodCode: codeOfPeriod(period), findings: run.findings, skipped: run.skipped, coverage, sha256: sha256Hex(canonicalJson({ period: codeOfPeriod(period), findings: run.findings.map((one) => [one.ruleId, one.code, one.severity, one.fingerprint]), coverage })) };
}

// -- the gate and the explanation ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const EXPLANATION_REASON_MIN = 20;
export const EXPLANATION_REASON_MAX = 2000;

export interface GateDecision {
  /** BLOCKING findings that involve the release and have no explanation. */
  blocking: CrosscheckFinding[];
  /** BLOCKING findings that involve the release and are explained. */
  explained: CrosscheckFinding[];
  /** WARNING findings that involve the release. */
  warnings: CrosscheckFinding[];
  passed: boolean;
}

/** What a release of the draft `refId` must clear: the findings that involve it, split by what is open. A finding of other reports never blocks it. A BLOCKING finding passes only with an explanation of its fingerprint. */
export function gateOf(result: CrosscheckResult, refId: string, explained: ReadonlySet<string>): GateDecision {
  const mine = result.findings.filter((one) => one.involves.includes(refId));
  const blocking = mine.filter((one) => one.severity === 'BLOCKING' && !explained.has(one.fingerprint));
  return { blocking, explained: mine.filter((one) => one.severity === 'BLOCKING' && explained.has(one.fingerprint)), warnings: mine.filter((one) => one.severity === 'WARNING'), passed: blocking.length === 0 };
}

/** The checks on an explanation before it is recorded: a reason of enough length, and an explainer who prepared none of the reports the finding is about. */
export function assertExplanationAllowed(finding: Pick<CrosscheckFinding, 'authors'>, input: { explainerId: string; reason: string }): void {
  const reason = input.reason.trim();
  if (reason.length < EXPLANATION_REASON_MIN || reason.length > EXPLANATION_REASON_MAX || reason !== input.reason) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  if (finding.authors.includes(input.explainerId)) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'explainer');
}

