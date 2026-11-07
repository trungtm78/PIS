import { DomainError } from './errors.ts';
import { isRuleDay, resolveGovernanceRule } from './governance-rules.ts';
import type { GovernanceRuleVersion, ResolvedGovernanceRule } from './governance-rules.ts';

/**
 * The KPI register (G0-4, BI 3 F1 and HOME 3 F1): one definition for each indicator, kept as `KPI_DEFINITION` rules of the governance store, so that the command center, the BI boards, the phone and the Excel file
 * all read the same words and the same numbers. This module is pure: the shape of a definition, how one is read out of a rule, the "i" of a figure (formula, source, as-of), the one way a figure is written as text, and the
 * life of a certification (G3-1: Nháp, Đã xác nhận, Đã chứng nhận, Lỗi thời) with the flags that say how far a figure can be trusted. No threshold or definition is a constant here: the defaults are data of `governance-rules`.
 */

export const KPI_RULE_TYPE = 'KPI_DEFINITION';
export const RAG_RULE_TYPE = 'RAG_THRESHOLDS';

export const KPI_UNITS = ['PERCENT', 'VND', 'COUNT', 'DAYS', 'RATIO'] as const;
export type KpiUnit = (typeof KPI_UNITS)[number];
export type KpiPeriod = 'YEAR_TO_DATE' | 'AS_OF_NOW' | 'WEEK' | 'MONTH' | 'QUARTER';

/** One definition as a reader sees it: the params of the rule in force, with the version and the days of that version. */
export interface KpiDefinition {
  code: string;
  name: string;
  formula: string;
  numerator: string | null;
  denominator: string | null;
  exclusions: string[];
  unit: KpiUnit;
  period: KpiPeriod;
  source: string;
  owner: string;
  decimals: number;
  refreshHours: number;
  /** How many days older than today the figure may be before the screen calls it old. */
  allowedLagDays: number;
  /** The `RAG_THRESHOLDS` code the figure is read against, if it has one. */
  ragCode: string | null;
  /** The version of the rule that gave this definition: 0 is the built-in default. */
  version: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  origin: 'RULE' | 'DEFAULT';
  /** The numbers behind a default nobody confirmed. */
  unverified: boolean;
  ruleId: string | null;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullable = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The definition a resolved rule says. A rule of another type, or one that lacks the members every definition has, is a mistake of the caller, not a figure. */
export function kpiDefinitionOf(resolved: ResolvedGovernanceRule, rules: readonly GovernanceRuleVersion[] = []): KpiDefinition {
  if (resolved.type !== KPI_RULE_TYPE) throw new DomainError('VALIDATION_FAILED', 422, 'rule_type');
  const params = resolved.params;
  const unit = (KPI_UNITS as readonly unknown[]).includes(params.unit) ? (params.unit as KpiUnit) : 'COUNT';
  const row = resolved.ruleId === null ? undefined : rules.find((candidate) => candidate.id === resolved.ruleId);
  return {
    code: resolved.code,
    name: text(params.name),
    formula: text(params.formula),
    numerator: nullable(params.numerator),
    denominator: nullable(params.denominator),
    exclusions: Array.isArray(params.exclusions) ? params.exclusions.filter((item): item is string => typeof item === 'string') : [],
    unit,
    period: (typeof params.period === 'string' ? params.period : 'AS_OF_NOW') as KpiPeriod,
    source: text(params.source),
    owner: text(params.owner),
    decimals: typeof params.decimals === 'number' ? params.decimals : 0,
    refreshHours: typeof params.refresh_hours === 'number' ? params.refresh_hours : 24,
    allowedLagDays: typeof params.allowed_lag_days === 'number' ? params.allowed_lag_days : 0,
    ragCode: nullable(params.rag_code),
    version: resolved.version,
    effectiveFrom: row?.effectiveFrom ?? null,
    effectiveTo: row?.effectiveTo ?? null,
    origin: resolved.source,
    unverified: resolved.unverified,
    ruleId: resolved.ruleId,
  };
}

/** The definition in force for `code` on `asOf`, or undefined when nobody defined it (a figure with no definition is not shown as a KPI). */
export function resolveKpi(rules: readonly GovernanceRuleVersion[], code: string, asOf: string): KpiDefinition | undefined {
  const resolved = resolveGovernanceRule(rules, KPI_RULE_TYPE, code, asOf);
  return resolved === undefined ? undefined : kpiDefinitionOf(resolved, rules);
}

// ---- the "i" of a figure ---------------------------------------------------------------------------------------------------------------------

/** What opens behind the "i" of a number: the formula, the source and the time it is as of, from the definition and nowhere else. */
export interface KpiInfo {
  code: string;
  name: string;
  formula: string;
  numerator: string | null;
  denominator: string | null;
  exclusions: string[];
  unit: KpiUnit;
  period: KpiPeriod;
  source: string;
  owner: string;
  allowedLagDays: number;
  version: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  origin: 'RULE' | 'DEFAULT';
  unverified: boolean;
  /** The day the figure is counted up to (the day of the snapshot, or the day it was read for a figure counted when it is asked). */
  asOf: string;
  /** The snapshot the figure comes from, when it comes from one. */
  snapshotId: string | null;
}

export function kpiInfoOf(definition: KpiDefinition, at: { asOf: string; snapshotId: string | null }): KpiInfo {
  return {
    code: definition.code,
    name: definition.name,
    formula: definition.formula,
    numerator: definition.numerator,
    denominator: definition.denominator,
    exclusions: definition.exclusions,
    unit: definition.unit,
    period: definition.period,
    source: definition.source,
    owner: definition.owner,
    allowedLagDays: definition.allowedLagDays,
    version: definition.version,
    effectiveFrom: definition.effectiveFrom,
    effectiveTo: definition.effectiveTo,
    origin: definition.origin,
    unverified: definition.unverified,
    asOf: at.asOf,
    snapshotId: at.snapshotId,
  };
}

// ---- one way to write a figure -----------------------------------------------------------------------------------------------------------------

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Rounds a decimal text half up (away from zero) to `decimals` places, by whole numbers: no float is involved, so the web, the phone and the file cannot differ by a last digit. */
export function roundDecimalText(value: string, decimals: number): string {
  if (!DECIMAL.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new DomainError('VALIDATION_FAILED', 422, 'value');
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const padded = fraction.padEnd(decimals + 1, '0');
  const kept = BigInt(`${whole}${padded.slice(0, decimals)}`);
  const up = padded.charCodeAt(decimals) >= 53 ? 1n : 0n;
  const scaled = (kept + up).toString().padStart(decimals + 1, '0');
  const body = decimals === 0 ? scaled : `${scaled.slice(0, -decimals)}.${scaled.slice(-decimals)}`;
  return negative && BigInt(scaled) !== 0n ? `-${body}` : body;
}

/**
 * The text of a figure as every channel writes it: a percent or a ratio with the places the definition fixes, money and counts whole. A figure with no value is null (never "0"): the caller says why from the reason
 * it was given.
 */
export function displayKpiValue(value: string | null, definition: Pick<KpiDefinition, 'unit' | 'decimals'>): string | null {
  if (value === null) return null;
  if (definition.unit === 'PERCENT' || definition.unit === 'RATIO' || definition.unit === 'DAYS') return roundDecimalText(value, definition.decimals);
  return roundDecimalText(value, 0);
}

// ---- RAG of one figure -------------------------------------------------------------------------------------------------------------------------

export type RagColor = 'GREEN' | 'AMBER' | 'RED';
export interface ThresholdLine {
  direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  green: number;
  amber: number;
}

/** Where a value stands against a line: on the better side of green, between, or past amber. A value that is not there has no colour. */
export function ragOfValue(line: ThresholdLine, value: number | null): RagColor | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (line.direction === 'HIGHER_IS_BETTER') return value >= line.green ? 'GREEN' : value >= line.amber ? 'AMBER' : 'RED';
  return value <= line.green ? 'GREEN' : value <= line.amber ? 'AMBER' : 'RED';
}

/** The share of the year that has gone by on `day`, in percent, as a number: the pace a disbursement is read against (the day of the year over the days of the year). */
export function yearPacePct(day: string): number {
  if (!isRuleDay(day)) throw new DomainError('VALIDATION_FAILED', 422, 'as_of');
  const year = Number(day.slice(0, 4));
  const start = Date.UTC(year, 0, 1);
  const days = (Date.UTC(year + 1, 0, 1) - start) / 86_400_000;
  const elapsed = (Date.parse(`${day}T00:00:00Z`) - start) / 86_400_000 + 1;
  return (elapsed / days) * 100;
}

// ---- certification ------------------------------------------------------------------------------------------------------------------------------

export const CERT_SUBJECTS = ['KPI', 'DATASET'] as const;
export type CertSubject = (typeof CERT_SUBJECTS)[number];
export const CERT_STATUSES = ['DRAFT', 'CONFIRMED', 'CERTIFIED', 'OBSOLETE'] as const;
export type CertStatus = (typeof CERT_STATUSES)[number];

export const isCertSubject = (value: unknown): value is CertSubject => (CERT_SUBJECTS as readonly unknown[]).includes(value);
export const isCertStatus = (value: unknown): value is CertStatus => (CERT_STATUSES as readonly unknown[]).includes(value);

/** One line of the log of a subject's certification (the table is append-only: what a subject is now is its latest line for the version). */
export interface CertLine {
  status: CertStatus;
  actor: string;
  /** Who confirmed the version: the certifier is someone else. */
  confirmedBy: string | null;
  at: string;
  note: string | null;
}

const MOVES: Readonly<Record<CertStatus, readonly CertStatus[]>> = {
  DRAFT: ['CONFIRMED'],
  CONFIRMED: ['CERTIFIED', 'DRAFT'],
  CERTIFIED: ['OBSOLETE'],
  OBSOLETE: [],
};

const reasonText = (note: string | undefined): string | null => {
  const trimmed = note === undefined ? '' : note.trim().normalize('NFC');
  return trimmed === '' ? null : trimmed;
};

/**
 * The line that a move adds, or the refusal. A version with no line is Nháp. It is confirmed by one person and certified by another (403 SELF_APPROVAL_DENIED: a certificate is a second pair of eyes); it cannot skip a
 * step (409 STAGE_TRANSITION_DENIED); sending it back to Nháp or making it Lỗi thời needs the reason in words (422 VALIDATION_FAILED on `note`). Lỗi thời is final for that version.
 */
export function nextCertification(current: CertLine | undefined, to: CertStatus, input: { actor: string; note?: string | undefined; at: string }): CertLine {
  const from: CertStatus = current?.status ?? 'DRAFT';
  if (!MOVES[from].includes(to)) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
  const note = reasonText(input.note);
  if ((to === 'DRAFT' || to === 'OBSOLETE') && (note === null || note.length < 5 || note.length > 500)) throw new DomainError('VALIDATION_FAILED', 422, 'note');
  if (note !== null && note.length > 500) throw new DomainError('VALIDATION_FAILED', 422, 'note');
  if (to === 'CERTIFIED' && current?.actor === input.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  if (to === 'CERTIFIED' && current?.confirmedBy !== undefined && current.confirmedBy === input.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  const confirmedBy = to === 'CONFIRMED' ? input.actor : to === 'CERTIFIED' || to === 'OBSOLETE' ? (current?.confirmedBy ?? current?.actor ?? null) : null;
  return { status: to, actor: input.actor, confirmedBy, at: input.at, note };
}

export type FigureFlag = 'NO_DATA' | 'NOT_CERTIFIED' | 'OBSOLETE' | 'STALE' | 'PARTIAL_COVERAGE' | 'UNVERIFIED_DEFINITION';

export interface FigureFacts {
  /** The figure has a value. */
  hasValue: boolean;
  /** The certification of the version of the definition the figure was made with. */
  certification: CertStatus;
  /** Days between the day the figure is as of and today. */
  ageDays: number | null;
  allowedLagDays: number;
  /** Share of the data that was there (0..100), when it is known. */
  coveragePct: number | null;
  unverifiedDefinition: boolean;
}

/**
 * The flags that sit on a number (G3-1, BI: "cờ chất lượng ngay trên số"): in the order of how much they matter. A figure that has no value says NO_DATA and never reads as 0; one whose version is not
 * certified (or was made obsolete) says so; one older than the lag its definition allows says STALE; one made from part of the data says PARTIAL_COVERAGE.
 */
export function figureFlags(facts: FigureFacts): FigureFlag[] {
  const flags: FigureFlag[] = [];
  if (!facts.hasValue) flags.push('NO_DATA');
  if (facts.certification === 'OBSOLETE') flags.push('OBSOLETE');
  else if (facts.certification !== 'CERTIFIED') flags.push('NOT_CERTIFIED');
  if (facts.ageDays !== null && facts.ageDays > facts.allowedLagDays) flags.push('STALE');
  if (facts.coveragePct !== null && facts.coveragePct < 100) flags.push('PARTIAL_COVERAGE');
  if (facts.unverifiedDefinition) flags.push('UNVERIFIED_DEFINITION');
  return flags;
}

/**
 * Whether a figure may be given to a leader (HOME-03 and the boards of the leader use certified figures only): only a certified version. The reason is the flag that stops it, which the tile carries in place of a value.
 */
export function leaderGate(certification: CertStatus): 'NOT_CERTIFIED' | 'OBSOLETE' | null {
  return certification === 'CERTIFIED' ? null : certification === 'OBSOLETE' ? 'OBSOLETE' : 'NOT_CERTIFIED';
}

/** The latest line of each version of a subject: what each version is now. */
export function currentCertification(lines: ReadonlyArray<{ version: number } & CertLine>, version: number): CertLine | undefined {
  const own = lines.filter((line) => line.version === version);
  return own[own.length - 1];
}
