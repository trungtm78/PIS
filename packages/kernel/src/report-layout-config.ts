import { DomainError } from './errors.ts';
import { registerRuleType } from './governance-rules.ts';
import type { FieldSpec, RuleParams } from './governance-rules.ts';
import { ENT4B_TEXT as T } from './messages/ent4b-texts.ts';
import { MOF_RECEIVER } from './period-report.ts';
import { RECEIVER_CODE } from './report-form.ts';
import { DEMO_MARK, MONEY_SCALES, PERIOD_BASES, REPORT_FORM_CATALOGUE, REPORT_PERIOD_KINDS, dataRowOf, defaultBasisOf, numFmtOf, periodRange, validateLayout } from './report-layout.ts';
import type { CellBinding, FormPeriod, FormPeriodKind, LayoutCell, LayoutColumn, LayoutRow, MoneyScale, PeriodBasis, ReportFillData, ReportFigure, ReportIndicatorDefinition, ReportLayout } from './report-layout.ts';

/**
 * The layout of an internal form or of a form for a Department, Board or Sector, chosen by the user without code (ENT-4b, eng-review R23, requirement BC.01: "choose indicators, columns, project groups"). The layout is a
 * governance rule of the type `REPORT_LAYOUT`: it has versions, a maker who is not its approver and an audit trail like every other rule, and an issued copy keeps the version (and the hash) of the layout it was made from.
 *
 * What the user chooses is a closed list, not free cell design: the indicators of the register (with a title and a period basis each), the columns of the project table from a fixed catalogue (with a title each), the
 * project groups (key and title), whether totals are shown, who signs, and for a form asked for by a Department, Board or Sector the name of the requesting body and the reference of its request. `compileLayoutConfig`
 * turns that into a `ReportLayout` for the report engine: the same engine fills it, the same three writers print it. The official forms of PVN, HPM and the Ministry stay owned by code and packs: the code of a
 * configured layout starts with `CFG_` (a pattern of the rule type, so a rule cannot be written under the code of a code-owned form), and its receiver cannot be one of theirs.
 */
export const REPORT_LAYOUT_RULE_TYPE = 'REPORT_LAYOUT';
export const CONFIG_CODE_PREFIX = 'CFG_';
/** The codes a configured layout may have: the prefix and up to 34 more characters, so that the layout code (at most 40) fits. */
export const CONFIG_CODE_PATTERN = '^CFG_[A-Z][A-Z0-9_]{1,34}$';
export const CONFIG_KINDS = ['INTERNAL', 'AGENCY_REQUEST'] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];
/** The columns the user may put in the project table; each is a field of the group datasets, except the rate, which is worked out by a live formula. */
export const CONFIG_COLUMN_KEYS = ['project_code', 'project_name', 'owner_unit', 'total_investment', 'plan_year', 'executed_period', 'disbursed_period', 'cumulative_year', 'rate_year', 'status', 'note'] as const;
export type ConfigColumnKey = (typeof CONFIG_COLUMN_KEYS)[number];
export const CONFIG_SIGNATURES = ['PREPARER', 'CHECKER', 'APPROVER'] as const;
export type ConfigSignature = (typeof CONFIG_SIGNATURES)[number];
export const CONFIG_INTERNAL_RECEIVER = 'INTERNAL';
export const CONFIG_DEFAULT_PROVIDER = 'DIS_HOME';
export const CONFIG_LIMITS = Object.freeze({ indicators: 40, columns: 11, groups: 10 });

/** The receivers that belong to code-owned forms (the six PVFCCo forms, the Ministry): a configured layout may not be addressed to them. */
export const PROTECTED_RECEIVERS: readonly string[] = Object.freeze([...new Set([...REPORT_FORM_CATALOGUE.map((entry) => entry.receiver), MOF_RECEIVER])]);

export interface ConfigIndicator {
  code: string;
  title?: string | undefined;
  basis?: PeriodBasis | undefined;
}
export interface ConfigColumn {
  key: ConfigColumnKey;
  title?: string | undefined;
}
export interface ConfigGroup {
  key: string;
  title: string;
}
export interface LayoutConfig {
  kind: ConfigKind;
  title: string;
  subtitle?: string | undefined;
  period_kind: FormPeriodKind;
  money_scale: MoneyScale;
  /** True: the form is a DEMO form (illustrative data, marked on every output, never accepted, R18). */
  demo: boolean;
  receiver: string;
  /** For a form asked for by a Department, Board or Sector. */
  agency?: { name: string; request_ref?: string | undefined } | undefined;
  /** The id of the provider of the figures (the API knows the providers); the default reads the command center. */
  data_provider?: string | undefined;
  indicators: ConfigIndicator[];
  columns: ConfigColumn[];
  groups: ConfigGroup[];
  totals: boolean;
  signatures: ConfigSignature[];
  note?: string | undefined;
}

// ---- the schema of the rule -------------------------------------------------------------------------------------------------------------------

const text = (max: number, optional = false): FieldSpec => ({ kind: 'text', max, optional });
const oneOf = (values: readonly string[], optional = false): FieldSpec => ({ kind: 'enum', values, optional });

export const REPORT_LAYOUT_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  kind: oneOf(CONFIG_KINDS),
  title: text(200),
  subtitle: text(200, true),
  period_kind: oneOf(REPORT_PERIOD_KINDS),
  money_scale: oneOf(MONEY_SCALES),
  demo: { kind: 'boolean' },
  receiver: { kind: 'text', max: 60, pattern: RECEIVER_CODE.source },
  agency: { kind: 'object', optional: true, fields: { name: text(200), request_ref: text(200, true) } },
  data_provider: { kind: 'text', max: 40, optional: true, pattern: '^[A-Z][A-Z0-9_]{1,39}$' },
  indicators: { kind: 'list', max: CONFIG_LIMITS.indicators, of: { kind: 'object', fields: { code: { kind: 'text', max: 64, pattern: '^[A-Z][A-Z0-9_]{1,63}$' }, title: text(200, true), basis: oneOf(PERIOD_BASES, true) } } },
  columns: { kind: 'list', max: CONFIG_LIMITS.columns, of: { kind: 'object', fields: { key: oneOf(CONFIG_COLUMN_KEYS), title: text(120, true) } } },
  groups: { kind: 'list', max: CONFIG_LIMITS.groups, of: { kind: 'object', fields: { key: { kind: 'text', max: 24, pattern: '^[a-z][a-z0-9_]{0,23}$' }, title: text(200) } } },
  totals: { kind: 'boolean' },
  signatures: { kind: 'list', max: CONFIG_SIGNATURES.length, of: oneOf(CONFIG_SIGNATURES) },
  note: text(500, true),
};

const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** The rules across fields that the closed schema cannot say. Returns the first offending field. */
export function refineLayoutConfig(params: Record<string, unknown>): string | undefined {
  const config = params as unknown as LayoutConfig;
  if (config.kind === 'AGENCY_REQUEST') {
    if (config.agency === undefined) return 'agency';
    if (config.receiver === CONFIG_INTERNAL_RECEIVER) return 'receiver';
  } else {
    if (config.agency !== undefined) return 'agency';
    if (config.receiver !== CONFIG_INTERNAL_RECEIVER) return 'receiver';
  }
  if (PROTECTED_RECEIVERS.some((one) => one.toLowerCase() === config.receiver.toLowerCase())) return 'receiver';
  if (config.indicators.length === 0 && config.groups.length === 0) return 'indicators';
  if (!distinct(config.indicators.map((one) => `${one.code}@${one.basis ?? ''}`))) return 'indicators';
  const columnKeys = config.columns.map((one) => one.key);
  if (!distinct(columnKeys)) return 'columns';
  if (!distinct(config.groups.map((one) => one.key))) return 'groups';
  if (config.groups.length === 0 && config.columns.length > 0) return 'columns';
  if (config.groups.length > 0) {
    if (!columnKeys.includes('project_name') && !columnKeys.includes('project_code')) return 'columns';
    if (columnKeys.includes('rate_year') && !(columnKeys.includes('plan_year') && columnKeys.includes('cumulative_year'))) return 'columns';
  }
  if (!distinct(config.signatures)) return 'signatures';
  return undefined;
}

/** The dataset a project group reads: the provider of the figures fills it (the enterprise provider of ENT-3a does); until then the cells stay empty and say why. */
export const groupDatasetOf = (key: string): string => `projects_${key}`;

// ---- the layout ---------------------------------------------------------------------------------------------------------------------------

type ColumnKind = 'TEXT' | 'MONEY' | 'RATE';
const COLUMN_DEFS: Readonly<Record<ConfigColumnKey, { kind: ColumnKind; width: number; label: string }>> = {
  project_code: { kind: 'TEXT', width: 14, label: T.column_project_code },
  project_name: { kind: 'TEXT', width: 40, label: T.column_project_name },
  owner_unit: { kind: 'TEXT', width: 26, label: T.column_owner_unit },
  total_investment: { kind: 'MONEY', width: 18, label: T.column_total_investment },
  plan_year: { kind: 'MONEY', width: 18, label: T.column_plan_year },
  executed_period: { kind: 'MONEY', width: 18, label: T.column_executed_period },
  disbursed_period: { kind: 'MONEY', width: 18, label: T.column_disbursed_period },
  cumulative_year: { kind: 'MONEY', width: 18, label: T.column_cumulative_year },
  rate_year: { kind: 'RATE', width: 14, label: T.column_rate_year },
  status: { kind: 'TEXT', width: 18, label: T.column_status },
  note: { kind: 'TEXT', width: 30, label: T.column_note },
};
/** The money columns of the catalogue, in the order of the catalogue. */
export const CONFIG_MONEY_COLUMNS: readonly ConfigColumnKey[] = CONFIG_COLUMN_KEYS.filter((key) => COLUMN_DEFS[key].kind === 'MONEY');
const SCALE_DECIMALS: Record<MoneyScale, number> = { VND: 0, THOUSAND_VND: 0, MILLION_VND: 0, BILLION_VND: 2 };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const letterOf = (col: number): string => String.fromCharCode(64 + col);
const fillWith = (template: string, values: Record<string, string>): string => template.replace(/\{([a-z]+)\}/g, (_match, key: string) => values[key] ?? '');

export interface CompiledLayout {
  layout: ReportLayout;
  /** The configured forms have no Word narrative. */
  narrative: null;
  receiver: string;
  periodKind: FormPeriodKind;
  demo: boolean;
  /** The datasets the layout reads, one per project group, in order. */
  datasets: string[];
  /** The indicators the layout binds, in order, each with the basis it asks for. */
  indicators: Array<{ code: string; basis: PeriodBasis | undefined }>;
}

export interface CompileOptions {
  /** The names of the indicators in the register, for a row whose title the user left out. */
  names?: Readonly<Record<string, string>> | undefined;
}

/** Reads the params of a rule as a layout config (they passed the schema and `refineLayoutConfig`). */
export function layoutConfigOf(params: RuleParams): LayoutConfig {
  const problem = refineLayoutConfig(params);
  if (problem !== undefined) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, problem);
  return params as unknown as LayoutConfig;
}

/**
 * Turns the choices of the user into a layout of the report engine. Pure and deterministic: the same code, version and config give the same layout, and so the same hash. With project groups the form is a title block, a
 * strip of the chosen indicators and a table of the chosen columns with a block per group (rows of its dataset, a subtotal when totals are on) and a grand total made of live SUM formulas; without groups it is a table of
 * the chosen indicators. The words of the form are the user's own titles where given, else the names of the register.
 */
export function compileLayoutConfig(code: string, version: string, config: LayoutConfig, options: CompileOptions = {}): CompiledLayout {
  if (!new RegExp(CONFIG_CODE_PATTERN).test(code)) throw new DomainError('VALIDATION_FAILED', 422, 'code');
  const problem = refineLayoutConfig(config as unknown as Record<string, unknown>);
  if (problem !== undefined) throw new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, problem);
  const names = options.names ?? {};
  const withGroups = config.groups.length > 0;
  const keys = withGroups ? config.columns.map((one) => one.key) : [];
  const columns: LayoutColumn[] = withGroups
    ? [
        { col: 1, key: 'no', header: [T.col_no], width: 6 },
        ...config.columns.map((one, index): LayoutColumn => {
          const def = COLUMN_DEFS[one.key];
          return { col: index + 2, key: one.key, header: [one.title ?? def.label], width: def.width, ...(def.kind === 'MONEY' ? { format: { scale: config.money_scale } } : {}) };
        }),
      ]
    : [
        { col: 1, key: 'no', header: [T.col_no], width: 6 },
        { col: 2, key: 'indicator', header: [T.col_indicator], width: 56 },
        { col: 3, key: 'value', header: [T.col_value], width: 24 },
      ];
  const width = columns.length;
  const colOf = (key: string): number => columns.find((one) => one.key === key)?.col ?? 0;
  const cell = (col: number, binding: CellBinding, extra: Partial<LayoutCell> = {}): LayoutCell => ({ col, binding, ...extra });
  const words = (col: number, value: string, extra: Partial<LayoutCell> = {}): LayoutCell => cell(col, { kind: 'TEXT', text: value }, extra);
  const wide = (value: string): LayoutRow => ({ kind: 'TITLE', cells: [words(1, value, { colSpan: width })] });
  const wideMeta = (key: string): LayoutRow => ({ kind: 'TITLE', cells: [cell(1, { kind: 'META', key }, { colSpan: width })] });

  const preface: LayoutRow[] = [];
  if (config.demo) preface.push(wide(DEMO_MARK));
  if (config.kind === 'AGENCY_REQUEST' && config.agency !== undefined) {
    preface.push(wide(fillWith(T.to_agency, { agency: config.agency.name })));
    if (config.agency.request_ref !== undefined) preface.push(wide(fillWith(T.request_ref, { ref: config.agency.request_ref })));
  }
  preface.push(wide(config.title));
  if (config.subtitle !== undefined) preface.push(wide(config.subtitle));
  preface.push(wideMeta('PERIOD_LABEL'), wideMeta('ORG_NAME'), wideMeta('UNIT_LABEL'));

  const indicatorLabel = (one: ConfigIndicator): string => one.title ?? names[one.code] ?? one.code;
  const indicatorBinding = (one: ConfigIndicator): CellBinding => ({ kind: 'INDICATOR', code: one.code, ...(one.basis === undefined ? {} : { basis: one.basis }) });
  const body: LayoutRow[] = [];

  if (withGroups) {
    // The strip of the chosen indicators above the table: the label across all but the last column, the figure in the last.
    if (width >= 2) {
      for (const one of config.indicators) preface.push({ kind: 'NOTE', cells: [words(1, indicatorLabel(one), { colSpan: width - 1 }), cell(width, indicatorBinding(one))] });
    }
    const moneyKeys = keys.filter((key) => COLUMN_DEFS[key].kind === 'MONEY');
    const rateFormula = (row: string): string => `IF(${letterOf(colOf('plan_year'))}${row}>0,ROUND(${letterOf(colOf('cumulative_year'))}${row}/${letterOf(colOf('plan_year'))}${row}*100,1),"")`;
    const sumFormula = (key: ConfigColumnKey, datasets: readonly string[]): string => `SUM(${datasets.map((dataset) => `${letterOf(colOf(key))}{first:${dataset}}:${letterOf(colOf(key))}{last:${dataset}}`).join(',')})`;
    const moneyFormat = { numFmt: numFmtOf(SCALE_DECIMALS[config.money_scale]) };
    const rateFormat = { numFmt: '#,##0.0' };
    const totalRow = (label: string, datasets: readonly string[]): LayoutRow => {
      const cells: LayoutCell[] = [words(labelColumn(), label)];
      for (const key of moneyKeys) cells.push(cell(colOf(key), { kind: 'FORMULA', formula: sumFormula(key, datasets) }, { format: moneyFormat }));
      if (keys.includes('rate_year')) cells.push(cell(colOf('rate_year'), { kind: 'FORMULA', formula: rateFormula('{row}') }, { format: rateFormat }));
      return { kind: 'TOTAL', cells: cells.sort((a, b) => a.col - b.col) };
    };
    // The label of a total sits in the first text column after the number.
    const labelColumn = (): number => columns.find((one) => one.col > 1 && COLUMN_DEFS[one.key as ConfigColumnKey]?.kind === 'TEXT')?.col ?? 2;
    const hasTotals = config.totals && moneyKeys.length + (keys.includes('rate_year') ? 1 : 0) > 0;
    const datasets: string[] = [];
    config.groups.forEach((group, index) => {
      const dataset = groupDatasetOf(group.key);
      datasets.push(dataset);
      body.push({ kind: 'NOTE', cells: [words(1, `${ROMAN[index] ?? String(index + 1)}. ${group.title}`, { colSpan: width })] });
      const data = dataRowOf(dataset, columns, { capacity: 3, numbered: 'no' });
      data.cells = data.cells.map((one) => (colOf('rate_year') === one.col ? cell(one.col, { kind: 'FORMULA', formula: rateFormula('{row}') }, { format: rateFormat }) : one));
      body.push(data);
      if (hasTotals) body.push(totalRow(fillWith(T.group_total, { title: group.title }), [dataset]));
    });
    if (hasTotals) body.push(totalRow(T.grand_total, datasets));
    if (config.demo) body.push({ kind: 'NOTE', cells: [words(1, T.note_demo_data, { colSpan: width })] });
  } else {
    config.indicators.forEach((one, index) => {
      body.push({ kind: 'NOTE', cells: [words(1, String(index + 1)), words(2, indicatorLabel(one)), cell(3, indicatorBinding(one))] });
    });
  }
  if (config.note !== undefined) body.push({ kind: 'NOTE', cells: [words(1, config.note, { colSpan: width })] });
  if (config.signatures.length > 0) {
    const roleWords: Record<ConfigSignature, string> = { PREPARER: T.sign_preparer, CHECKER: T.sign_checker, APPROVER: T.sign_approver };
    if (width >= config.signatures.length) {
      const span = Math.floor(width / config.signatures.length);
      body.push({ kind: 'NOTE', cells: config.signatures.map((role, index) => words(1 + index * span, roleWords[role], { colSpan: span })) });
    } else {
      for (const role of config.signatures) body.push({ kind: 'NOTE', cells: [words(1, roleWords[role], { colSpan: width })] });
    }
  }

  const layout: ReportLayout = {
    code,
    name: config.demo ? `${config.title}${T.demo_suffix}` : config.title,
    version,
    status: config.demo ? 'DEMO' : 'READY',
    formRef: null,
    sheetName: code.slice(0, 31),
    moneyScale: config.money_scale,
    headerMode: 'WRITE',
    columns,
    preface,
    body,
  };
  validateLayout(layout);
  return {
    layout,
    narrative: null,
    receiver: config.receiver,
    periodKind: config.period_kind,
    demo: config.demo,
    datasets: config.groups.map((group) => groupDatasetOf(group.key)),
    indicators: config.indicators.map((one) => ({ code: one.code, basis: one.basis })),
  };
}

// ---- illustrative data for the live preview -----------------------------------------------------------------------------------------------------

const hashOf = (value: string): number => {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash;
};

/**
 * Invented data that is the same every time, labelled so, for the preview of a layout while it is being edited and for a DEMO form: a figure for each indicator the register defines, a few rows for each project group.
 * Money is in whole millions of dong, so that sums scaled to millions have no rounding drift. An indicator that the register does not define gets no figure (the preview then says so, as a real report would).
 */
export function illustrativeLayoutData(config: LayoutConfig, period: FormPeriod, definitions: Readonly<Record<string, ReportIndicatorDefinition>>): ReportFillData {
  const figures: ReportFigure[] = [];
  const known: Record<string, ReportIndicatorDefinition> = {};
  for (const one of config.indicators) {
    const definition = definitions[one.code];
    if (definition === undefined) continue;
    known[one.code] = definition;
    const seed = hashOf(`${one.code}|${one.basis ?? ''}`);
    const basis = one.basis ?? defaultBasisOf(definition.period);
    const value = definition.unit === 'VND' ? String((1 + (seed % 900)) * 1_000_000_000) : definition.unit === 'PERCENT' ? `${20 + (seed % 70)}.${seed % 10}` : String(1 + (seed % 40));
    figures.push({ code: one.code, basis, value });
  }
  const datasets: Record<string, Array<Record<string, string | number | null>>> = {};
  config.groups.forEach((group, groupIndex) => {
    datasets[groupDatasetOf(group.key)] = Array.from({ length: 3 + (groupIndex % 2) }, (_, index) => {
      const seed = hashOf(`${group.key}|${index}`);
      const plan = (500 + (seed % 4000)) * 1_000_000;
      const done = Math.floor((plan / 1_000_000) * (0.2 + ((seed >>> 8) % 70) / 100)) * 1_000_000;
      const n = `${groupIndex + 1}.${index + 1}`;
      return {
        project_code: `DA-${n}`,
        project_name: fillWith(T.sample_group_project, { n }),
        owner_unit: fillWith(T.sample_owner, { n: String((seed % 9) + 1) }),
        total_investment: String(plan * 3),
        plan_year: String(plan),
        executed_period: String(Math.floor(done / 3)),
        disbursed_period: String(Math.floor(done / 4)),
        cumulative_year: String(done),
        status: index % 2 === 0 ? '-' : '--',
        note: T.sample_note,
      };
    });
  });
  const range = periodRange(period);
  return { period, locale: 'vi', meta: { ORG_NAME: T.sample_org, PERIOD_FROM: range.from, PERIOD_TO: range.to }, definitions: known, figures, datasets };
}

// ---- the built-in starting layouts -----------------------------------------------------------------------------------------------------------

const AS_OF = '2026-11-08';

/** The layout for a Department, Board or Sector that a tenant starts from: a title block, three headline indicators and two project groups; the tenant drafts a new version for the layout the requesting body asked for. */
export const AGENCY_REQUEST_DEFAULT: LayoutConfig = {
  kind: 'AGENCY_REQUEST',
  title: T.default_agency_title,
  subtitle: T.default_subtitle,
  period_kind: 'QUARTER',
  money_scale: 'MILLION_VND',
  demo: true,
  receiver: 'AGENCY',
  agency: { name: T.default_agency },
  indicators: [{ code: 'PLAN_TOTAL' }, { code: 'DISBURSED_TREASURY' }, { code: 'DISBURSEMENT_RATE_TOTAL' }],
  columns: [{ key: 'project_code' }, { key: 'project_name' }, { key: 'plan_year' }, { key: 'cumulative_year' }, { key: 'rate_year' }, { key: 'status' }],
  groups: [
    { key: 'construction', title: T.default_group_a },
    { key: 'purchase_repair', title: T.default_group_b },
  ],
  totals: true,
  signatures: ['PREPARER', 'CHECKER', 'APPROVER'],
};

/** An internal overview of the headline indicators, live (not a demo): a table of the chosen indicators. */
export const INTERNAL_OVERVIEW_DEFAULT: LayoutConfig = {
  kind: 'INTERNAL',
  title: T.default_internal_title,
  period_kind: 'MONTH',
  money_scale: 'MILLION_VND',
  demo: false,
  receiver: CONFIG_INTERNAL_RECEIVER,
  indicators: [{ code: 'DISBURSEMENT_RATE_TOTAL' }, { code: 'DISBURSED_TREASURY' }, { code: 'PLAN_TOTAL' }, { code: 'OPEN_WARNINGS' }],
  columns: [],
  groups: [],
  totals: false,
  signatures: ['PREPARER', 'APPROVER'],
};

let registered = false;

/** Registers the rule type `REPORT_LAYOUT` with the two starting layouts. Idempotent; the kernel calls it when it loads. */
export function registerReportLayoutRules(): void {
  if (registered) return;
  registered = true;
  registerRuleType({
    type: REPORT_LAYOUT_RULE_TYPE,
    ownerModule: 'RPT',
    modules: ['RPT', 'ENT'],
    formula: T.rule_formula,
    source: T.rule_source,
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: REPORT_LAYOUT_SCHEMA,
    refine: refineLayoutConfig,
    codePattern: CONFIG_CODE_PATTERN,
    defaults: {
      CFG_AGENCY_REQUEST: { params: JSON.parse(JSON.stringify(AGENCY_REQUEST_DEFAULT)) as RuleParams },
      CFG_INTERNAL_OVERVIEW: { params: JSON.parse(JSON.stringify(INTERNAL_OVERVIEW_DEFAULT)) as RuleParams },
    },
  });
}

registerReportLayoutRules();
