import { ApiError } from '@machvon/api-client';

/**
 * IND-1 on the screen (docs/ind-indicator-dictionary.md): the indicator dictionary (IND-01), the data entry rules (IND-02) and the Excel import mappings with the import flow (IND-03). The server speaks snake_case
 * and any text of the answer may be missing, so every payload is read here into a typed shape with a safe default; a screen never reads the raw answer.
 */

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const count = (value: unknown): number => whole(value) ?? 0;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string');

export const DASH = '—';
export const PATH_RULES = '/ind/ind-02';
export const PATH_MAPPINGS = '/ind/ind-03';
export const PATH_DICTIONARY = '/ind/ind-01';
/** The screens where a definition, a rule or a mapping is drafted, submitted and approved (a maker is not the checker): the governance rules of the tenant. */
export const PATH_GOVERNANCE = '/adm/adm-19';
export const HISTORY_PAGE_SIZE = 20;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PREVIEW_ROW_LIMIT = 500;
export const DECIMAL = /^-?(0|[1-9][0-9]{0,23})(\.[0-9]{1,6})?$/;
export const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const CATEGORIES = ['FUNDING', 'PLAN', 'EXECUTION', 'DISBURSEMENT', 'PROGRESS', 'RATE', 'OTHER'] as const;
export type Category = (typeof CATEGORIES)[number];
export const VALUE_KINDS = ['ENTERED', 'DERIVED'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];
export const SURFACES = ['DIS_REPORT', 'PRJ_PROJECT', 'INDICATOR_ENTRY', 'INDICATOR_IMPORT', 'PERIOD_NARRATIVE'] as const;
export type Surface = (typeof SURFACES)[number];
export const PERIOD_STATUSES = ['OPEN', 'SOFT_CLOSED', 'LOCKED', 'REOPENED'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

const oneOf = <T extends string>(all: readonly T[], value: unknown): T | undefined => all.find((item) => item === value);
export const categoryOf = (value: unknown): Category | undefined => oneOf(CATEGORIES, value);
export const valueKindOf = (value: unknown): ValueKind | undefined => oneOf(VALUE_KINDS, value);
export const surfaceOf = (value: unknown): Surface | undefined => oneOf(SURFACES, value);
export const periodStatusOf = (value: unknown): PeriodStatus | undefined => oneOf(PERIOD_STATUSES, value);

/** `FIELD_REQUIRED` as the key segment `fieldRequired`: the screens read their words under keys of lower camel segments. */
export function camelOf(code: string): string {
  const [head = '', ...tail] = code.toLowerCase().split('_');
  return head + tail.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** A moment as a Vietnam wall-clock `YYYY-MM-DD HH:mm` (UTC+7); empty for none or for a text that is not a moment. */
export function vietnamDateTime(moment: string | null | undefined): string {
  if (moment === null || moment === undefined) return '';
  const at = Date.parse(moment);
  if (Number.isNaN(at)) return '';
  const local = new Date(at + 7 * 3_600_000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

export const shortHash = (hash: string): string => hash.slice(0, 12);

/** A size in the unit a person reads: kilobytes below a megabyte, else megabytes with one decimal. */
export function sizeText(bytes: number, locale: string): { value: string; unit: 'KB' | 'MB' } {
  if (bytes < 1024 * 1024) return { value: Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale), unit: 'KB' };
  return { value: (Math.round((bytes / (1024 * 1024)) * 10) / 10).toLocaleString(locale, { maximumFractionDigits: 1 }), unit: 'MB' };
}

export const tooLarge = (file: { size: number }): boolean => file.size > MAX_FILE_BYTES;

/** Whether the session holds a permission; a session that does not say what it holds is left to the server's answer. */
export function holds(permissions: readonly string[] | undefined, permission: string): boolean {
  return permissions === undefined || permissions.includes(permission) || permissions.some((held) => held.endsWith('.*') && permission.startsWith(held.slice(0, -1)));
}

// ---------------------------------------------------------------------------------------------------------------------------------------- the dictionary

export type Origin = 'RULE' | 'DEFAULT';
const originOf = (value: unknown): Origin => (value === 'RULE' ? 'RULE' : 'DEFAULT');

export interface Indicator {
  code: string;
  name: string;
  formula: string;
  numerator: string | null;
  denominator: string | null;
  exclusions: string[];
  unit: string;
  period: string;
  source: string;
  owner: string;
  decimals: number;
  category: Category | null;
  valueKind: ValueKind;
  enterable: boolean;
  entryField: string | null;
  vatBasis: string | null;
  aliases: string[];
  requiredOn: Surface[];
  version: number;
  origin: Origin;
  unverified: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export function toIndicator(raw: unknown): Indicator | undefined {
  const body = asRecord(raw);
  const code = text(body?.code);
  if (body === undefined || code === undefined) return undefined;
  return {
    code,
    name: text(body.name) ?? code,
    formula: text(body.formula) ?? '',
    numerator: nullableText(body.numerator),
    denominator: nullableText(body.denominator),
    exclusions: strings(body.exclusions),
    unit: text(body.unit) ?? '',
    period: text(body.period) ?? '',
    source: text(body.source) ?? '',
    owner: text(body.owner) ?? '',
    decimals: count(body.decimals),
    category: categoryOf(body.category) ?? null,
    valueKind: valueKindOf(body.value_kind) ?? 'DERIVED',
    enterable: body.enterable === true,
    entryField: nullableText(body.entry_field),
    vatBasis: nullableText(body.vat_basis),
    aliases: strings(body.aliases),
    requiredOn: list(body.required_on).flatMap((item) => surfaceOf(item) ?? []),
    version: count(body.version),
    origin: originOf(body.origin),
    unverified: body.unverified === true,
    effectiveFrom: nullableText(body.effective_from),
    effectiveTo: nullableText(body.effective_to),
  };
}

export interface Finding {
  code: string;
  indicators: string[];
  detail: string;
}

export interface Dictionary {
  items: Indicator[];
  findings: Finding[];
  asOf: string | null;
}

export function toDictionary(raw: unknown): Dictionary | undefined {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.items)) return undefined;
  return {
    items: body.items.flatMap((item) => toIndicator(item) ?? []),
    findings: list(body.findings).flatMap((item): Finding[] => {
      const found = asRecord(item);
      const code = text(found?.code);
      return found === undefined || code === undefined ? [] : [{ code, indicators: strings(found.indicators), detail: text(found.detail) ?? '' }];
    }),
    asOf: nullableText(body.as_of),
  };
}

export interface Version {
  id: string;
  version: number;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
  createdByName: string | null;
  submittedByName: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
}

export function toVersion(raw: unknown): Version[] {
  const body = asRecord(raw);
  const id = text(body?.id);
  if (body === undefined || id === undefined) return [];
  return [
    {
      id,
      version: count(body.version),
      status: text(body.status) ?? '',
      effectiveFrom: text(body.effective_from) ?? '',
      effectiveTo: nullableText(body.effective_to),
      reason: text(body.reason) ?? '',
      createdByName: nullableText(body.created_by_name),
      submittedByName: nullableText(body.submitted_by_name),
      approvedByName: nullableText(body.approved_by_name),
      approvedAt: nullableText(body.approved_at),
    },
  ];
}

export interface Usage {
  rules: Array<{ code: string; check: string; active: boolean }>;
  mappings: Array<{ code: string; source: string; active: boolean }>;
}

export interface IndicatorDetail {
  indicator: Indicator;
  versions: Version[];
  usage: Usage;
  asOf: string | null;
}

export function toIndicatorDetail(raw: unknown): IndicatorDetail | undefined {
  const body = asRecord(raw);
  const indicator = toIndicator(body?.indicator);
  if (body === undefined || indicator === undefined) return undefined;
  const usage = asRecord(body.usage);
  return {
    indicator,
    versions: list(body.versions).flatMap(toVersion),
    usage: {
      rules: list(usage?.rules).flatMap((item) => {
        const rule = asRecord(item);
        const code = text(rule?.code);
        return code === undefined ? [] : [{ code, check: text(rule?.check) ?? '', active: rule?.active === true }];
      }),
      mappings: list(usage?.mappings).flatMap((item) => {
        const mapping = asRecord(item);
        const code = text(mapping?.code);
        return code === undefined ? [] : [{ code, source: text(mapping?.source) ?? '', active: mapping?.active === true }];
      }),
    },
    asOf: nullableText(body.as_of),
  };
}

/** The words a filter of the dictionary is made of; an empty field leaves the list as it is. */
export interface DictionaryFilter {
  category: Category | '';
  valueKind: ValueKind | '';
  enterableOnly: boolean;
  q: string;
}
export const NO_FILTER: DictionaryFilter = { category: '', valueKind: '', enterableOnly: false, q: '' };
export const isFiltered = (filter: DictionaryFilter): boolean => filter.category !== '' || filter.valueKind !== '' || filter.enterableOnly || filter.q.trim() !== '';

// ---------------------------------------------------------------------------------------------------------------------------------------- the figures

export interface Figure {
  id: string;
  projectCode: string;
  periodCode: string;
  indicatorCode: string;
  revision: number;
  value: string;
  unit: string;
  source: 'ENTRY' | 'IMPORT';
  mappingCode: string | null;
  mappingVersion: number | null;
  importLine: number | null;
  reason: string | null;
  enteredByName: string | null;
  enteredAt: string;
}

export function toFigure(raw: unknown): Figure[] {
  const body = asRecord(raw);
  const id = text(body?.id);
  const code = text(body?.indicator_code);
  if (body === undefined || id === undefined || code === undefined) return [];
  return [
    {
      id,
      projectCode: text(body.project_code) ?? '',
      periodCode: text(body.period_code) ?? '',
      indicatorCode: code,
      revision: count(body.revision),
      value: text(body.value) ?? '',
      unit: text(body.unit) ?? '',
      source: body.source === 'IMPORT' ? 'IMPORT' : 'ENTRY',
      mappingCode: nullableText(body.mapping_code),
      mappingVersion: whole(body.mapping_version) ?? null,
      importLine: whole(body.import_line) ?? null,
      reason: nullableText(body.reason),
      enteredByName: nullableText(body.entered_by_name),
      enteredAt: text(body.entered_at) ?? '',
    },
  ];
}

export interface FigureList {
  items: Figure[];
  asOf: string | null;
}

export function toFigureList(raw: unknown): FigureList | undefined {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.items)) return undefined;
  return { items: body.items.flatMap(toFigure), asOf: nullableText(body.as_of) };
}

export interface Violation {
  ruleCode: string;
  ruleVersion: number;
  check: string;
  severity: 'BLOCK' | 'WARN';
  fields: string[];
  message: string;
  detail: string;
}

export function toViolation(raw: unknown): Violation[] {
  const body = asRecord(raw);
  const ruleCode = text(body?.rule_code);
  if (body === undefined || ruleCode === undefined) return [];
  return [
    {
      ruleCode,
      ruleVersion: count(body.rule_version),
      check: text(body.check) ?? '',
      severity: body.severity === 'WARN' ? 'WARN' : 'BLOCK',
      fields: strings(body.fields),
      message: text(body.message) ?? '',
      detail: text(body.detail) ?? '',
    },
  ];
}

export interface EntryResult {
  created: number;
  revised: number;
  unchanged: number;
  warnings: Violation[];
  figures: Figure[];
}

export function toEntryResult(raw: unknown): EntryResult | undefined {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.figures)) return undefined;
  return { created: count(body.created), revised: count(body.revised), unchanged: count(body.unchanged), warnings: list(body.warnings).flatMap(toViolation), figures: body.figures.flatMap(toFigure) };
}

/** One line of the entry form: the indicator, the number as text and, for a correction, the reason. */
export interface EntryLine {
  indicatorCode: string;
  value: string;
  reason: string;
}

export type LineFault = 'indicator' | 'value' | 'duplicate';
/** What is wrong with a line before it is sent: no indicator, a number that is not a decimal text (a comma, a space), or an indicator used twice. */
export function lineFault(line: EntryLine, all: readonly EntryLine[]): LineFault | undefined {
  if (line.indicatorCode === '') return 'indicator';
  if (all.filter((other) => other.indicatorCode === line.indicatorCode).length > 1) return 'duplicate';
  if (!DECIMAL.test(line.value.trim())) return 'value';
  return undefined;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------------------------------------------------- the rules

export interface EntryRule {
  code: string;
  check: string;
  severity: 'BLOCK' | 'WARN';
  fields: string[];
  totalField: string | null;
  tolerance: string | null;
  message: string;
  surfaces: Surface[] | null;
  min: string | null;
  max: string | null;
  closedStates: string[];
  version: number;
  origin: Origin;
  active: boolean;
  unverified: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface RuleList {
  items: EntryRule[];
  surfaces: Surface[];
  asOf: string | null;
}

export function toRuleList(raw: unknown): RuleList | undefined {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.items)) return undefined;
  return {
    items: body.items.flatMap((item): EntryRule[] => {
      const rule = asRecord(item);
      const code = text(rule?.code);
      if (rule === undefined || code === undefined) return [];
      return [
        {
          code,
          check: text(rule.check) ?? '',
          severity: rule.severity === 'WARN' ? 'WARN' : 'BLOCK',
          fields: strings(rule.fields),
          totalField: nullableText(rule.total_field),
          tolerance: nullableText(rule.tolerance),
          message: text(rule.message) ?? '',
          surfaces: Array.isArray(rule.surfaces) ? list(rule.surfaces).flatMap((one) => surfaceOf(one) ?? []) : null,
          min: nullableText(rule.min),
          max: nullableText(rule.max),
          closedStates: strings(rule.closed_states),
          version: count(rule.version),
          origin: originOf(rule.origin),
          active: rule.active === true,
          unverified: rule.unverified === true,
          effectiveFrom: nullableText(rule.effective_from),
          effectiveTo: nullableText(rule.effective_to),
        },
      ];
    }),
    surfaces: list(body.surfaces).flatMap((item) => surfaceOf(item) ?? []),
    asOf: nullableText(body.as_of),
  };
}

export interface Verdict {
  allowed: boolean;
  violations: Violation[];
  evaluated: string[];
  skipped: Array<{ ruleCode: string; reason: string }>;
}

export function toVerdict(raw: unknown): Verdict | undefined {
  const body = asRecord(raw);
  if (body === undefined || typeof body.allowed !== 'boolean') return undefined;
  return {
    allowed: body.allowed,
    violations: list(body.violations).flatMap(toViolation),
    evaluated: strings(body.evaluated),
    skipped: list(body.skipped).flatMap((item) => {
      const one = asRecord(item);
      const ruleCode = text(one?.rule_code);
      return ruleCode === undefined ? [] : [{ ruleCode, reason: text(one?.reason) ?? '' }];
    }),
  };
}

/** A line of "try numbers": the name of a field of the entry and the number typed for it. */
export interface FactLine {
  field: string;
  value: string;
}
const FIELD = /^[A-Z][A-Z0-9_]{0,63}$/;
export const factFault = (line: FactLine, all: readonly FactLine[]): 'field' | 'value' | 'duplicate' | undefined =>
  !FIELD.test(line.field.trim()) ? 'field' : all.filter((other) => other.field.trim() === line.field.trim()).length > 1 ? 'duplicate' : line.value.trim() === '' ? 'value' : undefined;
export const factsOf = (lines: readonly FactLine[]): Record<string, string> => Object.fromEntries(lines.filter((line) => factFault(line, lines) === undefined).map((line) => [line.field.trim(), line.value.trim()]));

// ---------------------------------------------------------------------------------------------------------------------------------------- the mappings

export interface MappingLine {
  indicator: string;
  source: string;
  scale: string;
  required: boolean;
}

export interface MappingProblem {
  code: string;
  indicator: string;
  line: number;
}

export interface Mapping {
  code: string;
  name: string;
  layout: 'COLUMNS' | 'ROWS';
  numberFormat: 'PLAIN' | 'VN';
  projectColumn: string | null;
  periodColumn: string | null;
  labelColumn: string | null;
  valueColumn: string | null;
  lines: MappingLine[];
  version: number;
  origin: Origin;
  active: boolean;
  unverified: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  problems: MappingProblem[];
}

export function toMapping(raw: unknown): Mapping | undefined {
  const body = asRecord(raw);
  const code = text(body?.code);
  if (body === undefined || code === undefined) return undefined;
  return {
    code,
    name: text(body.name) ?? code,
    layout: body.layout === 'ROWS' ? 'ROWS' : 'COLUMNS',
    numberFormat: body.number_format === 'PLAIN' ? 'PLAIN' : 'VN',
    projectColumn: nullableText(body.project_column),
    periodColumn: nullableText(body.period_column),
    labelColumn: nullableText(body.label_column),
    valueColumn: nullableText(body.value_column),
    lines: list(body.lines).flatMap((item): MappingLine[] => {
      const line = asRecord(item);
      const indicator = text(line?.indicator);
      return line === undefined || indicator === undefined ? [] : [{ indicator, source: text(line.source) ?? '', scale: text(line.scale) ?? 'ONE', required: line.required === true }];
    }),
    version: count(body.version),
    origin: originOf(body.origin),
    active: body.active === true,
    unverified: body.unverified === true,
    effectiveFrom: nullableText(body.effective_from),
    effectiveTo: nullableText(body.effective_to),
    problems: list(body.problems).flatMap((item): MappingProblem[] => {
      const problem = asRecord(item);
      const found = text(problem?.code);
      return found === undefined ? [] : [{ code: found, indicator: text(problem?.indicator) ?? '', line: count(problem?.line) }];
    }),
  };
}

export interface MappingList {
  items: Mapping[];
  asOf: string | null;
}

export function toMappingList(raw: unknown): MappingList | undefined {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.items)) return undefined;
  return { items: body.items.flatMap((item) => toMapping(item) ?? []), asOf: nullableText(body.as_of) };
}

export interface MappingDetail {
  mapping: Mapping;
  versions: Version[];
  asOf: string | null;
}

export function toMappingDetail(raw: unknown): MappingDetail | undefined {
  const body = asRecord(raw);
  const mapping = toMapping(body?.mapping);
  if (body === undefined || mapping === undefined) return undefined;
  return { mapping, versions: list(body.versions).flatMap(toVersion), asOf: nullableText(body.as_of) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------- the import

export interface UploadedFile {
  fileObjectKey: string;
  fileSha256: string;
  sizeBytes: number;
  format: string;
  columns: string[];
  rowCount: number;
  fittingMappings: string[];
}

export function toUploadedFile(raw: unknown): UploadedFile | undefined {
  const body = asRecord(raw);
  const key = text(body?.file_object_key);
  const sha = text(body?.file_sha256);
  const rows = whole(body?.row_count);
  if (body === undefined || key === undefined || sha === undefined || rows === undefined) return undefined;
  return { fileObjectKey: key, fileSha256: sha, sizeBytes: count(body.size_bytes), format: (text(body.format) ?? '').toUpperCase(), columns: strings(body.columns), rowCount: rows, fittingMappings: strings(body.fitting_mappings) };
}

export type RowStatus = 'VALID' | 'ERROR' | 'DUPLICATE' | 'CONFLICT';
export const ROW_STATUSES: readonly RowStatus[] = ['VALID', 'ERROR', 'DUPLICATE', 'CONFLICT'];
export type Outcome = 'CREATE' | 'CREATE_AND_DIFFERENCE' | 'DIFFERENCE' | 'UNCHANGED';
const OUTCOMES: readonly Outcome[] = ['CREATE', 'CREATE_AND_DIFFERENCE', 'DIFFERENCE', 'UNCHANGED'];

export interface PreviewRow {
  line: number;
  businessKey: string | null;
  status: RowStatus;
  code: string | null;
  field: string | null;
  outcome: Outcome | null;
  preview: Array<[string, string]>;
}

export interface Preview {
  mappingCode: string;
  mappingVersion: number;
  fileSha256: string;
  alreadyApplied: boolean;
  counts: { total: number; valid: number; errors: number; duplicate: number; conflict: number };
  rows: PreviewRow[];
  rowsTruncated: boolean;
  checkedAt: string;
}

const pairs = (value: unknown): Array<[string, string]> => {
  const body = asRecord(value);
  return body === undefined ? [] : Object.entries(body).flatMap(([key, one]): Array<[string, string]> => (typeof one === 'string' ? [[key, one]] : []));
};

export function toPreview(raw: unknown, checkedAt: string): Preview | undefined {
  const body = asRecord(raw);
  const counts = asRecord(body?.counts);
  const sha = text(body?.file_sha256);
  if (body === undefined || counts === undefined || sha === undefined) return undefined;
  return {
    mappingCode: text(body.mapping_code) ?? '',
    mappingVersion: count(body.mapping_version),
    fileSha256: sha,
    alreadyApplied: body.already_applied === true,
    counts: { total: count(counts.total), valid: count(counts.valid), errors: count(counts.errors), duplicate: count(counts.duplicate), conflict: count(counts.conflict) },
    rows: list(body.rows).flatMap((item): PreviewRow[] => {
      const row = asRecord(item);
      const line = whole(row?.line);
      const status = oneOf(ROW_STATUSES, row?.status);
      if (row === undefined || line === undefined || status === undefined) return [];
      return [{ line, businessKey: nullableText(row.business_key), status, code: nullableText(row.code), field: nullableText(row.field), outcome: oneOf(OUTCOMES, row.outcome) ?? null, preview: pairs(row.preview) }];
    }),
    rowsTruncated: body.rows_truncated === true,
    checkedAt,
  };
}

export interface RowError {
  line: number;
  businessKey: string | null;
  code: string;
  field: string;
  preview: Array<[string, string]>;
}

export const toRowError = (raw: unknown): RowError[] => {
  const body = asRecord(raw);
  const line = whole(body?.line);
  const code = text(body?.code);
  return body === undefined || line === undefined || code === undefined ? [] : [{ line, businessKey: nullableText(body.business_key), code, field: text(body.field) ?? '', preview: pairs(body.preview) }];
};

export interface Counts {
  total: number;
  applied: number;
  duplicate: number;
  conflict: number;
  quarantined: number;
  differencesOpened: number;
}

const toCounts = (raw: unknown): Counts | undefined => {
  const body = asRecord(raw);
  if (body === undefined) return undefined;
  return { total: count(body.total), applied: count(body.applied), duplicate: count(body.duplicate), conflict: count(body.conflict), quarantined: count(body.quarantined), differencesOpened: count(body.differences_opened) };
};

export interface Applied {
  runId: string | null;
  mappingCode: string;
  mappingVersion: number;
  counts: Counts;
  figuresWritten: number;
  figuresUnchanged: number;
  figuresDiffering: number;
  errors: RowError[];
  errorsTruncated: boolean;
}

export function toApplied(raw: unknown): Applied | undefined {
  const body = asRecord(raw);
  const counts = toCounts(body?.counts);
  if (body === undefined || counts === undefined) return undefined;
  return {
    runId: nullableText(body.resource_id),
    mappingCode: text(body.mapping_code) ?? '',
    mappingVersion: count(body.mapping_version),
    counts,
    figuresWritten: count(body.figures_written),
    figuresUnchanged: count(body.figures_unchanged),
    figuresDiffering: count(body.figures_differing),
    errors: list(body.errors).flatMap(toRowError),
    errorsTruncated: body.errors_truncated === true,
  };
}

/** The answer of an apply that was refused for its rows (IMPORT_HAS_ERRORS): nothing was taken, the faults say why. */
export function refusedApply(error: unknown): Applied | undefined {
  if (!(error instanceof ApiError) || error.code !== 'IMPORT_HAS_ERRORS') return undefined;
  const counts = toCounts(error.extensions.counts);
  if (counts === undefined) return undefined;
  return { runId: null, mappingCode: '', mappingVersion: 0, counts, figuresWritten: 0, figuresUnchanged: 0, figuresDiffering: 0, errors: list(error.extensions.errors).flatMap(toRowError), errorsTruncated: error.extensions.errors_truncated === true };
}

export interface Run {
  id: string;
  formatVersion: string;
  fileSha256: string;
  status: 'IMPORTING' | 'APPLIED' | 'FAILED';
  errorCode: string | null;
  counts: Counts;
  openDifferences: number;
  importedBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface RunPage {
  items: Run[];
  nextCursor: string | null;
  asOf: string | null;
}

export function toRunPage(raw: unknown): RunPage | undefined {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.items)) return undefined;
  return {
    items: body.items.flatMap((item): Run[] => {
      const run = asRecord(item);
      const id = text(run?.id);
      const counts = toCounts(run?.counts);
      if (run === undefined || id === undefined || counts === undefined) return [];
      return [
        {
          id,
          formatVersion: text(run.format_version) ?? '',
          fileSha256: text(run.file_sha256) ?? '',
          status: run.status === 'FAILED' ? 'FAILED' : run.status === 'IMPORTING' ? 'IMPORTING' : 'APPLIED',
          errorCode: nullableText(run.error_code),
          counts,
          openDifferences: count(run.open_differences),
          importedBy: nullableText(run.imported_by_name),
          createdAt: text(run.created_at) ?? '',
          completedAt: nullableText(run.completed_at),
        },
      ];
    }),
    nextCursor: nullableText(body.next_cursor),
    asOf: nullableText(body.as_of),
  };
}

export interface Difference {
  id: string;
  line: number;
  businessKey: string;
  code: string;
  expected: string | null;
  actual: string | null;
  status: string;
  ownerName: string | null;
  dueAt: string;
}

export interface RunRows {
  errors: RowError[];
  errorsTruncated: boolean;
  differences: Difference[];
  asOf: string | null;
}

export function toRunRows(raw: unknown): RunRows | undefined {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.errors)) return undefined;
  return {
    errors: body.errors.flatMap(toRowError),
    errorsTruncated: body.errors_truncated === true,
    differences: list(body.differences).flatMap((item): Difference[] => {
      const one = asRecord(item);
      const id = text(one?.id);
      const line = whole(one?.line);
      if (one === undefined || id === undefined || line === undefined) return [];
      return [{ id, line, businessKey: text(one.business_key) ?? '', code: text(one.code) ?? '', expected: nullableText(one.expected), actual: nullableText(one.actual), status: text(one.status) ?? '', ownerName: nullableText(one.owner_name), dueAt: text(one.due_at) ?? '' }];
    }),
    asOf: nullableText(body.as_of),
  };
}

/** Whether a run that asked for an apply may be asked for again: the file was loaded before, a mapping is not approved, the rows were refused. */
export type ApplyBlock = 'noPreview' | 'noValid' | 'alreadyApplied' | 'noAuthority' | 'done' | 'working' | 'stale';

export interface ApplyGateInput {
  preview: Preview | undefined;
  previewIsCurrent: boolean;
  canApply: boolean;
  applied: boolean;
  working: boolean;
}

/** Why the apply is closed, or null when it is open. The first reason that holds is told. */
export function applyGate(input: ApplyGateInput): ApplyBlock | null {
  if (input.working) return 'working';
  if (input.applied) return 'done';
  if (!input.canApply) return 'noAuthority';
  if (input.preview === undefined) return 'noPreview';
  if (!input.previewIsCurrent) return 'stale';
  if (input.preview.alreadyApplied) return 'alreadyApplied';
  if (input.preview.counts.valid === 0) return 'noValid';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------- the problems

export type ProblemKind =
  | 'ruleViolated'
  | 'mappingNotApproved'
  | 'alreadyApplied'
  | 'hasErrors'
  | 'hashMismatch'
  | 'schemaInvalid'
  | 'empty'
  | 'fileRefused'
  | 'tooLarge'
  | 'scanPending'
  | 'periodLocked'
  | 'validation'
  | 'notFound'
  | 'scopeDenied'
  | 'denied'
  | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ProblemKind>> = {
  IND_ENTRY_RULE_VIOLATED: 'ruleViolated',
  IND_MAPPING_NOT_APPROVED: 'mappingNotApproved',
  IMPORT_FILE_ALREADY_APPLIED: 'alreadyApplied',
  IMPORT_HAS_ERRORS: 'hasErrors',
  HASH_MISMATCH: 'hashMismatch',
  IMPORT_SCHEMA_INVALID: 'schemaInvalid',
  IMPORT_EMPTY: 'empty',
  FILE_TYPE_NOT_ALLOWED: 'fileRefused',
  FILE_NOT_CLEAN: 'fileRefused',
  PAYLOAD_TOO_LARGE: 'tooLarge',
  SCAN_PENDING: 'scanPending',
  PERIOD_LOCKED: 'periodLocked',
  VALIDATION_FAILED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'scopeDenied',
};

export interface Problem {
  kind: ProblemKind;
  code: string;
  /** The field a validation names (`figures[0].value`, `reason`). */
  detail: string;
  /** IMPORT_SCHEMA_INVALID: the columns or rows the file does not have. */
  missing: string[];
  /** IND_ENTRY_RULE_VIOLATED: the rules that blocked the entry, with the words their maker wrote. */
  violations: Violation[];
}

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return { kind: 'general', code: '', detail: '', missing: [], violations: [] };
  const known = PROBLEM_BY_CODE[error.code];
  return {
    kind: known ?? (error.status === 403 ? 'denied' : 'general'),
    code: error.code,
    detail: error.detail ?? '',
    missing: [...strings(error.extensions.missing_columns), ...strings(error.extensions.missing_rows), ...strings(error.extensions.duplicate_rows)],
    violations: list(error.extensions.violations).flatMap(toViolation),
  };
}

export const isForbidden = (error: unknown): boolean => error instanceof ApiError && error.status === 403;
