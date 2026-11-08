import type { FieldSpec } from './governance-rules.ts';
import { message } from './messages.ts';

/**
 * The shapes of IND-1 as plain data (the indicator dictionary, the data-entry rules, the Excel import mappings): the closed lists, the fields that the three governance rule types accept and the starting
 * indicators. The module has no value import from `governance-rules.ts` (that file imports this one to register the types), so the schema is written here with plain objects.
 *
 * The dictionary is not a second register: an indicator is a `KPI_DEFINITION` rule of the governance store (codes, names, units, formulas, owners, versions, maker-checker approval, effective days) with a few
 * optional members that say how the figure is obtained and entered. Everything below is a starting value to be replaced by the customer's dictionary (DL.01, DL.02).
 */

/** Where a figure is typed or loaded: the weekly and monthly report of DIS, the project register, the entry of indicator figures and the import of an Excel file. */
export const ENTRY_SURFACES = ['DIS_REPORT', 'PRJ_PROJECT', 'INDICATOR_ENTRY', 'INDICATOR_IMPORT'] as const;
export type EntrySurface = (typeof ENTRY_SURFACES)[number];
export const isEntrySurface = (value: unknown): value is EntrySurface => (ENTRY_SURFACES as readonly unknown[]).includes(value);

/** The kinds of check of a `DATA_ENTRY_RULE`. */
export const DATA_ENTRY_CHECKS = ['CUMULATIVE_NOT_ABOVE_TOTAL', 'PARTS_EQUAL_TOTAL', 'PERIOD_LOCKED_AFTER_CLOSE', 'FIELD_REQUIRED', 'VALUE_IN_RANGE'] as const;
export type DataEntryCheck = (typeof DATA_ENTRY_CHECKS)[number];
export const DATA_ENTRY_SEVERITIES = ['BLOCK', 'WARN'] as const;
export type DataEntrySeverity = (typeof DATA_ENTRY_SEVERITIES)[number];
/** The states of a reporting period (`reporting_period.status`). */
export const PERIOD_STATES = ['OPEN', 'SOFT_CLOSED', 'LOCKED'] as const;
export type PeriodState = (typeof PERIOD_STATES)[number];

/** The pseudo field of the rule "mandatory fields": it stands for the fields the dictionary requires on the surface of the entry. */
export const MANDATORY_FIELDS_TOKEN = 'MANDATORY_FIELDS';

export const INDICATOR_CATEGORIES = ['FUNDING', 'PLAN', 'EXECUTION', 'DISBURSEMENT', 'PROGRESS', 'RATE', 'OTHER'] as const;
export type IndicatorCategory = (typeof INDICATOR_CATEGORIES)[number];
export const isIndicatorCategory = (value: unknown): value is IndicatorCategory => (INDICATOR_CATEGORIES as readonly unknown[]).includes(value);

/** `ENTERED`: a person types it or a file carries it. `DERIVED`: the platform computes it from other figures and nobody may enter it. */
export const INDICATOR_VALUE_KINDS = ['ENTERED', 'DERIVED'] as const;
export type IndicatorValueKind = (typeof INDICATOR_VALUE_KINDS)[number];
export const VAT_BASES = ['EXCLUDING_VAT', 'INCLUDING_VAT', 'NOT_APPLICABLE'] as const;
export type VatBasis = (typeof VAT_BASES)[number];

/** The unit a sheet is written in for money: the figure is kept in whole dong whatever the sheet says. */
export const IMPORT_SCALES = ['ONE', 'THOUSAND', 'MILLION', 'BILLION'] as const;
export type ImportScale = (typeof IMPORT_SCALES)[number];
export const SCALE_FACTORS: Readonly<Record<ImportScale, string>> = { ONE: '1', THOUSAND: '1000', MILLION: '1000000', BILLION: '1000000000' };
export const IMPORT_LAYOUTS = ['COLUMNS', 'ROWS'] as const;
export type ImportLayout = (typeof IMPORT_LAYOUTS)[number];
/** `PLAIN`: 1234.56 (a dot for the decimals, no group sign). `VN`: 1.234,56 (a dot between thousands, a comma for the decimals). */
export const NUMBER_FORMATS = ['PLAIN', 'VN'] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];

export const INDICATOR_IMPORT_RULE_TYPE = 'INDICATOR_IMPORT_MAPPING';
export const DATA_ENTRY_RULE_TYPE = 'DATA_ENTRY_RULE';
export const DECIMAL_TEXT_PATTERN = '^-?(0|[1-9][0-9]{0,23})(\\.[0-9]{1,6})?$';

const text = (max: number, optional = false, allowEmpty = false): FieldSpec => ({ kind: 'text', max, optional, allowEmpty });
const word = (optional = false): FieldSpec => ({ kind: 'text', max: 64, optional });
const codeText = (): FieldSpec => ({ kind: 'text', max: 40, pattern: '^[A-Z][A-Z0-9_]{1,39}$' });
const oneOf = (values: readonly string[], optional = false): FieldSpec => ({ kind: 'enum', values, optional });
const list = (of: FieldSpec, max: number, min = 0, optional = false): FieldSpec => ({ kind: 'list', of, max, min, optional });
const decimalText = (optional = true): FieldSpec => ({ kind: 'text', max: 32, optional, pattern: DECIMAL_TEXT_PATTERN });

// ---- the dictionary: what an indicator adds to a KPI definition ------------------------------------------------------------------------------------------------

/** The optional members of `KPI_DEFINITION` that make the register a dictionary. A rule that has none of them is a KPI of the command centre and is not offered for entry. */
export const INDICATOR_KPI_FIELDS: Readonly<Record<string, FieldSpec>> = {
  category: oneOf(INDICATOR_CATEGORIES, true),
  value_kind: oneOf(INDICATOR_VALUE_KINDS, true),
  /** The name of the figure in the facts of an entry rule (the field of a `DATA_ENTRY_RULE` and of the entry of a surface). */
  entry_field: word(true),
  vat_basis: oneOf(VAT_BASES, true),
  /** The names under which the figure appears in the customer's forms, matched without regard to case and spaces. */
  aliases: list(text(120), 10, 0, true),
  /** The surfaces where the figure must be given. */
  required_on: list(oneOf(ENTRY_SURFACES), 4, 0, true),
};

// ---- the entry rules ---------------------------------------------------------------------------------------------------------------------------------------------

/** The schema of `DATA_ENTRY_RULE` (the four checks of the first cut plus the range of a value), as plain data for the registry. */
export const DATA_ENTRY_RULE_FIELDS: Readonly<Record<string, FieldSpec>> = {
  check: oneOf(DATA_ENTRY_CHECKS),
  severity: oneOf(DATA_ENTRY_SEVERITIES),
  fields: list(word(), 12, 1),
  total_field: word(true),
  tolerance: { kind: 'number', min: 0, max: 1_000_000, optional: true },
  message: text(300),
  /** Where the rule applies; a rule with no list applies on every surface. */
  surfaces: list(oneOf(ENTRY_SURFACES), 4, 1, true),
  /** `VALUE_IN_RANGE`: decimal text, so a range of money is exact. */
  min: decimalText(),
  max: decimalText(),
  /** `PERIOD_LOCKED_AFTER_CLOSE`: the states that count as closed (default LOCKED). */
  closed_states: list(oneOf(PERIOD_STATES), 3, 1, true),
};

/** The judgement across fields: each check says what it needs. Returns the offending field. */
export function refineDataEntryRule(params: Record<string, unknown>): string | undefined {
  const fields = params['fields'] as string[];
  const check = params['check'];
  const present = (name: string): boolean => params[name] !== undefined && params[name] !== null;
  if (new Set(fields).size !== fields.length) return 'fields';
  if (check === 'CUMULATIVE_NOT_ABOVE_TOTAL') {
    if (fields.length !== 1) return 'fields';
    if (!present('total_field') || params['total_field'] === fields[0]) return 'total_field';
  }
  if (check === 'PARTS_EQUAL_TOTAL') {
    if (fields.length < 2) return 'fields';
    if (!present('total_field') || fields.includes(params['total_field'] as string)) return 'total_field';
  }
  if (check === 'VALUE_IN_RANGE') {
    if (!present('min') && !present('max')) return 'min';
    if (present('min') && present('max') && Number(params['min']) > Number(params['max'])) return 'max';
  }
  if (check !== 'CUMULATIVE_NOT_ABOVE_TOTAL' && check !== 'PARTS_EQUAL_TOTAL' && present('total_field')) return 'total_field';
  if (check !== 'VALUE_IN_RANGE' && (present('min') || present('max'))) return 'min';
  if (check !== 'PERIOD_LOCKED_AFTER_CLOSE' && present('closed_states')) return 'closed_states';
  if (check !== 'PARTS_EQUAL_TOTAL' && check !== 'CUMULATIVE_NOT_ABOVE_TOTAL' && present('tolerance')) return 'tolerance';
  return undefined;
}

/** The starting checks added to the first four (more are the tenant's own to approve). */
export const DATA_ENTRY_EXTRA_DEFAULTS: Readonly<Record<string, Record<string, unknown>>> = {
  PROGRESS_PERCENT_IN_RANGE: { check: 'VALUE_IN_RANGE', severity: 'BLOCK', fields: ['PHYSICAL_PROGRESS'], min: '0', max: '100', message: message('ind.rule.progress_percent_in_range.message') },
  CUMULATIVE_NOT_NEGATIVE: { check: 'VALUE_IN_RANGE', severity: 'WARN', fields: ['CUMULATIVE'], min: '0', message: message('ind.rule.cumulative_not_negative.message') },
};

// ---- the import mapping ----------------------------------------------------------------------------------------------------------------------------------------

const mappingLine: FieldSpec = {
  kind: 'object',
  fields: {
    indicator: { kind: 'text', max: 64, pattern: '^[A-Z][A-Z0-9_]{1,63}$' },
    /** The header of the column (layout COLUMNS) or the label of the row (layout ROWS) the figure is read from. */
    source: text(160),
    scale: oneOf(IMPORT_SCALES, true),
    required: { kind: 'boolean', optional: true },
  },
};

/** The schema of `INDICATOR_IMPORT_MAPPING`: one code for each form of the customer, versioned and approved by someone other than its maker. */
export const INDICATOR_IMPORT_FIELDS: Readonly<Record<string, FieldSpec>> = {
  name: text(160),
  layout: oneOf(IMPORT_LAYOUTS),
  number_format: oneOf(NUMBER_FORMATS),
  /** COLUMNS: the header of the column that holds the project code (without it the request names the project) and of the one that holds the period code. */
  project_column: text(160, true),
  period_column: text(160, true),
  /** ROWS: the header of the column that holds the label of the indicator and of the one that holds the value. */
  label_column: text(160, true),
  value_column: text(160, true),
  lines: list(mappingLine, 60, 1),
};

const normalized = (value: string): string => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** The judgement across fields of a mapping: the columns its layout needs, one line for each indicator and for each source. */
export function refineImportMapping(params: Record<string, unknown>): string | undefined {
  const present = (name: string): boolean => typeof params[name] === 'string' && params[name] !== '';
  const lines = params['lines'] as Array<{ indicator: string; source: string }>;
  if (params['layout'] === 'ROWS') {
    if (!present('label_column')) return 'label_column';
    if (!present('value_column')) return 'value_column';
    if (normalized(params['label_column'] as string) === normalized(params['value_column'] as string)) return 'value_column';
    if (present('project_column')) return 'project_column';
    if (present('period_column')) return 'period_column';
  } else {
    if (present('label_column')) return 'label_column';
    if (present('value_column')) return 'value_column';
    if (present('project_column') && present('period_column') && normalized(params['project_column'] as string) === normalized(params['period_column'] as string)) return 'period_column';
  }
  const indicators = new Set<string>();
  const sources = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (indicators.has(line.indicator)) return `lines[${index}].indicator`;
    indicators.add(line.indicator);
    const source = normalized(line.source);
    if (sources.has(source)) return `lines[${index}].source`;
    sources.add(source);
  }
  return undefined;
}

// ---- the starting dictionary --------------------------------------------------------------------------------------------------------------------------------------

export interface IndicatorSeed {
  code: string;
  /** The key of the texts: `ind.seed.<key>.name`, `.formula`, `.alias_1`, `.alias_2`, `.numerator`, `.denominator`. */
  key: string;
  unit: 'VND' | 'PERCENT';
  category: IndicatorCategory;
  valueKind: IndicatorValueKind;
  entryField: string | null;
  period: 'YEAR_TO_DATE' | 'AS_OF_NOW' | 'MONTH';
  owner: string;
  requiredOn: readonly EntrySurface[];
  aliasCount: 0 | 2;
  ratio: boolean;
  unitDecimals: number;
}

const SEED_OWNER = 'PROJECT_OWNER';

/** The figures a form of an enterprise investment report carries (DL.01, DL.02) and the derived figures of the funding model (docs/fnd-funding-model.md section 5.3). */
export const INDICATOR_SEEDS: readonly IndicatorSeed[] = [
  { code: 'TOTAL_INVESTMENT', key: 'total_investment', unit: 'VND', category: 'FUNDING', valueKind: 'ENTERED', entryField: 'TOTAL_INVESTMENT', period: 'AS_OF_NOW', owner: SEED_OWNER, requiredOn: [], aliasCount: 2, ratio: false, unitDecimals: 0 },
  { code: 'EQUITY_CAPITAL', key: 'equity_capital', unit: 'VND', category: 'FUNDING', valueKind: 'ENTERED', entryField: 'EQUITY', period: 'AS_OF_NOW', owner: SEED_OWNER, requiredOn: [], aliasCount: 2, ratio: false, unitDecimals: 0 },
  { code: 'LOAN_CAPITAL', key: 'loan_capital', unit: 'VND', category: 'FUNDING', valueKind: 'ENTERED', entryField: 'DEBT', period: 'AS_OF_NOW', owner: SEED_OWNER, requiredOn: [], aliasCount: 2, ratio: false, unitDecimals: 0 },
  { code: 'TOTAL_FUNDING', key: 'total_funding', unit: 'VND', category: 'FUNDING', valueKind: 'ENTERED', entryField: 'TOTAL', period: 'AS_OF_NOW', owner: SEED_OWNER, requiredOn: [], aliasCount: 2, ratio: false, unitDecimals: 0 },
  { code: 'PLAN_YEAR', key: 'plan_year', unit: 'VND', category: 'PLAN', valueKind: 'ENTERED', entryField: 'PLAN_YEAR', period: 'YEAR_TO_DATE', owner: SEED_OWNER, requiredOn: [], aliasCount: 2, ratio: false, unitDecimals: 0 },
  { code: 'CUMULATIVE_YTD', key: 'cumulative_ytd', unit: 'VND', category: 'EXECUTION', valueKind: 'ENTERED', entryField: 'CUMULATIVE', period: 'YEAR_TO_DATE', owner: SEED_OWNER, requiredOn: ['INDICATOR_ENTRY'], aliasCount: 2, ratio: false, unitDecimals: 0 },
  { code: 'EXECUTED_PERIOD', key: 'executed_period', unit: 'VND', category: 'EXECUTION', valueKind: 'ENTERED', entryField: 'EXECUTED', period: 'MONTH', owner: SEED_OWNER, requiredOn: [], aliasCount: 2, ratio: false, unitDecimals: 0 },
  { code: 'DISBURSED_PERIOD', key: 'disbursed_period', unit: 'VND', category: 'DISBURSEMENT', valueKind: 'ENTERED', entryField: 'DISBURSED', period: 'MONTH', owner: SEED_OWNER, requiredOn: [], aliasCount: 2, ratio: false, unitDecimals: 0 },
  { code: 'PHYSICAL_PROGRESS_REPORTED', key: 'physical_progress_reported', unit: 'PERCENT', category: 'PROGRESS', valueKind: 'ENTERED', entryField: 'PHYSICAL_PROGRESS', period: 'AS_OF_NOW', owner: SEED_OWNER, requiredOn: [], aliasCount: 2, ratio: false, unitDecimals: 2 },
  { code: 'RATE_YEAR_IN_FORCE', key: 'rate_year_in_force', unit: 'PERCENT', category: 'RATE', valueKind: 'DERIVED', entryField: null, period: 'YEAR_TO_DATE', owner: 'CAPITAL_PLANNER', requiredOn: [], aliasCount: 0, ratio: true, unitDecimals: 2 },
  { code: 'RATE_SINCE_START', key: 'rate_since_start', unit: 'PERCENT', category: 'RATE', valueKind: 'DERIVED', entryField: null, period: 'AS_OF_NOW', owner: 'CAPITAL_PLANNER', requiredOn: [], aliasCount: 0, ratio: true, unitDecimals: 2 },
  { code: 'REMAINING_YEAR', key: 'remaining_year', unit: 'VND', category: 'PLAN', valueKind: 'DERIVED', entryField: null, period: 'YEAR_TO_DATE', owner: 'CAPITAL_PLANNER', requiredOn: [], aliasCount: 0, ratio: false, unitDecimals: 0 },
  { code: 'STRUCTURE_SHARE', key: 'structure_share', unit: 'PERCENT', category: 'RATE', valueKind: 'DERIVED', entryField: null, period: 'YEAR_TO_DATE', owner: 'CAPITAL_PLANNER', requiredOn: [], aliasCount: 0, ratio: true, unitDecimals: 2 },
];

/** The params of one starting indicator (the texts are read from the kernel messages). */
export function indicatorSeedParams(seed: IndicatorSeed): Record<string, unknown> {
  const text = (suffix: string): string => message(`ind.seed.${seed.key}.${suffix}`);
  const aliases = seed.aliasCount === 0 ? [] : [text('alias_1'), text('alias_2')];
  return {
    name: text('name'),
    formula: text('formula'),
    source: message('ind.seed.source'),
    unit: seed.unit,
    owner: seed.owner,
    decimals: seed.unitDecimals,
    refresh_hours: 24,
    period: seed.period,
    allowed_lag_days: 31,
    ...(seed.ratio ? { numerator: text('numerator'), denominator: text('denominator') } : {}),
    category: seed.category,
    value_kind: seed.valueKind,
    ...(seed.entryField === null ? {} : { entry_field: seed.entryField }),
    ...(aliases.length === 0 ? {} : { aliases }),
    ...(seed.requiredOn.length === 0 ? {} : { required_on: [...seed.requiredOn] }),
  };
}

/** The two sample mappings (a form with a row for each project, and a form with a row for each indicator of one project), built from the starting dictionary. */
export function sampleMappingParams(layout: ImportLayout): Record<string, unknown> {
  const sources = ['total_investment', 'equity_capital', 'loan_capital', 'total_funding', 'cumulative_ytd'];
  const codes = ['TOTAL_INVESTMENT', 'EQUITY_CAPITAL', 'LOAN_CAPITAL', 'TOTAL_FUNDING', 'CUMULATIVE_YTD'];
  const lines = sources.map((key, index) => ({ indicator: codes[index] as string, source: message(`ind.seed.${key}.alias_1`), scale: 'MILLION', required: false }));
  return layout === 'COLUMNS'
    ? { name: message('ind.mapping.sample_columns.name'), layout, number_format: 'VN', project_column: message('ind.mapping.sample_columns.project_column'), period_column: message('ind.mapping.sample_columns.period_column'), lines }
    : { name: message('ind.mapping.sample_rows.name'), layout, number_format: 'VN', label_column: message('ind.mapping.sample_rows.label_column'), value_column: message('ind.mapping.sample_rows.value_column'), lines };
}
