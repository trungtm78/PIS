import type { CertStatus } from './certification-model';
import { CERT_STATUSES } from './certification-model';
import { formulaText, metricFormula } from './bi-model';
import type { Metric } from './bi-model';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

export interface RegisterCertification {
  status: CertStatus;
  version: number;
  origin: 'PLATFORM' | 'TENANT';
  certifiedBy: string | null;
  at: string | null;
}

/** One definition of the KPI register (G0-4): the same words the command center, the phone and the Excel file use. */
export interface RegisterKpi {
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
  allowedLagDays: number | null;
  version: number;
  /** DEFAULT: the starting value of the platform; RULE: a rule of the governance store. */
  origin: 'RULE' | 'DEFAULT';
  /** The numbers of the definition are a starting value nobody confirmed. */
  unverified: boolean;
  certification: RegisterCertification | null;
}

export interface KpiRegister {
  asOf: string;
  definitions: RegisterKpi[];
  skipped: number;
}

function certificationOf(raw: unknown): RegisterCertification | null {
  const row = asRecord(raw);
  const status = text(row?.status);
  const version = whole(row?.version);
  if (row === undefined || status === undefined || !(CERT_STATUSES as readonly string[]).includes(status) || version === undefined) return null;
  return { status: status as CertStatus, version, origin: row.origin === 'PLATFORM' ? 'PLATFORM' : 'TENANT', certifiedBy: nullableText(row.certified_by), at: nullableText(row.at) };
}

function toDefinition(raw: unknown): RegisterKpi | undefined {
  const row = asRecord(raw);
  const code = text(row?.code);
  const name = text(row?.name);
  const formula = text(row?.formula);
  const version = whole(row?.version);
  if (row === undefined || code === undefined || name === undefined || formula === undefined || version === undefined) return undefined;
  return {
    code,
    name,
    formula,
    numerator: nullableText(row.numerator),
    denominator: nullableText(row.denominator),
    exclusions: Array.isArray(row.exclusions) ? row.exclusions.filter((item): item is string => typeof item === 'string') : [],
    unit: text(row.unit) ?? '',
    period: text(row.period) ?? '',
    source: text(row.source) ?? '',
    owner: text(row.owner) ?? '',
    allowedLagDays: whole(row.allowed_lag_days) ?? null,
    version,
    origin: row.origin === 'RULE' ? 'RULE' : 'DEFAULT',
    unverified: row.unverified === true,
    certification: certificationOf(row.certification),
  };
}

/** The answer of `GET /home/kpi-register`; an answer without the list of definitions is not an answer. */
export function toKpiRegister(raw: unknown): KpiRegister | undefined {
  const row = asRecord(raw);
  if (row === undefined || !Array.isArray(row.definitions)) return undefined;
  const parsed = row.definitions.map(toDefinition);
  return { asOf: text(row.as_of) ?? '', definitions: parsed.filter((item): item is RegisterKpi => item !== undefined), skipped: parsed.filter((item) => item === undefined).length };
}

/** The definition of a BI metric in the register: the same code (the register writes its codes in capitals, a metric in lower case). */
export const registerFor = (register: KpiRegister | undefined, code: string): RegisterKpi | undefined => register?.definitions.find((definition) => definition.code.toLowerCase() === code.toLowerCase());

/** What the "i" of a figure says (everything but the words of its labels): the register when it has the code, otherwise the definition of the metric the screen already has. */
export interface FigureDefinition {
  from: 'REGISTER' | 'METRIC';
  name: string;
  formula: string;
  numerator: string | null;
  denominator: string | null;
  exclusions: string[];
  source: string;
  owner: string;
  /** The version of the definition: the register's version, or the revision of the metric. */
  version: number;
  unverified: boolean;
  /** A default definition that has no version of its own in the rules (version 0). */
  builtIn: boolean;
}

export function definitionFromRegister(definition: RegisterKpi): FigureDefinition {
  return {
    from: 'REGISTER',
    name: definition.name,
    formula: definition.formula,
    numerator: definition.numerator,
    denominator: definition.denominator,
    exclusions: definition.exclusions,
    source: definition.source,
    owner: definition.owner,
    version: definition.version,
    unverified: definition.unverified,
    builtIn: definition.version === 0,
  };
}

/**
 * The definition of a metric the board already has: its formula, its dataset as the source (with the period of the version it is counted from), its owner (the member id the registry keeps, short) and its revision.
 * `sourceText` is the dataset written by the caller; `none` stands for a missing owner.
 */
export function definitionFromMetric(metric: Metric, sourceText: string, none: string): FigureDefinition {
  const ratio = metric.aggregationType === 'ratio';
  return {
    from: 'METRIC',
    name: metric.code,
    formula: metricFormula(metric),
    numerator: ratio && metric.numerator !== null ? formulaText(metric.numerator) : null,
    denominator: ratio && metric.denominator !== null ? formulaText(metric.denominator) : null,
    exclusions: [],
    source: sourceText,
    owner: metric.ownerId === '' ? none : metric.ownerId.slice(0, 8),
    version: metric.revision,
    unverified: false,
    builtIn: false,
  };
}
